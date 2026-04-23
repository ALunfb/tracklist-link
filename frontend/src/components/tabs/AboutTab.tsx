import { ExternalLink, Github, ShieldCheck, Heart } from "lucide-react";
import { open as openUrl } from "@tauri-apps/plugin-shell";
import { useEffect, useState } from "react";
import { getStatus, type StatusView } from "../../lib/tauri";

const LINKS: Array<{ label: string; href: string; icon: React.ComponentType<{ className?: string }> }> = [
  {
    label: "Tracklist — music.blackpearl.gg",
    href: "https://music.blackpearl.gg",
    icon: ExternalLink,
  },
  {
    label: "Source code",
    href: "https://github.com/ALunfb/tracklist-link",
    icon: Github,
  },
  {
    label: "Security model",
    href: "https://github.com/ALunfb/tracklist-link/blob/main/SECURITY.md",
    icon: ShieldCheck,
  },
];

/**
 * About / credits / links out. Uses the shell plugin so clicks open in the
 * system browser instead of hijacking the Tauri window.
 */
export function AboutTab() {
  const [status, setStatus] = useState<StatusView | null>(null);

  useEffect(() => {
    void getStatus().then(setStatus);
  }, []);

  return (
    <div className="space-y-6">
      <div>
        <div className="text-[11px] uppercase tracking-[0.22em] text-slate-500">
          Companion · About
        </div>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">
          Tracklist Link
        </h1>
        <p className="mt-2 max-w-xl text-sm text-slate-400 leading-relaxed">
          Local audio companion for Tracklist. Open source, localhost-only,
          Rust. Never makes outbound network calls except the URLs you click.
        </p>
      </div>

      <div className="glass-panel grid gap-3 p-5 sm:grid-cols-2">
        <Info label="Version" value={status?.app_version ?? "—"} />
        <Info label="Bind address" value={status?.bind_addr ?? "—"} mono />
        <Info
          label="Sample rate"
          value={status ? `${(status.sample_rate / 1000).toFixed(1)} kHz` : "—"}
        />
        <Info label="Protocol" value="v1" />
      </div>

      <div className="glass-panel p-5">
        <h2 className="text-sm font-semibold uppercase tracking-widest text-slate-400">
          Links
        </h2>
        <ul className="mt-3 space-y-2">
          {LINKS.map((link) => {
            const Icon = link.icon;
            return (
              <li key={link.href}>
                <button
                  onClick={() => void openUrl(link.href)}
                  className="group flex w-full items-center gap-3 rounded-md border border-surface-border bg-surface px-3 py-2 text-sm text-slate-200 hover:bg-surface-hover hover:text-white"
                >
                  <Icon className="h-4 w-4 text-accent" />
                  <span className="flex-1 text-left">{link.label}</span>
                  <ExternalLink className="h-3.5 w-3.5 text-slate-500 group-hover:text-slate-300" />
                </button>
              </li>
            );
          })}
        </ul>
      </div>

      <div className="flex items-center justify-center gap-1.5 text-[11px] text-slate-600">
        Built with <Heart className="h-3 w-3 text-rose-400" /> by the
        Tracklist maintainers · MIT license
      </div>
    </div>
  );
}

function Info({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="rounded-md border border-surface-border bg-base-800/60 p-3">
      <div className="text-[11px] uppercase tracking-widest text-slate-500">
        {label}
      </div>
      <div
        className={
          mono
            ? "mt-1 font-mono text-sm text-accent"
            : "mt-1 text-sm text-slate-100"
        }
      >
        {value}
      </div>
    </div>
  );
}
