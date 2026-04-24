/**
 * User-tunable settings for the MilkDrop visualizer. Persisted to
 * localStorage so the streamer's knob positions survive app restarts.
 *
 * The values here are applied every frame inside the sampleAudio patch
 * (VisualizerTab.tsx) — they don't flow through to butterchurn preset
 * parameters. Think of them as a mixing console between the FFT feed
 * and whatever the active preset does with its input buffers.
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
   * Fast-attack / slow-release envelope follower applied per band.
   * Higher attack = bars jump up instantly. Higher release = bars
   * decay more slowly (trails). Both are raw IIR alphas in [0, 1].
   */
  attack: number;
  release: number;

  /**
   * Frequency-response tilt: -1 boosts bass, +1 boosts treble, 0 is
   * flat. Applied as a linear ramp across the band array. Useful
   * because some presets key off low-frequency energy (kicks) while
   * others prefer the treble band to move.
   */
  spectrumTilt: number;

  /**
   * Noise gate in 0..1. Bands below this magnitude are zeroed before
   * anything downstream sees them. Cuts ambient fan/crowd noise from
   * driving the visualizer during quiet moments.
   */
  noiseGate: number;

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
  attack: 0.55,
  release: 0.12,
  spectrumTilt: 0,
  noiseGate: 0,
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
