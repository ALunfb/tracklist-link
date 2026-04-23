import { useEffect, useState } from "react";
import { Sidebar, type TabId } from "./components/Sidebar";
import { StatusTab } from "./components/tabs/StatusTab";
import { VisualizerTab } from "./components/tabs/VisualizerTab";
import { PresetsTab } from "./components/tabs/PresetsTab";
import { SettingsTab } from "./components/tabs/SettingsTab";
import { AboutTab } from "./components/tabs/AboutTab";
import { getStatus, type StatusView } from "./lib/tauri";

/**
 * Root shell. Left sidebar selects the active tab; the main pane renders
 * whichever tab is active. Status/Settings are the functional tabs in this
 * Phase 1 MVP; Visualizer and Presets are placeholders so the navigation
 * feels complete while Phase 2 / 3 land.
 */
export default function App() {
  const [tab, setTab] = useState<TabId>("status");
  const [status, setStatus] = useState<StatusView | null>(null);

  // Poll status every 3s. Cheap: a single IPC round-trip, no allocations.
  // Used for the connection indicator in the sidebar footer.
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const next = await getStatus();
        if (alive) setStatus(next);
      } catch {
        // Rust side might not be ready yet on very first paint; just retry.
      }
    };
    void tick();
    const id = window.setInterval(tick, 3000);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, []);

  return (
    <div className="flex h-full w-full bg-base-900 text-slate-100">
      <Sidebar active={tab} onSelect={setTab} status={status} />
      <main className="relative flex-1 overflow-y-auto">
        <div className="hero-gradient pointer-events-none absolute inset-x-0 top-0 h-48" />
        <div className="relative mx-auto max-w-4xl px-8 py-8">
          {tab === "status" ? <StatusTab /> : null}
          {tab === "visualizer" ? <VisualizerTab /> : null}
          {tab === "presets" ? <PresetsTab /> : null}
          {tab === "settings" ? <SettingsTab /> : null}
          {tab === "about" ? <AboutTab /> : null}
        </div>
      </main>
    </div>
  );
}
