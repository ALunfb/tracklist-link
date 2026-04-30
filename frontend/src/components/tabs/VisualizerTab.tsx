import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Check,
  ChevronLeft,
  ChevronRight,
  Copy,
  Dice5,
  FolderOpen,
  Keyboard,
  Maximize2,
  Monitor,
  Pause,
  Play,
  Shuffle,
  SlidersHorizontal,
} from "lucide-react";
import { PresetGrid } from "../PresetGrid";
import { getPresetThumbnailUrl } from "../../lib/preset-catalog";
import { initPresetCatalog } from "../../lib/preset-catalog";
import { open as openUrl } from "@tauri-apps/plugin-shell";
import { ObsClient } from "../../lib/obs-websocket";
import { loadObsSettings, saveObsSettings, type ObsWsSettings } from "../../lib/obs-storage";
import butterchurn from "butterchurn";
// The npm package's pre-built JS bundles only cover ~367 of the 1738
// presets — they're a hand-picked curated subset for browser apps
// that don't want to ship the whole catalog. The full set lives as
// raw .json files under butterchurn-presets/presets/converted/, which
// the web app reads directly via its build-time catalog generator.
//
// To match the web app's catalog inside this Tauri app, we use Vite's
// import.meta.glob with eager+default to suck in all 1754 raw preset
// JSONs at build time. They get rolled into the final bundle, ~2-3 MB
// gzipped. Acceptable cost for a desktop app served from disk; the
// alternative is shipping the converted/ folder as a sidecar resource
// + reading it via Tauri at runtime, which adds complexity for no
// real benefit at this scale.
//
// The path is relative from this source file:
//   frontend/src/components/tabs/VisualizerTab.tsx
//     -> ../../../ = frontend/
//     -> node_modules/butterchurn-presets/presets/converted/*.json
const RAW_PRESET_MODULES = import.meta.glob<unknown>(
  "../../../node_modules/butterchurn-presets/presets/converted/*.json",
  { eager: true, import: "default" },
);
import { useLiveFft, useLiveSilence } from "../../lib/live-audio";
import {
  getConfig,
  listPresets,
  openPresetsFolder,
  readPreset,
  setVizSettings as setVizSettingsCmd,
  setVizPreset as setVizPresetCmd,
  getVizPreset,
  companionObsUrl,
} from "../../lib/tauri";
import {
  loadVizSettings,
  saveVizSettings,
  type VizSettings,
} from "../../lib/viz-settings";
import { VizTunePanel } from "../VizTunePanel";
import { cn } from "../../lib/cn";

/**
 * Butterchurn (MilkDrop 2) renderer driven by the companion's FFT feed.
 *
 * The trick: Butterchurn expects audio through Web Audio. We don't have
 * a MediaStream — we have bytes-per-band arriving over a Tauri event.
 * Solution: call `connectAudio()` with a silent gain node so Butterchurn
 * initializes its internal Audio struct, then monkey-patch its
 * `sampleAudio()` method to populate `freqArray` / `timeByteArray` from
 * our band ref instead of querying the (silent) analyser.
 *
 * Butterchurn's own render loop pulls from those arrays every frame, so
 * our FFT gets exactly the same treatment as real microphone audio
 * would — every preset works, no fork, no vendor patch.
 */
export function VisualizerTab() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const vizRef = useRef<ReturnType<typeof butterchurn.createVisualizer> | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const rafRef = useRef<number | null>(null);
  const bandsRef = useRef<number[] | null>(null);
  useLiveFft(bandsRef);

  // Build the bundled-preset map from RAW_PRESET_MODULES once. Each
  // entry's key is the filename (without .json), matching the web
  // app's catalog `originalFilename` minus the extension — this is the
  // key shape the rest of the picker + catalog lookup expects, so
  // R2 thumbnail URLs resolve cleanly with no name-mapping layer.
  const bundledMap = useMemo(() => {
    const out: Record<string, unknown> = {};
    for (const [path, preset] of Object.entries(RAW_PRESET_MODULES)) {
      const filename = path.split("/").pop();
      if (!filename) continue;
      const key = filename.replace(/\.json$/i, "");
      out[key] = preset;
    }
    return out;
  }, []);

  // User presets — .json files the streamer installed via the gallery
  // or dropped into the presets folder manually. Loaded asynchronously
  // on mount + refreshable via the "Refresh folder" button so installs
  // show up immediately without restarting the app.
  const [userPresetMap, setUserPresetMap] = useState<Record<string, unknown>>(
    {},
  );
  const [userLoadError, setUserLoadError] = useState<string | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);

  useEffect(() => {
    (async () => {
      try {
        const files = await listPresets();
        const loaded: Record<string, unknown> = {};
        for (const f of files) {
          if (f.kind !== "butterchurn") continue; // skip .milk/.milk2/.milk3
          try {
            const contents = await readPreset(f.filename);
            const parsed = JSON.parse(contents);
            // Display name: filename without extension, prefixed with a
            // "◯" glyph so user presets visually separate from the
            // bundled pack in the dropdown.
            loaded[`◯ ${f.name}`] = parsed;
          } catch {
            // Swallow per-preset parse errors — one bad file shouldn't
            // make the whole list vanish. Log count via state for UI.
          }
        }
        setUserPresetMap(loaded);
        setUserLoadError(null);
      } catch (err) {
        setUserLoadError((err as Error).message);
      }
    })();
  }, [refreshTick]);

  // Merged map keeps user presets first (◯ prefix sorts before most
  // letters) so installed ones are easy to find at the top.
  const presetMap = useMemo(() => {
    return { ...userPresetMap, ...bundledMap };
  }, [userPresetMap, bundledMap]);
  const presetNames = useMemo(
    () => Object.keys(presetMap).sort((a, b) => a.localeCompare(b)),
    [presetMap],
  );
  const userPresetCount = Object.keys(userPresetMap).length;

  // presetIndex restoration:
  //   1. On mount, query Rust state via getVizPreset() — that's the
  //      source of truth (set by every loadPreset). If it's non-empty
  //      and matches a known preset, use it.
  //   2. Otherwise fall back to localStorage (in case the user
  //      cold-launches the app — Rust state starts empty).
  //   3. Otherwise default to 0 (alphabetical first preset).
  // On every change, write to localStorage so the cold-launch fallback
  // is always recent.
  const [presetIndex, setPresetIndex] = useState(0);
  const [presetIndexRestored, setPresetIndexRestored] = useState(false);
  const [playing, setPlaying] = useState(true);
  const [autoCycle, setAutoCycle] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [showTune, setShowTune] = useState(false);
  const [showObsModal, setShowObsModal] = useState(false);
  const [silent, setSilent] = useState(false);
  // Copy-OBS-URL button state.
  const [obsUrlCopied, setObsUrlCopied] = useState(false);

  const onSilence = useCallback((evt: { silent: boolean }) => {
    setSilent(evt.silent);
  }, []);
  useLiveSilence(onSilence);

  // Tuning: live-editable audio + transport settings persisted to
  // localStorage. The sampleAudio override reads from settingsRef every
  // frame so slider drags feel instant without re-mounting the viz.
  const [settings, setSettings] = useState<VizSettings>(() => loadVizSettings());
  const settingsRef = useRef<VizSettings>(settings);
  useEffect(() => {
    settingsRef.current = settings;
    saveVizSettings(settings);
    // Push to the Rust server so every external WS client (web
    // /visualizer in OBS) mirrors the new values live. Fire-and-forget;
    // the local viz keeps working off settingsRef regardless.
    void setVizSettingsCmd(settings);
  }, [settings]);

  // Per-band envelope state for the attack/release smoothing applied
  // inside sampleAudio. Length auto-grows to match whatever Butterchurn's
  // analyser buffer size is the first time we see it.
  const bandEnvRef = useRef<Float32Array>(new Float32Array(0));

  // Bootstrap the preset catalog (slug + thumbnail lookup) on mount.
  // Cached in localStorage with stale-while-revalidate semantics, so
  // the picker has thumbnails available within a few hundred ms of
  // first launch and instantly thereafter.
  useEffect(() => {
    initPresetCatalog();
  }, []);

  // Mount / create the visualizer once. Re-uses the same AudioContext +
  // canvas through the lifetime of the tab so presets can cross-fade.
  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    const ctx = new AudioContext();
    audioContextRef.current = ctx;

    // Force layout so the CSS-computed 16:9 dimensions are available
    // before butterchurn initializes. Without this, an unmount/remount
    // cycle (e.g. toggling the Tune drawer) can catch clientWidth at 0
    // and butterchurn's internal render target gets stuck at 300×150.
    void canvas.getBoundingClientRect();
    const initW = canvas.clientWidth || 1280;
    const initH = canvas.clientHeight || 720;
    // CRITICAL: butterchurn's setRendererSize updates the GL viewport
    // but NOT canvas.width / canvas.height (the framebuffer
    // attributes). Without our explicit set, the canvas framebuffer
    // stays at the HTML default 300×150 and the WebGL viewport
    // (potentially much larger after a resize) renders into a
    // bottom-left chunk that's the only part visible. Manifests as a
    // dramatic zoom-into-corner crop in fullscreen / on big monitors.
    canvas.width = initW;
    canvas.height = initH;
    const viz = butterchurn.createVisualizer(ctx, canvas, {
      width: initW,
      height: initH,
      pixelRatio: Math.min(window.devicePixelRatio || 1, 2),
    });
    vizRef.current = viz;

    // Silent gain node so Butterchurn's internal audio init doesn't error
    // on the missing-source path. We don't actually want audio from the
    // context — the band data comes from our Tauri events instead.
    const silent = ctx.createGain();
    silent.gain.value = 0;
    silent.connect(ctx.destination);
    viz.connectAudio(silent);

    // Monkey-patch sampleAudio: let butterchurn's own implementation run
    // first (so it allocates / zero-fills whatever arrays its current
    // version uses — 2.6.x uses split freqArrayL/R + timeByteArrayL/R),
    // then overwrite any of the known audio fields with our FFT data.
    // Robust to library version drift: we iterate known field names and
    // only touch ones that exist, instead of hard-assuming a layout.
    const audioAny = (viz as unknown as { audio: Record<string, unknown> }).audio;
    const origSampleAudio = (audioAny.sampleAudio as () => void).bind(audioAny);

    const FREQ_FIELDS = ["freqArray", "freqArrayL", "freqArrayR"];
    const TIME_FIELDS = ["timeByteArray", "timeByteArrayL", "timeByteArrayR"];

    audioAny.sampleAudio = function () {
      // Always call the original first so butterchurn can populate / resize
      // its internal buffers from its (silent) analyser. Prevents the
      // "Cannot read property length of undefined" crash if a field we
      // try to overwrite hasn't been lazily allocated yet.
      origSampleAudio();

      const bands = bandsRef.current;
      if (!bands || bands.length === 0) return;

      // Pull live settings once per frame so mid-drag slider moves take
      // effect without having to re-mount the visualizer.
      const s = settingsRef.current;
      const gain = s.audioGain;
      const bassBoost = s.bassBoost;

      // Find the first buffer butterchurn actually allocates so we can
      // derive the target analyser-band count.
      let targetLen = 0;
      for (const field of FREQ_FIELDS) {
        const arr = (this as Record<string, unknown>)[field];
        if (arr && typeof (arr as { length?: unknown }).length === "number") {
          targetLen = (arr as Uint8Array).length;
          break;
        }
      }
      if (targetLen === 0) return;

      if (bandEnvRef.current.length !== targetLen) {
        bandEnvRef.current = new Float32Array(targetLen);
      }
      const env = bandEnvRef.current;

      // Stage 1: upsample bands + gain + bass boost (bottom third) into
      // the env buffer. Temporal smoothing already lives in Rust's FFT
      // processor — we don't layer another envelope follower here now
      // that attack/release sliders are gone.
      const bassCutoff = Math.floor(targetLen / 3);
      for (let i = 0; i < targetLen; i++) {
        const src = Math.floor((i / targetLen) * bands.length);
        let v = (bands[src] ?? 0) * gain;
        if (i < bassCutoff) {
          // Fades in over the bottom third — strongest at i=0, zero at
          // bassCutoff. Scaling factor at i=0 is (1 + bassBoost).
          const t = 1 - i / bassCutoff;
          v *= 1 + bassBoost * t;
        }
        if (v < 0) v = 0;
        if (v > 1) v = 1;
        env[i] = v;
      }

      // Stage 2: fan the envelope into every frequency buffer that exists
      // (mono + stereo-split variants) as 0..255 bytes.
      for (const field of FREQ_FIELDS) {
        const arr = (this as Record<string, unknown>)[field];
        if (arr && typeof (arr as { length?: unknown }).length === "number") {
          const buf = arr as Uint8Array;
          const n = buf.length;
          // If somehow sized differently than targetLen, just interpolate.
          for (let i = 0; i < n; i++) {
            const idx = n === targetLen ? i : Math.floor((i / n) * targetLen);
            buf[i] = Math.min(255, Math.max(0, Math.floor((env[idx] ?? 0) * 255)));
          }
        }
      }

      // Stage 3: synthesize a time-domain waveform keyed on overall
      // envelope amplitude so "wave" presets animate. Not physically
      // accurate PCM, but convincing enough for the routines that key
      // off waveform energy.
      let sum = 0;
      for (let k = 0; k < env.length; k++) sum += env[k]!;
      const amp = Math.min(1, (sum / env.length) * 3.0);
      for (const field of TIME_FIELDS) {
        const arr = (this as Record<string, unknown>)[field];
        if (arr && typeof (arr as { length?: unknown }).length === "number") {
          const buf = arr as Uint8Array;
          const n = buf.length;
          for (let i = 0; i < n; i++) {
            const osc = Math.sin((i / n) * Math.PI * 6) * amp * 96;
            buf[i] = Math.max(0, Math.min(255, 128 + Math.floor(osc)));
          }
        }
      }
    };

    // Chromium gates AudioContext construction + audio-graph work behind
    // a user gesture. Tauri's WebView2 inherits that policy. Resume once
    // we've got a handle — the visualizer needs the context actually
    // running, not just constructed, for its render path to be stable.
    void ctx.resume();

    // ResizeObserver → keep the canvas buffer matched to its layout size.
    // We sync canvas.width / canvas.height (the framebuffer) alongside
    // butterchurn's GL viewport update — see the long comment at canvas
    // creation. Without that sync, fullscreen on a wide monitor renders
    // only the bottom-left chunk of the visualizer.
    const ro = new ResizeObserver(() => {
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      if (w > 0 && h > 0) {
        if (canvas.width !== w) canvas.width = w;
        if (canvas.height !== h) canvas.height = h;
        viz.setRendererSize(w, h);
      }
    });
    ro.observe(container);

    const render = () => {
      if (!playing) {
        rafRef.current = requestAnimationFrame(render);
        return;
      }
      try {
        viz.render();
      } catch (err) {
        // Individual presets occasionally have compile errors; log + skip
        // rather than nuke the RAF loop.
        console.warn("butterchurn render error", err);
      }
      rafRef.current = requestAnimationFrame(render);
    };
    rafRef.current = requestAnimationFrame(render);

    return () => {
      ro.disconnect();
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      try {
        silent.disconnect();
      } catch {
        // Ignore — context may already be closed.
      }
      void ctx.close();
      vizRef.current = null;
      audioContextRef.current = null;
    };
    // Note: `playing` is read inside `render()` via closure. If we listed
    // it as a dep the whole viz would re-init on pause/resume, blowing
    // away the preset + RAF cadence. Accept the lint exception here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Restore the last-active preset on mount. AppState.viz_preset (Rust)
  // is the source of truth: it's set by every set_viz_preset call so it
  // survives tab unmount/remount. localStorage is the fallback for cold
  // launches when the Rust state is still empty. Without this, every
  // navigate-away-and-back resets to alphabetical-index-0.
  //
  // Runs once after `presetNames` is populated (which happens after the
  // bundled + user catalogs load).
  useEffect(() => {
    if (presetIndexRestored) return;
    if (presetNames.length === 0) return;
    let cancelled = false;
    void (async () => {
      let restoreName: string | null = null;
      try {
        const fromRust = await getVizPreset();
        if (fromRust.name) restoreName = fromRust.name;
      } catch {
        // Tauri command failed — use localStorage fallback.
      }
      if (!restoreName) {
        try {
          restoreName = localStorage.getItem("vizPresetName");
        } catch {
          restoreName = null;
        }
      }
      if (cancelled) return;
      if (restoreName) {
        const idx = presetNames.indexOf(restoreName);
        if (idx >= 0) {
          setPresetIndex(idx);
        }
      }
      setPresetIndexRestored(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [presetNames, presetIndexRestored]);

  // Persist the current preset name to localStorage on every change so
  // a cold-launched app picks up where the user left off (Rust state
  // starts empty after restart).
  useEffect(() => {
    const name = presetNames[presetIndex];
    if (!name) return;
    try {
      localStorage.setItem("vizPresetName", name);
    } catch {
      // Quota / privacy mode — non-fatal.
    }
  }, [presetIndex, presetNames]);

  // Load selected preset whenever the index changes.
  useEffect(() => {
    const viz = vizRef.current;
    if (!viz) return;
    const name = presetNames[presetIndex];
    if (!name) return;
    const preset = presetMap[name];
    if (!preset) return;
    try {
      // Blend time is live-tunable from the Tune panel.
      viz.loadPreset(preset, Math.max(0, settingsRef.current.blendTime));
      // Broadcast to external WS clients (web /visualizer in OBS) so
      // all visualizer instances converge on this same preset. Fire-and-
      // forget; the local viz keeps working regardless.
      void setVizPresetCmd(name);
    } catch (err) {
      console.warn("loadPreset failed", err);
    }
  }, [presetIndex, presetMap, presetNames]);

  // Auto-cycle — swap preset every N seconds when enabled, where N comes
  // from the Tune panel. Depend on settings.autoCycleSeconds explicitly
  // so slider changes re-arm the interval immediately.
  useEffect(() => {
    if (!autoCycle) return;
    const ms = Math.max(5, settings.autoCycleSeconds) * 1000;
    const id = window.setInterval(() => {
      setPresetIndex((i) => (i + 1) % presetNames.length);
    }, ms);
    return () => window.clearInterval(id);
  }, [autoCycle, presetNames.length, settings.autoCycleSeconds]);

  // Fullscreen via the Fullscreen API. Tauri wraps Chromium, so this
  // works exactly as in a browser — the whole webview goes fullscreen.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onChange = () => setFullscreen(document.fullscreenElement === el);
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  const toggleFullscreen = () => {
    const el = containerRef.current;
    if (!el) return;
    if (document.fullscreenElement === el) {
      void document.exitFullscreen();
    } else {
      void el.requestFullscreen();
    }
  };

  const randomize = () =>
    setPresetIndex(Math.floor(Math.random() * presetNames.length));

  const prevPreset = () =>
    setPresetIndex((i) => (i - 1 + presetNames.length) % presetNames.length);
  const nextPreset = () => setPresetIndex((i) => (i + 1) % presetNames.length);

  // Global keyboard shortcuts — only active when the visualizer is on
  // screen (component mounted = tab active). Guarded against firing while
  // the user is typing in the search input or the dropdown is focused,
  // both of which should keep their own keyboard semantics.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      switch (e.key) {
        case "ArrowRight":
        case "n":
        case "N":
          e.preventDefault();
          nextPreset();
          break;
        case "ArrowLeft":
        case "p":
        case "P":
          e.preventDefault();
          prevPreset();
          break;
        case "r":
        case "R":
          e.preventDefault();
          randomize();
          break;
        case " ":
          e.preventDefault();
          setPlaying((v) => !v);
          break;
        case "f":
        case "F":
          e.preventDefault();
          toggleFullscreen();
          break;
        case "c":
        case "C":
          e.preventDefault();
          setAutoCycle((v) => !v);
          break;
        case "?":
          e.preventDefault();
          setShowShortcuts((v) => !v);
          break;
        case "Escape":
          if (showShortcuts) {
            e.preventDefault();
            setShowShortcuts(false);
          }
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [presetNames.length, showShortcuts]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-4">
        <div>
          <div className="text-[11px] uppercase tracking-[0.22em] text-slate-500">
            Companion · Visualizer
          </div>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">
            MilkDrop 2 studio
          </h1>
          <p className="mt-1 text-xs text-slate-400">
            {presetNames.length.toLocaleString()} presets
            {userPresetCount > 0 ? (
              <>
                {" · "}
                <span className="text-accent">
                  {userPresetCount} installed
                </span>
                {" (◯)"}
              </>
            ) : null}
            {silent ? (
              <>
                {" · "}
                <span className="inline-flex items-center gap-1 rounded-full border border-amber-500/30 bg-amber-500/10 px-1.5 py-px text-[10px] font-semibold uppercase tracking-widest text-amber-300">
                  Silent
                </span>
              </>
            ) : (
              " · driven by your live audio"
            )}
          </p>
          {userLoadError ? (
            <p className="mt-1 text-[11px] text-rose-400">
              Couldn&apos;t load user presets: {userLoadError}
            </p>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={async () => {
              try {
                const url = await companionObsUrl();
                await navigator.clipboard.writeText(url);
                setObsUrlCopied(true);
                setTimeout(() => setObsUrlCopied(false), 2500);
              } catch {
                // Clipboard or Tauri command failed — silent. The
                // "Add to OBS" modal is the fallback.
              }
            }}
            className="inline-flex items-center gap-2 rounded-md border border-accent/40 bg-accent/10 px-3 py-1.5 text-xs text-accent hover:bg-accent/20"
            title="Copy the Browser Source URL with current token to clipboard. Paste into OBS as a Browser Source URL."
          >
            {obsUrlCopied ? (
              <Check className="h-3.5 w-3.5" />
            ) : (
              <Copy className="h-3.5 w-3.5" />
            )}
            {obsUrlCopied ? "Copied!" : "Copy OBS URL"}
          </button>
          <button
            onClick={() => setShowObsModal(true)}
            className="inline-flex items-center gap-2 rounded-md border border-accent/40 bg-accent/10 px-3 py-1.5 text-xs text-accent hover:bg-accent/20"
            title="Get the Browser Source URL to drop into OBS"
          >
            <Monitor className="h-3.5 w-3.5" />
            Add to OBS
          </button>
          <button
            onClick={() => setShowTune((v) => !v)}
            className={cn(
              "inline-flex items-center gap-2 rounded-md border px-3 py-1.5 text-xs",
              showTune
                ? "border-accent/50 bg-accent/15 text-accent"
                : "border-surface-border bg-surface text-slate-300 hover:bg-surface-hover hover:text-white",
            )}
            title="Tune visualizer settings"
          >
            <SlidersHorizontal className="h-3.5 w-3.5" />
            Tune
          </button>
          <button
            onClick={() => setRefreshTick((t) => t + 1)}
            className="inline-flex items-center gap-2 rounded-md border border-surface-border bg-surface px-3 py-1.5 text-xs text-slate-300 hover:bg-surface-hover hover:text-white"
            title="Re-scan presets folder"
          >
            <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="currentColor">
              <path d="M8 3V1L4 4l4 3V5c2.21 0 4 1.79 4 4 0 .56-.11 1.1-.32 1.59l1.46 1.46C13.7 11.14 14 10.1 14 9c0-3.31-2.69-6-6-6zm0 10c-2.21 0-4-1.79-4-4 0-.56.11-1.1.32-1.59L2.86 5.95C2.3 6.86 2 7.9 2 9c0 3.31 2.69 6 6 6v2l4-3-4-3v2z" />
            </svg>
            Rescan
          </button>
          <button
            onClick={() => setShowShortcuts(true)}
            className="inline-flex items-center gap-2 rounded-md border border-surface-border bg-surface px-3 py-1.5 text-xs text-slate-300 hover:bg-surface-hover hover:text-white"
            title="Keyboard shortcuts (?)"
          >
            <Keyboard className="h-3.5 w-3.5" />
            Shortcuts
          </button>
          <button
            onClick={() => void openPresetsFolder()}
            className="inline-flex items-center gap-2 rounded-md border border-surface-border bg-surface px-3 py-1.5 text-xs text-slate-300 hover:bg-surface-hover hover:text-white"
          >
            <FolderOpen className="h-3.5 w-3.5" />
            Presets folder
          </button>
        </div>
      </div>

      {/* When the Tune panel is open we pin the row to a fixed height so
          the canvas doesn't shrink vertically to match its narrower
          (panel-sharing) width. min(70vh, 560px) gives a big canvas on
          tall monitors while keeping the controls visible on short ones. */}
      <div
        className="flex gap-3"
        style={showTune ? { height: "min(70vh, 560px)" } : undefined}
      >
        <div
          ref={containerRef}
          className={cn(
            "glass-panel relative flex flex-1 items-center justify-center overflow-hidden bg-black",
            fullscreen
              ? ""
              : showTune
                ? "h-full"
                : "aspect-video",
          )}
        >
          {/* Canvas behavior depends on mode:
                - In-panel: 16:9 with maxWidth/maxHeight, letterboxed
                  cleanly inside the tab layout. Tab controls + Tune
                  drawer expect a predictable shape.
                - Fullscreen: fills the screen natively at whatever
                  aspect the display is. No forced 16:9, no letterbox.
                  This matches the web /visualizer (always native) and
                  the OBS Browser Source (always native), so the three
                  surfaces visually agree. */}
          <canvas
            ref={canvasRef}
            style={
              fullscreen
                ? { display: "block", width: "100vw", height: "100vh" }
                : {
                    display: "block",
                    aspectRatio: "16 / 9",
                    maxWidth: "100%",
                    maxHeight: "100%",
                  }
            }
          />
          {/* Fullscreen toggle floats over the canvas, top-right. */}
          <button
            onClick={toggleFullscreen}
            className="absolute right-3 top-3 flex h-8 w-8 items-center justify-center rounded-md bg-black/40 text-slate-200 backdrop-blur hover:bg-black/60"
            title={fullscreen ? "Exit fullscreen" : "Fullscreen"}
          >
            <Maximize2 className="h-4 w-4" />
          </button>
        </div>
        {showTune ? (
          <VizTunePanel
            settings={settings}
            onChange={setSettings}
            onClose={() => setShowTune(false)}
          />
        ) : null}
      </div>

      {/* Transport bar — preset name + prev/next/random/cycle/play. */}
      <div className="glass-panel p-3">
        <div className="flex items-center gap-2">
          <button
            onClick={prevPreset}
            className="flex h-9 w-9 items-center justify-center rounded-md border border-surface-border bg-surface text-slate-300 hover:bg-surface-hover hover:text-white"
            title="Previous preset (P / ←)"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <button
            onClick={nextPreset}
            className="flex h-9 w-9 items-center justify-center rounded-md border border-surface-border bg-surface text-slate-300 hover:bg-surface-hover hover:text-white"
            title="Next preset (N / →)"
          >
            <ChevronRight className="h-4 w-4" />
          </button>
          <button
            onClick={randomize}
            className="flex h-9 w-9 items-center justify-center rounded-md border border-surface-border bg-surface text-slate-300 hover:bg-surface-hover hover:text-white"
            title="Random preset (R)"
          >
            <Dice5 className="h-4 w-4" />
          </button>
          <button
            onClick={() => setAutoCycle((v) => !v)}
            className={cn(
              "flex h-9 w-9 items-center justify-center rounded-md border",
              autoCycle
                ? "border-accent/50 bg-accent/15 text-accent"
                : "border-surface-border bg-surface text-slate-300 hover:bg-surface-hover hover:text-white",
            )}
            title={autoCycle ? "Auto-cycle on — every 30s (C)" : "Auto-cycle off (C)"}
          >
            <Shuffle className="h-4 w-4" />
          </button>
          <button
            onClick={() => setPlaying((v) => !v)}
            className={cn(
              "flex h-9 w-9 items-center justify-center rounded-md border",
              playing
                ? "border-accent/50 bg-accent/15 text-accent"
                : "border-surface-border bg-surface text-slate-300 hover:bg-surface-hover hover:text-white",
            )}
            title={playing ? "Pause rendering (Space)" : "Resume rendering (Space)"}
          >
            {playing ? (
              <Pause className="h-4 w-4" />
            ) : (
              <Play className="h-4 w-4" />
            )}
          </button>
          {/* Compact "now playing" label — replaces the old dropdown
              picker. Read-only display; the actual picking happens in
              the tile grid below where streamers can scan thumbnails
              and star into collections. */}
          <div className="ml-2 flex min-w-0 flex-1 items-center gap-2 rounded-md border border-surface-border bg-base-800 px-2 py-1.5">
            <NowPlayingThumb name={presetNames[presetIndex] ?? null} />
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium text-slate-100">
                {presetNames[presetIndex] ?? "—"}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Persistent preset grid below the transport. This is the actual
          picker now — tiles with thumbnails, star to collections,
          search/filter at the top. Streamers can scroll through it
          while the canvas above keeps rendering the live preset. */}
      <PresetGrid
        names={presetNames}
        selectedIndex={presetIndex}
        onSelect={setPresetIndex}
      />

      {showShortcuts ? <ShortcutsPanel onClose={() => setShowShortcuts(false)} /> : null}
      {showObsModal ? <ObsIntegrationModal onClose={() => setShowObsModal(false)} /> : null}
    </div>
  );
}

/**
 * Modal that assembles the companion's OBS Browser Source URL + optionally
 * installs it into the streamer's OBS automatically via obs-websocket v5.
 *
 * Two tabs:
 *   - **One-click** (default): connects to OBS's built-in WebSocket
 *     Server, creates a Browser Source pointed at our viz page, places
 *     it in the current scene. Remembers password in localStorage.
 *   - **Copy URL**: the original paste-it-yourself flow for streamers
 *     who don't want the companion talking to OBS, or who use
 *     Streamlabs / some other broadcaster.
 */
function ObsIntegrationModal({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<"auto" | "manual">("auto");
  const [url, setUrl] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const cfg = await getConfig();
        const base = "https://music.blackpearl.gg/visualizer";
        const params = new URLSearchParams();
        params.set("token", cfg.token);
        if (cfg.port !== 38475) params.set("port", String(cfg.port));
        setUrl(`${base}?${params.toString()}`);
      } catch (err) {
        setError((err as Error).message);
      }
    })();
  }, []);

  const doCopy = async () => {
    if (!url) return;
    await navigator.clipboard.writeText(url);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur"
      onClick={onClose}
    >
      <div
        className="glass-panel max-w-xl w-full p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-2">
          <div>
            <div className="text-[11px] uppercase tracking-widest text-slate-500">
              OBS integration
            </div>
            <h2 className="text-lg font-semibold">Add visualizer to OBS</h2>
          </div>
          <button
            onClick={onClose}
            className="rounded-md border border-surface-border bg-surface px-2 py-1 text-xs text-slate-300 hover:bg-surface-hover hover:text-white"
          >
            Close
          </button>
        </div>

        {/* Tab switcher. One-click is default because it's the easier flow
            for the streamer who has obs-websocket enabled (default since
            OBS 28). Manual remains a first-class path. */}
        <div className="mt-4 flex items-center gap-1 rounded-md border border-surface-border bg-base-800 p-1">
          <button
            onClick={() => setTab("auto")}
            className={cn(
              "flex-1 rounded px-3 py-1.5 text-xs font-medium transition-colors",
              tab === "auto"
                ? "bg-accent/20 text-accent"
                : "text-slate-400 hover:text-slate-200",
            )}
          >
            One-click install
          </button>
          <button
            onClick={() => setTab("manual")}
            className={cn(
              "flex-1 rounded px-3 py-1.5 text-xs font-medium transition-colors",
              tab === "manual"
                ? "bg-accent/20 text-accent"
                : "text-slate-400 hover:text-slate-200",
            )}
          >
            Copy URL
          </button>
        </div>

        {error ? (
          <div className="mt-3 rounded-md border border-rose-500/30 bg-rose-500/10 p-3 text-xs text-rose-300">
            {error}
          </div>
        ) : null}

        {tab === "auto" ? (
          <ObsAutoInstall url={url} />
        ) : (
          <ObsManualInstall url={url} copied={copied} onCopy={doCopy} />
        )}

        <div className="mt-5 rounded-md border border-amber-500/25 bg-amber-500/5 p-3 text-[11px] text-amber-300/90 leading-relaxed">
          <b>Heads up:</b> the URL contains your companion token. It only
          works from OBS running on this machine + the Tracklist origin,
          but don&apos;t share it publicly (Regenerate token in Settings
          if it ever leaks).
        </div>
      </div>
    </div>
  );
}

/**
 * One-click install tab. Connects to OBS's built-in WebSocket Server
 * (default ws://127.0.0.1:4455), authenticates, creates a Browser
 * Source in the current scene pointed at the companion's viz URL.
 *
 * Requires OBS 28+ with Tools → WebSocket Server Settings → Enable.
 * If a password is set, the streamer copies it once from that dialog;
 * we remember it locally so subsequent installs are truly one-click.
 */
function ObsAutoInstall({ url }: { url: string }) {
  const [settings, setSettings] = useState<ObsWsSettings>(() => loadObsSettings());
  const [remember, setRemember] = useState<boolean>(() => {
    const s = loadObsSettings();
    return s.password.length > 0;
  });
  const [status, setStatus] = useState<
    | { kind: "idle" }
    | { kind: "connecting" }
    | { kind: "authed"; obs: ObsClient; scene: string }
    | { kind: "installing" }
    | { kind: "done"; scene: string; name: string }
    | { kind: "error"; message: string }
  >({ kind: "idle" });

  const disconnect = (clientStatus: typeof status) => {
    if (clientStatus.kind === "authed") clientStatus.obs.close();
  };

  const connect = async () => {
    setStatus({ kind: "connecting" });
    const obs = new ObsClient();
    const wsUrl = `ws://${settings.host}:${settings.port}`;
    try {
      await obs.connect(wsUrl, settings.password || undefined);
      const scene = await obs.getCurrentSceneName();
      setStatus({ kind: "authed", obs, scene });
      if (remember) saveObsSettings(settings);
      else saveObsSettings({ ...settings, password: "" });
    } catch (err) {
      obs.close();
      setStatus({ kind: "error", message: (err as Error).message });
    }
  };

  const install = async () => {
    if (status.kind !== "authed") return;
    if (!url) return;
    const obs = status.obs;
    setStatus({ kind: "installing" });
    try {
      // Avoid duplicate-name collisions by timestamping the input. OBS
      // CreateInput rejects existing names outright, and a streamer
      // probably wants multiple viz sources across scenes anyway.
      const inputName = `Tracklist Visualizer ${new Date().toLocaleTimeString(
        [],
        { hour: "2-digit", minute: "2-digit" },
      )}`;
      const res = await obs.createBrowserSource({
        sceneName: status.scene,
        inputName,
        url,
        width: 1920,
        height: 1080,
        shutdownWhenNotVisible: true,
      });
      obs.close();
      setStatus({ kind: "done", scene: res.sceneName, name: res.inputName });
    } catch (err) {
      setStatus({ kind: "error", message: (err as Error).message });
    }
  };

  return (
    <div className="mt-5 space-y-4">
      <p className="text-sm text-slate-300 leading-relaxed">
        Enter your OBS WebSocket password (if set) and we&apos;ll drop the
        visualizer into your <b>current scene</b> as a Browser Source.
        Nothing else in OBS is touched.
      </p>

      <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
        <label className="text-xs text-slate-300">
          <div className="mb-1 text-[11px] uppercase tracking-widest text-slate-500">
            OBS WebSocket password
          </div>
          <input
            type="password"
            value={settings.password}
            onChange={(e) =>
              setSettings((s) => ({ ...s, password: e.target.value }))
            }
            placeholder="leave blank if auth is off"
            className="w-full rounded-md border border-surface-border bg-base-800 px-3 py-2 text-xs font-mono text-slate-100 outline-none focus:border-accent"
          />
        </label>
        <label className="text-xs text-slate-300">
          <div className="mb-1 text-[11px] uppercase tracking-widest text-slate-500">
            Port
          </div>
          <input
            type="text"
            value={String(settings.port)}
            onChange={(e) =>
              setSettings((s) => ({
                ...s,
                port: Math.max(1, Math.min(65535, Number(e.target.value) || 4455)),
              }))
            }
            className="w-24 rounded-md border border-surface-border bg-base-800 px-3 py-2 text-xs font-mono text-slate-100 outline-none focus:border-accent"
          />
        </label>
      </div>

      <label className="flex items-center gap-2 text-xs text-slate-400">
        <input
          type="checkbox"
          checked={remember}
          onChange={(e) => setRemember(e.target.checked)}
          className="h-4 w-4 rounded border-surface-border"
        />
        Remember password on this computer
      </label>

      {/* Status + action row. The button morphs: Connect → Install →
          Done. Error state offers a retry inline so the streamer isn't
          stranded. */}
      <div className="flex items-center gap-3">
        {status.kind === "idle" || status.kind === "error" ? (
          <button
            onClick={() => void connect()}
            disabled={!url}
            className="inline-flex items-center gap-2 rounded-md border border-accent/40 bg-accent/10 px-4 py-2 text-sm text-accent hover:bg-accent/20 disabled:opacity-60"
          >
            Connect to OBS
          </button>
        ) : null}
        {status.kind === "connecting" ? (
          <span className="inline-flex items-center gap-2 text-sm text-amber-300">
            <div className="h-3 w-3 animate-spin rounded-full border-2 border-amber-300 border-t-transparent" />
            Connecting…
          </span>
        ) : null}
        {status.kind === "authed" ? (
          <>
            <button
              onClick={() => void install()}
              className="inline-flex items-center gap-2 rounded-md border border-accent/40 bg-accent hover:bg-accent-dim text-white px-4 py-2 text-sm font-medium"
            >
              Install into &ldquo;{status.scene}&rdquo;
            </button>
            <button
              onClick={() => {
                disconnect(status);
                setStatus({ kind: "idle" });
              }}
              className="text-xs text-slate-400 hover:text-slate-200"
            >
              Disconnect
            </button>
          </>
        ) : null}
        {status.kind === "installing" ? (
          <span className="inline-flex items-center gap-2 text-sm text-amber-300">
            <div className="h-3 w-3 animate-spin rounded-full border-2 border-amber-300 border-t-transparent" />
            Adding Browser Source…
          </span>
        ) : null}
        {status.kind === "done" ? (
          <span className="inline-flex items-center gap-2 text-sm text-emerald-400">
            <Check className="h-4 w-4" />
            Added &ldquo;{status.name}&rdquo; to &ldquo;{status.scene}&rdquo;.
            Check OBS.
          </span>
        ) : null}
      </div>

      {status.kind === "error" ? (
        <div className="rounded-md border border-rose-500/30 bg-rose-500/5 p-3 text-xs text-rose-300 leading-relaxed">
          {status.message}
        </div>
      ) : null}

      <div className="rounded-md border border-surface-border bg-base-800/40 p-3 text-[11px] text-slate-400 leading-relaxed">
        <b className="text-slate-200">First time?</b> In OBS: Tools →
        WebSocket Server Settings → tick <i>Enable WebSocket server</i> →
        Show Connect Info → copy the generated password. Paste above,
        check "Remember," connect. Next install is a single click.
      </div>
    </div>
  );
}

function ObsManualInstall({
  url,
  copied,
  onCopy,
}: {
  url: string;
  copied: boolean;
  onCopy: () => void | Promise<void>;
}) {
  return (
    <div className="mt-5 space-y-4">
      <p className="text-sm text-slate-300 leading-relaxed">
        Paste the URL below into an OBS <b>Browser Source</b>. The
        visualizer renders fullscreen inside OBS, connects back to this
        companion for audio, and cycles presets every 30 seconds.
      </p>

      <div className="flex items-stretch gap-2">
        <code className="flex-1 truncate rounded-md border border-surface-border bg-base-800/80 px-3 py-2 font-mono text-xs text-slate-100">
          {url || "Loading…"}
        </code>
        <button
          onClick={() => void onCopy()}
          disabled={!url}
          className="inline-flex items-center gap-1.5 rounded-md border border-accent/40 bg-accent/10 px-3 py-2 text-xs text-accent hover:bg-accent/20 disabled:opacity-60"
        >
          {copied ? (
            <>
              <Check className="h-3.5 w-3.5" />
              Copied
            </>
          ) : (
            <>
              <Copy className="h-3.5 w-3.5" />
              Copy
            </>
          )}
        </button>
        <button
          onClick={() => url && void openUrl(url)}
          disabled={!url}
          className="inline-flex items-center gap-1.5 rounded-md border border-surface-border bg-surface px-3 py-2 text-xs text-slate-200 hover:bg-surface-hover hover:text-white disabled:opacity-60"
        >
          Preview
        </button>
      </div>

      <div className="space-y-3 text-sm text-slate-300">
        <div className="text-[11px] uppercase tracking-widest text-slate-500">
          Three-step setup
        </div>
        <ol className="list-decimal space-y-2 pl-5 leading-relaxed">
          <li>
            In OBS: <b>+</b> button under Sources → <b>Browser</b> →
            name it e.g. &ldquo;Visualizer&rdquo;.
          </li>
          <li>
            URL: paste the one above. Width × Height:{" "}
            <b>1920 × 1080</b> (or match your scene). Tick{" "}
            <b>Shutdown source when not visible</b> to save CPU when on a
            different scene.
          </li>
          <li>
            <b>Click OK.</b> The preset auto-rotates. The visualizer
            flashes on beats once this companion sees audio.
          </li>
        </ol>
      </div>
    </div>
  );
}

function ShortcutsPanel({ onClose }: { onClose: () => void }) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur"
      onClick={onClose}
    >
      <div
        className="glass-panel max-w-md p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-2">
          <h2 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-widest text-slate-400">
            <Keyboard className="h-4 w-4 text-accent" />
            Keyboard shortcuts
          </h2>
          <button
            onClick={onClose}
            className="rounded-md border border-surface-border bg-surface px-2 py-1 text-xs text-slate-300 hover:bg-surface-hover hover:text-white"
          >
            Close
          </button>
        </div>
        <dl className="mt-4 grid gap-2 text-sm">
          <Shortcut keys={["N", "→"]} action="Next preset" />
          <Shortcut keys={["P", "←"]} action="Previous preset" />
          <Shortcut keys={["R"]} action="Random preset" />
          <Shortcut keys={["C"]} action="Toggle auto-cycle" />
          <Shortcut keys={["Space"]} action="Pause / resume" />
          <Shortcut keys={["F"]} action="Fullscreen" />
          <Shortcut keys={["?"]} action="This panel" />
          <Shortcut keys={["Esc"]} action="Close dialogs / exit fullscreen" />
        </dl>
        <p className="mt-4 text-[11px] text-slate-500 leading-relaxed">
          Shortcuts ignore presses while you&apos;re typing in the search
          box or dropdown.
        </p>
      </div>
    </div>
  );
}

function Shortcut({ keys, action }: { keys: string[]; action: string }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-md border border-surface-border bg-base-800/60 px-3 py-2">
      <span className="text-slate-200">{action}</span>
      <span className="flex items-center gap-1">
        {keys.map((k) => (
          <kbd
            key={k}
            className="rounded bg-surface-muted px-2 py-0.5 font-mono text-[11px] text-slate-200 shadow-[0_1px_0_0_rgba(255,255,255,0.08)]"
          >
            {k}
          </kbd>
        ))}
      </span>
    </div>
  );
}

/**
 * Tiny thumbnail next to the now-playing label in the transport row.
 * Renders the catalog GIF when available; otherwise a placeholder.
 * 24×14 — small enough to feel like a status badge, big enough to
 * give a glance of the current visual when the streamer is focused
 * on the canvas above the grid.
 */
function NowPlayingThumb({ name }: { name: string | null }) {
  const url = name ? getPresetThumbnailUrl(name) : null;
  if (!url) {
    return (
      <div
        aria-hidden
        className="h-[14px] w-[24px] shrink-0 rounded-sm border border-surface-border/60 bg-base-900"
      />
    );
  }
  return (
    <img
      src={url}
      loading="lazy"
      decoding="async"
      alt=""
      className="h-[14px] w-[24px] shrink-0 rounded-sm border border-surface-border/40 object-cover"
    />
  );
}
