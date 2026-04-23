# Security Policy

Tracklist Link runs on the streamer's machine with access to the default audio
output device. The trust model matters: streamers are sensitive to anything
that could leak audio, expose their machine, or turn into a doxing vector.
This document enumerates the threats we defend against, the controls we use,
and the threats we don't defend against.

## Threat model

### T1. Unauthorized audio capture by other processes
A malicious or curious process on the same machine attempts to subscribe to
audio data.

**Control:** every connection requires a per-install auth token. The token is
a 32-byte secret, generated at first run, stored in the Windows Credential
Manager (not the raw filesystem), and never transmitted off-machine. All
auth comparisons use constant-time equality (via `subtle::ConstantTimeEq`)
to foreclose timing attacks.

### T2. Unauthorized audio capture by a drive-by website
A public site in the streamer's regular browser discovers the companion port
and tries to open a WebSocket.

**Control:** the WebSocket upgrade handler validates the `Origin` header
against a strict allowlist (`https://music.blackpearl.gg` plus `localhost`
variants for dev). Unknown origins are rejected before the upgrade response.
Combined with the auth token, a random page can't stumble into a working
session.

### T3. DNS rebinding
An attacker tricks the browser into treating `attacker.com` as same-origin
with `127.0.0.1` via an A-record flip.

**Control:** the upgrade handler also validates `Host: 127.0.0.1:<port>` or
`Host: localhost:<port>`. Any other Host header is a rejection. Combined
with the Origin check, rebinding fails before reaching WebSocket state.

### T4. Memory-safety CVEs
Buffer overflow / UAF / double-free in audio decoders, WebSocket parsers,
etc.

**Control:** **the entire companion is Rust**. The borrow checker eliminates
entire CVE categories that plague C/C++ audio software. Third-party deps are
audited with `cargo-geiger`; any `unsafe` code outside the standard library
is reviewed.

### T5. Exfiltration (a malicious or compromised companion uploads audio)
If the companion itself is compromised (supply-chain attack on a dependency,
or malicious code merged), it could relay audio to a remote attacker.

**Controls:**
- No outbound network calls are permitted in the audio path. The binary
  pattern-matches: only the update-check endpoint (`github.com/ALunfb/tracklist-link/releases`)
  is invoked, once per day.
- Audit-log every outbound socket opened, persisted in a rotating log the
  streamer can inspect.
- Reproducible builds: `cargo build --locked` from the source tree produces
  a binary whose hash matches the signed release.
- Open source — all code is public. Third-party audits welcome.

### T6. Auto-update poisoning
A compromised update channel pushes a malicious release.

**Control:** release artifacts are Minisign-signed (Ed25519). The public key
is embedded in the binary at compile time and cannot be swapped at runtime.
Users who distrust our signing key can disable auto-update and install
releases manually.

### T7. Token theft from disk
Malware on the machine reads the auth token file.

**Control:** the token is stored in the Windows Credential Manager via the
`keyring` crate, not plain disk. The file-system artifact is a salted nonce,
not the secret itself. The secret is only in memory while the companion is
running.

### T8. User confusion / unclear intent
Streamer installs the app but doesn't realize what it does or when.

**Controls:**
- Tray icon is always visible. Right-click surfaces an always-accurate
  status panel: what's subscribed, who is subscribed, when they connected.
- On first pair-request, a single OS dialog asks for explicit consent:
  "Pair with https://music.blackpearl.gg? This grants the site audio
  spectrum data until you revoke."
- The status panel shows **every connection** with its origin + subscribed
  topics. The streamer can revoke at any moment.
- The tray icon pulses when any client is actively subscribed so the
  streamer can tell at a glance that audio is being read.

### T9. Doxing via audio-leak
Audio from an open mic captured in the same buffer as music — voice leaks.

**Controls:**
- Default capture target is the default system **output** device only. Mic,
  webcam audio, and screen audio are never accessed.
- The capture API uses WASAPI loopback mode, which taps the output mix. It
  physically cannot read mic input.
- A future voice-activity-detection feature (which would require mic access)
  must be behind a separate, per-feature consent prompt. This is enforced in
  code by a feature flag not bundled in the default binary.

### T10. Supply-chain attack on dependencies
A compromised crate in the tree pulls in malicious code at build.

**Controls:**
- `Cargo.lock` is committed; every dep is pinned to a hash.
- `deny.toml` blocks known-vulnerable versions (auto-generated from
  [RustSec](https://rustsec.org/) advisories).
- GitHub Actions builds from source with pinned toolchain; no pre-built
  binaries in the CI pipeline.

## Threats we don't (currently) defend against

- **Streamer's machine is already compromised.** If an attacker has kernel
  access, process injection, or elevated privileges on the streamer's
  machine, they can already read audio from any source. No user-space
  companion app can protect against this.
- **Physical access to the machine.** Same reasoning.
- **Browser-level MITM against github.com during auto-update.** We rely on
  the OS trust store + HTTPS + Minisign. If a user's trust store is tampered
  with, all bets are off.

## Reporting a vulnerability

Open a **private security advisory** on the GitHub repo rather than a public
issue. We aim to acknowledge within 48 hours and ship a fix (or rollback) in
a point release as soon as the scope is clear.

## Defaults for sensitive behavior

| Behavior | Default |
|---|---|
| Audio capture target | System default output device only |
| Audio capture target (mic) | Disabled; requires separate consent |
| Bind address | `127.0.0.1` only |
| Origin allowlist | `https://music.blackpearl.gg` + `http://localhost:*` |
| Auto-start on login | On |
| Audit log | On; ~7 day retention |
| Outbound network | Only GitHub Releases for update check, once/day |
| Auto-update | Opt-in after v1.0 ships; defaults toward manual |
