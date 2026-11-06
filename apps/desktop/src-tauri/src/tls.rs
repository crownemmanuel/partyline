//! Self-signed server certificate (ARCHITECTURE §5.3), LAN address discovery, and the pinned
//! client verifier used when this desktop joins another host.
use anyhow::{Context, Result};
use rcgen::{CertificateParams, DistinguishedName, DnType, KeyPair, SanType};
use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::{DigitallySignedStruct, SignatureScheme};
use sha2::{Digest, Sha256};
use std::net::{IpAddr, Ipv4Addr};
use std::path::Path;
use std::sync::{Arc, Mutex};

pub struct CertFiles {
    pub cert_pem: String,
    pub key_pem: String,
    pub fingerprint: String,
    pub sans: Vec<String>,
}

/// LAN IPv4 addresses, best first: RFC1918 before VPN/CGNAT (Tailscale 100.64/10) and link-local.
pub fn lan_ipv4s() -> Vec<Ipv4Addr> {
    let mut v: Vec<Ipv4Addr> = if_addrs::get_if_addrs()
        .unwrap_or_default()
        .into_iter()
        .filter(|i| !i.is_loopback())
        .filter_map(|i| match i.ip() {
            IpAddr::V4(ip) => Some(ip),
            _ => None,
        })
        .collect();
    v.sort_by_key(|ip| rank(*ip));
    v.dedup();
    v
}
fn rank(ip: Ipv4Addr) -> u8 {
    let o = ip.octets();
    match o {
        [192, 168, ..] => 0,
        [10, ..] => 1,
        [172, b, ..] if (16..=31).contains(&b) => 2,
        [169, 254, ..] => 9,
        [100, b, ..] if (64..=127).contains(&b) => 8,
        _ => 5,
    }
}

pub fn host_name() -> String {
    hostname::get().ok().and_then(|h| h.into_string().ok()).unwrap_or_else(|| "partyline".into()).trim_end_matches(".local").to_string()
}

pub fn wanted_sans() -> Vec<String> {
    let host = host_name();
    let mut s = vec!["partyline.local".to_string(), "localhost".into(), host.clone(), format!("{host}.local"), "127.0.0.1".into()];
    s.extend(lan_ipv4s().iter().map(|ip| ip.to_string()));
    s.dedup();
    s
}

pub fn fingerprint_der(der: &[u8]) -> String {
    hex::encode(Sha256::digest(der))
}

/// Bump when the cert profile changes so older stored certs are replaced on next start.
const CERT_PROFILE: u32 = 2;
/// iOS rejects TLS server certs valid for more than 825 days, with no "visit anyway" option.
const CERT_DAYS: i64 = 820;
/// Renew this long before expiry.
const RENEW_DAYS: i64 = 30;

/// Stored cert still usable: current profile and not close to expiry.
fn stored_cert_ok(dir: &Path) -> bool {
    let Some(meta) = std::fs::read_to_string(dir.join("cert.meta.json")).ok().and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok()) else {
        return false;
    };
    let now = time::OffsetDateTime::now_utc().unix_timestamp();
    meta["profile"].as_u64() == Some(CERT_PROFILE as u64) && meta["notAfter"].as_i64().is_some_and(|t| t - now > RENEW_DAYS * 86_400)
}

/// Load the stored cert, or make one with the given SANs: P-256, 820 days, serverAuth EKU
/// (both required by iOS/macOS for TLS server certs, self-signed included).
pub fn load_or_create(dir: &Path, force_sans: Option<Vec<String>>) -> Result<CertFiles> {
    let cp = dir.join("cert.pem");
    let kp = dir.join("key.pem");
    let sp = dir.join("cert.sans.json");
    if force_sans.is_none() && cp.exists() && kp.exists() && stored_cert_ok(dir) {
        let cert_pem = std::fs::read_to_string(&cp)?;
        let key_pem = std::fs::read_to_string(&kp)?;
        let der = pem_to_der(&cert_pem)?;
        let sans = std::fs::read_to_string(&sp).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default();
        return Ok(CertFiles { fingerprint: fingerprint_der(&der), cert_pem, key_pem, sans });
    }
    let sans = force_sans.unwrap_or_else(wanted_sans);
    let mut params = CertificateParams::default();
    let mut dn = DistinguishedName::new();
    dn.push(DnType::CommonName, format!("PartyLine {}", host_name()));
    params.distinguished_name = dn;
    params.subject_alt_names = sans
        .iter()
        .filter_map(|s| match s.parse::<IpAddr>() {
            Ok(ip) => Some(SanType::IpAddress(ip)),
            Err(_) => s.clone().try_into().ok().map(SanType::DnsName),
        })
        .collect();
    let now = time::OffsetDateTime::now_utc();
    params.not_before = now - time::Duration::days(1);
    params.not_after = now + time::Duration::days(CERT_DAYS);
    params.key_usages = vec![rcgen::KeyUsagePurpose::DigitalSignature];
    params.extended_key_usages = vec![rcgen::ExtendedKeyUsagePurpose::ServerAuth];
    let key = KeyPair::generate_for(&rcgen::PKCS_ECDSA_P256_SHA256)?;
    let cert = params.self_signed(&key)?;
    let cert_pem = cert.pem();
    let key_pem = key.serialize_pem();
    std::fs::write(&cp, &cert_pem)?;
    std::fs::write(&kp, &key_pem)?;
    std::fs::write(&sp, serde_json::to_string(&sans)?)?;
    std::fs::write(dir.join("cert.meta.json"), serde_json::json!({ "profile": CERT_PROFILE, "notAfter": params.not_after.unix_timestamp() }).to_string())?;
    tracing::info!("generated TLS certificate for {:?}", sans);
    Ok(CertFiles { fingerprint: fingerprint_der(cert.der()), cert_pem, key_pem, sans })
}

fn pem_to_der(pem: &str) -> Result<Vec<u8>> {
    use base64::Engine;
    let b64: String = pem.lines().filter(|l| !l.starts_with("-----")).collect();
    base64::engine::general_purpose::STANDARD.decode(b64).context("bad cert pem")
}

/// Accepts exactly one certificate (sha256 of DER). With `expected = None` it accepts any
/// certificate and records its fingerprint (used to show "Trust …?" before pinning).
#[derive(Debug)]
pub struct PinnedVerifier {
    pub expected: Option<String>,
    pub seen: Mutex<Option<String>>,
    provider: Arc<rustls::crypto::CryptoProvider>,
}

impl PinnedVerifier {
    pub fn new(expected: Option<String>) -> Arc<Self> {
        Arc::new(PinnedVerifier { expected: expected.map(|s| s.to_lowercase()), seen: Mutex::new(None), provider: Arc::new(rustls::crypto::ring::default_provider()) })
    }
}

impl ServerCertVerifier for PinnedVerifier {
    fn verify_server_cert(&self, end_entity: &CertificateDer<'_>, _: &[CertificateDer<'_>], _: &ServerName<'_>, _: &[u8], _: UnixTime) -> Result<ServerCertVerified, rustls::Error> {
        let fp = fingerprint_der(end_entity.as_ref());
        *self.seen.lock().unwrap() = Some(fp.clone());
        match &self.expected {
            Some(e) if *e != fp => Err(rustls::Error::General(format!("certificate fingerprint changed (got {fp})"))),
            _ => Ok(ServerCertVerified::assertion()),
        }
    }
    fn verify_tls12_signature(&self, message: &[u8], cert: &CertificateDer<'_>, dss: &DigitallySignedStruct) -> Result<HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls12_signature(message, cert, dss, &self.provider.signature_verification_algorithms)
    }
    fn verify_tls13_signature(&self, message: &[u8], cert: &CertificateDer<'_>, dss: &DigitallySignedStruct) -> Result<HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls13_signature(message, cert, dss, &self.provider.signature_verification_algorithms)
    }
    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.provider.signature_verification_algorithms.supported_schemes()
    }
}

pub fn client_config(verifier: Arc<PinnedVerifier>) -> Arc<rustls::ClientConfig> {
    let cfg = rustls::ClientConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
        .with_safe_default_protocol_versions()
        .expect("tls versions")
        .dangerous()
        .with_custom_certificate_verifier(verifier)
        .with_no_client_auth();
    Arc::new(cfg)
}
