//! LiveKit access tokens (grants per PROTOCOL §5) and the RoomService Twirp API
//! (MutePublishedTrack, RemoveParticipant, UpdateParticipant). Plain HS256 JWTs and JSON Twirp
//! over loopback HTTP: no extra SDK needed for these four calls.
use crate::model::{DeviceRow, ROOM};
use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64;
use base64::Engine;
use bytes::Bytes;
use hmac::{Hmac, Mac};
use http_body_util::{BodyExt, Full};
use hyper_util::client::legacy::{connect::HttpConnector, Client};
use hyper_util::rt::TokioExecutor;
use serde_json::{json, Value};
use sha2::Sha256;

pub const TOKEN_TTL_SECS: i64 = 3600;

#[derive(Clone)]
pub struct LiveKitAdmin {
    pub api_key: String,
    api_secret: String,
    base: String,
    http: Client<HttpConnector, Full<Bytes>>,
}

impl LiveKitAdmin {
    pub fn new(api_key: String, api_secret: String, port: u16) -> Self {
        LiveKitAdmin { api_key, api_secret, base: format!("http://127.0.0.1:{port}"), http: Client::builder(TokioExecutor::new()).build_http() }
    }

    fn sign(&self, claims: &Value) -> String {
        let h = B64.encode(br#"{"alg":"HS256","typ":"JWT"}"#);
        let p = B64.encode(serde_json::to_vec(claims).unwrap());
        let mut mac = Hmac::<Sha256>::new_from_slice(self.api_secret.as_bytes()).unwrap();
        mac.update(format!("{h}.{p}").as_bytes());
        format!("{h}.{p}.{}", B64.encode(mac.finalize().into_bytes()))
    }

    /// Participant token: identity = device id, audio-only publish, 1 h.
    pub fn participant_token(&self, d: &DeviceRow) -> String {
        let now = chrono::Utc::now().timestamp();
        self.sign(&json!({
            "iss": self.api_key, "sub": d.id, "name": d.display_name, "nbf": now - 10, "exp": now + TOKEN_TTL_SECS, "jti": d.id,
            "metadata": json!({ "groupId": d.group_id, "isAdmin": d.is_admin }).to_string(),
            "video": { "roomJoin": true, "room": ROOM, "canPublish": true, "canPublishSources": ["microphone"],
                       "canSubscribe": true, "canPublishData": false }
        }))
    }

    async fn twirp(&self, method: &str, body: Value) -> Option<Value> {
        let now = chrono::Utc::now().timestamp();
        let tok = self.sign(&json!({ "iss": self.api_key, "nbf": now - 10, "exp": now + 60, "video": { "roomAdmin": true, "room": ROOM, "roomList": true } }));
        let req = hyper::Request::post(format!("{}/twirp/livekit.RoomService/{method}", self.base))
            .header("content-type", "application/json")
            .header("authorization", format!("Bearer {tok}"))
            .body(Full::new(Bytes::from(body.to_string())))
            .ok()?;
        let res = match tokio::time::timeout(std::time::Duration::from_secs(3), self.http.request(req)).await {
            Ok(Ok(r)) => r,
            Ok(Err(e)) => {
                tracing::warn!("livekit {method}: {e}");
                return None;
            }
            Err(_) => {
                tracing::warn!("livekit {method}: timeout");
                return None;
            }
        };
        let status = res.status();
        let bytes = res.into_body().collect().await.ok()?.to_bytes();
        let v: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
        if !status.is_success() {
            tracing::warn!("livekit {method} -> {status}: {}", v.get("msg").and_then(|m| m.as_str()).unwrap_or(""));
            return None;
        }
        Some(v)
    }

    /// Server-side mute of every audio track the participant publishes (admin mute is enforced
    /// here, not only in the roster). LiveKit only supports remote *mute*; unmute is the
    /// client's own next press.
    pub async fn mute(&self, identity: &str) {
        let Some(p) = self.twirp("GetParticipant", json!({ "room": ROOM, "identity": identity })).await else { return };
        for t in p.get("tracks").and_then(|t| t.as_array()).cloned().unwrap_or_default() {
            let audio = t.get("type").map_or(false, |x| x == "AUDIO" || x == 0) || t.get("source").map_or(false, |x| x == "MICROPHONE");
            if let (true, Some(sid)) = (audio, t.get("sid").and_then(|s| s.as_str())) {
                self.twirp("MutePublishedTrack", json!({ "room": ROOM, "identity": identity, "track_sid": sid, "muted": true })).await;
            }
        }
    }
    pub async fn remove(&self, identity: &str) {
        self.twirp("RemoveParticipant", json!({ "room": ROOM, "identity": identity })).await;
    }
    pub async fn update_metadata(&self, d: &DeviceRow) {
        let meta = json!({ "groupId": d.group_id, "isAdmin": d.is_admin }).to_string();
        self.twirp("UpdateParticipant", json!({ "room": ROOM, "identity": d.id, "name": d.display_name, "metadata": meta })).await;
    }
}
