import { RotateCcw, X } from "lucide-react";
import {
  DEFAULT_VIZ_SETTINGS,
  type VizSettings,
} from "../lib/viz-settings";

interface Props {
  settings: VizSettings;
  onChange: (next: VizSettings) => void;
  onClose: () => void;
}

/**
 * Right-side drawer for viz tuning. Sliders apply live (no Save button)
 * so the streamer can dial in the feel with the canvas visible in the
 * same glance. Reset button snaps everything back to DEFAULT_VIZ_SETTINGS.
 */
export function VizTunePanel({ settings, onChange, onClose }: Props) {
  const set = (key: keyof VizSettings, value: number) =>
    onChange({ ...settings, [key]: value });

  return (
    <aside className="glass-panel flex w-72 shrink-0 flex-col overflow-y-auto p-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <div>
          <div className="text-[11px] uppercase tracking-widest text-slate-500">
            Tune
          </div>
          <h2 className="text-sm font-semibold">Visualizer</h2>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={() => onChange({ ...DEFAULT_VIZ_SETTINGS })}
            className="inline-flex items-center gap-1 rounded-md border border-surface-border bg-surface px-2 py-1 text-[11px] text-slate-300 hover:bg-surface-hover hover:text-white"
            title="Reset all to defaults"
          >
            <RotateCcw className="h-3 w-3" />
            Reset
          </button>
          <button
            onClick={onClose}
            className="inline-flex h-6 w-6 items-center justify-center rounded-md border border-surface-border bg-surface text-slate-400 hover:bg-surface-hover hover:text-white"
            title="Close"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      <div className="space-y-5">
        <Section label="Audio">
          <Slider
            label="Audio gain"
            hint="How much the spectrum pushes the visualizer. Bump if presets look sluggish."
            value={settings.audioGain}
            onChange={(v) => set("audioGain", v)}
            min={0.1}
            max={5}
            step={0.1}
            format={(v) => `${v.toFixed(1)}×`}
          />
          <Slider
            label="Bass boost"
            hint="Multiplies the bottom third of the spectrum. 0 = flat. Great for bringing kicks forward on presets that react to overall energy."
            value={settings.bassBoost}
            onChange={(v) => set("bassBoost", v)}
            min={0}
            max={1}
            step={0.05}
            format={(v) =>
              v === 0 ? "flat" : `+${Math.round(v * 100)}%`
            }
          />
        </Section>

        <Section label="Presets">
          <Slider
            label="Auto-cycle"
            hint="Seconds between automatic preset changes (when Shuffle is on)."
            value={settings.autoCycleSeconds}
            onChange={(v) => set("autoCycleSeconds", Math.round(v))}
            min={5}
            max={300}
            step={5}
            format={(v) =>
              v < 60 ? `${v}s` : `${Math.floor(v / 60)}m ${v % 60}s`
            }
          />
          <Slider
            label="Blend time"
            hint="Cross-fade duration when switching presets."
            value={settings.blendTime}
            onChange={(v) => set("blendTime", v)}
            min={0}
            max={5}
            step={0.1}
            format={(v) => (v === 0 ? "cut" : `${v.toFixed(1)}s`)}
          />
        </Section>
      </div>

      <div className="mt-6 rounded-md border border-surface-border bg-base-800/60 p-3 text-[11px] text-slate-500 leading-relaxed">
        Settings save as you drag. They apply only to this machine — the
        defaults feel good on most setups, but every mic / output device
        behaves a little differently.
      </div>
    </aside>
  );
}

function Section({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="mb-2 text-[10px] font-semibold uppercase tracking-widest text-slate-500">
        {label}
      </div>
      <div className="space-y-3">{children}</div>
    </div>
  );
}

function Slider({
  label,
  hint,
  value,
  onChange,
  min,
  max,
  step,
  format,
}: {
  label: string;
  hint: string;
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
  step: number;
  format: (v: number) => string;
}) {
  return (
    <div>
      <div className="mb-0.5 flex items-baseline justify-between gap-2">
        <label className="text-xs font-medium text-slate-200">{label}</label>
        <span className="font-mono text-[11px] tabular-nums text-slate-400">
          {format(value)}
        </span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full accent-brand-500"
      />
      <p className="mt-0.5 text-[10px] text-slate-500 leading-snug">{hint}</p>
    </div>
  );
}
