# Reactive Signals — Framework

Every interesting feature in Tracklist Link — audio-reactive visuals, overlay pulses, future CS2 GSI hooks, hypothetical chat-triggered effects — is the same basic shape: **something happens, consumers react**. Rather than bolting each case onto the system separately, the companion models them as *reactive signals* flowing through a single pub/sub bus.

This doc is the contract. New producers (beat detection, CS2 GSI listener, chat event adapter, etc.) should emit signals in this shape. New consumers (visualizer flash, overlay border pulse, OBS scene auto-switch, future audio ducking) should subscribe against it without caring where the signal came from.

## The shape

Every signal is:

```json
{
  "kind": "<string>",
  "t_ms": 1712345678901,
  "confidence": 0.82
}
```

Optional fields depending on the `kind`:
- `bands`: `number[]` for FFT frames (`audio/fft/*`)
- `rms`, `peak`: `number` for level (`audio/level`)
- `payload`: topic-specific nested object (used by `game/cs2/*`)

The outer `kind` is the wire discriminator — it's the value the client subscribes against via `Subscribe { topics: [...] }`.

## The bus

- A single `tokio::sync::broadcast::Sender<AudioFrame>` (and, later, a parallel `GameFrame`) inside the companion process.
- WebSocket server subscribes, fans out per-connection based on the client's topic set.
- Tauri IPC event bridge also subscribes, emits `audio-*` / `game-*` events to the local UI (no origin/token dance needed for the in-process case).

Producers *push* into the bus. Consumers *filter by topic* on the way out. The bus itself doesn't know or care what the signals mean.

## Topics — current + planned

| Topic | Producer | Shape | Status |
|-------|----------|-------|--------|
| `audio/fft/64` | audio capture + realfft | `FftFrame { bins, seq, t_ms, bands }` | shipped |
| `audio/level` | audio capture | `LevelFrame { seq, t_ms, rms, peak }` | shipped |
| `audio/beat` | beat detector | `BeatEvent { seq, t_ms, confidence, kind }` | **this release** |
| `audio/bpm` | BPM estimator | `BpmEstimate { t_ms, bpm, confidence }` | reserved |
| `audio/fft/512` | higher-res FFT | same as fft/64 with 512 bins | reserved |
| `system/heartbeat` | server loop | `Heartbeat { t_ms, subscribers, uptime_since_ms }` | shipped |
| `game/cs2/player` | CS2 GSI listener | `{ payload: <gsi player json subset> }` | planned |
| `game/cs2/round` | CS2 GSI listener | `{ payload: <gsi round json subset>, kind: "start"\|"end"\|"plant"\|"defuse"\|"win" }` | planned |
| `game/cs2/match` | CS2 GSI listener | `{ payload: <gsi match json subset> }` | planned |
| `game/cs2/raw` | CS2 GSI listener | opaque gsi blob, advanced consumers | planned |

Adding a new topic = add a variant to `ServerMessage`, add a topic string to `Topic::<Name>`, implement a producer that pushes into the bus.

## Contract for producers

1. **Never block the bus.** All production goes through `broadcast::Sender::send`, which is wait-free. If no receiver exists, the message is dropped — callers don't stall.
2. **Always carry `t_ms`.** Wall-clock milliseconds since the Unix epoch. Consumers correlate across topics (e.g., "was this beat near a round_win?") by timestamp.
3. **Carry `confidence` when the signal is derived.** FFT bands are measured — no confidence needed. Beat detection is derived — emit confidence so consumers can threshold. CS2 GSI events from the game are authoritative — confidence 1.0.
4. **Prefer fine-grained topics over generic ones.** `game/cs2/round` rather than `game/generic`. Lets subscribers narrow by event family without filtering in the handler.
5. **No producer talks to the UI directly.** Always go via the bus. Future tests, integration layers, etc. all benefit from the single path.

## Contract for consumers

1. **Subscribe to the topics you need, not everything.** The broadcast channel buffers 64 messages; a lagging consumer drops frames, not crashes — but narrow subscription means you never lag in the first place.
2. **Use `t_ms` for correlation, not wall-clock at handler time.** Network + IPC jitter makes the latter unreliable for "did these two events co-occur".
3. **Handle unknown kinds gracefully.** When a new topic is added, older consumers should ignore it. The protocol is additive by design.
4. **Separate transport from effect.** A React component that flashes the overlay accent on `audio/beat` should NOT also know about WebSocket URLs, origin headers, or Tauri IPC. Hooks (`useLiveBeat`, `useLiveFft`) wrap transport; components consume the hook.

## Consumer effects — the matrix

Once a signal flows, any consumer can bind to it. The matrix that emerges is what makes the system feel "integrated":

| Consumer | `audio/beat` | `audio/level` | `game/cs2/round` | `game/cs2/player` |
|----------|:---:|:---:|:---:|:---:|
| Companion visualizer | accent flash | gain bump | scene swap | camera shake |
| Overlay card | border pulse | bar wiggle | color theme | icon indicator |
| Future: OBS scene auto-switch | - | silence→break scene | match end→post-match | clutch→dramatic |
| Future: chat bot | - | - | - | kill announcer |

Current release ships the top-left cell (beat → accent flash). Every other cell becomes cheap once the signal exists on the bus.

## Why this matters for CS2 GSI

Per [`CS2_GSI_SAFETY.md`](./CS2_GSI_SAFETY.md), the CS2 GSI listener is exclusively an HTTP receiver. When it lands:

1. It'll receive JSON POSTs from CS2.
2. It'll parse a narrow slice (round state, player state, match state).
3. It'll push into the bus as `game/cs2/*` frames.

Every reactive consumer written against this framework (viz flash, overlay pulse, etc.) automatically gets CS2 awareness with **zero consumer changes**. The producer is the only new code.

This is the intentional payoff of building beat detection first as a framework-compliant producer rather than as a one-off. The same hooks, handlers, and effect layers will drive CS2 reactions the day the listener ships.

## Non-goals

- **Not an in-app scripting language.** Consumers are React / Rust code, not user-provided expressions. (If that becomes a feature, it belongs in a sandboxed layer above this one.)
- **Not a distributed event bus.** Everything is in-process. The WS fan-out is a *transport* from in-process to external consumers (overlays in OBS, etc.), not a distributed topology.
- **Not persistent.** Signals are instantaneous. If you want history (e.g., "beats over the last hour"), build a separate sink that subscribes to the bus and stores.
