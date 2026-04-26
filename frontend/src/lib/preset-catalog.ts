/**
 * Fetches the Tracklist web app's catalog.json once on first call,
 * caches in module state + localStorage, and exposes a name-to-thumbnail
 * lookup so the in-app preset picker can render preview GIFs alongside
 * names.
 *
 * The catalog lives at https://music.blackpearl.gg/presets/catalog.json
 * (Vercel-served, regenerated on every build). Each entry has:
 *   - slug:             content hash, also the preview filename
 *   - originalFilename: e.g. "_Aderrasi - X - Y.json"
 *   - previewUrl:       full URL to the GIF on Cloudflare R2
 *
 * butterchurn-presets keys its presets by `originalFilename` minus the
 * `.json` extension, so name lookup is straightforward.
 *
 * Stale-while-revalidate cache: returns localStorage immediately if
 * present, kicks off a background fetch to refresh. Streamer never sees
 * a loading spinner past the first launch ever.
 */

const CATALOG_URL = "https://music.blackpearl.gg/presets/catalog.json";
const CACHE_KEY = "tracklist:preset-catalog:v1";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h — catalog rarely changes

export type ReactivityTag = "bass" | "mid" | "treb" | "vol";

export interface CatalogEntry {
  slug: string;
  displayName: string;
  originalFilename: string;
  previewUrl: string | null;
  /** Audio bands the preset's equations actually reference. */
  reactivity: ReactivityTag[];
  author: string | null;
}

interface CatalogPayload {
  fetchedAt: number;
  presets: CatalogEntry[];
}

let lookupByName: Map<string, CatalogEntry> | null = null;
let inflightFetch: Promise<void> | null = null;

function buildLookup(presets: CatalogEntry[]): Map<string, CatalogEntry> {
  const map = new Map<string, CatalogEntry>();
  for (const p of presets) {
    // Strip .json from originalFilename to match the key shape that
    // butterchurnPresets.getPresets() returns.
    const key = p.originalFilename.replace(/\.json$/i, "");
    map.set(key, p);
  }
  return map;
}

function loadCache(): CatalogPayload | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CatalogPayload;
    if (
      !parsed ||
      typeof parsed.fetchedAt !== "number" ||
      !Array.isArray(parsed.presets)
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function saveCache(payload: CatalogPayload): void {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(payload));
  } catch {
    // localStorage may be disabled / quota'd; not fatal — module-state
    // cache still works for the session.
  }
}

async function fetchCatalog(): Promise<void> {
  if (inflightFetch) return inflightFetch;
  inflightFetch = (async () => {
    try {
      const res = await fetch(CATALOG_URL, { cache: "no-store" });
      if (!res.ok) {
        // Don't throw — graceful degrade to "no thumbnails" rather than
        // breaking the picker. Logged once in console for diagnosis.
        console.warn(`[preset-catalog] fetch ${res.status}`);
        return;
      }
      const data = (await res.json()) as { presets?: CatalogEntry[] };
      if (!Array.isArray(data.presets)) {
        console.warn("[preset-catalog] unexpected catalog shape");
        return;
      }
      lookupByName = buildLookup(data.presets);
      saveCache({ fetchedAt: Date.now(), presets: data.presets });
    } catch (err) {
      console.warn("[preset-catalog] fetch failed", err);
    } finally {
      inflightFetch = null;
    }
  })();
  return inflightFetch;
}

/**
 * Initialize from cache (sync, fast) and kick off a background refresh
 * if the cache is missing or stale. Call on app mount.
 */
export function initPresetCatalog(): void {
  const cached = loadCache();
  if (cached) {
    lookupByName = buildLookup(cached.presets);
    if (Date.now() - cached.fetchedAt > CACHE_TTL_MS) {
      void fetchCatalog();
    }
  } else {
    void fetchCatalog();
  }
}

/**
 * Returns the full catalog entry for a preset name as exposed by
 * butterchurnPresets.getPresets(). Returns null if the catalog hasn't
 * loaded yet OR the preset isn't in the catalog (e.g. user-installed
 * preset, render failed at gen time). Never throws.
 *
 * Tries the name as-is, plus stripping the user-preset glyph prefix
 * ("◯ ") that the companion uses to mark filesystem-imported presets.
 */
export function getPresetEntry(name: string): CatalogEntry | null {
  if (!lookupByName) return null;
  const stripped = name.replace(/^◯\s+/, "");
  return lookupByName.get(name) ?? lookupByName.get(stripped) ?? null;
}

/**
 * Convenience accessor for just the thumbnail URL — most callers in
 * the picker only need this. Returns null when the catalog miss
 * means we can't show a thumb.
 */
export function getPresetThumbnailUrl(name: string): string | null {
  return getPresetEntry(name)?.previewUrl ?? null;
}

/**
 * For diagnostics — returns whether the catalog has been loaded yet.
 */
export function isPresetCatalogReady(): boolean {
  return lookupByName !== null && lookupByName.size > 0;
}
