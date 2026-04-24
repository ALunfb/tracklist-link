import { useEffect, useState } from "react";
import {
  AlertTriangle,
  FolderOpen,
  Power,
  RefreshCw,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import {
  getAutostart,
  getConfig,
  openConfigFolder,
  regenerateToken,
  setAutostart,
  setLaunchMinimized,
  type ConfigView,
} from "../../lib/tauri";
import { cn } from "../../lib/cn";

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
  const [autostartOn, setAutostartOn] = useState<boolean | null>(null);
  const [autostartBusy, setAutostartBusy] = useState(false);
  const [launchMinBusy, setLaunchMinBusy] = useState(false);

  useEffect(() => {
    void getConfig().then(setConfig);
    void getAutostart()
      .then(setAutostartOn)
      .catch(() => setAutostartOn(false));
  }, []);

  const toggleAutostart = async () => {
    if (autostartOn === null) return;
    setAutostartBusy(true);
    try {
      await setAutostart(!autostartOn);
      setAutostartOn(!autostartOn);
    } finally {
      setAutostartBusy(false);
    }
  };

  const toggleLaunchMinimized = async () => {
    if (!config) return;
    setLaunchMinBusy(true);
    try {
      await setLaunchMinimized(!config.launch_minimized);
      setConfig({ ...config, launch_minimized: !config.launch_minimized });
    } finally {
      setLaunchMinBusy(false);
    }
  };

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

      {/* Launch behavior — autostart + minimize-to-tray. Both land in the
          Windows Run key + config.toml respectively; no admin rights. */}
      <section className="glass-panel">
        <div className="flex items-center justify-between gap-4 border-b border-surface-border p-4">
          <div>
            <div className="flex items-center gap-2 text-sm font-medium text-slate-100">
              <Power className="h-4 w-4 text-accent" />
              Launch on Windows startup
            </div>
            <p className="mt-1 max-w-md text-[11px] text-slate-500 leading-relaxed">
              Adds a per-user Run-key entry so the companion is ready the
              moment you log in. No admin rights needed, no system service.
              Remove by toggling off.
            </p>
          </div>
          <Toggle
            on={autostartOn === true}
            busy={autostartBusy || autostartOn === null}
            onClick={toggleAutostart}
          />
        </div>
        <div className="flex items-center justify-between gap-4 p-4">
          <div>
            <div className="flex items-center gap-2 text-sm font-medium text-slate-100">
              <Sparkles className="h-4 w-4 text-accent" />
              Start minimized to tray
            </div>
            <p className="mt-1 max-w-md text-[11px] text-slate-500 leading-relaxed">
              Companion boots silently — only the tray icon shows. Pair
              this with autostart for a no-interrupt login. Toggle the
              window back on from the tray menu anytime.
            </p>
          </div>
          <Toggle
            on={config?.launch_minimized === true}
            busy={launchMinBusy || !config}
            onClick={toggleLaunchMinimized}
          />
        </div>
      </section>

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

function Toggle({
  on,
  busy,
  onClick,
}: {
  on: boolean;
  busy: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      disabled={busy}
      role="switch"
      aria-checked={on}
      className={cn(
        "relative h-6 w-11 shrink-0 rounded-full border transition-colors",
        on
          ? "border-accent/50 bg-accent"
          : "border-surface-border bg-surface-muted",
        busy ? "opacity-60" : "hover:opacity-90",
      )}
    >
      <span
        className={cn(
          "absolute top-0.5 h-4 w-4 rounded-full bg-white shadow-sm transition-transform",
          on ? "translate-x-6" : "translate-x-0.5",
        )}
      />
    </button>
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
