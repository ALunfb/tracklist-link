import { useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
  Dice5,
  FolderOpen,
  Keyboard,
  Maximize2,
  Pause,
  Play,
  Search,
  Shuffle,
  SlidersHorizontal,
  X,
} from "lucide-react";
import butterchurn from "butterchurn";
import butterchurnPresets from "butterchurn-presets";
import { useCallback } from "react";
import { useLiveBeat, useLiveFft } from "../../lib/live-audio";
import { listPresets, openPresetsFolder, readPreset } from "../../lib/tauri";
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

  // Bundled presets from the butterchurn-presets npm package. `getPresets()`
  // returns an object keyed by display name; convert to a stable array.
  const bundledMap = useMemo(() => {
    return butterchurnPresets.getPresets() as Record<string, unknown>;
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

  const [presetIndex, setPresetIndex] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [autoCycle, setAutoCycle] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [query, setQuery] = useState("");
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [showTune, setShowTune] = useState(false);
  const [beatCount, setBeatCount] = useState(0);

  // Restart the CSS animation on each beat by removing + re-adding the
  // class in a forced-reflow dance. Purely visual; Butterchurn itself
  // already renders reactive — this is a companion-scope confirmation
  // that beat detection is flowing, and a seed for future CS2-GSI
  // effects that'll trigger the same class.
  const onBeat = useCallback(() => {
    const el = containerRef.current;
    if (el) {
      el.classList.remove("beat-flash");
      void el.offsetWidth; // force reflow
      el.classList.add("beat-flash");
    }
    setBeatCount((n) => n + 1);
  }, []);
  useLiveBeat(onBeat);

  // Tuning: live-editable audio + transport settings persisted to
  // localStorage. The sampleAudio override reads from settingsRef every
  // frame so slider drags feel instant without re-mounting the viz.
  const [settings, setSettings] = useState<VizSettings>(() => loadVizSettings());
  const settingsRef = useRef<VizSettings>(settings);
  useEffect(() => {
    settingsRef.current = settings;
    saveVizSettings(settings);
  }, [settings]);

  // Per-band envelope state for the attack/release smoothing applied
  // inside sampleAudio. Length auto-grows to match whatever Butterchurn's
  // analyser buffer size is the first time we see it.
  const bandEnvRef = useRef<Float32Array>(new Float32Array(0));

  // Filtered preset list driven by the search box. Case-insensitive; we
  // keep a parallel array of *original* indices so selecting a filtered
  // result still maps to the true preset in presetMap. Filter runs on
  // every keystroke — cheap, array is ~50 entries.
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) {
      return presetNames.map((name, idx) => ({ name, idx }));
    }
    return presetNames
      .map((name, idx) => ({ name, idx }))
      .filter(({ name }) => name.toLowerCase().includes(q));
  }, [query, presetNames]);

  // Mount / create the visualizer once. Re-uses the same AudioContext +
  // canvas through the lifetime of the tab so presets can cross-fade.
  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    const ctx = new AudioContext();
    audioContextRef.current = ctx;

    const viz = butterchurn.createVisualizer(ctx, canvas, {
      width: canvas.clientWidth,
      height: canvas.clientHeight,
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
      const tilt = s.spectrumTilt;
      const gate = s.noiseGate;
      const attack = s.attack;
      const release = s.release;

      // Find the first buffer butterchurn actually allocates so we can
      // derive the target analyser-band count. Treat this as the canonical
      // destination size for the envelope follower.
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

      // Stage 1: upsample + shape + smooth into the envelope buffer (0..1).
      for (let i = 0; i < targetLen; i++) {
        const src = Math.floor((i / targetLen) * bands.length);
        let v = (bands[src] ?? 0) * gain;
        // Linear tilt: i=0 → (1 - tilt), i=N-1 → (1 + tilt). Flat at 0.
        const tiltMul = 1 + tilt * ((i / targetLen) * 2 - 1);
        v *= tiltMul;
        // Noise gate — a hard knee is cheap, musical feel fine.
        if (v < gate) v = 0;
        if (v < 0) v = 0;
        if (v > 1) v = 1;
        const prev = env[i]!;
        const k = v > prev ? attack : release;
        env[i] = prev + (v - prev) * k;
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
    // Without this, preset render looks stretched when the window resizes.
    const ro = new ResizeObserver(() => {
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      if (w > 0 && h > 0) {
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
            {beatCount > 0 ? (
              <>
                {" · "}
                <span className="font-mono tabular-nums text-accent">
                  {beatCount.toLocaleString()}
                </span>{" "}
                beats
              </>
            ) : null}
            {" · driven by your live audio"}
          </p>
          {userLoadError ? (
            <p className="mt-1 text-[11px] text-rose-400">
              Couldn&apos;t load user presets: {userLoadError}
            </p>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
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
            "glass-panel relative flex-1 overflow-hidden",
            fullscreen
              ? ""
              : showTune
                ? "h-full"
                : "aspect-video",
          )}
        >
          <canvas
            ref={canvasRef}
            className="h-full w-full"
            style={{ display: "block" }}
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
          <div className="ml-2 flex-1 min-w-0">
            <select
              value={presetIndex}
              onChange={(e) => setPresetIndex(Number(e.target.value))}
              className="w-full rounded-md border border-surface-border bg-base-800 px-2 py-2 text-sm text-slate-100 font-medium focus:border-accent focus:outline-none"
            >
              {filtered.map(({ name, idx }) => (
                <option key={name} value={idx}>
                  {name}
                </option>
              ))}
              {filtered.length === 0 ? (
                <option disabled>No matches</option>
              ) : null}
            </select>
          </div>
        </div>
        {/* Search filter — shows under the transport so the user can
            narrow the dropdown without losing focus context. */}
        <div className="mt-2 flex items-center gap-2">
          <div className="flex flex-1 items-center gap-2 rounded-md border border-surface-border bg-base-800 px-2">
            <Search className="h-3.5 w-3.5 text-slate-500" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Filter presets…"
              className="flex-1 bg-transparent py-1.5 text-xs text-slate-200 placeholder:text-slate-600 focus:outline-none"
            />
            {query ? (
              <button
                onClick={() => setQuery("")}
                className="text-slate-500 hover:text-slate-300"
                title="Clear"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            ) : null}
          </div>
          <div className="text-[11px] text-slate-500 tabular-nums">
            {filtered.length}/{presetNames.length}
          </div>
        </div>
      </div>

      {showShortcuts ? <ShortcutsPanel onClose={() => setShowShortcuts(false)} /> : null}
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
