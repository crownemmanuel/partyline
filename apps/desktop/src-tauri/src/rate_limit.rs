//! Join attempts: 5 failures per minute per IP, then a 5 minute lockout (ARCHITECTURE §5.2).
use std::collections::HashMap;
use std::time::{Duration, Instant};

#[derive(Default)]
pub struct RateLimiter {
    ips: HashMap<String, Entry>,
}
#[derive(Default)]
struct Entry {
    fails: Vec<Instant>,
    locked_until: Option<Instant>,
}

const WINDOW: Duration = Duration::from_secs(60);
const MAX_FAILS: usize = 5;
const LOCKOUT: Duration = Duration::from_secs(300);

impl RateLimiter {
    /// Seconds to wait if this IP is locked out.
    pub fn check(&mut self, ip: &str) -> Option<u64> {
        let e = self.ips.get(ip)?;
        let until = e.locked_until?;
        let now = Instant::now();
        (until > now).then(|| (until - now).as_secs().max(1))
    }
    pub fn fail(&mut self, ip: &str) {
        let now = Instant::now();
        let e = self.ips.entry(ip.to_string()).or_default();
        e.fails.retain(|t| now.duration_since(*t) < WINDOW);
        e.fails.push(now);
        if e.fails.len() >= MAX_FAILS {
            e.locked_until = Some(now + LOCKOUT);
            e.fails.clear();
        }
        if self.ips.len() > 10_000 {
            self.ips.retain(|_, e| e.locked_until.map_or(false, |u| u > now) || !e.fails.is_empty());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn locks_after_five() {
        let mut r = RateLimiter::default();
        for _ in 0..4 {
            r.fail("1.2.3.4");
            assert!(r.check("1.2.3.4").is_none());
        }
        r.fail("1.2.3.4");
        assert!(r.check("1.2.3.4").unwrap() > 200);
        assert!(r.check("5.6.7.8").is_none());
    }
}
