//! In-memory world (persisted rows + live state + WS sessions) and broadcast. One std Mutex
//! guards it all: at 3–30 devices every operation is microseconds. Anything async (LiveKit
//! calls, delayed upserts) is returned as an `Effect` and run after the lock is released.
use crate::db::Db;
use crate::livekit_admin::LiveKitAdmin;
use crate::model::*;
use crate::rate_limit::RateLimiter;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};
use tokio::sync::mpsc;

pub enum Out {
    Text(String),
    Close(u16, String),
}

pub struct Session {
    pub conn: u64,
    pub tx: mpsc::UnboundedSender<Out>,
}

pub enum Effect {
    Mute(String),
    Remove(String),
    UpdateMeta(DeviceRow),
    DelayedUpsert(String, Duration),
    Readvertise,
}

pub struct ServerRow {
    pub id: String,
    pub name: String,
    pub join_code: String,
    pub join_open: bool,
}

pub struct World {
    pub db: Db,
    pub server: ServerRow,
    pub settings: Settings,
    pub groups: Vec<Group>,
    pub devices: HashMap<String, DeviceRow>,
    pub live: HashMap<String, Live>,
    pub messages: Vec<Message>,
    pub sessions: HashMap<String, Session>,
    pub rate: RateLimiter,
    pub fingerprint: String,
    upserts: HashMap<String, (Instant, bool)>,
    pub effects: Vec<Effect>,
}

pub struct Core {
    world: Mutex<World>,
    pub lk: LiveKitAdmin,
}

pub type Err = (&'static str, String);
pub fn err(code: &'static str, msg: impl Into<String>) -> Err {
    (code, msg.into())
}

pub fn sha256_hex(s: &str) -> String {
    hex::encode(Sha256::digest(s.as_bytes()))
}
pub fn random_token() -> String {
    use base64::Engine;
    let b: [u8; 32] = rand::random();
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(b)
}
pub fn new_join_code() -> String {
    use rand::Rng;
    format!("{:06}", rand::thread_rng().gen_range(0..1_000_000))
}
pub fn envelope(kind: &str, payload: Value) -> String {
    json!({ "type": kind, "ts": now_iso(), "payload": payload }).to_string()
}

impl Core {
    pub fn new(world: World, lk: LiveKitAdmin) -> Arc<Core> {
        Arc::new(Core { world: Mutex::new(world), lk })
    }
    pub fn lock(&self) -> MutexGuard<'_, World> {
        self.world.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// Run with the world locked, then perform the effects it queued.
    pub fn with<R>(self: &Arc<Self>, f: impl FnOnce(&mut World) -> R) -> R {
        let (r, effects) = {
            let mut w = self.lock();
            let r = f(&mut w);
            (r, std::mem::take(&mut w.effects))
        };
        self.run(effects);
        r
    }

    pub fn run(self: &Arc<Self>, effects: Vec<Effect>) {
        for e in effects {
            let core = self.clone();
            match e {
                Effect::Mute(id) => {
                    tokio::spawn(async move { core.lk.mute(&id).await });
                }
                Effect::Remove(id) => {
                    tokio::spawn(async move { core.lk.remove(&id).await });
                }
                Effect::UpdateMeta(d) => {
                    tokio::spawn(async move { core.lk.update_metadata(&d).await });
                }
                Effect::DelayedUpsert(id, after) => {
                    tokio::spawn(async move {
                        tokio::time::sleep(after).await;
                        core.with(|w| w.flush_upsert(&id));
                    });
                }
                Effect::Readvertise => {
                    if let Some(cb) = READVERTISE.lock().unwrap().as_ref() {
                        cb();
                    }
                }
            }
        }
    }
}

/// Set by the host so a server rename re-registers mDNS.
pub static READVERTISE: Mutex<Option<Box<dyn Fn() + Send>>> = Mutex::new(None);

impl World {
    pub fn new(db: Db, server: ServerRow, settings: Settings, fingerprint: String) -> anyhow::Result<World> {
        let groups = db.groups()?;
        let devices = db.devices()?.into_iter().map(|d| (d.id.clone(), d)).collect();
        let messages = db.recent_messages(2000)?;
        Ok(World {
            db,
            server,
            settings,
            groups,
            devices,
            live: HashMap::new(),
            messages,
            sessions: HashMap::new(),
            rate: RateLimiter::default(),
            fingerprint,
            upserts: HashMap::new(),
            effects: vec![],
        })
    }

    // ---------------------------------------------------------------- lookups

    pub fn group(&self, id: &str) -> Option<&Group> {
        self.groups.iter().find(|g| g.id == id)
    }
    pub fn sorted_groups(&self) -> Vec<Group> {
        let mut g = self.groups.clone();
        g.sort_by_key(|g| g.sort_order);
        g
    }
    pub fn active_devices(&self) -> impl Iterator<Item = &DeviceRow> {
        self.devices.values().filter(|d| !d.revoked)
    }
    pub fn device_by_token(&self, token: &str) -> Option<&DeviceRow> {
        let h = sha256_hex(token);
        self.devices.values().find(|d| d.token_hash.as_deref() == Some(h.as_str()))
    }
    pub fn is_admin(&self, id: &str) -> bool {
        self.devices.get(id).map_or(false, |d| d.is_admin && !d.revoked)
    }

    pub fn default_talk_mode(&self, d: &DeviceRow) -> String {
        if let Some(m) = &d.forced_talk_mode {
            return m.clone();
        }
        if let Some(m) = self.group(&d.group_id).and_then(|g| g.default_talk_mode.clone()) {
            return m;
        }
        if d.is_admin {
            "latch".into()
        } else {
            self.settings.default_talk_mode.clone()
        }
    }

    pub fn live_mut(&mut self, id: &str) -> &mut Live {
        if !self.live.contains_key(id) {
            let d = &self.devices[id];
            let l = Live {
                online: false,
                rtc_connected: false,
                mic_live: false,
                speaker_muted: false,
                talk_mode: self.default_talk_mode(d),
                talk_targets: vec![format!("g:{}", d.group_id)],
                speaking: false,
                battery: None,
                charging: None,
                headset: None,
                output_route: None,
                rtt_ms: None,
            };
            self.live.insert(id.to_string(), l);
        }
        let forced = self.devices.get(id).and_then(|d| d.forced_talk_mode.clone());
        let l = self.live.get_mut(id).unwrap();
        if let Some(f) = forced {
            l.talk_mode = f;
        }
        l
    }

    pub fn view(&mut self, id: &str) -> Option<DeviceView> {
        if !self.devices.contains_key(id) {
            return None;
        }
        let live = self.live_mut(id).clone();
        let d = &self.devices[id];
        Some(DeviceView {
            id: d.id.clone(),
            display_name: d.display_name.clone(),
            platform: d.platform.clone(),
            app_version: d.app_version.clone(),
            group_id: d.group_id.clone(),
            listen_group_ids: d.listen_group_ids.clone(),
            can_talk_group_ids: d.can_talk_group_ids.clone(),
            is_admin: d.is_admin,
            forced_talk_mode: d.forced_talk_mode.clone(),
            admin_muted: d.admin_muted,
            created_at: d.created_at.clone(),
            last_seen_at: d.last_seen_at.clone(),
            live,
        })
    }
    pub fn all_views(&mut self) -> Vec<DeviceView> {
        let ids: Vec<String> = self.active_devices().map(|d| d.id.clone()).collect();
        ids.iter().filter_map(|id| self.view(id)).collect()
    }

    pub fn server_info(&self, for_admin: bool) -> ServerInfo {
        let failed = if for_admin { self.db.failed_attempts_since(chrono::Utc::now().timestamp() - 3600).unwrap_or(0) } else { 0 };
        ServerInfo {
            server_id: self.server.id.clone(),
            name: self.server.name.clone(),
            app_version: APP_VERSION.into(),
            api_version: API_VERSION,
            join_code: for_admin.then(|| self.server.join_code.clone()),
            join_open: self.server.join_open,
            fingerprint: self.fingerprint.clone(),
            failed_join_attempts: failed,
        }
    }

    pub fn save_device(&mut self, id: &str) {
        if let Some(d) = self.devices.get(id) {
            if let Err(e) = self.db.save_device(d) {
                tracing::error!("db save device: {e}");
            }
        }
    }
    pub fn save_server(&self) {
        let s = &self.server;
        for (k, v) in [("name", s.name.clone()), ("join_code", s.join_code.clone()), ("join_open", s.join_open.to_string())] {
            let _ = self.db.kv_set(k, &v);
        }
        let _ = self.db.kv_set("settings", &serde_json::to_string(&self.settings).unwrap());
    }

    // ---------------------------------------------------------------- routing rules (PROTOCOL §4)

    pub fn talkable_groups(&self, d: &DeviceRow) -> Vec<String> {
        if d.is_admin {
            self.groups.iter().map(|g| g.id.clone()).collect()
        } else {
            d.can_talk_group_ids.iter().filter(|g| self.group(g).is_some()).cloned().collect()
        }
    }
    pub fn listenable_groups(&self, d: &DeviceRow) -> Vec<String> {
        if d.is_admin {
            self.groups.iter().map(|g| g.id.clone()).collect()
        } else {
            let mut v = vec![d.group_id.clone()];
            for g in &d.can_talk_group_ids {
                if !v.contains(g) {
                    v.push(g.clone());
                }
            }
            v
        }
    }

    pub fn validate_targets(&self, d: &DeviceRow, targets: &[String]) -> Result<Vec<String>, Err> {
        let talkable = self.talkable_groups(d);
        let mut out: Vec<String> = vec![];
        let mut add = |t: String| {
            if !out.contains(&t) {
                out.push(t)
            }
        };
        for t in targets {
            if t == "all" {
                talkable.iter().for_each(|g| add(format!("g:{g}")));
            } else if let Some(g) = t.strip_prefix("g:") {
                if self.group(g).is_none() {
                    return Err(err("not_found", format!("no group {g}")));
                }
                if !talkable.iter().any(|x| x == g) {
                    return Err(err("bad_request", format!("talkTargets: not allowed to talk to {t}")));
                }
                add(t.clone());
            } else if let Some(id) = t.strip_prefix("d:") {
                let Some(target) = self.devices.get(id).filter(|x| !x.revoked) else { return Err(err("not_found", format!("no device {t}"))) };
                if !(d.is_admin || target.is_admin || talkable.contains(&target.group_id)) {
                    return Err(err("bad_request", format!("talkTargets: not allowed to talk to {t}")));
                }
                add(t.clone());
            } else {
                return Err(err("bad_request", format!("bad target {t}")));
            }
        }
        Ok(out)
    }

    pub fn visible_to(m: &Message, d: &DeviceRow) -> bool {
        if d.is_admin || m.from == d.id || m.to == "all" || m.to == format!("d:{}", d.id) {
            return true;
        }
        if let Some(g) = m.to.strip_prefix("g:") {
            return g == d.group_id || d.listen_group_ids.iter().any(|x| x == g);
        }
        false
    }
    pub fn message_view(m: &Message, for_admin: bool) -> Value {
        let mut v = serde_json::to_value(m).unwrap();
        if !for_admin {
            v.as_object_mut().unwrap().remove("ackedBy");
        }
        v
    }
    pub fn can_address(&self, d: &DeviceRow, to: &str) -> bool {
        if to == "all" {
            return d.is_admin || self.settings.crew_can_broadcast;
        }
        if d.is_admin {
            if let Some(g) = to.strip_prefix("g:") {
                return self.group(g).is_some();
            }
            return to.strip_prefix("d:").map_or(false, |id| self.devices.contains_key(id));
        }
        if let Some(g) = to.strip_prefix("g:") {
            return self.listenable_groups(d).iter().any(|x| x == g);
        }
        to.strip_prefix("d:").map_or(false, |id| self.devices.get(id).map_or(false, |x| x.is_admin))
    }
    pub fn recipients(&self, to: &str) -> Vec<String> {
        self.active_devices()
            .filter(|d| {
                to == "all"
                    || to == format!("d:{}", d.id)
                    || to.strip_prefix("g:").map_or(false, |g| d.group_id == g || d.listen_group_ids.iter().any(|x| x == g))
            })
            .map(|d| d.id.clone())
            .collect()
    }

    // ---------------------------------------------------------------- sending

    pub fn send_to(&self, id: &str, kind: &str, payload: Value) {
        if let Some(s) = self.sessions.get(id) {
            let _ = s.tx.send(Out::Text(envelope(kind, payload)));
        }
    }
    pub fn broadcast(&self, kind: &str, payload: Value) {
        let text = envelope(kind, payload);
        for s in self.sessions.values() {
            let _ = s.tx.send(Out::Text(text.clone()));
        }
    }
    pub fn broadcast_admins(&self, kind: &str, payload: Value) {
        for (id, s) in &self.sessions {
            if self.is_admin(id) {
                let _ = s.tx.send(Out::Text(envelope(kind, payload.clone())));
            }
        }
    }
    pub fn broadcast_server(&self) {
        let admin = serde_json::to_value(self.server_info(true)).unwrap();
        let crew = serde_json::to_value(self.server_info(false)).unwrap();
        for (id, s) in &self.sessions {
            let p = if self.is_admin(id) { admin.clone() } else { crew.clone() };
            let _ = s.tx.send(Out::Text(envelope("server.updated", p)));
        }
    }
    pub fn notice(&self, id: &str, kind: &str, text: &str) {
        self.send_to(id, "admin.notice", json!({ "kind": kind, "text": text }));
    }

    /// Coalesced roster push: at most one `device.upsert` per device per 250 ms, unless
    /// `immediate` (micLive, targets, admin changes).
    pub fn upsert(&mut self, id: &str, immediate: bool) {
        let now = Instant::now();
        let (last, pending) = self.upserts.get(id).copied().unwrap_or((now - Duration::from_secs(1), false));
        let since = now.duration_since(last);
        if immediate || since >= Duration::from_millis(250) {
            self.flush_upsert(id);
        } else if !pending {
            self.upserts.insert(id.to_string(), (last, true));
            self.effects.push(Effect::DelayedUpsert(id.to_string(), Duration::from_millis(250) - since));
        }
    }
    pub fn flush_upsert(&mut self, id: &str) {
        self.upserts.insert(id.to_string(), (Instant::now(), false));
        if self.devices.get(id).map_or(false, |d| !d.revoked) {
            if let Some(v) = self.view(id) {
                self.broadcast("device.upsert", serde_json::to_value(v).unwrap());
            }
        }
    }

    pub fn deliver_message(&mut self, m: Message) {
        if let Err(e) = self.db.insert_message(&m) {
            tracing::error!("db insert message: {e}");
        }
        for (id, s) in &self.sessions {
            if let Some(d) = self.devices.get(id) {
                if Self::visible_to(&m, d) {
                    let _ = s.tx.send(Out::Text(envelope("message", Self::message_view(&m, d.is_admin))));
                }
            }
        }
        self.messages.push(m);
        if self.messages.len() > 2500 {
            self.messages.drain(..500);
            let _ = self.db.prune_messages(20_000);
        }
    }

    pub fn welcome(&mut self, id: &str, livekit_token: String) -> Value {
        let me = self.view(id).unwrap();
        let d = self.devices[id].clone();
        let msgs: Vec<Value> = {
            let vis: Vec<&Message> = self.messages.iter().filter(|m| Self::visible_to(m, &d)).collect();
            vis[vis.len().saturating_sub(50)..].iter().map(|m| Self::message_view(m, d.is_admin)).collect()
        };
        json!({
            "me": me, "devices": self.all_views(), "groups": self.sorted_groups(),
            "server": self.server_info(d.is_admin), "settings": self.settings,
            "livekitToken": livekit_token, "roomName": ROOM, "messages": msgs,
        })
    }
}
