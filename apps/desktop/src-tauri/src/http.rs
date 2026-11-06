//! axum router shared by both listeners: HTTPS :8443 on the LAN and plain HTTP on loopback
//! (the desktop's own webview loads the web client from there: WKWebView will not accept the
//! self-signed cert, and http://127.0.0.1 is a secure context for getUserMedia).
//! Loopback is the host's own console: it joins without a code and is admin.
use crate::model::*;
use crate::state::*;
use axum::body::Body;
use axum::extract::ws::{Message as AxMsg, WebSocketUpgrade};
use axum::extract::{ConnectInfo, FromRequestParts, Query, Request, State};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use axum::routing::{any, get, post};
use axum::{Extension, Json, Router};
use futures_util::{SinkExt, StreamExt};
use http_body_util::BodyExt;
use rust_embed::RustEmbed;
use serde::Deserialize;
use serde_json::{json, Value};
use std::net::SocketAddr;
use std::sync::Arc;
use tokio_tungstenite::tungstenite::Message as TMsg;

#[derive(RustEmbed)]
#[folder = "../../../packages/web-client/dist"]
struct WebClient;

#[derive(Clone, Copy, PartialEq)]
pub enum Listener {
    Lan,
    Loopback,
}

#[derive(Clone)]
pub struct AppState {
    pub core: Arc<Core>,
    pub livekit_port: u16,
    /// Shared with `Host`, kept current by the IP watcher; only shown to loopback callers.
    pub lan: Arc<std::sync::Mutex<Vec<std::net::Ipv4Addr>>>,
    pub https_port: u16,
    pub apk: Option<Arc<std::path::PathBuf>>,
}

pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/healthz", get(|| async { "ok" }))
        .route("/api/info", get(info))
        .route("/api/join", post(join))
        .route("/api/session", post(session))
        .route("/api/messages", get(messages))
        .route("/download/partyline.apk", get(download_apk))
        .route("/api/ws", get(ws_upgrade))
        .route("/rtc", any(rtc))
        .route("/rtc/{*rest}", any(rtc))
        .route("/api/{*rest}", any(|| async { api_err(StatusCode::NOT_FOUND, "not_found", "no such endpoint") }))
        .fallback(get(static_file))
        .with_state(state)
}

pub fn api_err(status: StatusCode, code: &str, message: &str) -> Response {
    (status, [(header::CACHE_CONTROL, "no-store")], Json(json!({ "error": { "code": code, "message": message } }))).into_response()
}
fn ok_json(v: Value) -> Response {
    ([(header::CACHE_CONTROL, "no-store")], Json(v)).into_response()
}

async fn info(State(st): State<AppState>, Extension(l): Extension<Listener>) -> Response {
    let w = st.core.lock();
    let mut v = json!({
        "apiVersion": API_VERSION, "serverId": w.server.id, "name": w.server.name, "appVersion": APP_VERSION,
        "fingerprint": w.fingerprint, "joinOpen": w.server.join_open, "livekitUrl": "/rtc", "minClientVersion": "0.1.0",
    });
    // where phones get the native apps (shown on /#install)
    v["androidApk"] = match st.apk.as_deref().and_then(|p| std::fs::metadata(p).ok()) {
        Some(m) => json!({ "url": "/download/partyline.apk", "size": m.len() }),
        None => Value::Null,
    };
    v["iosInstallUrl"] = json!(w.settings.ios_install_url);
    if l == Listener::Loopback {
        v["localHost"] = json!(true);
        let lan: Vec<String> = st.lan.lock().unwrap().iter().map(|ip| format!("https://{ip}:{}", st.https_port)).collect();
        v["lanUrls"] = json!(lan);
    }
    ok_json(v)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct JoinReq {
    join_code: Option<Value>,
    device_id: String,
    display_name: String,
    platform: String,
    app_version: Option<String>,
    api_version: Option<u32>,
}

fn bearer(h: &HeaderMap) -> Option<String> {
    h.get(header::AUTHORIZATION)?.to_str().ok()?.strip_prefix("Bearer ").map(|s| s.trim().to_string())
}

fn session_body(core: &Core, w: &mut World, id: &str) -> Value {
    let tok = core.lk.participant_token(&w.devices[id]);
    json!({ "livekitToken": tok, "livekitUrl": "/rtc", "roomName": ROOM, "me": w.view(id), "groups": w.sorted_groups() })
}

async fn join(State(st): State<AppState>, Extension(l): Extension<Listener>, ConnectInfo(addr): ConnectInfo<SocketAddr>, body: axum::body::Bytes) -> Response {
    let ip = addr.ip().to_string();
    let local = l == Listener::Loopback;
    let core = st.core.clone();
    if !local {
        if let Some(wait) = core.lock().rate.check(&ip) {
            let mut r = api_err(StatusCode::TOO_MANY_REQUESTS, "rate_limited", &format!("Too many attempts, try again in {wait} s"));
            r.headers_mut().insert(header::RETRY_AFTER, HeaderValue::from_str(&wait.to_string()).unwrap());
            return r;
        }
    }
    let Ok(req) = serde_json::from_slice::<JoinReq>(&body) else { return api_err(StatusCode::BAD_REQUEST, "bad_request", "deviceId, displayName and platform are required") };
    if req.api_version.map_or(false, |v| v != API_VERSION) {
        return api_err(StatusCode::BAD_REQUEST, "version_unsupported", "apiVersion 1 required");
    }
    let name = req.display_name.trim().chars().take(40).collect::<String>();
    if uuid::Uuid::parse_str(&req.device_id).is_err() || name.is_empty() || !["ios", "android", "web", "desktop"].contains(&req.platform.as_str()) {
        return api_err(StatusCode::BAD_REQUEST, "bad_request", "deviceId (uuid), displayName and platform are required");
    }
    let code = match &req.join_code {
        Some(Value::String(s)) => s.trim().to_string(),
        Some(Value::Number(n)) => format!("{:06}", n.as_u64().unwrap_or(0)),
        _ => String::new(),
    };
    core.with(|w| {
        if !local {
            if !w.server.join_open {
                return api_err(StatusCode::FORBIDDEN, "join_closed", "Joining is closed");
            }
            let now = chrono::Utc::now().timestamp();
            if code != w.server.join_code {
                w.rate.fail(&ip);
                let _ = w.db.record_join_attempt(now, &ip, false);
                tracing::warn!("join: wrong code from {ip}");
                w.broadcast_server();
                return api_err(StatusCode::UNAUTHORIZED, "invalid_code", "Wrong join code");
            }
            let _ = w.db.record_join_attempt(now, &ip, true);
        }
        let token = random_token();
        let now = now_iso();
        let id = req.device_id.to_lowercase();
        if let Some(d) = w.devices.get_mut(&id) {
            // re-pairing keeps group and permissions; the old token stops working
            d.token_hash = Some(sha256_hex(&token));
            d.revoked = false;
            d.display_name = name;
            d.platform = req.platform.clone();
            if let Some(v) = &req.app_version {
                d.app_version = v.clone();
            }
            d.last_seen_at = now;
            if local {
                d.is_admin = true;
            }
        } else {
            let mut groups = w.sorted_groups();
            if groups.is_empty() {
                return api_err(StatusCode::INTERNAL_SERVER_ERROR, "bad_request", "no groups");
            }
            let all: Vec<String> = groups.iter().map(|g| g.id.clone()).collect();
            let home = if local {
                groups.iter().find(|g| g.id == "producer").unwrap_or(&groups[0]).id.clone()
            } else {
                groups.retain(|g| g.id != "producer");
                groups.first().map(|g| g.id.clone()).unwrap_or_else(|| all[0].clone())
            };
            w.devices.insert(
                id.clone(),
                DeviceRow {
                    id: id.clone(),
                    display_name: name,
                    platform: req.platform.clone(),
                    app_version: req.app_version.clone().unwrap_or_else(|| "0.0.0".into()),
                    group_id: home.clone(),
                    listen_group_ids: if local { all.clone() } else { vec![home.clone()] },
                    can_talk_group_ids: if local { all } else { vec![home] },
                    is_admin: local,
                    forced_talk_mode: None,
                    admin_muted: false,
                    created_at: now.clone(),
                    last_seen_at: now,
                    token_hash: Some(sha256_hex(&token)),
                    revoked: false,
                },
            );
        }
        if let Some(s) = w.sessions.remove(&id) {
            let _ = s.tx.send(Out::Close(4001, "re-paired".into()));
        }
        w.save_device(&id);
        tracing::info!("join: {} ({}) from {ip}{}", w.devices[&id].display_name, w.devices[&id].platform, if w.devices[&id].is_admin { " [admin]" } else { "" });
        w.upsert(&id, true);
        let mut body = session_body(&core, w, &id);
        body["deviceToken"] = json!(token);
        ok_json(body)
    })
}

async fn session(State(st): State<AppState>, headers: HeaderMap) -> Response {
    let Some(tok) = bearer(&headers) else { return api_err(StatusCode::UNAUTHORIZED, "invalid_token", "Missing device token") };
    let core = st.core.clone();
    core.with(|w| {
        let Some(d) = w.device_by_token(&tok).cloned() else { return api_err(StatusCode::UNAUTHORIZED, "invalid_token", "Unknown device token") };
        if d.revoked {
            return api_err(StatusCode::FORBIDDEN, "revoked", "This device was removed by the admin");
        }
        w.devices.get_mut(&d.id).unwrap().last_seen_at = now_iso();
        w.save_device(&d.id);
        ok_json(session_body(&core, w, &d.id))
    })
}

#[derive(Deserialize)]
struct MsgQuery {
    since: Option<String>,
    limit: Option<usize>,
}
async fn messages(State(st): State<AppState>, headers: HeaderMap, Query(q): Query<MsgQuery>) -> Response {
    let Some(tok) = bearer(&headers) else { return api_err(StatusCode::UNAUTHORIZED, "invalid_token", "Missing device token") };
    let w = st.core.lock();
    let Some(d) = w.device_by_token(&tok).cloned() else { return api_err(StatusCode::UNAUTHORIZED, "invalid_token", "Unknown device token") };
    if d.revoked {
        return api_err(StatusCode::FORBIDDEN, "revoked", "removed");
    }
    let limit = q.limit.unwrap_or(100).clamp(1, 500);
    let list: Vec<Value> = w
        .messages
        .iter()
        .filter(|m| World::visible_to(m, &d) && q.since.as_ref().map_or(true, |s| m.ts.as_str() > s.as_str()))
        .map(|m| World::message_view(m, d.is_admin))
        .collect();
    ok_json(Value::Array(list[list.len().saturating_sub(limit)..].to_vec()))
}

async fn ws_upgrade(State(st): State<AppState>, ws: WebSocketUpgrade) -> Response {
    ws.max_message_size(64 * 1024).on_upgrade(move |s| crate::ws::session(st.core, s))
}

// ------------------------------------------------------------------ static web client

async fn static_file(uri: Uri) -> Response {
    let path = uri.path().trim_start_matches('/');
    let (file, path) = match WebClient::get(path) {
        Some(f) if !path.is_empty() => (f, path.to_string()),
        _ => match WebClient::get("index.html") {
            Some(f) => (f, "index.html".to_string()),
            None => return (StatusCode::OK, "PartyLine host. Web client not built (packages/web-client/dist).").into_response(),
        },
    };
    let mime = mime_guess::from_path(&path).first_or_octet_stream();
    // only Vite's content-hashed bundles are safe to cache forever; icons/manifest keep their names
    let cache = if path == "index.html" {
        "no-store"
    } else if path.starts_with("assets/") {
        "public, max-age=31536000, immutable"
    } else {
        "no-cache"
    };
    ([(header::CONTENT_TYPE, mime.as_ref().to_string()), (header::CACHE_CONTROL, cache.to_string())], file.data.into_owned()).into_response()
}

// ------------------------------------------------------------------ Android app download

async fn download_apk(State(st): State<AppState>) -> Response {
    let Some(path) = st.apk.clone() else { return api_err(StatusCode::NOT_FOUND, "not_found", "no Android app bundled with this host") };
    let file = match tokio::fs::File::open(path.as_path()).await {
        Ok(f) => f,
        Err(_) => return api_err(StatusCode::NOT_FOUND, "not_found", "Android app missing"),
    };
    let len = file.metadata().await.map(|m| m.len()).unwrap_or(0);
    (
        [
            (header::CONTENT_TYPE, "application/vnd.android.package-archive".to_string()),
            (header::CONTENT_DISPOSITION, "attachment; filename=\"PartyLine.apk\"".to_string()),
            (header::CONTENT_LENGTH, len.to_string()),
            (header::CACHE_CONTROL, "no-cache".to_string()),
        ],
        Body::from_stream(tokio_util::io::ReaderStream::with_capacity(file, 256 * 1024)),
    )
        .into_response()
}

// ------------------------------------------------------------------ /rtc → LiveKit

/// SDKs append "/rtc" (or "/rtc/v1", "/rtc/validate") to the URL they are given; a client
/// given wss://host:8443/rtc therefore asks for /rtc/rtc…. Strip our prefix once.
pub fn rtc_upstream_path(path_and_query: &str) -> String {
    let stripped = path_and_query.strip_prefix("/rtc").unwrap_or(path_and_query);
    if stripped == "/rtc" || stripped.starts_with("/rtc/") || stripped.starts_with("/rtc?") {
        stripped.to_string()
    } else {
        path_and_query.to_string()
    }
}

async fn rtc(State(st): State<AppState>, req: Request) -> Response {
    proxy_rtc(st.livekit_port, req).await
}

/// Client headers LiveKit needs on the upstream WebSocket. Native SDKs (Android 2.x, Swift)
/// send the token as `Authorization: Bearer …` rather than `?access_token=`.
const WS_FORWARD: [header::HeaderName; 3] = [header::AUTHORIZATION, header::USER_AGENT, header::SEC_WEBSOCKET_PROTOCOL];

/// Upstream WebSocket request for `url`, carrying the client's [`WS_FORWARD`] headers.
pub fn ws_upstream_request(url: &str, from: &HeaderMap) -> Result<tokio_tungstenite::tungstenite::handshake::client::Request, tokio_tungstenite::tungstenite::Error> {
    use tokio_tungstenite::tungstenite::client::IntoClientRequest;
    let mut r = url.into_client_request()?;
    for h in WS_FORWARD {
        if let Some(v) = from.get(&h) {
            r.headers_mut().insert(h, v.clone());
        }
    }
    Ok(r)
}

/// Forward one /rtc request (WebSocket signalling or plain HTTP like /rtc/validate) to LiveKit.
pub async fn proxy_rtc(livekit_port: u16, req: Request) -> Response {
    let pq = req.uri().path_and_query().map(|p| p.as_str().to_string()).unwrap_or_else(|| "/rtc".into());
    let upstream = rtc_upstream_path(&pq);
    let is_ws = req.headers().get(header::UPGRADE).and_then(|v| v.to_str().ok()).map_or(false, |v| v.eq_ignore_ascii_case("websocket"));
    let ua = req.headers().get(header::USER_AGENT).and_then(|v| v.to_str().ok()).unwrap_or("-").chars().take(60).collect::<String>();
    tracing::info!(target: "partyline::rtc", "{:?} {} {} ws={} auth_header={} ua={}", req.version(), req.method(), pq.split('?').next().unwrap_or(""), is_ws, req.headers().contains_key(header::AUTHORIZATION), ua);
    if is_ws {
        let (mut parts, _) = req.into_parts();
        let ws = match WebSocketUpgrade::from_request_parts(&mut parts, &()).await {
            Ok(ws) => ws,
            Err(e) => {
                tracing::warn!(target: "partyline::rtc", "bad upgrade: {e}");
                return api_err(StatusCode::BAD_REQUEST, "bad_request", "bad upgrade");
            }
        };
        let Ok(up_req) = ws_upstream_request(&format!("ws://127.0.0.1:{livekit_port}{upstream}"), &parts.headers) else {
            return api_err(StatusCode::BAD_REQUEST, "bad_request", "bad path");
        };
        // connect upstream first so a LiveKit outage is an HTTP error, not a dead socket
        let (up, up_res) = match tokio_tungstenite::connect_async(up_req).await {
            Ok(x) => x,
            Err(tokio_tungstenite::tungstenite::Error::Http(r)) => {
                let status = StatusCode::from_u16(r.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
                let body = r.body().clone().unwrap_or_default();
                tracing::warn!(target: "partyline::rtc", "livekit refused ws: {status} {}", String::from_utf8_lossy(&body));
                return (status, body).into_response();
            }
            Err(e) => {
                tracing::warn!("rtc proxy: {e}");
                return api_err(StatusCode::BAD_GATEWAY, "bad_request", "audio server not running");
            }
        };
        // echo the subprotocol LiveKit picked, if any, so strict clients accept the upgrade
        let ws = match up_res.headers().get(header::SEC_WEBSOCKET_PROTOCOL).and_then(|v| v.to_str().ok()) {
            Some(p) => ws.protocols([p.to_string()]),
            None => ws,
        };
        return ws.max_message_size(16 << 20).max_frame_size(16 << 20).on_upgrade(move |client| pump(client, up));
    }
    // plain HTTP (e.g. /rtc/validate). Phones reach us over HTTP/2 (ALPN); LiveKit and this
    // client speak HTTP/1.1, so downgrade the request instead of forwarding it as h2.
    let client = hyper_util::client::legacy::Client::builder(hyper_util::rt::TokioExecutor::new()).build_http::<Body>();
    let (mut parts, body) = req.into_parts();
    parts.uri = match format!("http://127.0.0.1:{livekit_port}{upstream}").parse() {
        Ok(u) => u,
        Err(_) => return api_err(StatusCode::BAD_REQUEST, "bad_request", "bad path"),
    };
    parts.version = axum::http::Version::HTTP_11;
    for h in [header::HOST, header::CONNECTION, header::TE, header::UPGRADE, header::TRANSFER_ENCODING] {
        parts.headers.remove(h);
    }
    match client.request(Request::from_parts(parts, body)).await {
        Ok(r) => {
            let (mut p, b) = r.into_parts();
            // hop-by-hop headers are illegal on an HTTP/2 response
            for h in [header::CONNECTION, header::TRANSFER_ENCODING, header::UPGRADE] {
                p.headers.remove(h);
            }
            p.headers.remove("keep-alive");
            Response::from_parts(p, Body::new(b.map_err(axum::Error::new)))
        }
        Err(e) => {
            tracing::warn!("rtc proxy http: {e}");
            api_err(StatusCode::BAD_GATEWAY, "bad_request", "audio server not running")
        }
    }
}

pub async fn pump(client: axum::extract::ws::WebSocket, up: tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>) {
    let (mut csink, mut cstream) = client.split();
    let (mut usink, mut ustream) = up.split();
    let c2u = async {
        while let Some(Ok(m)) = cstream.next().await {
            let m = match m {
                AxMsg::Binary(b) => TMsg::Binary(b),
                AxMsg::Text(t) => TMsg::Text(t.as_str().into()),
                AxMsg::Close(_) => break,
                _ => continue,
            };
            if usink.send(m).await.is_err() {
                break;
            }
        }
        let _ = usink.close().await;
    };
    let u2c = async {
        while let Some(Ok(m)) = ustream.next().await {
            let m = match m {
                TMsg::Binary(b) => AxMsg::Binary(b),
                TMsg::Text(t) => AxMsg::Text(t.as_str().into()),
                TMsg::Close(_) => break,
                _ => continue,
            };
            if csink.send(m).await.is_err() {
                break;
            }
        }
        let _ = csink.close().await;
    };
    tokio::select! { _ = c2u => {}, _ = u2c => {} }
}

#[cfg(test)]
mod tests {
    use super::rtc_upstream_path as p;
    #[test]
    fn rtc_paths() {
        assert_eq!(p("/rtc/rtc?access_token=x"), "/rtc?access_token=x");
        assert_eq!(p("/rtc/rtc/validate?a=1"), "/rtc/validate?a=1");
        assert_eq!(p("/rtc/rtc/v1?a=1"), "/rtc/v1?a=1");
        assert_eq!(p("/rtc?access_token=x"), "/rtc?access_token=x");
        assert_eq!(p("/rtc/validate?x"), "/rtc/validate?x");
    }

    // ---- /rtc proxy regressions found with native phones (OkHttp/URLSession)

    use super::proxy_rtc;
    use axum::extract::Request;
    use axum::http::StatusCode;
    use axum::routing::any;
    use axum::Router;
    use futures_util::{SinkExt, StreamExt};
    use http_body_util::BodyExt;
    use tokio::net::TcpListener;
    use tokio_tungstenite::tungstenite::client::IntoClientRequest;
    use tokio_tungstenite::tungstenite::handshake::server::{ErrorResponse, Request as WsReq, Response as WsRes};
    use tokio_tungstenite::tungstenite::Message;

    async fn serve(app: Router) -> u16 {
        let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = l.local_addr().unwrap().port();
        tokio::spawn(async move { axum::serve(l, app).await.unwrap() });
        port
    }
    /// our /rtc routes in front of a stand-in LiveKit on `lk`
    async fn proxy(lk: u16) -> u16 {
        serve(Router::new().route("/rtc", any(move |r: Request| proxy_rtc(lk, r))).route("/rtc/{*rest}", any(move |r: Request| proxy_rtc(lk, r)))).await
    }

    #[tokio::test]
    async fn rtc_validate_over_http2() {
        // stand-in LiveKit /rtc/validate: 401 without a token, 200 with one
        let lk = serve(Router::new().route(
            "/rtc/validate",
            any(|r: Request| async move { if r.uri().query().unwrap_or("").contains("access_token=") { (StatusCode::OK, "ok") } else { (StatusCode::UNAUTHORIZED, "no token") } }),
        ))
        .await;
        let px = proxy(lk).await;
        // phones negotiate h2; prior-knowledge h2c reaches the same code path
        let client = hyper_util::client::legacy::Client::builder(hyper_util::rt::TokioExecutor::new()).http2_only(true).build_http::<axum::body::Body>();
        let get = |q: &'static str| {
            let c = client.clone();
            async move {
                let r = c.request(axum::http::Request::get(format!("http://127.0.0.1:{px}/rtc/rtc/validate{q}")).body(axum::body::Body::empty()).unwrap()).await.unwrap();
                assert_eq!(r.version(), axum::http::Version::HTTP_2);
                let st = r.status();
                (st, String::from_utf8(r.into_body().collect().await.unwrap().to_bytes().to_vec()).unwrap())
            }
        };
        assert_eq!(get("?access_token=x").await, (StatusCode::OK, "ok".into()));
        assert_eq!(get("").await.0, StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn rtc_ws_token_in_authorization_header() {
        // stand-in LiveKit signalling: accepts only `Authorization: Bearer good`, then echoes
        let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let lk = l.local_addr().unwrap().port();
        tokio::spawn(async move {
            while let Ok((tcp, _)) = l.accept().await {
                tokio::spawn(async move {
                    let check = |req: &WsReq, res: WsRes| -> Result<WsRes, ErrorResponse> {
                        if req.headers().get("authorization").and_then(|v| v.to_str().ok()) == Some("Bearer good") {
                            Ok(res)
                        } else {
                            let mut e = ErrorResponse::new(Some("unauthorized".into()));
                            *e.status_mut() = StatusCode::UNAUTHORIZED;
                            Err(e)
                        }
                    };
                    if let Ok(mut ws) = tokio_tungstenite::accept_hdr_async(tcp, check).await {
                        while let Some(Ok(m)) = ws.next().await {
                            if m.is_text() && ws.send(m).await.is_err() {
                                break;
                            }
                        }
                    }
                });
            }
        });
        let px = proxy(lk).await;
        let url = format!("ws://127.0.0.1:{px}/rtc/rtc?auto_subscribe=1&protocol=15");

        let mut req = url.as_str().into_client_request().unwrap();
        req.headers_mut().insert("authorization", "Bearer good".parse().unwrap());
        let (mut ws, _) = tokio_tungstenite::connect_async(req).await.expect("header-only token must reach LiveKit");
        ws.send(Message::text("ping")).await.unwrap();
        assert_eq!(ws.next().await.unwrap().unwrap().into_text().unwrap().as_str(), "ping");

        match tokio_tungstenite::connect_async(url.as_str()).await {
            Err(tokio_tungstenite::tungstenite::Error::Http(r)) => assert_eq!(r.status(), StatusCode::UNAUTHORIZED),
            other => panic!("expected 401 without a token, got {:?}", other.map(|_| ())),
        }
    }
}

