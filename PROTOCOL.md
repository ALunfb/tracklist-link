# Tracklist Link Protocol

Client-to-companion wire protocol. JSON frames over a single WebSocket
connection, versioned via the `v` field in the initial Hello message.

## Endpoint

```
ws://127.0.0.1:<port>/ws?token=<auth-token>
```

- **Port** — default `38475`. Configurable via the companion's config file.
- **Scheme** — `ws://` (not `wss://`). Chrome / Chromium (which OBS Browser
  Source embeds) treats `127.0.0.1` as a secure origin and exempts it from
  mixed-content blocking, so https pages can connect to `ws://127.0.0.1`
  without errors.
- **Token** — passed as `?token=...` query param. The companion
  constant-time compares against its stored secret. Missing or wrong token
  yields HTTP 401 before the WS upgrade.
- **Origin check** — the `Origin` header must be in the allowlist:
  `https://music.blackpearl.gg`, `http://localhost:<any>`,
  `http://127.0.0.1:<any>`. Anything else: 403.
- **Host check** — the `Host` header must be `127.0.0.1:<port>` or
  `localhost:<port>`. DNS rebinding protection.

## Handshake

Once connected, the companion sends a `Hello` frame:

```json
{
  "kind": "hello",
  "v": 1,
  "app_version": "0.1.0",
  "sample_rate": 48000
}
```

Client MUST verify `v` matches its expected version. If different, client
should log + disconnect.

## Subscribing

```json
{ "kind": "subscribe", "topics": ["audio/fft/64", "audio/level"] }
```

Topics are additive and idempotent. Re-subscribing to the same topic is
harmless.

```json
{ "kind": "unsubscribe", "topics": ["audio/level"] }
```

## Topics

### `audio/fft/64`

64-band FFT, ~60 Hz.

```json
{
  "kind": "audio/fft",
  "bins": 64,
  "seq": 12847,
  "t_ms": 1716327910234,
  "bands": [0.12, 0.09, 0.41, /* ... 64 floats in 0..1 */]
}
```

Band allocation: logarithmic 20 Hz → 20 kHz split into 64 bins. Normalized
so typical music peaks at ~0.7, loud transients at ~1.0. Clipped, not
rescaled — transient spikes above 1.0 are rare but can happen.

### `audio/fft/512`

512-band FFT at ~30 Hz. Same shape as `audio/fft/64` but `bins: 512` and
`bands` is length 512. For spectrum analyzers + lyrics-sync detailed
matching.

### `audio/level`

Simple amplitude.

```json
{
  "kind": "audio/level",
  "seq": 4301,
  "t_ms": 1716327910234,
  "rms": 0.34,
  "peak": 0.82
}
```

### `audio/beat`

Onset event (future topic). Fires only when the onset detector identifies a
beat candidate. `confidence` is a 0..1 heuristic.

```json
{
  "kind": "audio/beat",
  "seq": 183,
  "t_ms": 1716327910234,
  "confidence": 0.78
}
```

### `audio/bpm`

BPM estimate (future topic). Fires on change (>= 2 BPM delta).

```json
{
  "kind": "audio/bpm",
  "t_ms": 1716327910234,
  "bpm": 126.4,
  "confidence": 0.91
}
```

### `system/heartbeat`

Sent every 2 seconds to every connected client regardless of subscription.
Lets clients detect dead connections faster than the OS-level TCP keepalive.

```json
{
  "kind": "system/heartbeat",
  "t_ms": 1716327910234,
  "subscribers": 3,
  "uptime_since_ms": 1716320000000
}
```

## Ping / Pong

Client may send a ping at any time. Companion responds immediately.

```json
{ "kind": "ping", "nonce": 42 }
```

```json
{ "kind": "pong", "nonce": 42 }
```

## Backpressure

The companion uses a bounded broadcast channel (capacity: 64 frames per
topic). If a client is slow to read, frames are dropped on its stream. The
frame `seq` counter lets clients detect drops:

```
client received seq 14, 15, then 18 → dropped 16, 17
```

Clients should NOT attempt retransmission. The data is ephemeral; the next
frame is already on its way.

## Evolution

Additive changes (new `kind` values, new topics, new optional fields on
existing messages) do not bump the protocol version. Clients MUST ignore
unknown `kind` values and unknown fields.

Breaking changes bump `v` and the companion serves both old and new
versions for one minor release. The `Hello` message tells a new client the
companion's minimum and maximum supported `v`.

## Why JSON not protobuf?

The primary consumer is a browser overlay. JSON avoids a binary schema
build step, is trivially inspectable in devtools, and the per-frame payload
(64 floats + a few ints) is ~800 bytes uncompressed — WebSocket's permessage-
deflate gets that down to ~200 bytes. The bandwidth cost of binary would
shave a few kilobytes per second, not worth the developer-experience hit.
