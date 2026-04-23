import { useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
  Dice5,
  FolderOpen,
  Maximize2,
  Pause,
  Play,
  Shuffle,
  Sparkles,
} from "lucide-react";
import butterchurn from "butterchurn";
import butterchurnPresets from "butterchurn-presets";
import { useLiveFft } from "../../lib/live-audio";
import { openPresetsFolder } from "../../lib/tauri";
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

  // Presets ship in the butterchurn-presets npm package. `getPresets()`
  // returns an object keyed by display name; convert to a stable array.
  const presetMap = useMemo(() => {
    const map = butterchurnPresets.getPresets() as Record<string, unknown>;
    return map;
  }, []);
  const presetNames = useMemo(
    () => Object.keys(presetMap).sort((a, b) => a.localeCompare(b)),
    [presetMap],
  );

  const [presetIndex, setPresetIndex] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [autoCycle, setAutoCycle] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);

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

    // Monkey-patch sampleAudio: push our FFT bands into the analyser-fed
    // arrays. Butterchurn reads these as 0..255 integers every frame.
    const audio = (viz as unknown as { audio: { freqArray: Uint8Array; timeByteArray: Uint8Array; sampleAudio: () => void } }).audio;
    audio.sampleAudio = function () {
      const bands = bandsRef.current;
      const n = this.freqArray.length;
      if (!bands || bands.length === 0) {
        this.freqArray.fill(0);
        this.timeByteArray.fill(128);
        return;
      }
      let sum = 0;
      for (let i = 0; i < n; i++) {
        const src = Math.floor((i / n) * bands.length);
        const v = bands[src] ?? 0;
        this.freqArray[i] = Math.min(255, Math.max(0, Math.floor(v * 255)));
        sum += v;
      }
      // Synthesize a time-domain waveform whose amplitude tracks the
      // spectrum sum. Not physically correct (real PCM would have phase
      // information), but gives MilkDrop's "wave" shapes something to
      // animate against — otherwise `wave_a = 0` presets look dead.
      const amp = Math.min(1, (sum / n) * 3.0);
      const base = this.timeByteArray.length;
      for (let i = 0; i < base; i++) {
        const osc = Math.sin((i / base) * Math.PI * 6) * amp * 96;
        this.timeByteArray[i] = Math.max(
          0,
          Math.min(255, 128 + Math.floor(osc)),
        );
      }
    };

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
      // 2-second blend matches MilkDrop's default preset-change feel.
      viz.loadPreset(preset, 2.0);
    } catch (err) {
      console.warn("loadPreset failed", err);
    }
  }, [presetIndex, presetMap, presetNames]);

  // Auto-cycle — swap preset every 30s when enabled. Rough MilkDrop
  // default; tuneable in settings later.
  useEffect(() => {
    if (!autoCycle) return;
    const id = window.setInterval(() => {
      setPresetIndex((i) => (i + 1) % presetNames.length);
    }, 30_000);
    return () => window.clearInterval(id);
  }, [autoCycle, presetNames.length]);

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
            {presetNames.length} bundled presets · driven by your live audio
          </p>
        </div>
        <button
          onClick={() => void openPresetsFolder()}
          className="inline-flex items-center gap-2 rounded-md border border-surface-border bg-surface px-3 py-1.5 text-xs text-slate-300 hover:bg-surface-hover hover:text-white"
        >
          <FolderOpen className="h-3.5 w-3.5" />
          Presets folder
        </button>
      </div>

      <div
        ref={containerRef}
        className={cn(
          "glass-panel relative overflow-hidden",
          fullscreen ? "" : "aspect-video",
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

      {/* Transport bar — preset name + prev/next/random/cycle/play. */}
      <div className="glass-panel p-3">
        <div className="flex items-center gap-2">
          <button
            onClick={() =>
              setPresetIndex(
                (presetIndex - 1 + presetNames.length) % presetNames.length,
              )
            }
            className="flex h-9 w-9 items-center justify-center rounded-md border border-surface-border bg-surface text-slate-300 hover:bg-surface-hover hover:text-white"
            title="Previous preset"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <button
            onClick={() => setPresetIndex((presetIndex + 1) % presetNames.length)}
            className="flex h-9 w-9 items-center justify-center rounded-md border border-surface-border bg-surface text-slate-300 hover:bg-surface-hover hover:text-white"
            title="Next preset"
          >
            <ChevronRight className="h-4 w-4" />
          </button>
          <button
            onClick={randomize}
            className="flex h-9 w-9 items-center justify-center rounded-md border border-surface-border bg-surface text-slate-300 hover:bg-surface-hover hover:text-white"
            title="Random preset"
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
            title={
              autoCycle
                ? "Auto-cycle on (every 30s)"
                : "Auto-cycle off"
            }
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
            title={playing ? "Pause rendering" : "Resume rendering"}
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
              {presetNames.map((name, i) => (
                <option key={name} value={i}>
                  {name}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className="mt-2 flex items-center gap-2 text-[11px] text-slate-500">
          <Sparkles className="h-3 w-3" />
          Tip: press the fullscreen button or F11, then capture the window
          in OBS for a visualizer-only scene.
        </div>
      </div>
    </div>
  );
}
