import { useEffect, useState } from "react";
import {
  Check,
  Copy,
  ExternalLink,
  KeyRound,
  Link2,
  Radio,
  RefreshCw,
} from "lucide-react";
import {
  copyTokenToClipboard,
  getConfig,
  getStatus,
  openPairUrl,
  regenerateToken,
  type ConfigView,
  type StatusView,
} from "../../lib/tauri";
import { cn } from "../../lib/cn";

/**
 * Home tab. Answers the three questions a streamer always has:
 *   1. Is the companion actually running / where?
 *   2. How do I hook up my browser?
 *   3. Can I see my token?
 */
export function StatusTab() {
  const [status, setStatus] = useState<StatusView | null>(null);
  const [config, setConfig] = useState<ConfigView | null>(null);
  const [copied, setCopied] = useState(false);
  const [pairOpened, setPairOpened] = useState(false);
  const [regenAt, setRegenAt] = useState<number | null>(null);
  const [tokenHidden, setTokenHidden] = useState(true);

  useEffect(() => {
    void Promise.all([getStatus(), getConfig()]).then(([s, c]) => {
      setStatus(s);
      setConfig(c);
    });
  }, []);

  const reload = async () => {
    const [s, c] = await Promise.all([getStatus(), getConfig()]);
    setStatus(s);
    setConfig(c);
  };

  const handleCopy = async () => {
    await copyTokenToClipboard();
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };

  const handlePair = async () => {
    await openPairUrl();
    setPairOpened(true);
    window.setTimeout(() => setPairOpened(false), 2000);
  };

  const handleRegen = async () => {
    const confirm = window.confirm(
      "Regenerate token? Any paired browser/overlay will need to re-pair.",
    );
    if (!confirm) return;
    await regenerateToken();
    setRegenAt(Date.now());
    await reload();
  };

  return (
    <div className="space-y-6">
      <Header
        eyebrow="Companion · Status"
        title="Everything green? You're ready to stream."
        subtitle="Tracklist Link is capturing system audio and serving FFT frames over a private localhost connection."
      />

      <section className="grid gap-3 sm:grid-cols-3">
        <StatCard
          icon={Radio}
          label="WS endpoint"
          value={status?.bind_addr ?? "—"}
          mono
        />
        <StatCard
          icon={RefreshCw}
          label="Sample rate"
          value={status ? `${(status.sample_rate / 1000).toFixed(1)} kHz` : "—"}
        />
        <StatCard
          icon={KeyRound}
          label="Protocol"
          value={status ? `v1 · app ${status.app_version}` : "—"}
        />
      </section>

      {/* Pair section — the primary happy-path CTA. */}
      <section className="glass-panel p-5">
        <h2 className="text-sm font-semibold uppercase tracking-widest text-slate-400">
          Pair with your dashboard
        </h2>
        <p className="mt-1 text-sm text-slate-300 leading-relaxed">
          One click opens the Tracklist dashboard with your token pre-filled.
          The token rides in the URL fragment so it never leaves your browser.
          Works with any OBS Browser Source on this PC.
        </p>
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <button
            onClick={handlePair}
            className="inline-flex items-center gap-2 rounded-md bg-accent px-3.5 py-2 text-sm font-medium text-white shadow-glow transition-colors hover:bg-accent-dim"
          >
            <Link2 className="h-4 w-4" />
            Pair dashboard
            <ExternalLink className="h-3.5 w-3.5 opacity-70" />
          </button>
          {pairOpened ? (
            <span className="inline-flex items-center gap-1 text-xs text-emerald-400">
              <Check className="h-3.5 w-3.5" />
              Opened your browser
            </span>
          ) : null}
        </div>
      </section>

      {/* Token reveal + copy. Hidden by default so screen-shares don't leak. */}
      <section className="glass-panel p-5">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-sm font-semibold uppercase tracking-widest text-slate-400">
              Companion token
            </h2>
            <p className="mt-1 text-sm text-slate-300 leading-relaxed">
              32 bytes of randomness, unique to this install. Required for
              any browser to subscribe to the FFT feed. Keep it private.
            </p>
          </div>
          <button
            onClick={() => setTokenHidden((h) => !h)}
            className="rounded-md border border-surface-border bg-surface px-2 py-1 text-[11px] text-slate-300 hover:text-white hover:border-surface-muted"
          >
            {tokenHidden ? "Reveal" : "Hide"}
          </button>
        </div>
        <div className="mt-3 flex items-stretch gap-2">
          <code
            className={cn(
              "flex-1 truncate rounded-md border border-surface-border bg-base-800/80 px-3 py-2 font-mono text-xs",
              tokenHidden ? "tracking-[0.3em] text-slate-500" : "text-slate-100",
            )}
          >
            {tokenHidden
              ? "••••••••••••••••••••••••••••••••••••••••"
              : (config?.token ?? "")}
          </code>
          <button
            onClick={handleCopy}
            className="inline-flex items-center gap-1.5 rounded-md border border-surface-border bg-surface px-3 py-2 text-xs text-slate-200 hover:bg-surface-hover hover:text-white"
          >
            {copied ? (
              <>
                <Check className="h-3.5 w-3.5 text-emerald-400" />
                Copied
              </>
            ) : (
              <>
                <Copy className="h-3.5 w-3.5" />
                Copy
              </>
            )}
          </button>
        </div>
        <div className="mt-3 flex items-center gap-3 text-[11px] text-slate-500">
          <button
            onClick={handleRegen}
            className="inline-flex items-center gap-1.5 hover:text-rose-400"
          >
            <RefreshCw className="h-3 w-3" />
            Regenerate
          </button>
          {regenAt ? (
            <span className="text-emerald-400">
              New token generated. Re-pair any connected overlays.
            </span>
          ) : null}
        </div>
      </section>

      {/* Quick-start — three-step for first-timers. */}
      <section className="glass-panel p-5">
        <h2 className="text-sm font-semibold uppercase tracking-widest text-slate-400">
          First-time setup (30 seconds)
        </h2>
        <ol className="mt-3 space-y-3 text-sm text-slate-300">
          <Step n={1}>
            Click <b>Pair dashboard</b> above. Your browser opens the
            Tracklist site with the token already applied.
          </Step>
          <Step n={2}>
            On the dashboard, scroll to <b>OBS overlay</b> → set{" "}
            <b>Analyzer</b> to <code className="font-mono">bars</code>.
          </Step>
          <Step n={3}>
            Copy the Browser-source URL, paste into an OBS{" "}
            <b>Browser</b> source. Play music. Bars react.
          </Step>
        </ol>
      </section>
    </div>
  );
}

function Header({
  eyebrow,
  title,
  subtitle,
}: {
  eyebrow: string;
  title: string;
  subtitle: string;
}) {
  return (
    <div>
      <div className="text-[11px] uppercase tracking-[0.22em] text-slate-500">
        {eyebrow}
      </div>
      <h1 className="mt-1 text-2xl font-semibold tracking-tight">{title}</h1>
      <p className="mt-2 max-w-xl text-sm text-slate-400 leading-relaxed">
        {subtitle}
      </p>
    </div>
  );
}

function StatCard({
  icon: Icon,
  label,
  value,
  mono,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="glass-panel p-4">
      <div className="flex items-center gap-2 text-[11px] uppercase tracking-widest text-slate-500">
        <Icon className="h-3.5 w-3.5" />
        {label}
      </div>
      <div
        className={cn(
          "mt-2 truncate text-lg font-semibold",
          mono ? "font-mono text-accent" : "text-slate-100",
        )}
      >
        {value}
      </div>
    </div>
  );
}

function Step({ n, children }: { n: number; children: React.ReactNode }) {
  return (
    <li className="flex gap-3">
      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-accent/15 text-[11px] font-semibold text-accent">
        {n}
      </span>
      <span className="leading-relaxed">{children}</span>
    </li>
  );
}
