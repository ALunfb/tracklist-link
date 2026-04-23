//! Origin + Host header validation.
//!
//! The WS upgrade request carries an `Origin` header reflecting the
//! document that initiated the connection. We allowlist against the config.
//! Combined with the `Host` check (must be `127.0.0.1:<port>` or
//! `localhost:<port>`), this foreclosures cross-site connections and DNS
//! rebinding attacks before the WebSocket upgrade completes.

pub fn check_origin(allowed: &[String], presented: Option<&str>) -> bool {
    let Some(p) = presented else {
        return false;
    };
    // Normalize: strip trailing slash just in case. Ports must match.
    let p = p.trim_end_matches('/');
    allowed.iter().any(|a| a.trim_end_matches('/') == p)
}

pub fn check_host(port: u16, presented: Option<&str>) -> bool {
    let Some(h) = presented else {
        // Some WS clients omit Host during manual upgrades. For defense in
        // depth we insist on its presence.
        return false;
    };
    let expected_1 = format!("127.0.0.1:{}", port);
    let expected_2 = format!("localhost:{}", port);
    h == expected_1 || h == expected_2
}
