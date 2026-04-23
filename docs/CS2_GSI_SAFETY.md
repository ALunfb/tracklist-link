# CS2 GSI — Strict Safety Requirements

**This document governs any Counter-Strike 2 Game State Integration (GSI) work in this project. Every future contributor, automated agent, and reviewer must read and respect these rules before touching CS2-adjacent code. These rules are non-negotiable.**

The project maintainer's Steam account holds tens of thousands of dollars of inventory. A VAC ban is catastrophic and non-recoverable. Treat this as a hard safety requirement, not a preference.

## Absolute rules — do not violate under any circumstance

1. **READ-ONLY relationship with CS2.** The implementation must only receive HTTP POST requests that CS2 itself sends to a localhost endpoint. Nothing in this codebase may read, write, scan, inspect, hook, or otherwise interact with the CS2 game process, its memory, its window, or its files.

2. **No process interaction of any kind.** Do not use, suggest, or import any library that:
   - Reads or writes process memory (e.g., `ReadProcessMemory`, `WriteProcessMemory`, `/proc/<pid>/mem`, memory scanners).
   - Injects into processes (DLL injection, manual mapping, `LoadLibrary`, `CreateRemoteThread`).
   - Hooks APIs, the rendering pipeline, or input (Detours, MinHook, overlay libraries like Overwolf SDK, Discord-style overlays).
   - Enumerates, attaches to, or inspects the CS2 process (`pymem`, `frida`, `node-ffi` used against `cs2.exe`, debugger attachment).
   - Reads or modifies anything inside the CS2 install directory beyond the single `.cfg` file described below.

3. **No modification of game files.** The ONLY file this project is allowed to create inside the CS2 install directory is a single GSI config file at exactly this path:

   ```
   <Steam>/steamapps/common/Counter-Strike Global Offensive/game/csgo/cfg/gamestate_integration_<name>.cfg
   ```

   Note: the folder is still named "Counter-Strike Global Offensive" even though the game is CS2 — **this is correct, do not "fix" it.** The file must be a standard Valve GSI config in VDF/KeyValues format (see the official Valve Developer wiki page for "Counter-Strike: Global Offensive Game State Integration"). Do not touch VPKs, binaries, other `.cfg` files, `.vcfg` files, or anything else in the game folder. If automating this file's creation is risky or unclear, prefer giving the maintainer instructions to place it manually.

4. **No third-party "helper" libraries.** Do not suggest packages that claim to "enhance" GSI by pulling additional data from the game. If data isn't exposed in the JSON CS2 sends to the listener, it doesn't exist for this project. Acceptable dependencies are limited to general-purpose web frameworks (Express, Fastify, Flask, Axum, Actix, etc.) and standard JSON/HTTP libraries.

5. **No overlays that draw on the game.** This project outputs to a browser page intended for OBS Browser Source only. Do not suggest transparent desktop overlays, DirectX/OpenGL hooks, or anything that renders on top of the CS2 window.

6. **No CS2 launch option modifications.** GSI does NOT require any launch option — CS2 automatically loads any `gamestate_integration_*.cfg` file in the cfg folder at startup. Do not suggest adding launch options to Steam. In particular, **never** suggest `-allow_third_party_software` or `-insecure`, as these are associated with lowered trust factor and VAC issues.

7. **No console commands or in-game modifications.** Do not suggest running commands in the CS2 developer console, modifying `cs2_user_convars.vcfg`, `cs2_user_keys.vcfg`, or any autoexec file. GSI is fully configured by the single `.cfg` file in rule 3.

## What the implementation should do

- Run a local HTTP server that listens on a localhost port (e.g., `http://127.0.0.1:<port>`).
- Accept POST requests from CS2 containing JSON game state.
- Parse and expose that JSON to the rest of the project (and/or serve a webpage consumable as an OBS Browser Source).
- **That's it. Nothing else involving CS2.**

## Before writing code

Any time you approach CS2 GSI work, you must:

1. Confirm in writing that you understand these constraints and will not deviate from them.
2. Explain the proposed architecture in plain terms so the maintainer can verify no part of it interacts with the game process.
3. List every dependency you plan to add and justify why each is safe (general-purpose, no process interaction).
4. Flag explicitly if anything you've been asked for elsewhere in this project conflicts with these rules — **do not silently work around it.**

## If in doubt

If at any point you are uncertain whether something is safe, **stop and ask.** The maintainer would rather have a partially working integration than a subtle risk introduced by a well-intentioned addition. "This is probably fine" is not acceptable reasoning on this project.

---

This document was authored by the maintainer and must not be edited without their explicit sign-off. Summarize, quote, or reference it in other docs, but do not relax or reinterpret any rule above.
