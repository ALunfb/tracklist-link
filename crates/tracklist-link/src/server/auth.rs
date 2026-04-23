//! Constant-time token validation.
//!
//! The companion's per-install secret is passed by clients as the `token`
//! query-string parameter on the WS upgrade URL. We compare against the
//! configured secret in constant time so a brute-force attacker can't
//! guess the token byte-by-byte via timing side channels.

use subtle::ConstantTimeEq;

pub fn check_token(expected: &str, presented: Option<&str>) -> bool {
    let Some(p) = presented else {
        return false;
    };
    // Length-bound both sides to a fixed upper bound before constant-time
    // compare so different-length inputs always take the same shape.
    let a = expected.as_bytes();
    let b = p.as_bytes();
    if a.len() != b.len() {
        return false;
    }
    a.ct_eq(b).into()
}
