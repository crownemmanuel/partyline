//! SQLite persistence (rusqlite, bundled): server key/values, groups, devices, messages,
//! join attempts. Small and synchronous; callers hold the world lock.
use crate::model::*;
use anyhow::Result;
use rusqlite::{params, Connection, OptionalExtension};
use std::path::Path;

pub struct Db {
    conn: Connection,
}

const MIGRATIONS: &[&str] = &[r#"
CREATE TABLE server (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE groups (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, color TEXT NOT NULL, sort_order INTEGER NOT NULL,
  default_talk_mode TEXT
);
CREATE TABLE devices (
  id TEXT PRIMARY KEY, display_name TEXT NOT NULL, platform TEXT NOT NULL, app_version TEXT NOT NULL,
  group_id TEXT NOT NULL, listen_group_ids TEXT NOT NULL, can_talk_group_ids TEXT NOT NULL,
  is_admin INTEGER NOT NULL, forced_talk_mode TEXT, admin_muted INTEGER NOT NULL,
  device_token_hash TEXT, revoked INTEGER NOT NULL, created_at TEXT NOT NULL, last_seen_at TEXT NOT NULL
);
CREATE INDEX devices_token ON devices(device_token_hash);
CREATE TABLE messages (
  id TEXT PRIMARY KEY, from_device_id TEXT NOT NULL, to_ref TEXT NOT NULL, kind TEXT NOT NULL,
  text TEXT NOT NULL, created_at TEXT NOT NULL, acked_by TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX messages_time ON messages(created_at);
CREATE TABLE join_attempts (ts INTEGER NOT NULL, ip TEXT NOT NULL, ok INTEGER NOT NULL);
"#];

impl Db {
    pub fn open(path: &Path) -> Result<Db> {
        let conn = Connection::open(path)?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "synchronous", "NORMAL")?;
        let v: i64 = conn.pragma_query_value(None, "user_version", |r| r.get(0))?;
        for (i, m) in MIGRATIONS.iter().enumerate().skip(v as usize) {
            conn.execute_batch(m)?;
            conn.pragma_update(None, "user_version", (i + 1) as i64)?;
        }
        Ok(Db { conn })
    }

    pub fn kv_get(&self, key: &str) -> Result<Option<String>> {
        Ok(self.conn.query_row("SELECT value FROM server WHERE key=?1", [key], |r| r.get(0)).optional()?)
    }
    pub fn kv_set(&self, key: &str, value: &str) -> Result<()> {
        self.conn.execute("INSERT INTO server(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [key, value])?;
        Ok(())
    }

    pub fn groups(&self) -> Result<Vec<Group>> {
        let mut st = self.conn.prepare("SELECT id,name,color,sort_order,default_talk_mode FROM groups ORDER BY sort_order")?;
        let rows = st.query_map([], |r| {
            Ok(Group { id: r.get(0)?, name: r.get(1)?, color: r.get(2)?, sort_order: r.get(3)?, default_talk_mode: r.get(4)? })
        })?;
        Ok(rows.collect::<Result<_, _>>()?)
    }
    pub fn save_group(&self, g: &Group) -> Result<()> {
        self.conn.execute(
            "INSERT INTO groups(id,name,color,sort_order,default_talk_mode) VALUES(?1,?2,?3,?4,?5)
             ON CONFLICT(id) DO UPDATE SET name=excluded.name,color=excluded.color,sort_order=excluded.sort_order,default_talk_mode=excluded.default_talk_mode",
            params![g.id, g.name, g.color, g.sort_order, g.default_talk_mode],
        )?;
        Ok(())
    }
    pub fn delete_group(&self, id: &str) -> Result<()> {
        self.conn.execute("DELETE FROM groups WHERE id=?1", [id])?;
        Ok(())
    }

    pub fn devices(&self) -> Result<Vec<DeviceRow>> {
        let mut st = self.conn.prepare(
            "SELECT id,display_name,platform,app_version,group_id,listen_group_ids,can_talk_group_ids,is_admin,
                    forced_talk_mode,admin_muted,device_token_hash,revoked,created_at,last_seen_at FROM devices",
        )?;
        let rows = st.query_map([], |r| {
            let l: String = r.get(5)?;
            let c: String = r.get(6)?;
            Ok(DeviceRow {
                id: r.get(0)?,
                display_name: r.get(1)?,
                platform: r.get(2)?,
                app_version: r.get(3)?,
                group_id: r.get(4)?,
                listen_group_ids: serde_json::from_str(&l).unwrap_or_default(),
                can_talk_group_ids: serde_json::from_str(&c).unwrap_or_default(),
                is_admin: r.get::<_, i64>(7)? != 0,
                forced_talk_mode: r.get(8)?,
                admin_muted: r.get::<_, i64>(9)? != 0,
                token_hash: r.get(10)?,
                revoked: r.get::<_, i64>(11)? != 0,
                created_at: r.get(12)?,
                last_seen_at: r.get(13)?,
            })
        })?;
        Ok(rows.collect::<Result<_, _>>()?)
    }
    pub fn save_device(&self, d: &DeviceRow) -> Result<()> {
        self.conn.execute(
            "INSERT INTO devices(id,display_name,platform,app_version,group_id,listen_group_ids,can_talk_group_ids,is_admin,
                                 forced_talk_mode,admin_muted,device_token_hash,revoked,created_at,last_seen_at)
             VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14)
             ON CONFLICT(id) DO UPDATE SET display_name=excluded.display_name,platform=excluded.platform,app_version=excluded.app_version,
               group_id=excluded.group_id,listen_group_ids=excluded.listen_group_ids,can_talk_group_ids=excluded.can_talk_group_ids,
               is_admin=excluded.is_admin,forced_talk_mode=excluded.forced_talk_mode,admin_muted=excluded.admin_muted,
               device_token_hash=excluded.device_token_hash,revoked=excluded.revoked,last_seen_at=excluded.last_seen_at",
            params![
                d.id,
                d.display_name,
                d.platform,
                d.app_version,
                d.group_id,
                serde_json::to_string(&d.listen_group_ids)?,
                serde_json::to_string(&d.can_talk_group_ids)?,
                d.is_admin as i64,
                d.forced_talk_mode,
                d.admin_muted as i64,
                d.token_hash,
                d.revoked as i64,
                d.created_at,
                d.last_seen_at
            ],
        )?;
        Ok(())
    }
    pub fn delete_device(&self, id: &str) -> Result<()> {
        self.conn.execute("DELETE FROM devices WHERE id=?1", [id])?;
        Ok(())
    }

    pub fn insert_message(&self, m: &Message) -> Result<()> {
        self.conn.execute(
            "INSERT INTO messages(id,from_device_id,to_ref,kind,text,created_at,acked_by) VALUES(?1,?2,?3,?4,?5,?6,?7)",
            params![m.id, m.from, m.to, m.kind, m.text, m.ts, serde_json::to_string(&m.acked_by)?],
        )?;
        Ok(())
    }
    pub fn set_acks(&self, id: &str, acked: &[String]) -> Result<()> {
        self.conn.execute("UPDATE messages SET acked_by=?2 WHERE id=?1", params![id, serde_json::to_string(acked)?])?;
        Ok(())
    }
    pub fn recent_messages(&self, limit: i64) -> Result<Vec<Message>> {
        let mut st = self.conn.prepare(
            "SELECT id,from_device_id,to_ref,kind,text,created_at,acked_by FROM
               (SELECT rowid AS r, * FROM messages ORDER BY created_at DESC, rowid DESC LIMIT ?1) ORDER BY created_at, r",
        )?;
        let rows = st.query_map([limit], |r| {
            let a: String = r.get(6)?;
            Ok(Message { id: r.get(0)?, from: r.get(1)?, to: r.get(2)?, kind: r.get(3)?, text: r.get(4)?, ts: r.get(5)?, acked_by: serde_json::from_str(&a).unwrap_or_default() })
        })?;
        Ok(rows.collect::<Result<_, _>>()?)
    }
    pub fn prune_messages(&self, keep: i64) -> Result<()> {
        self.conn.execute("DELETE FROM messages WHERE rowid NOT IN (SELECT rowid FROM messages ORDER BY created_at DESC LIMIT ?1)", [keep])?;
        Ok(())
    }

    pub fn record_join_attempt(&self, ts: i64, ip: &str, ok: bool) -> Result<()> {
        self.conn.execute("INSERT INTO join_attempts(ts,ip,ok) VALUES(?1,?2,?3)", params![ts, ip, ok as i64])?;
        self.conn.execute("DELETE FROM join_attempts WHERE ts < ?1", [ts - 7 * 86400])?;
        Ok(())
    }
    pub fn failed_attempts_since(&self, ts: i64) -> Result<i64> {
        Ok(self.conn.query_row("SELECT COUNT(*) FROM join_attempts WHERE ok=0 AND ts>=?1", [ts], |r| r.get(0))?)
    }
}
