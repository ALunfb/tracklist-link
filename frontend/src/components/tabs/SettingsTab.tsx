import { useEffect, useState } from "react";
import {
  AlertTriangle,
  FolderOpen,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";
import {
  getConfig,
  openConfigFolder,
  regenerateToken,
  type ConfigView,
} from "../../lib/tauri";

/**
 * Phase-1 settings: read-only display of the runtime config + destructive
 * actions (regenerate token, open config folder for manual edits).
 *
 * Port / allowed origins / sample-rate editing is deliberately hidden
 * behind "Open config folder" for now — changing those requires a restart,
 * and a Phase-1 UI that implies live-edit would mislead the streamer.
 */
export function SettingsTab() {
  const [config, setConfig] = useState<ConfigView | null>(null);
  const [regenBusy, setRegenBusy] = useState(false);

  useEffect(() => {
    void getConfig().then(setConfig);
  }, []);

  const handleRegen = async () => {
    const confirm = window.confirm(
      "Regenerating the token invalidates every currently-paired browser + overlay. Proceed?",
    );
    if (!confirm) return;
    setRegenBusy(true);
    try {
      await regenerateToken();
      setConfig(await getConfig());
    } finally {
      setRegenBusy(false);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <div className="text-[11px] uppercase tracking-[0.22em] text-slate-500">
          Companion · Settings
        </div>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">Settings</h1>
        <p className="mt-2 max-w-xl text-sm text-slate-400 leading-relaxed">
          Everything here is read from{" "}
          <code className="font-mono text-slate-300">
            %APPDATA%\blackpearl\tracklist-link\config.toml
          </code>
          . Editing the file and restarting is the advanced path; for now
          the app only exposes the one destructive action that actually
          matters — token rotation.
        </p>
      </div>

      <section className="glass-panel divide-y divide-surface-border">
        <Row
          label="Bind address"
          value={`127.0.0.1:${config?.port ?? "—"}`}
          mono
          hint="Localhost only. Never exposed to the network."
        />
        <Row
          label="Sample rate"
          value={config ? `${(config.sample_rate / 1000).toFixed(1)} kHz` : "—"}
          hint="Determined by your default Windows output device."
        />
        <Row
          label="Allowed origins"
          value={
            config ? (
              <ul className="space-y-1 font-mono text-[11px] text-slate-300">
                {config.allowed_origins.map((o) => (
                  <li key={o}>{o}</li>
                ))}
              </ul>
            ) : (
              "—"
            )
          }
          hint="Only browsers with these Origin headers can subscribe."
        />
      </section>

      <section className="glass-panel p-5">
        <div className="flex items-start gap-3">
          <ShieldCheck className="mt-0.5 h-4 w-4 text-accent" />
          <div>
            <h2 className="text-sm font-semibold uppercase tracking-widest text-slate-400">
              Rotate companion token
            </h2>
            <p className="mt-1 text-sm text-slate-300 leading-relaxed">
              Generates a new 32-byte secret. Use this if you suspect a
              token leak, or just as routine hygiene. Every paired browser
              has to Pair again after rotation.
            </p>
          </div>
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <button
            onClick={handleRegen}
            disabled={regenBusy}
            className="inline-flex items-center gap-2 rounded-md border border-rose-500/40 bg-rose-500/10 px-3 py-1.5 text-sm font-medium text-rose-300 hover:bg-rose-500/20 disabled:opacity-60"
          >
            <RefreshCw className={regenBusy ? "h-4 w-4 animate-spin" : "h-4 w-4"} />
            {regenBusy ? "Regenerating…" : "Regenerate token"}
          </button>
          <button
            onClick={() => void openConfigFolder()}
            className="inline-flex items-center gap-2 rounded-md border border-surface-border bg-surface px-3 py-1.5 text-sm text-slate-200 hover:bg-surface-hover hover:text-white"
          >
            <FolderOpen className="h-4 w-4" />
            Open config folder
          </button>
        </div>
        <div className="mt-4 flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-[11px] text-amber-300/90 leading-relaxed">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          Rotation is not undoable. Any overlay URL you've shared that
          embedded the previous token will stop working.
        </div>
      </section>
    </div>
  );
}

function Row({
  label,
  value,
  hint,
  mono,
}: {
  label: string;
  value: React.ReactNode;
  hint?: string;
  mono?: boolean;
}) {
  return (
    <div className="flex items-start gap-6 p-4">
      <div className="w-40 shrink-0">
        <div className="text-[11px] uppercase tracking-widest text-slate-500">
          {label}
        </div>
        {hint ? (
          <div className="mt-1 text-[11px] text-slate-600 leading-relaxed">
            {hint}
          </div>
        ) : null}
      </div>
      <div
        className={
          mono
            ? "flex-1 font-mono text-sm text-accent"
            : "flex-1 text-sm text-slate-200"
        }
      >
        {value}
      </div>
    </div>
  );
}
