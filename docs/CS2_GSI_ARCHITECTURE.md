# CS2 GSI — Proposed Architecture (for maintainer review)

Sibling to [`CS2_GSI_SAFETY.md`](./CS2_GSI_SAFETY.md). That file establishes
the hard safety rules; this one proposes an implementation that fits inside
them. **Do not write any CS2 code until the maintainer signs off on this
document.** Any deviation from what's written here requires re-approval.

This is an architecture pass, not a PR. Nothing below has been implemented.

---

## Scope

Counter-Strike 2 ships with a Game State Integration feature that lets the
game POST JSON game-state snapshots to a local HTTP listener when configured
via a single `.cfg` file in the game's cfg folder. The game initiates these
requests on its own schedule (typically 10–60 Hz depending on events). The
companion's role here is **exclusively to be an HTTP sink.** Nothing else.

What this unlocks for Tracklist:

- Audio-reactive effects that *also* react to CS2 events (round win → beat
  drop hit, player death → muted visualizer, bomb planted → tension overlay).
- Overlay widgets showing score / round / player state alongside the
  now-playing card.
- Stat surfacing in the editor pack (tracks that played during clutch moments).

## Non-goals (enforced by [`CS2_GSI_SAFETY.md`](./CS2_GSI_SAFETY.md))

All process memory access, DLL injection, API hooking, VPK or binary
modification, desktop overlays drawn on the game, launch-option changes,
console-command automation, and third-party data-extraction libraries are
**forbidden**. The implementation is HTTP-sink + JSON parse only.

---

## Components

```
┌──────────┐   HTTP POST JSON   ┌──────────────────┐   broadcast   ┌────────────┐
│   CS2    │ ─────────────────▶ │ gsi listener     │ ────────────▶ │ ws clients │
│  (game)  │  127.0.0.1:<port>  │ (Axum on tokio)  │  game/cs2/*   │            │
└──────────┘                    └──────────────────┘               └────────────┘
     ▲
     │ reads
     │
gamestate_integration_tracklist.cfg  ← written once to the CS2 cfg folder
                                        by the companion on first-run setup
                                        (or by the user manually — safer
                                        default).
```

### New topics

Extend the existing pub/sub protocol (topics like `audio/fft/64`) with:

- `game/cs2/player`   — player state, alive/dead, weapons, health.
- `game/cs2/round`    — round phase, bomb plant/defuse, win/loss.
- `game/cs2/match`    — score, map, CT/T side.
- `game/cs2/raw`      — the full unparsed JSON blob, for advanced clients.

Every topic carries a `seq` counter and `t_ms` timestamp just like the
audio topics. Additive; the companion keeps serving audio topics exactly
as before to existing clients.

### HTTP listener

A second `TcpListener` bound to `127.0.0.1:<gsi_port>` (separate port from
the WS endpoint). Single POST route. Reads body, parses JSON, validates
against an expected GSI shape, broadcasts on the tokio broadcast channel
(same bus the audio capture feeds).

**Why a separate port:** keeps the WS origin/token auth pristine —
CS2's POST has no Origin header and no way to present a token. Mixing them
would either break the audio WS auth or compromise the GSI listener.

**Authentication:** CS2's GSI config can include a shared secret that CS2
sends in the POST body. The companion checks it. See "Auth" below.

### Dependencies (exhaustive; to be added to `Cargo.toml`)

- `axum` (≥ 0.7) or `hyper` directly — general-purpose HTTP server. No
  process interaction.
- `serde_json` — already a workspace dep.
- `tokio` — already a workspace dep.

**That's the full dependency diff.** No `cs2-*` crate, no `steam-*` crate,
no inventory or process enumeration library. Per
[`CS2_GSI_SAFETY.md`](./CS2_GSI_SAFETY.md) rule #4.

---

## Real-world validation — SteelSeries Engine

Users commonly already have a SteelSeries GSI config sitting in the same
cfg folder, which confirms two things about our design:

1. **Multi-vendor coexistence.** CS2 loads *every* `gamestate_integration_*.cfg`
   it finds and POSTs to each URI independently. Adding ours alongside
   SteelSeries's (or any other integration) does not interfere with them
   and they do not interfere with us.
2. **Our format matches the standard.** SteelSeries's file is structurally
   identical to what we propose below.

Reference (SteelSeries Engine ships this pattern in production):

```
"SteelSeries Engine v 1.0"
{
    "uri"       "http://127.0.0.1:62111/csgo_game_event"
    "timeout"   "5.0"
    "buffer"    "0.1"
    "throttle"  "0.1"
    "heartbeat" "0.1"
    "auth"
    {
        "key1" "rx54AtFVYw2bXmCCWJu6"
        "key2" "6HMGuv2F8m5grBFy292d"
    }
    "data"
    {
        "provider"            "1"
        "map"                 "1"
        "round"               "1"
        "player_id"           "1"
        "player_state"        "1"
        "player_weapons"      "1"
        "player_match_stats"  "1"
    }
}
```

Two intentional deltas between theirs and our proposal:

- **Heartbeat.** They use `"0.1"` (100 ms) for LED liveness polling; we use
  `"5.0"` (5 s) since we only care about game-state deltas, not a liveness
  pulse. Lower traffic, zero UX cost.
- **Auth shape.** They use `key1` + `key2` (two keys CS2 echoes in the POST
  body). We use a single `token`. CS2 accepts either; one key is simpler
  to validate and we have no need for role-separated keys.

## Config file content

Written to (or instructed for manual placement at):
```
<Steam>/steamapps/common/Counter-Strike Global Offensive/game/csgo/cfg/gamestate_integration_tracklist.cfg
```

Canonical content:
```
"Tracklist Link v1.0"
{
    "uri"       "http://127.0.0.1:38476/gsi"
    "timeout"   "5.0"
    "buffer"    "0.1"
    "throttle"  "0.1"
    "heartbeat" "5.0"
    "auth"
    {
        "token" "<per-install-auth-token>"
    }
    "data"
    {
        "provider"            "1"
        "map"                 "1"
        "round"               "1"
        "player_id"           "1"
        "player_state"        "1"
        "player_weapons"      "1"
        "player_match_stats"  "1"
        "allplayers_id"       "0"
    }
}
```

Notes:
- Distinct port from the WS endpoint (38476 vs 38475).
- `auth.token` is a per-install secret (separate from the audio token) so
  even if the audio token leaks to a pastebin, the GSI listener is
  independently protected.
- `allplayers_id` defaults to `0` — we don't need other players' data
  for Tracklist features, and it's not available outside spectator/demos
  anyway.
- `buffer` + `throttle` at 0.1s means ~10 Hz updates with event bursts
  bundled — plenty for overlay reactions.

## First-run setup

**Preferred path — manual placement:** the dashboard shows the exact file
content + target path, and a "Copy config" button. The streamer pastes
into Notepad, saves to the path, done.

**Optional automation:** the tray menu grows a "Set up CS2 GSI" item that:
1. Detects the Steam install via the Windows registry
   (`HKCU\Software\Valve\Steam\SteamPath`).
2. Walks `libraryfolders.vdf` to find the library that actually contains
   CS2 (Steam games can live on any drive).
3. Confirms the `cfg` directory exists and is writable.
4. Writes the config file — only this file. Reads nothing else from the
   game directory.
5. Prompts the streamer to restart CS2 (loadtime-only pickup).

If any step fails, we fall back to manual instructions. We never assume
paths, never write anywhere outside that one `.cfg`, and never touch
other files in the `cfg` folder.

## Auth

Three moving parts, none of them related to the audio auth:

1. **GSI listener token** — secret in the `.cfg`. CS2 sends it in the POST
   body's `auth.token` field. Companion rejects POSTs without a match
   (constant-time compare).
2. **Host check** — companion's listener binds `127.0.0.1` only (same
   policy as the WS server). CS2 runs on the same machine, so this is
   always satisfied.
3. **Method + path** — only `POST /gsi` is routed. All other requests
   return 404 without auth work.

No third-party library handles the auth — it's a three-line `subtle`-based
constant-time compare against the per-install secret.

## Data flow end-to-end

1. Streamer installs companion, runs first-time GSI setup (manual or
   tray-driven). Token written to `.cfg`.
2. Companion starts. Second listener comes up on `127.0.0.1:<gsi_port>`.
3. CS2 launches, reads every `gamestate_integration_*.cfg` at startup,
   begins POSTing to the URI in the file.
4. Companion receives POST, verifies token, parses JSON, extracts the
   subset Tracklist cares about, publishes to `game/cs2/*` topics on the
   broadcast bus.
5. Subscribed WS clients receive the events alongside audio/fft frames.
6. Overlay uses them: "round won" → flash accent, "player dead" → dim
   analyzer, etc.

## What's explicitly NOT in this design

Per the safety charter, and stated plainly so no future agent silently adds
any of these:

- ❌ Reading CS2 process memory, or any process-level data.
- ❌ Attaching to the CS2 window, enumerating it, or sending input events
  to it.
- ❌ Reading Steam inventory, market, or any non-GSI Valve API.
- ❌ Rendering overlays drawn onto the CS2 window (Overwolf-style).
- ❌ Modifying launch options, autoexec, or other config files.
- ❌ Console-command automation.
- ❌ Third-party "GSI enhancer" libraries.
- ❌ Auto-updating the `.cfg` after first-run without explicit streamer action.

If any future requirement seems to want one of these, **stop, ask,
redesign.** Do not compromise the no-process-interaction invariant.

---

## Open questions for maintainer review

Please respond inline or in a follow-up comment. No code goes in until
these are answered.

1. **Port allocation.** Current proposal uses 38476 for GSI (audio is 38475).
   Collision-unlikely but arbitrary — preference?
2. **Config auto-write.** Safer default is manual paste. OK to ship *only*
   the manual path for M4 and add auto-write later, or prefer auto-write
   with a big confirmation modal?
3. **Shared auth.** Current proposal uses a separate GSI token. Simpler
   alternative: reuse the audio token. Tradeoff: one leak compromises both
   surfaces. Prefer separate or same?
4. **Topic granularity.** Four topics (`player`, `round`, `match`, `raw`)
   — enough, too many, too few?
5. **Which CS2 mode.** GSI fires in competitive, premier, deathmatch,
   casual, and workshop. Any mode you'd want the companion to ignore (e.g.
   workshop → avoid polluting real-match stats)?

Once these land, we can implement in a single bounded PR: `axum` dep,
listener module, topic serde, tray menu item, documentation.
