//! `_partyline._tcp` advertisement (Host) and browsing (Join), PROTOCOL §1.
use mdns_sd::{ServiceDaemon, ServiceEvent, ServiceInfo};
use serde::Serialize;
use std::collections::HashMap;
use std::net::Ipv4Addr;
use std::sync::{Arc, Mutex};

const SERVICE: &str = "_partyline._tcp.local.";

pub struct Advert {
    daemon: ServiceDaemon,
    fullname: Option<String>,
}

impl Advert {
    pub fn new() -> anyhow::Result<Advert> {
        Ok(Advert { daemon: ServiceDaemon::new()?, fullname: None })
    }
    pub fn register(&mut self, server_id: &str, name: &str, fp: &str, port: u16, ips: &[Ipv4Addr]) -> anyhow::Result<()> {
        self.unregister();
        // instance names are labels: keep them short and free of dots
        let instance: String = name.replace('.', " ").chars().take(60).collect();
        let props = [("v", "1"), ("id", server_id), ("name", name), ("fp", fp)];
        let ips: Vec<std::net::IpAddr> = ips.iter().map(|i| (*i).into()).collect();
        let info = ServiceInfo::new(SERVICE, &instance, "partyline.local.", &ips[..], port, &props[..])?;
        self.fullname = Some(info.get_fullname().to_string());
        self.daemon.register(info)?;
        tracing::info!("mDNS: advertising {instance} on {:?}:{port}", ips);
        Ok(())
    }
    pub fn unregister(&mut self) {
        if let Some(f) = self.fullname.take() {
            if let Ok(rx) = self.daemon.unregister(&f) {
                let _ = rx.recv_timeout(std::time::Duration::from_millis(500));
            }
        }
    }
    pub fn shutdown(mut self) {
        self.unregister();
        let _ = self.daemon.shutdown();
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Found {
    pub id: String,
    pub name: String,
    pub address: String,
    pub port: u16,
    pub fingerprint: String,
}

/// Background browser; `list()` returns what is currently on the network.
pub struct Browser {
    found: Arc<Mutex<HashMap<String, Found>>>,
    _daemon: ServiceDaemon,
}

impl Browser {
    pub fn start() -> anyhow::Result<Browser> {
        let daemon = ServiceDaemon::new()?;
        let rx = daemon.browse(SERVICE)?;
        let found: Arc<Mutex<HashMap<String, Found>>> = Default::default();
        let f2 = found.clone();
        std::thread::spawn(move || {
            while let Ok(ev) = rx.recv() {
                match ev {
                    ServiceEvent::ServiceResolved(info) => {
                        let prop = |k: &str| info.get_property_val_str(k).unwrap_or("").to_string();
                        let mut addrs: Vec<Ipv4Addr> = info.get_addresses_v4().into_iter().copied().collect();
                        addrs.sort_by_key(|a| !a.is_private());
                        let Some(addr) = addrs.first() else { continue };
                        let id = prop("id");
                        if id.is_empty() {
                            continue;
                        }
                        f2.lock().unwrap().insert(
                            info.get_fullname().to_string(),
                            Found { id, name: prop("name"), address: addr.to_string(), port: info.get_port(), fingerprint: prop("fp") },
                        );
                    }
                    ServiceEvent::ServiceRemoved(_, fullname) => {
                        f2.lock().unwrap().remove(&fullname);
                    }
                    _ => {}
                }
            }
        });
        Ok(Browser { found, _daemon: daemon })
    }
    pub fn list(&self) -> Vec<Found> {
        let mut v: Vec<Found> = self.found.lock().unwrap().values().cloned().collect();
        v.sort_by(|a, b| a.name.cmp(&b.name));
        v.dedup_by(|a, b| a.id == b.id);
        v
    }
}
