//! Protocol objects (PROTOCOL.md §3.4), serialized camelCase exactly as on the wire.
use serde::{Deserialize, Serialize};

pub const API_VERSION: u32 = 1;
pub const ROOM: &str = "partyline";
pub const APP_VERSION: &str = env!("CARGO_PKG_VERSION");

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Group {
    pub id: String,
    pub name: String,
    pub color: String,
    pub sort_order: i64,
    pub default_talk_mode: Option<String>,
}

/// Persisted device row (+ server-only fields that never go on the wire).
#[derive(Clone, Debug)]
pub struct DeviceRow {
    pub id: String,
    pub display_name: String,
    pub platform: String,
    pub app_version: String,
    pub group_id: String,
    pub listen_group_ids: Vec<String>,
    pub can_talk_group_ids: Vec<String>,
    pub is_admin: bool,
    pub forced_talk_mode: Option<String>,
    pub admin_muted: bool,
    pub created_at: String,
    pub last_seen_at: String,
    pub token_hash: Option<String>,
    pub revoked: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Live {
    pub online: bool,
    pub rtc_connected: bool,
    pub mic_live: bool,
    pub speaker_muted: bool,
    pub talk_mode: String,
    pub talk_targets: Vec<String>,
    pub speaking: bool,
    pub battery: Option<i64>,
    pub charging: Option<bool>,
    pub headset: Option<bool>,
    pub output_route: Option<String>,
    pub rtt_ms: Option<i64>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceView {
    pub id: String,
    pub display_name: String,
    pub platform: String,
    pub app_version: String,
    pub group_id: String,
    pub listen_group_ids: Vec<String>,
    pub can_talk_group_ids: Vec<String>,
    pub is_admin: bool,
    pub forced_talk_mode: Option<String>,
    pub admin_muted: bool,
    pub created_at: String,
    pub last_seen_at: String,
    pub live: Live,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub crew_can_broadcast: bool,
    pub default_talk_mode: String,
    pub quick_replies: Vec<String>,
    #[serde(default)]
    pub admins_hear_everything: bool,
    /// TestFlight (or other https) link shown on the /#install page for iPhones
    #[serde(default)]
    pub ios_install_url: Option<String>,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            crew_can_broadcast: false,
            default_talk_mode: "ptt".into(),
            quick_replies: ["OK", "Standby", "Go", "Problem", "Can't hear"].iter().map(|s| s.to_string()).collect(),
            admins_hear_everything: false,
            ios_install_url: None,
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerInfo {
    pub server_id: String,
    pub name: String,
    pub app_version: String,
    pub api_version: u32,
    pub join_code: Option<String>,
    pub join_open: bool,
    pub fingerprint: String,
    pub failed_join_attempts: i64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Message {
    pub id: String,
    pub from: String,
    pub to: String,
    pub kind: String,
    pub text: String,
    pub ts: String,
    #[serde(default)]
    pub acked_by: Vec<String>,
}

pub fn now_iso() -> String {
    chrono::Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string()
}
