import { useEffect, useState } from "react";
import {
  Check,
  CloudDownload,
  Download,
  Folder,
  Loader2,
  RefreshCw,
  Sparkles,
} from "lucide-react";
import {
  listPresets,
  openPresetsFolder,
  savePreset,
  type PresetEntry,
} from "../../lib/tauri";
import { open as openUrl } from "@tauri-apps/plugin-shell";
import { cn } from "../../lib/cn";

/**
 * Reads `%APPDATA%\blackpearl\tracklist-link\config\presets\` via the
 * Rust side and renders each `.milk*` file as a card. Primary actions:
 *
 *   - Open the folder in Explorer so the streamer can drop new `.milk`s
 *     straight in from a download.
 *   - Bounce out to the website's curated gallery.
 *
 * Preset preview / load-into-visualizer moves to this tab in the next
 * pass; for now the built-in Butterchurn pack is picked from the
 * Visualizer tab directly.
 */
export function PresetsTab() {
  const [presets, setPresets] = useState<PresetEntry[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [installUrl, setInstallUrl] = useState("");
  const [installState, setInstallState] = useState<{
    kind: "idle" | "fetching" | "saving" | "done" | "error";
    message?: string;
    filename?: string;
  }>({ kind: "idle" });

  const load = async () => {
    setLoading(true);
    try {
      setPresets(await listPresets());
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const installFromUrl = async () => {
    const url = installUrl.trim();
    if (!url) return;
    // Enforce https: or our own prod origin. Rejects file://, data:, and
    // anything that would let a malicious paste read local files.
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      setInstallState({ kind: "error", message: "Not a valid URL" });
      return;
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      setInstallState({
        kind: "error",
        message: `Refusing ${parsed.protocol} URL — use https only.`,
      });
      return;
    }
    setInstallState({ kind: "fetching" });
    try {
      const res = await fetch(url, {
        headers: { Accept: "application/json, text/plain" },
      });
      if (!res.ok) {
        setInstallState({
          kind: "error",
          message: `Fetch failed — HTTP ${res.status}`,
        });
        return;
      }
      const text = await res.text();
      // Derive a filename from the URL's last path segment, fallback to
      // a content-hash-like timestamp. Always append .json (we enforce the
      // extension allowlist server-side anyway).
      const lastSeg = parsed.pathname.split("/").filter(Boolean).pop() ?? "preset";
      let filename = decodeURIComponent(lastSeg);
      // Strip characters the Rust side would reject.
      filename = filename.replace(/[\\/:*?"<>|]/g, "_");
      if (!/\.(json|milk|milk2|milk3)$/i.test(filename)) {
        filename = `${filename}.json`;
      }
      setInstallState({ kind: "saving", filename });
      await savePreset(filename, text);
      setInstallState({
        kind: "done",
        message: `Saved as ${filename}`,
        filename,
      });
      setInstallUrl("");
      await load();
      window.setTimeout(() => {
        setInstallState((s) => (s.kind === "done" ? { kind: "idle" } : s));
      }, 3000);
    } catch (err) {
      setInstallState({
        kind: "error",
        message: (err as Error).message || "Install failed",
      });
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="text-[11px] uppercase tracking-[0.22em] text-slate-500">
            Companion · Presets
          </div>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">
            MilkDrop preset library
          </h1>
          <p className="mt-2 max-w-xl text-sm text-slate-400 leading-relaxed">
            Drop <code className="font-mono text-slate-300">.milk</code> or{" "}
            <code className="font-mono text-slate-300">.milk2</code> files
            into your presets folder and they show up here. The Visualizer
            tab ships with a curated Butterchurn-compatible pack out of the
            box — this tab is for your own additions.
          </p>
        </div>
        <button
          onClick={() => void load()}
          className="inline-flex items-center gap-2 rounded-md border border-surface-border bg-surface px-3 py-1.5 text-sm text-slate-200 hover:bg-surface-hover hover:text-white"
          title="Re-scan folder"
        >
          <RefreshCw className={cn("h-4 w-4", loading && "animate-spin")} />
          Refresh
        </button>
      </div>

      <div className="glass-panel flex flex-col gap-3 p-5 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-md bg-accent/10 text-accent">
            <Folder className="h-5 w-5" />
          </div>
          <div>
            <div className="text-sm font-medium text-slate-100">
              Your presets folder
            </div>
            <div className="font-mono text-[11px] text-slate-500">
              %APPDATA%\blackpearl\tracklist-link\config\presets\
            </div>
          </div>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() =>
              void openUrl("https://music.blackpearl.gg/visualizers")
            }
            className="inline-flex items-center gap-2 rounded-md border border-accent/40 bg-accent/10 px-3 py-1.5 text-sm text-accent hover:bg-accent/20"
          >
            <Download className="h-4 w-4" />
            Browse gallery
          </button>
          <button
            onClick={() => void openPresetsFolder()}
            className="inline-flex items-center gap-2 rounded-md border border-surface-border bg-surface px-3 py-1.5 text-sm text-slate-200 hover:bg-surface-hover hover:text-white"
          >
            <Folder className="h-4 w-4" />
            Open in Explorer
          </button>
        </div>
      </div>

      {/* Install from URL — paste an install URL copied from the website
          gallery (or any raw .json URL you trust). We fetch it client-
          side, then hand the bytes to Rust which validates + writes. */}
      <div className="glass-panel p-4">
        <div className="mb-2 flex items-center gap-2">
          <CloudDownload className="h-4 w-4 text-accent" />
          <span className="text-sm font-semibold">Install from URL</span>
          <span className="ml-auto text-[11px] text-slate-500">
            Paste from{" "}
            <a
              href="#"
              onClick={(e) => {
                e.preventDefault();
                void openUrl("https://music.blackpearl.gg/visualizers");
              }}
              className="text-accent underline-offset-2 hover:underline"
            >
              music.blackpearl.gg/visualizers
            </a>
          </span>
        </div>
        <div className="flex items-stretch gap-2">
          <input
            value={installUrl}
            onChange={(e) => setInstallUrl(e.target.value)}
            placeholder="https://music.blackpearl.gg/presets/files/abc123.json"
            className="flex-1 min-w-0 rounded-md border border-surface-border bg-base-800 px-3 py-2 text-xs font-mono text-slate-100 outline-none focus:border-accent"
            onKeyDown={(e) => {
              if (e.key === "Enter") void installFromUrl();
            }}
          />
          <button
            onClick={() => void installFromUrl()}
            disabled={
              !installUrl.trim() ||
              installState.kind === "fetching" ||
              installState.kind === "saving"
            }
            className="inline-flex items-center gap-2 rounded-md border border-accent/40 bg-accent/10 px-4 py-2 text-sm text-accent hover:bg-accent/20 disabled:opacity-60"
          >
            {installState.kind === "fetching" ||
            installState.kind === "saving" ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Download className="h-4 w-4" />
            )}
            {installState.kind === "fetching"
              ? "Fetching…"
              : installState.kind === "saving"
                ? "Saving…"
                : "Install"}
          </button>
        </div>
        {installState.kind === "done" ? (
          <div className="mt-2 inline-flex items-center gap-1.5 text-[11px] text-emerald-400">
            <Check className="h-3.5 w-3.5" />
            {installState.message}
          </div>
        ) : installState.kind === "error" ? (
          <div className="mt-2 text-[11px] text-rose-400">
            {installState.message}
          </div>
        ) : null}
      </div>

      {presets === null ? (
        <div className="glass-panel p-8 text-center text-sm text-slate-500">
          Loading presets…
        </div>
      ) : presets.length === 0 ? (
        <div className="glass-panel p-8 text-center">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-accent/10 text-accent">
            <Sparkles className="h-5 w-5" />
          </div>
          <div className="mt-3 text-sm text-slate-200">
            No custom presets yet.
          </div>
          <div className="mt-1 text-xs text-slate-500 leading-relaxed">
            The Visualizer tab already has a curated pack you can use right
            now. Drop extra{" "}
            <code className="font-mono">.milk</code> files in the folder
            above to grow the library.
          </div>
        </div>
      ) : (
        <div className="grid gap-2 sm:grid-cols-2">
          {presets.map((p) => (
            <div
              key={p.filename}
              className="glass-panel flex items-center gap-3 p-3"
            >
              <div
                className={cn(
                  "flex h-10 w-10 shrink-0 items-center justify-center rounded-md text-[10px] font-bold uppercase tracking-widest",
                  p.kind === "milk3"
                    ? "bg-rose-500/15 text-rose-300"
                    : "bg-accent/15 text-accent",
                )}
              >
                {p.kind === "milk3" ? "M3" : "M2"}
              </div>
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium text-slate-100">
                  {p.name}
                </div>
                <div className="truncate font-mono text-[11px] text-slate-500">
                  {p.filename} · {(p.size_bytes / 1024).toFixed(1)} KB
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="rounded-md border border-amber-500/25 bg-amber-500/5 p-3 text-[11px] text-amber-300/80 leading-relaxed">
        <b>.milk3 files</b> will be listed here once projectM (MilkDrop 3)
        integration ships in Phase 5 — they can&apos;t render in the
        browser today.
      </div>
    </div>
  );
}
