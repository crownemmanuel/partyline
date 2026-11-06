//! `/api/ws` sessions (PROTOCOL §3): auth within 5 s, dispatch + validation (§4), ack/error,
//! ping/pong, token refresh 5 min before expiry.
use crate::livekit_admin::TOKEN_TTL_SECS;
use crate::model::*;
use crate::state::*;
use axum::extract::ws::{CloseFrame, Message as WsMsg, WebSocket};
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::mpsc;

static CONN_SEQ: AtomicU64 = AtomicU64::new(1);

pub async fn session(core: Arc<Core>, socket: WebSocket) {
    let (mut sink, mut stream) = socket.split();
    let (tx, mut rx) = mpsc::unbounded_channel::<Out>();
    let conn = CONN_SEQ.fetch_add(1, Ordering::Relaxed);

    let writer = tokio::spawn(async move {
        while let Some(o) = rx.recv().await {
            let r = match o {
                Out::Text(t) => sink.send(WsMsg::Text(t.into())).await,
                Out::Close(code, reason) => {
                    let _ = sink.send(WsMsg::Close(Some(CloseFrame { code, reason: reason.into() }))).await;
                    break;
                }
            };
            if r.is_err() {
                break;
            }
        }
        let _ = sink.close().await;
    });

    // ---- auth (first message, within 5 s)
    let first = tokio::time::timeout(Duration::from_secs(5), stream.next()).await;
    let reply_err = |tx: &mpsc::UnboundedSender<Out>, id: Option<&Value>, code: &str, msg: &str| {
        let mut p = json!({ "code": code, "message": msg });
        if let Some(id) = id {
            p["replyTo"] = id.clone();
        }
        let _ = tx.send(Out::Text(envelope("error", p)));
    };
    let device_id = match first {
        Ok(Some(Ok(WsMsg::Text(t)))) => {
            let msg: Value = serde_json::from_str(&t).unwrap_or(Value::Null);
            if msg["type"] != "auth" {
                reply_err(&tx, msg.get("id"), "invalid_token", "auth must be first");
                let _ = tx.send(Out::Close(4003, "auth first".into()));
                let _ = writer.await;
                return;
            }
            let token = msg["payload"]["deviceToken"].as_str().unwrap_or("").to_string();
            let app_version = msg["payload"]["appVersion"].as_str().map(str::to_string);
            let res = core.with(|w| -> Result<String, Err> {
                let d = w.device_by_token(&token).cloned().ok_or_else(|| err("invalid_token", "Unknown device token"))?;
                if d.revoked {
                    return Err(err("revoked", "removed by admin"));
                }
                if let Some(old) = w.sessions.remove(&d.id) {
                    let _ = old.tx.send(Out::Close(4005, "replaced".into()));
                }
                w.sessions.insert(d.id.clone(), Session { conn, tx: tx.clone() });
                {
                    let dm = w.devices.get_mut(&d.id).unwrap();
                    if let Some(v) = app_version {
                        dm.app_version = v;
                    }
                    dm.last_seen_at = now_iso();
                }
                w.save_device(&d.id);
                w.live_mut(&d.id).online = true;
                let tok = core.lk.participant_token(&w.devices[&d.id]);
                let welcome = w.welcome(&d.id, tok);
                w.send_to(&d.id, "welcome", welcome);
                w.upsert(&d.id, true);
                tracing::info!("ws: {} online", w.devices[&d.id].display_name);
                Ok(d.id)
            });
            match res {
                Ok(id) => {
                    if let Some(id_v) = msg.get("id") {
                        let _ = tx.send(Out::Text(envelope("ack", json!({ "replyTo": id_v }))));
                    }
                    id
                }
                Err((code, m)) => {
                    reply_err(&tx, msg.get("id"), code, &m);
                    let _ = tx.send(Out::Close(if code == "revoked" { 4004 } else { 4001 }, code.into()));
                    let _ = writer.await;
                    return;
                }
            }
        }
        _ => {
            let _ = tx.send(Out::Close(4000, "auth timeout".into()));
            let _ = writer.await;
            return;
        }
    };

    // ---- token refresh timer: 5 min before expiry, repeating
    let refresh = {
        let core = core.clone();
        let id = device_id.clone();
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_secs((TOKEN_TTL_SECS - 300) as u64)).await;
                core.with(|w| {
                    if let Some(d) = w.devices.get(&id).filter(|d| !d.revoked) {
                        let t = core.lk.participant_token(d);
                        w.send_to(&id, "token.refreshed", json!({ "livekitToken": t }));
                    }
                });
            }
        })
    };

    // ---- main loop; no traffic for 45 s (client pings every 15 s) → drop
    loop {
        let next = tokio::time::timeout(Duration::from_secs(45), stream.next()).await;
        let text = match next {
            Ok(Some(Ok(WsMsg::Text(t)))) => t,
            Ok(Some(Ok(WsMsg::Ping(_) | WsMsg::Pong(_) | WsMsg::Binary(_)))) => continue,
            _ => break,
        };
        let msg: Value = match serde_json::from_str(&text) {
            Ok(v) => v,
            Err(_) => {
                reply_err(&tx, None, "bad_request", "invalid JSON");
                continue;
            }
        };
        let id_v = msg.get("id").cloned();
        let kind = msg["type"].as_str().unwrap_or("").to_string();
        let payload = msg.get("payload").cloned().unwrap_or(json!({}));
        let res = core.with(|w| -> Result<(), Err> {
            if !w.devices.get(&device_id).map_or(false, |d| !d.revoked) || w.sessions.get(&device_id).map_or(true, |s| s.conn != conn) {
                return Err(err("revoked", "session ended"));
            }
            handle(w, &core, &device_id, &kind, &payload, id_v.as_ref())
        });
        match res {
            Ok(()) => {
                if kind != "ping" {
                    if let Some(i) = &id_v {
                        let _ = tx.send(Out::Text(envelope("ack", json!({ "replyTo": i }))));
                    }
                }
            }
            Err((code, m)) => {
                if code == "revoked" {
                    break;
                }
                reply_err(&tx, id_v.as_ref(), code, &m)
            }
        }
    }

    refresh.abort();
    core.with(|w| {
        if w.sessions.get(&device_id).map_or(false, |s| s.conn == conn) {
            w.sessions.remove(&device_id);
            if w.devices.contains_key(&device_id) {
                let l = w.live_mut(&device_id);
                l.online = false;
                l.rtc_connected = false;
                l.mic_live = false;
                l.speaking = false;
                w.devices.get_mut(&device_id).unwrap().last_seen_at = now_iso();
                w.save_device(&device_id);
                tracing::info!("ws: {} offline", w.devices[&device_id].display_name);
                w.upsert(&device_id, true);
            }
        }
    });
    drop(tx);
    let _ = tokio::time::timeout(Duration::from_secs(2), writer).await;
}

fn str_vec(v: &Value) -> Option<Vec<String>> {
    v.as_array().map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect())
}
fn require_admin(w: &World, id: &str) -> Result<(), Err> {
    if w.is_admin(id) {
        Ok(())
    } else {
        Err(err("not_admin", "admin only"))
    }
}
fn slug(name: &str) -> String {
    let mut s = String::new();
    for c in name.to_lowercase().chars() {
        if c.is_ascii_alphanumeric() {
            s.push(c);
        } else if !s.ends_with('-') {
            s.push('-');
        }
    }
    let s = s.trim_matches('-').chars().take(32).collect::<String>();
    if s.is_empty() {
        "group".into()
    } else {
        s
    }
}
fn clip(s: &str, n: usize) -> String {
    s.trim().chars().take(n).collect()
}

fn handle(w: &mut World, core: &Arc<Core>, me_id: &str, kind: &str, p: &Value, id_v: Option<&Value>) -> Result<(), Err> {
    let me = w.devices[me_id].clone();
    match kind {
        "ping" => {
            let mut env = json!({ "type": "pong", "ts": now_iso(), "payload": {} });
            if let Some(i) = id_v {
                env["id"] = i.clone();
            }
            if let Some(s) = w.sessions.get(me_id) {
                let _ = s.tx.send(Out::Text(env.to_string()));
            }
            Ok(())
        }
        "auth" => Err(err("bad_request", "already authenticated")),

        "state.set" => {
            // validate all fields first; on any error state is unchanged
            let targets = match p.get("talkTargets") {
                Some(v) => Some(w.validate_targets(&me, &str_vec(v).ok_or_else(|| err("bad_request", "talkTargets must be an array"))?)?),
                None => None,
            };
            let listen = match p.get("listenGroupIds") {
                Some(v) => {
                    let l = str_vec(v).ok_or_else(|| err("bad_request", "listenGroupIds must be an array"))?;
                    let ok = w.listenable_groups(&me);
                    if let Some(bad) = l.iter().find(|g| !ok.contains(g)) {
                        return Err(err("bad_request", format!("listenGroupIds: not allowed to listen to {bad}")));
                    }
                    let mut dedup: Vec<String> = vec![];
                    l.into_iter().for_each(|g| {
                        if !dedup.contains(&g) {
                            dedup.push(g)
                        }
                    });
                    Some(dedup)
                }
                None => None,
            };
            let mode = match p.get("talkMode") {
                Some(v) => match v.as_str() {
                    Some(m @ ("ptt" | "latch")) => Some(m.to_string()),
                    _ => return Err(err("bad_request", "talkMode must be ptt or latch")),
                },
                None => None,
            };
            let mut immediate = false;
            if let Some(l) = listen {
                w.devices.get_mut(me_id).unwrap().listen_group_ids = l;
                w.save_device(me_id);
                immediate = true;
            }
            let forced = me.forced_talk_mode.clone();
            let admin_muted = me.admin_muted;
            let l = w.live_mut(me_id);
            if let Some(t) = targets {
                l.talk_targets = t;
                immediate = true;
            }
            if let Some(v) = p.get("micLive").and_then(|v| v.as_bool()) {
                let v = v && !admin_muted;
                immediate |= v != l.mic_live;
                l.mic_live = v;
            }
            if let Some(v) = p.get("speakerMuted").and_then(|v| v.as_bool()) {
                l.speaker_muted = v;
            }
            if let Some(m) = mode {
                l.talk_mode = forced.unwrap_or(m);
            }
            w.upsert(me_id, immediate);
            Ok(())
        }

        "status" => {
            let l = w.live_mut(me_id);
            if let Some(v) = p.get("rtcConnected").and_then(Value::as_bool) {
                l.rtc_connected = v;
            }
            if let Some(v) = p.get("speaking").and_then(Value::as_bool) {
                l.speaking = v;
            }
            if let Some(v) = p.get("charging").and_then(Value::as_bool) {
                l.charging = Some(v);
            }
            if let Some(v) = p.get("headset").and_then(Value::as_bool) {
                l.headset = Some(v);
            }
            if let Some(v) = p.get("battery").and_then(Value::as_f64) {
                l.battery = Some(v.round().clamp(0.0, 100.0) as i64);
            }
            if let Some(v) = p.get("rttMs").and_then(Value::as_f64) {
                l.rtt_ms = Some(v.round() as i64);
            }
            if let Some(v) = p.get("outputRoute").and_then(Value::as_str) {
                l.output_route = Some(v.to_string());
            }
            // status floods ride the 250 ms coalescing (DESKTOP.md "Roster broadcast")
            w.upsert(me_id, false);
            Ok(())
        }

        "message.send" => {
            let text = p["text"].as_str().unwrap_or("").trim().to_string();
            let kind = if p["kind"] == "quick" { "quick" } else { "text" };
            let to = p["to"].as_str().unwrap_or("").to_string();
            if text.is_empty() || text.chars().count() > 500 {
                return Err(err("bad_request", "text must be 1-500 chars"));
            }
            if kind == "quick" && !w.settings.quick_replies.contains(&text) {
                return Err(err("bad_request", "not a quick reply"));
            }
            if !w.can_address(&me, &to) {
                return Err(err("bad_request", format!("not allowed to message {to}")));
            }
            let m = Message { id: format!("m-{}", uuid::Uuid::new_v4()), from: me.id.clone(), to, kind: kind.into(), text, ts: now_iso(), acked_by: vec![] };
            w.deliver_message(m);
            Ok(())
        }
        "message.ack" => {
            let mid = p["messageId"].as_str().unwrap_or("");
            let Some(m) = w.messages.iter_mut().find(|m| m.id == mid) else { return Err(err("not_found", "no such message")) };
            if !m.acked_by.contains(&me.id) {
                m.acked_by.push(me.id.clone());
                let acked = m.acked_by.clone();
                let _ = w.db.set_acks(mid, &acked);
            }
            w.broadcast_admins("message.acked", json!({ "messageId": mid, "deviceId": me.id, "ts": now_iso() }));
            Ok(())
        }
        "signal.send" => {
            let to = p["to"].as_str().unwrap_or("").to_string();
            if !w.can_address(&me, &to) || (to == "all" && !me.is_admin) {
                return Err(err("bad_request", format!("not allowed to signal {to}")));
            }
            for r in w.recipients(&to) {
                if r != me.id {
                    w.send_to(&r, "signal", json!({ "from": me.id, "to": to }));
                }
            }
            Ok(())
        }
        "token.refresh" => {
            let t = core.lk.participant_token(&me);
            w.send_to(me_id, "token.refreshed", json!({ "livekitToken": t }));
            Ok(())
        }

        // ------------------------------------------------------------ admin
        "admin.device.update" => {
            require_admin(w, me_id)?;
            let tid = p["deviceId"].as_str().unwrap_or("").to_string();
            let Some(t) = w.devices.get(&tid).filter(|d| !d.revoked).cloned() else { return Err(err("not_found", "no such device")) };
            let group_id = p.get("groupId").and_then(Value::as_str).map(str::to_string);
            if let Some(g) = &group_id {
                if w.group(g).is_none() {
                    return Err(err("not_found", format!("no group {g}")));
                }
            }
            let listen = p.get("listenGroupIds").map(|v| str_vec(v).ok_or_else(|| err("bad_request", "listenGroupIds"))).transpose()?;
            let cantalk = p.get("canTalkGroupIds").map(|v| str_vec(v).ok_or_else(|| err("bad_request", "canTalkGroupIds"))).transpose()?;
            for l in [&listen, &cantalk].into_iter().flatten() {
                if l.iter().any(|g| w.group(g).is_none()) {
                    return Err(err("bad_request", "unknown group"));
                }
            }
            let forced = match p.get("forcedTalkMode") {
                None => None,
                Some(Value::Null) => Some(None),
                Some(v) => match v.as_str() {
                    Some(m @ ("ptt" | "latch")) => Some(Some(m.to_string())),
                    _ => return Err(err("bad_request", "forcedTalkMode")),
                },
            };
            if let Some(n) = p.get("displayName").and_then(Value::as_str) {
                let n = clip(n, 40);
                if !n.is_empty() && n != t.display_name {
                    w.devices.get_mut(&tid).unwrap().display_name = n.clone();
                    w.notice(&tid, "renamed", &format!("You were renamed to {n}"));
                }
            }
            if let Some(g) = group_id.filter(|g| *g != t.group_id) {
                {
                    let d = w.devices.get_mut(&tid).unwrap();
                    d.group_id = g.clone();
                    d.listen_group_ids = listen.clone().unwrap_or_else(|| if t.is_admin { t.listen_group_ids.clone() } else { vec![g.clone()] });
                    d.can_talk_group_ids = cantalk.clone().unwrap_or_else(|| if t.is_admin { t.can_talk_group_ids.clone() } else { vec![g.clone()] });
                }
                let mode = w.default_talk_mode(&w.devices[&tid].clone());
                let l = w.live_mut(&tid);
                l.talk_targets = vec![format!("g:{g}")];
                if t.forced_talk_mode.is_none() {
                    l.talk_mode = mode;
                }
                let gname = w.group(&g).map(|x| x.name.clone()).unwrap_or(g);
                w.notice(&tid, "moved", &format!("You were moved to {gname}"));
            } else {
                if let Some(l) = listen {
                    w.devices.get_mut(&tid).unwrap().listen_group_ids = l;
                }
                if let Some(c) = cantalk {
                    w.devices.get_mut(&tid).unwrap().can_talk_group_ids = c.clone();
                    let is_admin = t.is_admin;
                    w.live_mut(&tid).talk_targets.retain(|x| x.strip_prefix("g:").map_or(true, |g| is_admin || c.iter().any(|y| y == g)));
                }
            }
            if let Some(a) = p.get("isAdmin").and_then(Value::as_bool) {
                w.devices.get_mut(&tid).unwrap().is_admin = a;
            }
            if let Some(f) = forced {
                if f != t.forced_talk_mode {
                    w.devices.get_mut(&tid).unwrap().forced_talk_mode = f.clone();
                    if let Some(m) = f {
                        w.live_mut(&tid).talk_mode = m;
                        w.notice(&tid, "forcedPtt", "The producer set you to hold-to-talk");
                    }
                }
            }
            w.save_device(&tid);
            w.effects.push(Effect::UpdateMeta(w.devices[&tid].clone()));
            w.upsert(&tid, true);
            if p.get("isAdmin").is_some() && w.sessions.contains_key(&tid) {
                // the admin flag changes what this device's snapshot contains: send a fresh one
                let tok = core.lk.participant_token(&w.devices[&tid]);
                let wel = w.welcome(&tid, tok);
                w.send_to(&tid, "welcome", wel);
            }
            Ok(())
        }
        "admin.device.mute" => {
            require_admin(w, me_id)?;
            let tid = p["deviceId"].as_str().unwrap_or("").to_string();
            if !w.devices.get(&tid).map_or(false, |d| !d.revoked) {
                return Err(err("not_found", "no such device"));
            }
            let muted = p["muted"].as_bool().unwrap_or(false);
            w.devices.get_mut(&tid).unwrap().admin_muted = muted;
            if muted {
                w.live_mut(&tid).mic_live = false;
                w.effects.push(Effect::Mute(tid.clone()));
            }
            w.save_device(&tid);
            w.upsert(&tid, true);
            w.notice(&tid, if muted { "muted" } else { "unmuted" }, if muted { "The producer muted your mic" } else { "The producer unmuted your mic" });
            Ok(())
        }
        "admin.device.remove" => {
            require_admin(w, me_id)?;
            let tid = p["deviceId"].as_str().unwrap_or("").to_string();
            if !w.devices.contains_key(&tid) {
                return Err(err("not_found", "no such device"));
            }
            w.devices.get_mut(&tid).unwrap().revoked = true;
            w.save_device(&tid);
            if let Some(s) = w.sessions.remove(&tid) {
                let _ = s.tx.send(Out::Text(envelope("kicked", json!({ "reason": "removed_by_admin" }))));
                let _ = s.tx.send(Out::Close(4004, "removed".into()));
            }
            w.live.remove(&tid);
            w.effects.push(Effect::Remove(tid.clone()));
            w.broadcast("device.removed", json!({ "deviceId": tid }));
            Ok(())
        }
        "admin.device.forget" => {
            require_admin(w, me_id)?;
            let tid = p["deviceId"].as_str().unwrap_or("").to_string();
            if !w.devices.contains_key(&tid) {
                return Err(err("not_found", "no such device"));
            }
            if w.sessions.contains_key(&tid) {
                return Err(err("bad_request", "device is online; remove it first"));
            }
            w.devices.remove(&tid);
            w.live.remove(&tid);
            let _ = w.db.delete_device(&tid);
            w.broadcast("device.removed", json!({ "deviceId": tid }));
            Ok(())
        }
        "admin.group.create" => {
            require_admin(w, me_id)?;
            let name = clip(p["name"].as_str().unwrap_or(""), 40);
            if name.is_empty() {
                return Err(err("bad_request", "name required"));
            }
            let base = slug(&name);
            let mut id = base.clone();
            let mut i = 2;
            while w.group(&id).is_some() {
                id = format!("{}-{i}", &base[..base.len().min(29)]);
                i += 1;
            }
            let g = Group {
                id: id.clone(),
                name,
                color: p["color"].as_str().unwrap_or("#64748b").to_string(),
                sort_order: w.groups.iter().map(|g| g.sort_order).max().unwrap_or(-1) + 1,
                default_talk_mode: p["defaultTalkMode"].as_str().filter(|m| *m == "ptt" || *m == "latch").map(str::to_string),
            };
            let _ = w.db.save_group(&g);
            w.groups.push(g);
            // admins may address and hear every group
            let admins: Vec<String> = w.active_devices().filter(|d| d.is_admin).map(|d| d.id.clone()).collect();
            for a in admins {
                let d = w.devices.get_mut(&a).unwrap();
                d.can_talk_group_ids.push(id.clone());
                d.listen_group_ids.push(id.clone());
                w.save_device(&a);
                w.upsert(&a, true);
            }
            w.broadcast("groups.updated", json!({ "groups": w.sorted_groups() }));
            Ok(())
        }
        "admin.group.update" => {
            require_admin(w, me_id)?;
            let gid = p["groupId"].as_str().unwrap_or("");
            let Some(g) = w.groups.iter_mut().find(|g| g.id == gid) else { return Err(err("not_found", "no such group")) };
            if let Some(n) = p["name"].as_str() {
                let n = clip(n, 40);
                if !n.is_empty() {
                    g.name = n;
                }
            }
            if let Some(c) = p["color"].as_str() {
                g.color = c.chars().take(16).collect();
            }
            if let Some(o) = p["sortOrder"].as_i64() {
                g.sort_order = o;
            }
            if let Some(m) = p.get("defaultTalkMode") {
                g.default_talk_mode = m.as_str().filter(|m| *m == "ptt" || *m == "latch").map(str::to_string);
            }
            let g = g.clone();
            let _ = w.db.save_group(&g);
            w.broadcast("groups.updated", json!({ "groups": w.sorted_groups() }));
            Ok(())
        }
        "admin.group.delete" => {
            require_admin(w, me_id)?;
            let gid = p["groupId"].as_str().unwrap_or("").to_string();
            let to = p["moveDevicesTo"].as_str().unwrap_or("").to_string();
            if w.group(&gid).is_none() {
                return Err(err("not_found", "no such group"));
            }
            if to == gid || w.group(&to).is_none() {
                return Err(err("bad_request", "moveDevicesTo must be another existing group"));
            }
            w.groups.retain(|g| g.id != gid);
            let _ = w.db.delete_group(&gid);
            let to_name = w.group(&to).unwrap().name.clone();
            let ids: Vec<String> = w.devices.keys().cloned().collect();
            for id in ids {
                let moved = {
                    let d = w.devices.get_mut(&id).unwrap();
                    let moved = d.group_id == gid;
                    if moved {
                        d.group_id = to.clone();
                    }
                    d.listen_group_ids.retain(|x| *x != gid);
                    d.can_talk_group_ids.retain(|x| *x != gid);
                    if !d.is_admin && !d.listen_group_ids.contains(&d.group_id) {
                        d.listen_group_ids.push(d.group_id.clone());
                    }
                    if !d.can_talk_group_ids.contains(&d.group_id) {
                        d.can_talk_group_ids.push(d.group_id.clone());
                    }
                    moved
                };
                let gref = format!("g:{gid}");
                let l = w.live_mut(&id);
                l.talk_targets.retain(|x| *x != gref);
                if moved {
                    l.talk_targets = vec![format!("g:{to}")];
                    w.notice(&id, "moved", &format!("You were moved to {to_name}"));
                }
                w.save_device(&id);
            }
            w.broadcast("groups.updated", json!({ "groups": w.sorted_groups() }));
            let ids: Vec<String> = w.active_devices().map(|d| d.id.clone()).collect();
            for id in ids {
                w.upsert(&id, true);
            }
            Ok(())
        }
        "admin.join.rotate" => {
            require_admin(w, me_id)?;
            w.server.join_code = new_join_code();
            w.save_server();
            w.broadcast_server();
            Ok(())
        }
        "admin.join.setOpen" => {
            require_admin(w, me_id)?;
            w.server.join_open = p["open"].as_bool().unwrap_or(true);
            w.save_server();
            w.broadcast_server();
            Ok(())
        }
        "admin.settings.update" => {
            require_admin(w, me_id)?;
            let mut renamed = false;
            if let Some(n) = p["serverName"].as_str() {
                let n = clip(n, 60);
                if !n.is_empty() && n != w.server.name {
                    w.server.name = n;
                    renamed = true;
                }
            }
            if let Some(b) = p["crewCanBroadcast"].as_bool() {
                w.settings.crew_can_broadcast = b;
            }
            if let Some(m) = p["defaultTalkMode"].as_str() {
                w.settings.default_talk_mode = if m == "latch" { "latch".into() } else { "ptt".into() };
            }
            if p.get("iosInstallUrl").is_some() {
                // null or "" clears it; only https links are accepted
                w.settings.ios_install_url = p["iosInstallUrl"].as_str().map(|u| clip(u.trim(), 300)).filter(|u| u.starts_with("https://"));
            }
            w.save_server();
            w.broadcast("settings.updated", serde_json::to_value(&w.settings).unwrap());
            if renamed {
                w.broadcast_server();
                w.effects.push(Effect::Readvertise);
            }
            Ok(())
        }
        other => Err(err("bad_request", format!("unknown type {other}"))),
    }
}
