//! Headless host: the same server as the desktop app without a window.
//!   cargo run --bin partyline-host
//! Env: PARTYLINE_DATA, PARTYLINE_PORT (8443), PARTYLINE_LOOPBACK_PORT (8442),
//! PARTYLINE_LIVEKIT_PORT (7880), PARTYLINE_LIVEKIT_TCP_PORT (7881), PARTYLINE_UDP_START/END,
//! PARTYLINE_LIVEKIT_BIN, PARTYLINE_NO_MDNS. PARTYLINE_JOIN(+_FP) runs only the join-mode proxy.
use partyline_lib::host::{Host, HostOptions};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt().with_env_filter(tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into())).init();
    // Join-mode check without the GUI: PARTYLINE_JOIN=<host:port> PARTYLINE_JOIN_FP=<fp|probe>
    if let Ok(addr) = std::env::var("PARTYLINE_JOIN") {
        let fp = match std::env::var("PARTYLINE_JOIN_FP").ok().filter(|f| f != "probe") {
            Some(f) => f,
            None => {
                let p = partyline_lib::proxy::probe(&addr).await?;
                println!("probe: {} {} fp {}", p.name, p.server_id, p.fingerprint);
                p.fingerprint
            }
        };
        let px = partyline_lib::proxy::start(&addr, &fp, 8441).await?;
        println!("join proxy {} -> {}", px.url, px.address);
        tokio::signal::ctrl_c().await?;
        return Ok(());
    }
    let opts = HostOptions::from_env();
    let host = Host::start(opts).await?;
    let (code, fp, id) = {
        let w = host.core.lock();
        (w.server.join_code.clone(), w.fingerprint.clone(), w.server.id.clone())
    };
    println!("PartyLine host");
    for u in host.lan_urls() {
        println!("  {u}   join code {code}");
        println!("  join link {u}/#join?code={code}&fp={fp}&id={id}");
    }
    println!("  console (this machine, admin): {}", host.loopback_url());
    println!("  data {}", host.opts.data_dir.display());
    shutdown_signal().await;
    host.stop().await;
    Ok(())
}

async fn shutdown_signal() {
    #[cfg(unix)]
    {
        let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()).expect("sigterm");
        tokio::select! { _ = tokio::signal::ctrl_c() => {}, _ = term.recv() => {} }
    }
    #[cfg(not(unix))]
    let _ = tokio::signal::ctrl_c().await;
}
