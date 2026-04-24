/**
 * Per-install OBS WebSocket settings (host, port, password). Persisted
 * to localStorage so the streamer doesn't re-enter them every time they
 * open the Add-to-OBS modal. Stored in the webview's localStorage —
 * scoped to the companion's origin, not shared with the website.
 *
 * Password is stored in plaintext. The Windows user profile is the
 * trust boundary for everything in the companion's local storage
 * (Spotify cookies, companion token, etc.); encrypting-at-rest here
 * would buy nothing without a broader threat-model shift.
 */

const STORAGE_KEY = "tracklist.obs-ws";

export interface ObsWsSettings {
  /** Default 127.0.0.1 — OBS never listens on anything else by default. */
  host: string;
  port: number;
  /** Empty string = no password (obs-websocket auth disabled). */
  password: string;
}

export const DEFAULT_OBS_SETTINGS: ObsWsSettings = {
  host: "127.0.0.1",
  port: 4455,
  password: "",
};

export function loadObsSettings(): ObsWsSettings {
  if (typeof window === "undefined") return DEFAULT_OBS_SETTINGS;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_OBS_SETTINGS;
    const parsed = JSON.parse(raw) as Partial<ObsWsSettings>;
    return { ...DEFAULT_OBS_SETTINGS, ...parsed };
  } catch {
    return DEFAULT_OBS_SETTINGS;
  }
}

export function saveObsSettings(settings: ObsWsSettings): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // QuotaExceeded etc. — ignore; settings just won't persist.
  }
}
