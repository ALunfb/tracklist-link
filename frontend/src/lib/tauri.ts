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

/** VizSettings shape mirrors `tracklist_link_proto::VizSettings`. Rust
 *  expects camelCase via `#[serde(rename_all = "camelCase")]` — the
 *  fields here match the TS VizSettings from lib/viz-settings.ts exactly
 *  so we can pass the local object straight through. */
export interface VizSettingsPayload {
  audioGain: number;
  bassBoost: number;
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

/** Read the currently-active preset name from the shared Rust state.
 *  VisualizerTab calls this on mount so the displayed preset survives
 *  tab navigation — without it, the local React `presetIndex` state
 *  resets to 0 every time the tab unmounts. */
export const getVizPreset = () =>
  invoke<{ name: string }>("get_viz_preset");

/** Build the full OBS Browser Source URL with the current token + port.
 *  Used by the "Copy OBS URL" button so streamers never have to manually
 *  concat a token into a URL. The token is URL-safe base64, no further
 *  encoding needed. */
export const companionObsUrl = () =>
  invoke<string>("companion_obs_url");

// --- Preset collections -----------------------------------------------------
// Streamer-curated subsets of the bundled + user preset catalog. Stored
// as preset-collections.json in the app config dir so it survives app
// updates and can be hand-edited if a streamer wants to share a list.

export interface PresetCollection {
  id: string;
  name: string;
  /**
   * Names match what butterchurnPresets.getPresets() returns — the
   * bundled-pack key for catalog presets, or the same with a "◯ "
   * prefix for user-installed ones. The picker uses these directly.
   */
  preset_names: string[];
}

export interface CollectionsView {
  collections: PresetCollection[];
  /** Currently-active collection id; null means "show all presets". */
  active_collection_id: string | null;
}

export const listPresetCollections = () =>
  invoke<CollectionsView>("list_preset_collections");

export const createPresetCollection = (name: string) =>
  invoke<CollectionsView>("create_preset_collection", { name });

export const renamePresetCollection = (id: string, name: string) =>
  invoke<CollectionsView>("rename_preset_collection", { id, name });

export const deletePresetCollection = (id: string) =>
  invoke<CollectionsView>("delete_preset_collection", { id });

export const addToPresetCollection = (id: string, presetName: string) =>
  invoke<CollectionsView>("add_to_preset_collection", {
    id,
    presetName,
  });

export const removeFromPresetCollection = (id: string, presetName: string) =>
  invoke<CollectionsView>("remove_from_preset_collection", {
    id,
    presetName,
  });

export const setActivePresetCollection = (id: string | null) =>
  invoke<CollectionsView>("set_active_preset_collection", { id });

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

export interface SilenceEvent {
  seq: number;
  t_ms: number;
  silent: boolean;
}
