//! App updates from the GitHub releases (docs/RELEASES.md).
//!
//! The background check only records that a newer version exists; downloading, installing and
//! restarting happen when the operator presses Update (`update_install`). The check and install
//! run here in Rust, so no webview (the join-mode proxy serves another host's page) gets the
//! updater plugin's own commands.
use serde::Serialize;
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_updater::UpdaterExt;

#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct Available {
    pub version: String,
    pub notes: Option<String>,
    pub date: Option<String>,
}

#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub current: String,
    pub available: Option<Available>,
    pub checked_at: Option<i64>,
    pub error: Option<String>,
    pub installing: bool,
    /// Development builds check but never install: update them from git.
    pub dev: bool,
}

#[derive(Default)]
pub struct Updates(pub Mutex<Status>);

fn message(e: impl std::fmt::Display) -> String {
    let t = e.to_string();
    // No release published yet, or the repository is unreachable.
    if t.contains("valid release JSON") || t.contains("404") {
        "No published release found on GitHub yet.".into()
    } else {
        t
    }
}

pub async fn check<R: Runtime>(app: &AppHandle<R>) -> Status {
    let result = match app.updater() {
        Ok(u) => u.check().await.map_err(message),
        Err(e) => Err(message(e)),
    };
    let state = app.state::<Updates>();
    let mut s = state.0.lock().unwrap();
    s.current = app.package_info().version.to_string();
    s.dev = cfg!(debug_assertions);
    s.checked_at = Some(chrono::Utc::now().timestamp_millis());
    match result {
        Ok(u) => {
            s.available = u.map(|u| Available { version: u.version, notes: u.body.filter(|b| !b.trim().is_empty()), date: u.date.map(|d| d.to_string()) });
            s.error = None;
        }
        Err(e) => s.error = Some(e),
    }
    s.clone()
}

/// Look for a new version shortly after start, then every six hours. Installs nothing.
pub fn start_checks<R: Runtime>(app: AppHandle<R>) {
    if cfg!(debug_assertions) {
        return;
    }
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(20)).await;
        loop {
            let s = check(&app).await;
            if let Some(a) = &s.available {
                tracing::info!("update available: {} -> {}", s.current, a.version);
            }
            tokio::time::sleep(Duration::from_secs(6 * 3600)).await;
        }
    });
}

/// Download and install `version` (the one the operator saw), then restart into it.
/// `before_install` stops the host/proxy so the sidecar is not running while files are replaced.
pub async fn install<R: Runtime, F: std::future::Future<Output = ()>>(app: &AppHandle<R>, version: &str, before_install: F) -> Result<(), String> {
    if cfg!(debug_assertions) {
        return Err("This is a development build: update it from git. Installed copies update here.".into());
    }
    let update = app.updater().map_err(message)?.check().await.map_err(message)?.ok_or("PartyLine is up to date.")?;
    if update.version != version {
        return Err(format!("The available update is {}, not {version}. Check again.", update.version));
    }
    app.state::<Updates>().0.lock().unwrap().installing = true;
    let bytes = update.download(|_, _| {}, || {}).await.map_err(|e| {
        app.state::<Updates>().0.lock().unwrap().installing = false;
        message(e)
    })?;
    before_install.await;
    // On Windows the installer closes the app and starts the new version itself. If installing
    // fails the host is already stopped, so restart anyway: the old version resumes its role.
    if let Err(e) = update.install(bytes) {
        tracing::error!("installing update {version}: {}", message(e));
    }
    app.restart();
}
