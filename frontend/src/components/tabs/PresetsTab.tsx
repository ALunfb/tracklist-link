import { Download, Folder, Hourglass } from "lucide-react";
import { openConfigFolder } from "../../lib/tauri";

/**
 * Phase-3 placeholder. Will list .milk/.milk2/.milk3 files from
 * %APPDATA%\blackpearl\tracklist-link\presets\ and let the streamer
 * preview / enable each one. Until then we still surface the Open
 * folder button so streamers can drop presets in ahead of time.
 */
export function PresetsTab() {
  return (
    <div className="space-y-6">
      <div>
        <div className="text-[11px] uppercase tracking-[0.22em] text-slate-500">
          Companion · Presets
        </div>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">
          MilkDrop preset library
        </h1>
        <p className="mt-2 max-w-xl text-sm text-slate-400 leading-relaxed">
          Drop <code className="font-mono text-slate-300">.milk</code> files
          into your presets folder and they'll show up here once Phase 3
          ships. You can pre-seed the folder today; the Visualizer tab
          will pick them up automatically when it goes live.
        </p>
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
              %APPDATA%\blackpearl\tracklist-link\config\
            </div>
          </div>
        </div>
        <button
          onClick={() => void openConfigFolder()}
          className="inline-flex items-center gap-2 rounded-md border border-surface-border bg-surface px-3 py-1.5 text-sm text-slate-200 hover:bg-surface-hover hover:text-white"
        >
          <Folder className="h-4 w-4" />
          Open in Explorer
        </button>
      </div>

      <div className="glass-panel flex items-center justify-between gap-4 p-5">
        <div>
          <div className="flex items-center gap-2 text-sm font-medium text-slate-100">
            <Download className="h-4 w-4 text-accent" />
            Free preset packs — on the way
          </div>
          <p className="mt-1 max-w-lg text-xs text-slate-400 leading-relaxed">
            We're curating a preset gallery on{" "}
            <span className="text-slate-200">music.blackpearl.gg/visualizers</span>{" "}
            with one-click downloads that land directly in this folder. For
            now you can bring your own — any MilkDrop 2 preset works.
          </p>
        </div>
        <div className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-surface-border bg-surface px-2.5 py-0.5 text-[10px] uppercase tracking-widest text-slate-400">
          <Hourglass className="h-3 w-3" />
          Phase 4
        </div>
      </div>
    </div>
  );
}
