import { Hourglass, Sparkles } from "lucide-react";

/**
 * Phase-2 placeholder. The real implementation will bridge our companion's
 * FFT topic into a Butterchurn AnalyserNode-shaped shim and render
 * MilkDrop 2 presets in-app. Shipping the placeholder so the nav feels
 * complete without pretending the feature exists.
 */
export function VisualizerTab() {
  return (
    <div className="space-y-6">
      <div>
        <div className="text-[11px] uppercase tracking-[0.22em] text-slate-500">
          Companion · Visualizer
        </div>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">
          Visualizer studio
        </h1>
        <p className="mt-2 max-w-xl text-sm text-slate-400 leading-relaxed">
          Drop in a MilkDrop preset, see it come alive with your system
          audio. Coming in Phase 2 — we bridge the companion's 64-band FFT
          into Butterchurn's WebGL renderer so presets feel authentic
          without the legacy plugin sandbox.
        </p>
      </div>

      <div className="glass-panel relative flex min-h-[320px] items-center justify-center overflow-hidden">
        {/* Ambient gradient so the placeholder feels alive, not blank. */}
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_30%_20%,rgba(168,85,247,0.25),transparent_60%),radial-gradient(circle_at_80%_70%,rgba(56,189,248,0.15),transparent_60%)]" />
        <div className="relative flex flex-col items-center gap-3 text-center">
          <div className="flex h-14 w-14 items-center justify-center rounded-full bg-accent/15 text-accent">
            <Sparkles className="h-6 w-6" />
          </div>
          <div className="text-sm font-semibold text-slate-100">
            Butterchurn + companion FFT
          </div>
          <div className="max-w-md text-xs text-slate-400 leading-relaxed">
            Arriving in the next session. It'll honor your .milk files,
            react to whatever audio is playing on this PC, and stream the
            output to OBS as a Window Capture source.
          </div>
          <div className="mt-2 inline-flex items-center gap-1.5 rounded-full border border-surface-border bg-surface px-2.5 py-0.5 text-[10px] uppercase tracking-widest text-slate-400">
            <Hourglass className="h-3 w-3" />
            Phase 2
          </div>
        </div>
      </div>
    </div>
  );
}
