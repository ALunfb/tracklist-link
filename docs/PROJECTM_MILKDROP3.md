# projectM / MilkDrop 3 — Plan

Phase 5 of the companion roadmap. Nothing here is implemented; this doc scopes the work so we can sequence it honestly.

## Why projectM

Butterchurn (Phase 2, shipped) renders MilkDrop 2 presets in the browser via WebGL. Two things it can't do:

1. **Full pixel-shader presets** — some MilkDrop 2 presets use HLSL pixel shaders that Butterchurn either approximates poorly or ignores. The visual gap is noticeable on flagship presets like Geiss's later work.
2. **MilkDrop 3 `.milk3` files.** MilkDrop 3 (shipped 2023) introduced a new format with more powerful shader features. Butterchurn doesn't support it at all. The projectM project does.

projectM is a C++ library (Apache 2.0, now maintained by the Arch Linux + Winamp renaissance crowd) that:

- Parses `.milk`, `.milk2`, and `.milk3` files correctly.
- Renders them via OpenGL / OpenGL ES.
- Is what Winamp 5.9+ uses internally.
- Is a proper cross-platform native audio visualizer.

## Why not embed Butterchurn + a `.milk3` parser

Short answer: rewriting MilkDrop's shader pipeline for WebGL is a year of someone's life, and it won't fully match the reference renderer. projectM already does this work; use it.

## Architecture options

### Option A: projectM as a sidecar process

A separate binary (`tracklist-projectm.exe`) ships alongside the main companion. It's a small C++ or Rust-with-FFI program that:

1. Reads `.milk*` files from the same presets folder the companion exposes.
2. Subscribes to the companion's WS server for FFT frames (or uses the same broadcast bus via IPC).
3. Renders to its own OpenGL window.
4. OBS captures the window as a **Window Capture** source.

Tauri companion's Visualizer tab gains a **"Launch projectM window"** button that spawns the sidecar. Quit button closes it.

**Pros:**
- Clean process isolation — projectM crashes don't take down the audio pipeline.
- OBS Window Capture is well-understood by streamers.
- Can scale to multiple preset windows.

**Cons:**
- Two binaries to ship + version together.
- Window lifecycle coordination (what if streamer closes the window by mistake?).
- OpenGL context + fullscreen toggle = more failure modes.

### Option B: projectM as a native Rust dep, rendered inside Tauri

Link `libprojectm` into the companion binary. Render to an offscreen framebuffer, pipe pixels to the Tauri webview as an `ImageData` or WebGL texture.

**Pros:**
- One binary.
- Same UI as the rest of the companion.

**Cons:**
- FFI + C++ deps = much harder cross-compile. MSVC on Windows, clang on macOS, gcc on Linux.
- Moving pixels from native OpenGL → Tauri webview each frame is ~5-10 MB/s at 1080p60 — works but non-trivial IPC.
- Hard to make fullscreen in a way OBS can consume.

### Option C: Windows-native overlay window owned by the main Tauri binary

Tauri exposes `tao::window::Window` APIs. Create a second window that doesn't use Wry (no webview); render OpenGL directly into it via `glutin` or `wgpu`.

**Pros:**
- One process, no IPC pixel copies.
- Clean window lifecycle.

**Cons:**
- Mix of Tauri webview windows + native GL windows in one process is not Tauri's happy path.
- Still requires `libprojectm` FFI.

### Recommendation: Option A (sidecar)

Clearest separation of concerns. The main Tauri UI stays React/webview all the way. The projectM window is a standalone binary that the companion happens to know how to launch.

## Build + package story

Preferred path: **static-link projectM** into the sidecar binary so streamers don't need to install dependencies.

- `libprojectM` has CMake build. We'd add a `sidecars/projectm/` crate with a `build.rs` that invokes CMake.
- Or: use the `projectm` Rust crate if it's published (check current state of the ecosystem — was in progress as of 2025).
- Sidecar gets its own GitHub release alongside the main companion.

Cross-compile on CI: Windows MSVC (works with cmake + vcpkg), later macOS (SDKs), Linux (pkg-config).

## Audio input bridge

Sidecar needs the same FFT frames the Butterchurn tab gets. Two paths:

1. Subscribe to the companion's WS server on `127.0.0.1:38475` — same token the dashboard uses, works today, no extra work.
2. Add a second broadcast endpoint over a named pipe / unix socket, faster and doesn't round-trip through the WS auth — nice-to-have.

Start with #1. Migrate to #2 only if latency matters.

## OBS integration

Once the window exists:

- Streamer adds **Window Capture** source in OBS, picks "Tracklist projectM".
- We recommend setting the window to a fixed size matching their canvas (1920×1080 typical), keep it un-decorated, keep it borderless.
- Optional: a **"Copy OBS instructions"** button in the companion that writes the exact window name to clipboard for the capture dialog.

We do NOT want to ship a custom OBS plugin — that's a whole separate security + build surface. Window Capture is good enough.

## Timeline

| Step | Work | Estimate |
|------|------|----------|
| 1 | New `sidecars/projectm/` crate scaffold, pick library binding approach | 2 days |
| 2 | CMake / vcpkg integration for libprojectM on Windows | 3 days |
| 3 | Minimal window with a hard-coded preset, rendering with silence | 2 days |
| 4 | Wire up WS client to companion, feed audio into projectM | 2 days |
| 5 | Preset folder integration (read the companion's folder) | 1 day |
| 6 | Fullscreen + window controls (decoration, title, size) | 1 day |
| 7 | Companion UI: "Launch projectM" button, state, quit handler | 1 day |
| 8 | CI cross-compile for Windows release | 2 days |
| 9 | macOS port (deferred) | ~1 week |
| 10 | Linux port (deferred) | ~1 week |

**Windows-only MVP: ~2 weeks.** Everything that follows is cross-platform fanout.

## Open questions for maintainer

1. Are we OK shipping a second binary? (Increases update coordination.)
2. Preferred license-compat: projectM's Apache 2.0 is fine for us; any concerns?
3. Should projectM ship bundled with the companion installer, or as a separate download users opt into?
4. Default preset on first launch — pick one crowd-pleaser or boot into the last used?
