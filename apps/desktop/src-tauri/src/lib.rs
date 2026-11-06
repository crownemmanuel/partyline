//! PartyLine desktop: Tauri shell around the host core. The bundled page is the Home screen
//! (Host / Join); either role moves the webview to a loopback URL that serves the web client.
pub mod config;
pub mod db;
pub mod host;
pub mod http;
pub mod livekit_admin;
pub mod livekit_sidecar;
pub mod mdns;
pub mod model;
pub mod proxy;
pub mod rate_limit;
pub mod state;
pub mod tls;
pub mod updater;
pub mod ws;

use host::{Host, HostOptions};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tauri::{Manager, RunEvent, WebviewWindow};

const JOIN_PROXY_PORT: u16 = 8441;

#[derive(Serialize, Deserialize, Default, Clone)]
#[serde(rename_all = "camelCase")]
struct Prefs {
    role: String, // "host" | "join" | ""
    join_address: Option<String>,
    join_fingerprint: Option<String>,
}

struct Ctl {
    host: tokio::sync::Mutex<Option<Arc<Host>>>,
    proxy: tokio::sync::Mutex<Option<proxy::JoinProxy>>,
    browser: Option<mdns::Browser>,
    home_url: Mutex<Option<tauri::Url>>,
    prefs_path: PathBuf,
}

impl Ctl {
    fn prefs(&self) -> Prefs {
        std::fs::read_to_string(&self.prefs_path).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default()
    }
    fn save_prefs(&self, p: &Prefs) {
        if let Some(d) = self.prefs_path.parent() {
            let _ = std::fs::create_dir_all(d);
        }
        let _ = std::fs::write(&self.prefs_path, serde_json::to_string_pretty(p).unwrap());
    }
}

async fn do_host_start(ctl: &Ctl) -> Result<String, String> {
    if let Some(p) = ctl.proxy.lock().await.take() {
        p.stop();
    }
    let mut h = ctl.host.lock().await;
    if h.is_none() {
        *h = Some(Host::start(HostOptions::from_env()).await.map_err(|e| format!("{e:#}"))?);
    }
    let mut p = ctl.prefs();
    p.role = "host".into();
    ctl.save_prefs(&p);
    Ok(h.as_ref().unwrap().loopback_url())
}

async fn do_join(ctl: &Ctl, address: &str, fingerprint: &str) -> Result<String, String> {
    if let Some(old) = ctl.proxy.lock().await.take() {
        old.stop();
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    let p = proxy::start(address, fingerprint, JOIN_PROXY_PORT).await.map_err(|e| format!("{e:#}"))?;
    let url = p.url.clone();
    let mut prefs = ctl.prefs();
    prefs.role = "join".into();
    prefs.join_address = Some(p.address.clone());
    prefs.join_fingerprint = Some(p.fingerprint.clone());
    ctl.save_prefs(&prefs);
    *ctl.proxy.lock().await = Some(p);
    Ok(url)
}

fn go_home_window(ctl: &Ctl, w: &WebviewWindow) {
    if let Some(u) = ctl.home_url.lock().unwrap().clone() {
        let _ = w.navigate(u);
    }
}

#[tauri::command]
async fn host_start(ctl: tauri::State<'_, Ctl>) -> Result<serde_json::Value, String> {
    Ok(json!({ "url": do_host_start(&ctl).await? }))
}

#[tauri::command]
async fn host_stop(ctl: tauri::State<'_, Ctl>, window: WebviewWindow) -> Result<(), String> {
    if let Some(h) = ctl.host.lock().await.take() {
        h.stop().await;
    }
    let mut p = ctl.prefs();
    p.role = String::new();
    ctl.save_prefs(&p);
    go_home_window(&ctl, &window);
    Ok(())
}

#[tauri::command]
async fn discover(ctl: tauri::State<'_, Ctl>) -> Result<Vec<mdns::Found>, String> {
    let own = match ctl.host.lock().await.as_ref() {
        Some(h) => Some(h.core.lock().server.id.clone()),
        None => None,
    };
    Ok(ctl.browser.as_ref().map(|b| b.list()).unwrap_or_default().into_iter().filter(|f| Some(&f.id) != own.as_ref()).collect())
}

#[tauri::command]
async fn probe_server(address: String) -> Result<proxy::Probe, String> {
    proxy::probe(&address).await.map_err(|e| format!("{e:#}"))
}

#[tauri::command]
async fn join_remote(ctl: tauri::State<'_, Ctl>, address: String, fingerprint: String) -> Result<serde_json::Value, String> {
    Ok(json!({ "url": do_join(&ctl, &address, &fingerprint).await? }))
}

#[tauri::command]
async fn go_home(ctl: tauri::State<'_, Ctl>, window: WebviewWindow) -> Result<(), String> {
    if let Some(p) = ctl.proxy.lock().await.take() {
        p.stop();
    }
    if ctl.host.lock().await.is_none() {
        let mut p = ctl.prefs();
        p.role = String::new();
        ctl.save_prefs(&p);
        go_home_window(&ctl, &window);
    } else {
        // host keeps running; just reload its console
        let _ = window.eval("location.reload()");
    }
    Ok(())
}

#[tauri::command]
async fn get_local_info(ctl: tauri::State<'_, Ctl>) -> Result<serde_json::Value, String> {
    if let Some(h) = ctl.host.lock().await.as_ref() {
        return Ok(json!({
            "role": "host", "lanUrls": h.lan_urls(), "livekit": *h.sidecar_status.lock().unwrap(),
            "mdns": h.mdns_on(), "dataDir": h.opts.data_dir,
        }));
    }
    let role = if ctl.proxy.lock().await.is_some() { "join" } else { "none" };
    Ok(json!({ "role": role, "lanUrls": [], "livekit": { "running": false, "restarts": 0, "lastError": null }, "mdns": false, "dataDir": "" }))
}

#[tauri::command]
fn update_status(updates: tauri::State<'_, updater::Updates>) -> updater::Status {
    updates.0.lock().unwrap().clone()
}

#[tauri::command]
async fn update_check(app: tauri::AppHandle) -> Result<updater::Status, String> {
    Ok(updater::check(&app).await)
}

/// Download and install the update the operator saw, then restart (everyone reconnects after).
#[tauri::command]
async fn update_install(app: tauri::AppHandle, version: String) -> Result<(), String> {
    let ctl = app.state::<Ctl>();
    updater::install(&app, &version, stop_roles(&ctl)).await
}

/// Stop hosting / the join proxy before an update replaces the app (and the LiveKit sidecar).
async fn stop_roles(ctl: &Ctl) {
    if let Some(p) = ctl.proxy.lock().await.take() {
        p.stop();
    }
    if let Some(h) = ctl.host.lock().await.take() {
        h.stop().await;
    }
}

pub fn run() {
    tracing_subscriber::fmt().with_env_filter(tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info,partyline_lib=debug".into())).init();
    let app = tauri::Builder::default()
        // Checked and installed from Rust only (updater.rs); no webview gets the plugin's commands.
        .plugin(tauri_plugin_updater::Builder::new().build())
        // Native dialogs for PartyLine → Check for Updates… (Rust only, no webview permissions)
        .plugin(tauri_plugin_dialog::init())
        .manage(updater::Updates::default())
        .on_menu_event(|app, e| {
            if e.id() == updater::MENU_CHECK {
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    let ctl = app.state::<Ctl>();
                    let hosting = ctl.host.lock().await.is_some();
                    updater::check_from_menu(&app, hosting, stop_roles(&ctl)).await;
                });
            }
        })
        .setup(|app| {
            #[cfg(target_os = "macos")]
            app.set_menu(updater::app_menu(app.handle())?)?;
            let prefs_path = app.path().app_config_dir().unwrap_or_else(|_| std::env::temp_dir()).join("prefs.json");
            let ctl = Ctl {
                host: Default::default(),
                proxy: Default::default(),
                browser: mdns::Browser::start().map_err(|e| tracing::warn!("mDNS browse: {e}")).ok(),
                home_url: Mutex::new(None),
                prefs_path,
            };
            let window = app.get_webview_window("main").expect("main window");
            *ctl.home_url.lock().unwrap() = window.url().ok();
            let prefs = ctl.prefs();
            app.manage(ctl);
            updater::start_checks(app.handle().clone());
            // relaunch resumes the last role (acceptance 6: same host, browsers reconnect)
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let ctl = handle.state::<Ctl>();
                let url = match prefs.role.as_str() {
                    "host" => do_host_start(&ctl).await,
                    "join" => match (&prefs.join_address, &prefs.join_fingerprint) {
                        (Some(a), Some(f)) => do_join(&ctl, a, f).await,
                        _ => return,
                    },
                    _ => return,
                };
                match url.and_then(|u| u.parse::<tauri::Url>().map_err(|e| e.to_string())) {
                    Ok(u) => {
                        let _ = window.navigate(u);
                    }
                    Err(e) => tracing::error!("resume {}: {e}", prefs.role),
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![host_start, host_stop, discover, probe_server, join_remote, go_home, get_local_info, update_status, update_check, update_install])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|handle, event| {
        if let RunEvent::Exit = event {
            let ctl = handle.state::<Ctl>();
            tauri::async_runtime::block_on(async {
                if let Some(p) = ctl.proxy.lock().await.take() {
                    p.stop();
                }
                if let Some(h) = ctl.host.lock().await.take() {
                    h.stop().await;
                }
            });
        }
    });
}
