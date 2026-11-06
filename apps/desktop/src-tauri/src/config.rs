//! App data dir and first-run generation: server id, LiveKit key/secret, join code, default
//! groups. Everything persists in SQLite so a relaunch keeps the same code and groups.
use crate::db::Db;
use crate::model::{Group, Settings};
use crate::state::{new_join_code, random_token, ServerRow};
use anyhow::Result;
use std::path::PathBuf;

pub fn default_data_dir() -> PathBuf {
    if let Ok(d) = std::env::var("PARTYLINE_DATA") {
        return d.into();
    }
    dirs::data_dir().unwrap_or_else(std::env::temp_dir).join("app.partyline.desktop").join("host")
}

pub struct Loaded {
    pub server: ServerRow,
    pub settings: Settings,
    pub livekit_key: String,
    pub livekit_secret: String,
}

pub fn load_or_init(db: &Db) -> Result<Loaded> {
    let get_or = |k: &str, make: &dyn Fn() -> String| -> Result<String> {
        if let Some(v) = db.kv_get(k)? {
            return Ok(v);
        }
        let v = make();
        db.kv_set(k, &v)?;
        Ok(v)
    };
    let id = get_or("server_id", &|| uuid::Uuid::new_v4().to_string())?;
    let name = get_or("name", &|| default_server_name())?;
    let join_code = get_or("join_code", &new_join_code)?;
    let join_open = get_or("join_open", &|| "true".into())? == "true";
    let livekit_key = get_or("livekit_key", &|| format!("PL{}", &uuid::Uuid::new_v4().simple().to_string()[..12]))?;
    let livekit_secret = get_or("livekit_secret", &random_token)?;
    let settings: Settings = db.kv_get("settings")?.and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default();
    if db.kv_get("seeded")?.is_none() {
        for (i, (id, name, color, mode)) in [("producer", "Producer", "#e11d48", Some("latch")), ("camera", "Camera", "#2563eb", None), ("backstage", "Backstage", "#16a34a", None)].into_iter().enumerate() {
            db.save_group(&Group { id: id.into(), name: name.into(), color: color.into(), sort_order: i as i64, default_talk_mode: mode.map(str::to_string) })?;
        }
        db.kv_set("settings", &serde_json::to_string(&settings)?)?;
        db.kv_set("seeded", "1")?;
    }
    Ok(Loaded { server: ServerRow { id, name, join_code, join_open }, settings, livekit_key, livekit_secret })
}

fn default_server_name() -> String {
    // macOS: the user-facing computer name ("Emmanuel's MacBook")
    #[cfg(target_os = "macos")]
    if let Ok(o) = std::process::Command::new("scutil").args(["--get", "ComputerName"]).output() {
        let n = String::from_utf8_lossy(&o.stdout).trim().to_string();
        if o.status.success() && !n.is_empty() {
            return n;
        }
    }
    let host = crate::tls::host_name();
    let pretty = host.replace(['-', '_'], " ");
    if pretty.is_empty() {
        "PartyLine".into()
    } else {
        format!("{pretty} PartyLine")
    }
}
