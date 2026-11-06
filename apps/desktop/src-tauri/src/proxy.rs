//! Join role: a loopback HTTP proxy to another host's HTTPS, pinned to its certificate
//! fingerprint (trust on first use, ARCHITECTURE §5.3). The webview loads the remote web
//! client through it, so WKWebView never sees the self-signed certificate.
use crate::tls::{client_config, PinnedVerifier};
use anyhow::{anyhow, Context, Result};
use axum::body::Body;
use axum::extract::ws::WebSocketUpgrade;
use axum::extract::{FromRequestParts, Request, State};
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Router;
use http_body_util::BodyExt;
use hyper_util::rt::TokioIo;
use rustls::pki_types::ServerName;
use serde::Serialize;
use std::sync::Arc;
use std::time::Duration;
use tokio_rustls::TlsConnector;

#[derive(Clone)]
struct Remote {
    host: String,
    port: u16,
    tls: Arc<rustls::ClientConfig>,
}

pub struct JoinProxy {
    pub url: String,
    pub address: String,
    pub fingerprint: String,
    stop: tokio::sync::watch::Sender<bool>,
}

/// "192.168.1.20", "192.168.1.20:8443", "https://host:8443/…" → (host, port)
pub fn parse_address(a: &str) -> Result<(String, u16)> {
    let a = a.trim().trim_start_matches("https://").trim_start_matches("http://");
    let a = a.split(['/', '#', '?']).next().unwrap_or("");
    if a.is_empty() {
        return Err(anyhow!("enter the host's address"));
    }
    match a.rsplit_once(':') {
        Some((h, p)) if !h.contains(':') || h.ends_with(']') => Ok((h.trim_matches(['[', ']']).to_string(), p.parse().context("bad port")?)),
        _ => Ok((a.trim_matches(['[', ']']).to_string(), 8443)),
    }
}

async fn tls_stream(host: &str, port: u16, cfg: Arc<rustls::ClientConfig>) -> Result<tokio_rustls::client::TlsStream<tokio::net::TcpStream>> {
    let tcp = tokio::time::timeout(Duration::from_secs(4), tokio::net::TcpStream::connect((host, port))).await.context("connection timed out")??;
    tcp.set_nodelay(true)?;
    let name = ServerName::try_from(host.to_string()).map_err(|_| anyhow!("bad host name"))?;
    Ok(TlsConnector::from(cfg).connect(name, tcp).await?)
}

async fn http_get(host: &str, port: u16, cfg: Arc<rustls::ClientConfig>, path: &str) -> Result<Vec<u8>> {
    let tls = tls_stream(host, port, cfg).await?;
    let (mut send, conn) = hyper::client::conn::http1::handshake(TokioIo::new(tls)).await?;
    tokio::spawn(conn);
    let req = hyper::Request::get(path).header(header::HOST, format!("{host}:{port}")).body(Body::empty())?;
    let res = send.send_request(req).await?;
    Ok(res.into_body().collect().await?.to_bytes().to_vec())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Probe {
    pub server_id: String,
    pub name: String,
    pub fingerprint: String,
    pub address: String,
}

/// Connect without trusting yet: return the certificate fingerprint and /api/info.
pub async fn probe(address: &str) -> Result<Probe> {
    crate::host::install_crypto();
    let (host, port) = parse_address(address)?;
    let v = PinnedVerifier::new(None);
    let body = http_get(&host, port, client_config(v.clone()), "/api/info").await.with_context(|| format!("cannot reach {host}:{port}"))?;
    let info: serde_json::Value = serde_json::from_slice(&body).context("not a PartyLine server")?;
    let fp = v.seen.lock().unwrap().clone().unwrap_or_default();
    Ok(Probe {
        server_id: info["serverId"].as_str().unwrap_or("").into(),
        name: info["name"].as_str().unwrap_or("PartyLine").into(),
        fingerprint: fp,
        address: format!("{host}:{port}"),
    })
}

pub async fn start(address: &str, fingerprint: &str, local_port: u16) -> Result<JoinProxy> {
    crate::host::install_crypto();
    let (host, port) = parse_address(address)?;
    let tls = client_config(PinnedVerifier::new(Some(fingerprint.to_string())));
    // fail early (wrong fingerprint, host down) instead of loading a broken page
    http_get(&host, port, tls.clone(), "/healthz").await.with_context(|| format!("cannot connect securely to {host}:{port}"))?;
    let remote = Remote { host: host.clone(), port, tls };
    let app = Router::new().fallback(forward).with_state(remote);
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", local_port)).await.with_context(|| format!("port {local_port} in use"))?;
    let (stop, mut rx) = tokio::sync::watch::channel(false);
    tokio::spawn(async move {
        let _ = axum::serve(listener, app)
            .with_graceful_shutdown(async move {
                let _ = rx.changed().await;
            })
            .await;
    });
    Ok(JoinProxy { url: format!("http://127.0.0.1:{local_port}/"), address: format!("{host}:{port}"), fingerprint: fingerprint.to_string(), stop })
}

impl JoinProxy {
    pub fn stop(&self) {
        let _ = self.stop.send(true);
    }
}

async fn forward(State(r): State<Remote>, req: Request) -> Response {
    let pq = req.uri().path_and_query().map(|p| p.as_str().to_string()).unwrap_or_else(|| "/".into());
    let is_ws = req.headers().get(header::UPGRADE).and_then(|v| v.to_str().ok()).map_or(false, |v| v.eq_ignore_ascii_case("websocket"));
    if is_ws {
        let (mut parts, _) = req.into_parts();
        let Ok(ws) = WebSocketUpgrade::from_request_parts(&mut parts, &()).await else { return StatusCode::BAD_REQUEST.into_response() };
        let Ok(up_req) = crate::http::ws_upstream_request(&format!("wss://{}:{}{}", r.host, r.port, pq), &parts.headers) else { return StatusCode::BAD_REQUEST.into_response() };
        let up = tokio_tungstenite::connect_async_tls_with_config(up_req, None, true, Some(tokio_tungstenite::Connector::Rustls(r.tls.clone()))).await;
        return match up {
            Ok((s, _)) => ws.max_message_size(16 << 20).on_upgrade(move |c| crate::http::pump(c, s)),
            Err(e) => (StatusCode::BAD_GATEWAY, format!("upstream: {e}")).into_response(),
        };
    }
    let tls = match tls_stream(&r.host, r.port, r.tls.clone()).await {
        Ok(t) => t,
        Err(e) => return (StatusCode::BAD_GATEWAY, format!("host unreachable: {e}")).into_response(),
    };
    let Ok((mut send, conn)) = hyper::client::conn::http1::handshake(TokioIo::new(tls)).await else { return StatusCode::BAD_GATEWAY.into_response() };
    tokio::spawn(conn);
    let (mut parts, body) = req.into_parts();
    parts.uri = pq.parse().unwrap_or_default();
    parts.version = hyper::Version::HTTP_11; // the upstream connection is HTTP/1.1
    parts.headers.insert(header::HOST, format!("{}:{}", r.host, r.port).parse().unwrap());
    match send.send_request(hyper::Request::from_parts(parts, body)).await {
        Ok(res) => {
            let (p, b) = res.into_parts();
            Response::from_parts(p, Body::new(b.map_err(axum::Error::new)))
        }
        Err(e) => (StatusCode::BAD_GATEWAY, format!("upstream: {e}")).into_response(),
    }
}

#[cfg(test)]
mod tests {
    use super::parse_address as p;
    #[test]
    fn addresses() {
        assert_eq!(p("192.168.1.20").unwrap(), ("192.168.1.20".into(), 8443));
        assert_eq!(p("192.168.1.20:9000").unwrap(), ("192.168.1.20".into(), 9000));
        assert_eq!(p("https://mac.local:8443/#join?code=1").unwrap(), ("mac.local".into(), 8443));
    }
}
