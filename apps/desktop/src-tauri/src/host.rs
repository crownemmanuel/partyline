//! Host role: SQLite + control server (HTTPS LAN + HTTP loopback) + LiveKit sidecar + mDNS,
//! with the IP-change watcher. Used by the Tauri app and by the headless `partyline-host`.
use crate::config;
use crate::db::Db;
use crate::http::{self, AppState, Listener};
use crate::livekit_admin::LiveKitAdmin;
use crate::livekit_sidecar::{find_binary, Sidecar, SidecarConfig, SidecarStatus};
use crate::mdns::Advert;
use crate::state::*;
use crate::tls;
use anyhow::{Context, Result};
use axum::Extension;
use axum_server::tls_rustls::RustlsConfig;
use serde_json::json;
use std::net::{Ipv4Addr, SocketAddr};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

#[derive(Clone, Debug)]
pub struct HostOptions {
    pub data_dir: PathBuf,
    pub https_port: u16,
    pub loopback_port: u16,
    pub livekit_port: u16,
    pub livekit_tcp_port: u16,
    pub udp_start: u16,
    pub udp_end: u16,
    pub livekit_bin: PathBuf,
    pub mdns: bool,
    /// Android app served at /download/partyline.apk (bundled with the desktop app)
    pub apk_path: Option<PathBuf>,
}

impl HostOptions {
    /// Defaults from DESKTOP.md / ARCHITECTURE §5.4; env overrides for testing side by side.
    pub fn from_env() -> HostOptions {
        let n = |k: &str, d: u16| std::env::var(k).ok().and_then(|v| v.parse().ok()).unwrap_or(d);
        HostOptions {
            data_dir: config::default_data_dir(),
            https_port: n("PARTYLINE_PORT", 8443),
            loopback_port: n("PARTYLINE_LOOPBACK_PORT", 8442),
            livekit_port: n("PARTYLINE_LIVEKIT_PORT", 7880),
            livekit_tcp_port: n("PARTYLINE_LIVEKIT_TCP_PORT", 7881),
            udp_start: n("PARTYLINE_UDP_START", 50000),
            udp_end: n("PARTYLINE_UDP_END", 50200),
            livekit_bin: find_binary(),
            mdns: std::env::var("PARTYLINE_NO_MDNS").is_err(),
            apk_path: find_apk(),
        }
    }
}

/// The bundled Android APK: $PARTYLINE_APK, else the app's resources (macOS
/// Contents/Resources/resources/, Windows/Linux next to the exe), else the dev tree.
pub fn find_apk() -> Option<PathBuf> {
    if let Some(p) = std::env::var_os("PARTYLINE_APK").map(PathBuf::from) {
        return p.is_file().then_some(p);
    }
    let exe_dir = std::env::current_exe().ok()?.parent()?.to_path_buf();
    [
        exe_dir.join("../Resources/resources/partyline.apk"),
        exe_dir.join("resources/partyline.apk"),
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/partyline.apk"),
    ]
    .into_iter()
    .find(|p| p.is_file())
}

pub struct Host {
    pub core: Arc<Core>,
    pub opts: HostOptions,
    sidecar: tokio::sync::Mutex<Option<Sidecar>>,
    pub sidecar_status: Arc<Mutex<SidecarStatus>>,
    advert: Arc<Mutex<Option<Advert>>>,
    lan: Arc<Mutex<Vec<Ipv4Addr>>>,
    tls_handle: axum_server::Handle<SocketAddr>,
    stop_tx: tokio::sync::watch::Sender<bool>,
}

pub fn install_crypto() {
    let _ = rustls::crypto::ring::default_provider().install_default();
}

impl Host {
    pub async fn start(opts: HostOptions) -> Result<Arc<Host>> {
        install_crypto();
        std::fs::create_dir_all(&opts.data_dir).with_context(|| format!("create {}", opts.data_dir.display()))?;
        let db = Db::open(&opts.data_dir.join("partyline.db"))?;
        let loaded = config::load_or_init(&db)?;
        let lan = tls::lan_ipv4s();
        let mut cert = tls::load_or_create(&opts.data_dir, None)?;
        if let Some(ip) = lan.first() {
            if !cert.sans.contains(&ip.to_string()) {
                tracing::warn!("LAN IP {ip} not in certificate; regenerating (fingerprint changes)");
                cert = tls::load_or_create(&opts.data_dir, Some(tls::wanted_sans()))?;
            }
        }
        let fp = cert.fingerprint.clone();
        let world = World::new(db, loaded.server, loaded.settings, fp.clone())?;
        let lk = LiveKitAdmin::new(loaded.livekit_key.clone(), loaded.livekit_secret.clone(), opts.livekit_port);
        let core = Core::new(world, lk);

        // listeners first, so a busy port is reported instead of half-starting
        let lan_listener = std::net::TcpListener::bind(("0.0.0.0", opts.https_port)).with_context(|| format!("port {} is in use (another PartyLine host?)", opts.https_port))?;
        lan_listener.set_nonblocking(true)?;
        let lo_listener = tokio::net::TcpListener::bind(("127.0.0.1", opts.loopback_port)).await.with_context(|| format!("port {} is in use", opts.loopback_port))?;

        let sidecar = Sidecar::start(
            SidecarConfig {
                bin: opts.livekit_bin.clone(),
                data_dir: opts.data_dir.clone(),
                port: opts.livekit_port,
                tcp_port: opts.livekit_tcp_port,
                udp_start: opts.udp_start,
                udp_end: opts.udp_end,
                api_key: loaded.livekit_key,
                api_secret: loaded.livekit_secret,
            },
            lan.first().map(|i| i.to_string()).unwrap_or_else(|| "127.0.0.1".into()),
        );
        let sidecar_status = sidecar.status.clone();

        let lan_shared = Arc::new(Mutex::new(lan.clone()));
        let app = http::router(AppState { core: core.clone(), livekit_port: opts.livekit_port, lan: lan_shared.clone(), https_port: opts.https_port, apk: opts.apk_path.clone().map(Arc::new) });
        let tls_cfg = RustlsConfig::from_pem(cert.cert_pem.clone().into_bytes(), cert.key_pem.clone().into_bytes()).await?;
        let tls_handle: axum_server::Handle<SocketAddr> = axum_server::Handle::new();
        {
            let app = app.clone().layer(Extension(Listener::Lan));
            let h = tls_handle.clone();
            let cfg = tls_cfg.clone();
            tokio::spawn(async move {
                if let Err(e) = axum_server::from_tcp_rustls(lan_listener, cfg).expect("tls listener").handle(h).serve(app.into_make_service_with_connect_info::<SocketAddr>()).await {
                    tracing::error!("https server: {e}");
                }
            });
        }
        let (stop_tx, mut stop_rx) = tokio::sync::watch::channel(false);
        {
            let app = app.layer(Extension(Listener::Loopback));
            let mut rx = stop_rx.clone();
            tokio::spawn(async move {
                let _ = axum::serve(lo_listener, app.into_make_service_with_connect_info::<SocketAddr>())
                    .with_graceful_shutdown(async move {
                        let _ = rx.changed().await;
                    })
                    .await;
            });
        }

        let host = Arc::new(Host {
            core: core.clone(),
            opts: opts.clone(),
            sidecar: tokio::sync::Mutex::new(Some(sidecar)),
            sidecar_status,
            advert: Arc::new(Mutex::new(None)),
            lan: lan_shared,
            tls_handle,
            stop_tx,
        });
        if opts.mdns {
            match Advert::new() {
                Ok(a) => *host.advert.lock().unwrap() = Some(a),
                Err(e) => tracing::warn!("mDNS unavailable: {e}"),
            }
            host.advertise();
            let h2 = Arc::downgrade(&host);
            *READVERTISE.lock().unwrap() = Some(Box::new(move || {
                if let Some(h) = h2.upgrade() {
                    h.advertise();
                }
            }));
        }

        // IP-change watcher (DESKTOP.md "IP change")
        {
            let h = Arc::downgrade(&host);
            tokio::spawn(async move {
                loop {
                    tokio::select! {
                        _ = tokio::time::sleep(Duration::from_secs(5)) => {}
                        _ = stop_rx.changed() => return,
                    }
                    let Some(host) = h.upgrade() else { return };
                    host.check_ip(&tls_cfg).await;
                }
            });
        }
        let (code, name) = {
            let w = core.lock();
            (w.server.join_code.clone(), w.server.name.clone())
        };
        tracing::info!("hosting \"{name}\" join code {code} fp {fp} on {:?}", host.lan_urls());
        Ok(host)
    }

    pub fn lan_urls(&self) -> Vec<String> {
        self.lan.lock().unwrap().iter().map(|ip| format!("https://{ip}:{}", self.opts.https_port)).collect()
    }
    pub fn loopback_url(&self) -> String {
        format!("http://127.0.0.1:{}/", self.opts.loopback_port)
    }
    pub fn mdns_on(&self) -> bool {
        self.advert.lock().unwrap().is_some()
    }

    fn advertise(&self) {
        let (id, name, fp) = {
            let w = self.core.lock();
            (w.server.id.clone(), w.server.name.clone(), w.fingerprint.clone())
        };
        let ips = self.lan.lock().unwrap().clone();
        if let Some(a) = self.advert.lock().unwrap().as_mut() {
            if ips.is_empty() {
                a.unregister();
            } else if let Err(e) = a.register(&id, &name, &fp, self.opts.https_port, &ips) {
                tracing::warn!("mDNS register: {e}");
            }
        }
    }

    async fn check_ip(&self, tls_cfg: &RustlsConfig) {
        let now = tls::lan_ipv4s();
        let changed = {
            let mut l = self.lan.lock().unwrap();
            if *l == now {
                false
            } else {
                tracing::info!("LAN addresses changed: {:?} -> {:?}", *l, now);
                *l = now.clone();
                true
            }
        };
        if !changed {
            return;
        }
        if let Some(ip) = now.first() {
            if let Ok(cert) = tls::load_or_create(&self.opts.data_dir, None) {
                if !cert.sans.contains(&ip.to_string()) {
                    // native apps pinned the old fingerprint and will ask to trust again
                    if let Ok(new) = tls::load_or_create(&self.opts.data_dir, Some(tls::wanted_sans())) {
                        let _ = tls_cfg.reload_from_pem(new.cert_pem.into_bytes(), new.key_pem.into_bytes()).await;
                        self.core.with(|w| {
                            w.fingerprint = new.fingerprint.clone();
                            w.broadcast_server();
                        });
                    }
                }
            }
            if let Some(s) = self.sidecar.lock().await.as_ref() {
                s.set_node_ip(ip.to_string());
            }
        }
        self.advertise();
    }

    /// PROTOCOL §3.3 server.shutdown, then stop everything.
    pub async fn stop(&self) {
        self.core.with(|w| {
            w.broadcast("server.shutdown", json!({ "reconnectAfterMs": 3000 }));
        });
        tokio::time::sleep(Duration::from_millis(200)).await;
        self.core.with(|w| {
            for (_, s) in w.sessions.drain() {
                let _ = s.tx.send(Out::Close(1001, "shutdown".into()));
            }
        });
        if let Some(a) = self.advert.lock().unwrap().take() {
            a.shutdown();
        }
        *READVERTISE.lock().unwrap() = None;
        let _ = self.stop_tx.send(true);
        self.tls_handle.graceful_shutdown(Some(Duration::from_millis(500)));
        if let Some(s) = self.sidecar.lock().await.take() {
            s.stop().await;
        }
        tracing::info!("host stopped");
    }
}
