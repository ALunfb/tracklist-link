import {
  Activity,
  Info,
  LayoutGrid,
  Settings,
  Sparkles,
  Zap,
} from "lucide-react";
import { cn } from "../lib/cn";
import type { StatusView } from "../lib/tauri";

export type TabId = "status" | "visualizer" | "presets" | "settings" | "about";

interface NavItem {
  id: TabId;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  badge?: string;
}

const NAV: NavItem[] = [
  { id: "status", label: "Status", icon: Activity },
  { id: "visualizer", label: "Visualizer", icon: Sparkles },
  { id: "presets", label: "Presets", icon: LayoutGrid },
  { id: "settings", label: "Settings", icon: Settings },
  { id: "about", label: "About", icon: Info },
];

interface Props {
  active: TabId;
  onSelect: (tab: TabId) => void;
  status: StatusView | null;
}

export function Sidebar({ active, onSelect, status }: Props) {
  return (
    <aside className="flex h-full w-56 shrink-0 flex-col border-r border-surface-border bg-base-950/80 backdrop-blur">
      <div className="flex h-14 items-center gap-2 border-b border-surface-border px-4">
        <div className="flex h-8 w-8 items-center justify-center rounded-md bg-accent/15 text-accent">
          <Zap className="h-4 w-4" />
        </div>
        <div className="flex min-w-0 flex-col leading-none">
          <span className="text-sm font-semibold">Tracklist Link</span>
          <span className="truncate text-[10px] uppercase tracking-widest text-slate-500">
            companion
          </span>
        </div>
      </div>

      <nav className="flex flex-1 flex-col gap-0.5 p-2">
        {NAV.map((item) => {
          const Icon = item.icon;
          const isActive = active === item.id;
          return (
            <button
              key={item.id}
              onClick={() => onSelect(item.id)}
              className={cn(
                "group flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors",
                isActive
                  ? "bg-accent/15 text-white"
                  : "text-slate-400 hover:bg-surface hover:text-slate-100",
              )}
            >
              <Icon
                className={cn(
                  "h-4 w-4 shrink-0 transition-colors",
                  isActive ? "text-accent" : "group-hover:text-slate-200",
                )}
              />
              <span className="flex-1 text-left">{item.label}</span>
              {item.badge ? (
                <span className="rounded-full bg-surface-border px-1.5 py-0.5 text-[9px] uppercase tracking-widest text-slate-500">
                  {item.badge}
                </span>
              ) : null}
            </button>
          );
        })}
      </nav>

      {/* Status footer — bind address + version. Green pulse = server up. */}
      <div className="border-t border-surface-border p-3">
        <div className="flex items-center gap-2 text-[11px] text-slate-400">
          <span className="relative flex h-2 w-2">
            <span
              className={cn(
                "absolute inline-flex h-full w-full rounded-full opacity-60",
                status ? "animate-ping bg-emerald-400" : "bg-slate-600",
              )}
            />
            <span
              className={cn(
                "relative inline-flex h-2 w-2 rounded-full",
                status ? "bg-emerald-500" : "bg-slate-600",
              )}
            />
          </span>
          <span className="font-mono truncate">
            {status ? status.bind_addr : "starting…"}
          </span>
        </div>
        <div className="mt-1 font-mono text-[10px] text-slate-600">
          {status ? `v${status.app_version}` : ""}
        </div>
      </div>
    </aside>
  );
}
