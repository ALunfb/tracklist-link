/**
 * User-tunable settings for the MilkDrop visualizer. Persisted to
 * localStorage so the streamer's knob positions survive app restarts.
 *
 * The values here are applied every frame inside the sampleAudio patch
 * (VisualizerTab.tsx) — they don't flow through to butterchurn preset
 * parameters. Think of them as a mixing console between the FFT feed
 * and whatever the active preset does with its input buffers.
 *
 * Scope cut in v0.8.0: previous fields `attack`, `release`, `noiseGate`
 * were removed (redundant on top of the Rust-side FFT smoothing + the
 * new 30Hz-16kHz band clamp). `spectrumTilt` was renamed to `bassBoost`
 * and narrowed to 0..1 — the treble side had no visible effect on
 * butterchurn presets, which already consume bass/mid/treb separately.
 */

export interface VizSettings {
  /**
   * Per-band multiplier before we hand the spectrum to butterchurn.
   * 1.0 = pass-through the AGC'd band values. Bump to 2-3× if presets
   * look sluggish on quieter tracks, drop to 0.5× if everything's
   * slammed against the ceiling.
   */
  audioGain: number;

  /**
   * Bass boost, 0..1. Multiplies the bottom third of bands by up to 2×
   * so low-frequency energy punches through presets that otherwise sit
   * on the mids. 0 = flat.
   */
  bassBoost: number;

  /**
   * Auto-cycle interval in seconds. Applies when the Shuffle button
   * is active on the transport bar. Range 5-300.
   */
  autoCycleSeconds: number;

  /**
   * Cross-fade duration between presets when switching (either
   * manually or via auto-cycle). 0 = hard cut, ~2 = classic
   * MilkDrop feel, 5 = slow morph.
   */
  blendTime: number;
}

export const DEFAULT_VIZ_SETTINGS: VizSettings = {
  audioGain: 1.0,
  bassBoost: 0,
  autoCycleSeconds: 30,
  blendTime: 2.0,
};

const STORAGE_KEY = "tracklist.viz-settings";

export function loadVizSettings(): VizSettings {
  if (typeof window === "undefined") return DEFAULT_VIZ_SETTINGS;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_VIZ_SETTINGS;
    const parsed = JSON.parse(raw) as Partial<VizSettings>;
    // Merge over defaults so missing fields (schema additions over time)
    // fall through to the newest default value.
    return { ...DEFAULT_VIZ_SETTINGS, ...parsed };
  } catch {
    return DEFAULT_VIZ_SETTINGS;
  }
}

export function saveVizSettings(settings: VizSettings) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // QuotaExceeded is the only realistic failure path in a Tauri
    // WebView, and even then there's nothing the UI can do about it.
  }
}
