/**
 * Typed wrappers around the Rust-side Tauri commands. Keep every IPC call
 * funneled through this file so the React components never touch `invoke`
 * directly — makes the call surface easy to audit + mock in tests.
 */

import { invoke } from "@tauri-apps/api/core";

export interface StatusView {
  app_version: string;
  port: number;
  sample_rate: number;
  bind_addr: string;
}

export interface ConfigView {
  port: number;
  token: string;
  allowed_origins: string[];
  sample_rate: number;
  launch_minimized: boolean;
  audio_device_name: string | null;
  beat_sensitivity: number;
}

export interface AudioDeviceInfo {
  name: string;
  is_default: boolean;
}

export const getStatus = () => invoke<StatusView>("get_status");
export const getConfig = () => invoke<ConfigView>("get_config");
export const regenerateToken = () => invoke<string>("regenerate_token");
export const openPairUrl = () => invoke<string>("open_pair_url");
export const copyTokenToClipboard = () => invoke<void>("copy_token_to_clipboard");
export const openConfigFolder = () => invoke<void>("open_config_folder");

export interface PresetEntry {
  name: string;
  filename: string;
  size_bytes: number;
  modified_ms: number;
  kind: "milk2" | "milk3" | "butterchurn";
}

export const listPresets = () => invoke<PresetEntry[]>("list_presets");
export const readPreset = (filename: string) =>
  invoke<string>("read_preset", { filename });
export const openPresetsFolder = () => invoke<void>("open_presets_folder");
export const savePreset = (filename: string, contents: string) =>
  invoke<void>("save_preset", { filename, contents });

export const getAutostart = () => invoke<boolean>("get_autostart");
export const setAutostart = (enabled: boolean) =>
  invoke<void>("set_autostart", { enabled });
export const setLaunchMinimized = (enabled: boolean) =>
  invoke<void>("set_launch_minimized", { enabled });

export const listAudioDevices = () =>
  invoke<AudioDeviceInfo[]>("list_audio_devices");
export const setAudioDevice = (name: string | null) =>
  invoke<void>("set_audio_device", { name });
export const setBeatSensitivity = (value: number) =>
  invoke<void>("set_beat_sensitivity", { value });

/** VizSettings shape mirrors `tracklist_link_proto::VizSettings`. Rust
 *  expects camelCase via `#[serde(rename_all = "camelCase")]` — the
 *  fields here match the TS VizSettings from lib/viz-settings.ts exactly
 *  so we can pass the local object straight through. */
export interface VizSettingsPayload {
  audioGain: number;
  attack: number;
  release: number;
  spectrumTilt: number;
  noiseGate: number;
  autoCycleSeconds: number;
  blendTime: number;
}

/** Push current Tune settings to the Rust WS server so every connected
 *  external client (the web /visualizer running in OBS) mirrors them
 *  live. Fire-and-forget — local viz keeps reading from localStorage
 *  directly, so failures never disrupt the in-app experience. */
export const setVizSettings = (settings: VizSettingsPayload) =>
  invoke<void>("set_viz_settings", { settings });

/** Broadcast the current preset name. Invoked by VisualizerTab after
 *  every loadPreset (auto-cycle or manual pick) so all connected
 *  visualizer instances converge on the same preset. Fire-and-forget. */
export const setVizPreset = (name: string) =>
  invoke<void>("set_viz_preset", { name });

export interface FftEvent {
  seq: number;
  t_ms: number;
  bands: number[];
}

export interface LevelEvent {
  seq: number;
  t_ms: number;
  rms: number;
  peak: number;
}

export interface BeatEvent {
  seq: number;
  t_ms: number;
  confidence: number;
}

export interface SilenceEvent {
  seq: number;
  t_ms: number;
  silent: boolean;
}
