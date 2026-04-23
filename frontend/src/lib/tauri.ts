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
}

export const getStatus = () => invoke<StatusView>("get_status");
export const getConfig = () => invoke<ConfigView>("get_config");
export const regenerateToken = () => invoke<string>("regenerate_token");
export const openPairUrl = () => invoke<string>("open_pair_url");
export const copyTokenToClipboard = () => invoke<void>("copy_token_to_clipboard");
export const openConfigFolder = () => invoke<void>("open_config_folder");
