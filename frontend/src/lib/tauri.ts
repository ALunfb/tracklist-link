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
