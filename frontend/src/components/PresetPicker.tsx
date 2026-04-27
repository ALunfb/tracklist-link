import { useEffect, useMemo, useRef, useState } from "react";
import { Search, X, ChevronDown, Star, Folder, Plus, Trash2 } from "lucide-react";
import { cn } from "../lib/cn";
import {
  getPresetEntry,
  getPresetThumbnailUrl,
  type ReactivityTag,
} from "../lib/preset-catalog";
import { useCollections } from "../lib/use-collections";

/**
 * Rich preset picker — replaces the previous <select> + standalone
 * search input pair. Built for the 1738-preset Cream of the Crop
 * catalog where a flat dropdown loses half its value at scale.
 *
 * Three changes vs the old picker:
 *   1. Multi-signal search: a single query box matches against the
 *      preset's display name, author (parsed from the original
 *      filename's "<author> - <title>" convention), AND reactivity
 *      tags (bass/mid/treb/vol — pulled from the catalog manifest
 *      which the renderer's static analysis already produced).
 *   2. Reactivity filter chips: streamers tuning to bass-heavy music
 *      can pre-filter to bass-reactive presets in one click. The
 *      filter ANDs with the search query.
 *   3. Visual results: each row shows a 80×45 thumbnail (lazy-loaded
 *      from previews.blackpearl.gg) so streamers can scan visually
 *      instead of reading filename poetry. User-installed presets
 *      (◯ prefix) and the 5 render-failures show a placeholder; no
 *      hard error.
 *
 * Performance notes:
 *   - Catalog lookup is O(1) via the Map built once on app mount.
 *   - Thumbnails use loading="lazy" + a hard cap of 50 visible rows
 *     so the browser never tries to decode 1700 GIFs simultaneously.
 *   - The "show more" affordance expands the cap by 50 each click
 *     for cases where a streamer wants to scroll the full filtered
 *     set without typing more.
 */

interface Props {
  /** All preset names available, already merged (user + bundled) and sorted. */
  names: string[];
  /** Currently selected preset's index in `names`. */
  selectedIndex: number;
  /** Setter — receives the new index in `names`. */
  onSelect: (index: number) => void;
}

interface ScoredEntry {
  /** Index back into `names` so onSelect can be called with it. */
  idx: number;
  name: string;
  /** Parsed from "Author - Title" convention; falls back to null. */
  author: string | null;
  /** From catalog if available, else empty array. */
  reactivity: ReactivityTag[];
  /** Higher = better match. 0 = no match (filtered out). */
  score: number;
  /** R2 thumbnail URL or null if unavailable. */
  thumbnailUrl: string | null;
}

const REACTIVITY_LABELS: Record<ReactivityTag, string> = {
  bass: "Bass",
  mid: "Mid",
  treb: "Treble",
  vol: "Volume",
};

const INITIAL_VISIBLE = 50;
const VISIBLE_PAGE_SIZE = 50;

/**
 * Splits "Author - Title" filename convention into parts. Stripped
 * directly from the catalog generator's parseNameParts so behavior
 * matches what the gallery shows. Returns author=null for names that
 * don't follow the convention (some user-installed presets won't).
 */
function parseAuthor(name: string): { author: string | null; title: string } {
  // Strip the user-preset glyph + sort-hack prefixes the catalog gen
  // also strips, so search matches the cleaned form.
  const cleaned = name
    .replace(/^◯\s+/, "")
    .replace(/^\$+\s*/, "")
    .replace(/^!+\s*/, "")
    .replace(/^@+\s*/, "")
    .replace(/^-+\s*/, "")
    .replace(/^\*+\s*/, "")
    .trim();
  const idx = cleaned.indexOf(" - ");
  if (idx < 0) return { author: null, title: cleaned };
  const author = cleaned.slice(0, idx).trim();
  const title = cleaned.slice(idx + 3).trim();
  if (!title) return { author: null, title: cleaned };
  return { author, title };
}

export function PresetPicker({ names, selectedIndex, onSelect }: Props) {
  const [query, setQuery] = useState("");
  const [activeFilters, setActiveFilters] = useState<Set<ReactivityTag>>(
    new Set(),
  );
  const [visibleLimit, setVisibleLimit] = useState(INITIAL_VISIBLE);
  const [open, setOpen] = useState(false);
  const [showCollections, setShowCollections] = useState(false);
  const [creatingCollection, setCreatingCollection] = useState(false);
  const [newCollectionName, setNewCollectionName] = useState("");
  const containerRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const newCollectionInputRef = useRef<HTMLInputElement | null>(null);

  const {
    collections,
    activeCollection,
    activeCollectionId,
    isInActiveCollection,
    toggleInActiveCollection,
    createCollection,
    deleteCollection,
    setActiveCollection,
  } = useCollections();

  // Membership set for the active collection — pre-built so the indexed
  // loop below can do an O(1) check per preset rather than .includes()
  // on a 1700-name array.
  const activeCollectionSet = useMemo(() => {
    if (!activeCollection) return null;
    return new Set(activeCollection.preset_names);
  }, [activeCollection]);

  // Close on outside click — the picker is positioned in the layout
  // not as a modal, but a click anywhere outside should collapse it
  // since it can be tall.
  useEffect(() => {
    if (!open) return;
    const handle = (e: MouseEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    };
    window.addEventListener("mousedown", handle);
    return () => window.removeEventListener("mousedown", handle);
  }, [open]);

  // When opening, focus the search input + reset visible cap. Keeps
  // the experience consistent every time the streamer reaches for it.
  useEffect(() => {
    if (open) {
      setVisibleLimit(INITIAL_VISIBLE);
      // Defer to next tick so the input is mounted.
      const id = window.setTimeout(() => {
        inputRef.current?.focus();
      }, 0);
      return () => window.clearTimeout(id);
    }
  }, [open]);

  // Build the searchable index once per `names` change. Each entry
  // pulls thumbnail + reactivity tags + author from the catalog; falls
  // back to filename-parsed author + empty tags for user-installed
  // presets (◯ prefix) that aren't in the catalog.
  const indexed = useMemo<Omit<ScoredEntry, "score">[]>(() => {
    return names.map((name, idx) => {
      const entry = getPresetEntry(name);
      const author = entry?.author ?? parseAuthor(name).author;
      const reactivity = entry?.reactivity ?? [];
      const thumbnailUrl = entry?.previewUrl ?? null;
      return { idx, name, author, reactivity, thumbnailUrl };
    });
  }, [names]);

  // Score each preset against the current query + filters. Substring
  // match on three fields with weighted scoring:
  //   name match    +3 (most signal — what streamers usually type)
  //   author match  +2
  //   tag match     +1 (e.g. "bass" matches the chip semantically)
  const filtered = useMemo<ScoredEntry[]>(() => {
    const q = query.trim().toLowerCase();
    const tokens = q.length > 0 ? q.split(/\s+/) : [];
    const out: ScoredEntry[] = [];

    for (const entry of indexed) {
      // Active-collection scope hard-filters before anything else. When
      // a collection is selected, only its members are candidates for
      // the rest of the picker (search, reactivity chips, etc).
      if (activeCollectionSet && !activeCollectionSet.has(entry.name)) {
        continue;
      }

      // Reactivity filter chips AND with everything else.
      if (activeFilters.size > 0) {
        let allMatched = true;
        for (const f of activeFilters) {
          if (!entry.reactivity.includes(f)) {
            allMatched = false;
            break;
          }
        }
        if (!allMatched) continue;
      }

      let score = 0;
      if (tokens.length === 0) {
        score = 1; // pass-through when no query, no filter
      } else {
        const nameLc = entry.name.toLowerCase();
        const authorLc = (entry.author ?? "").toLowerCase();
        let allTokensMatched = true;
        for (const t of tokens) {
          let tokenHit = false;
          if (nameLc.includes(t)) {
            score += 3;
            tokenHit = true;
          }
          if (authorLc && authorLc.includes(t)) {
            score += 2;
            tokenHit = true;
          }
          // Match against reactivity literal (when reactivity data lands).
          if (
            (t === "bass" || t === "mid" || t === "treb" || t === "vol") &&
            entry.reactivity.includes(t as ReactivityTag)
          ) {
            score += 1;
            tokenHit = true;
          }
          if (!tokenHit) {
            // Every token must match SOMETHING; otherwise filter out.
            // Keeps multi-word queries like "geiss color" precise rather
            // than turning them into noisy OR matches.
            allTokensMatched = false;
            break;
          }
        }
        if (!allTokensMatched) continue;
      }

      out.push({ ...entry, score });
    }

    // Sort by score desc, then name asc for stable order on ties.
    out.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.name.localeCompare(b.name);
    });
    return out;
  }, [indexed, query, activeFilters, activeCollectionSet]);

  const visible = filtered.slice(0, visibleLimit);
  const hasMore = filtered.length > visibleLimit;

  const selectedName = names[selectedIndex];
  const selectedThumbnail = selectedName
    ? getPresetThumbnailUrl(selectedName)
    : null;

  function toggleFilter(tag: ReactivityTag) {
    setActiveFilters((prev) => {
      const next = new Set(prev);
      if (next.has(tag)) next.delete(tag);
      else next.add(tag);
      return next;
    });
    setVisibleLimit(INITIAL_VISIBLE);
  }

  function pick(idx: number) {
    onSelect(idx);
    setOpen(false);
  }

  /**
   * Create a new collection inline from the picker. After creation,
   * activate it so the streamer can immediately star presets into it.
   */
  async function handleCreateCollection() {
    const name = newCollectionName.trim();
    if (!name) {
      setCreatingCollection(false);
      return;
    }
    const created = await createCollection(name);
    if (created) {
      await setActiveCollection(created.id);
    }
    setNewCollectionName("");
    setCreatingCollection(false);
  }

  // Focus the inline-create input when the streamer opens it.
  useEffect(() => {
    if (creatingCollection) {
      newCollectionInputRef.current?.focus();
    }
  }, [creatingCollection]);

  return (
    <div ref={containerRef} className="relative w-full">
      {/* Trigger row — shows the currently-selected preset with its
          thumbnail. Click to expand the picker. */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "flex w-full items-center gap-2 rounded-md border bg-base-800 px-2 py-1.5 text-sm text-slate-100 hover:bg-surface-hover focus:border-accent focus:outline-none",
          open ? "border-accent" : "border-surface-border",
        )}
      >
        <PresetThumb url={selectedThumbnail} size="sm" />
        <div className="min-w-0 flex-1 text-left">
          <div className="truncate font-medium">{selectedName ?? "—"}</div>
        </div>
        <ChevronDown
          className={cn(
            "h-4 w-4 shrink-0 text-slate-400 transition-transform",
            open && "rotate-180",
          )}
        />
      </button>

      {open ? (
        <div className="absolute left-0 right-0 top-full z-30 mt-1 rounded-md border border-surface-border bg-base-900 shadow-2xl shadow-black/40">
          {/* Collection scope row — sits above search so the streamer
              chooses "what pool am I picking from" before "what within
              that pool am I looking for". */}
          <div className="border-b border-surface-border px-2.5 py-2">
            <div className="flex items-center gap-2">
              <Folder
                className={cn(
                  "h-4 w-4 shrink-0",
                  activeCollectionId ? "text-accent" : "text-slate-500",
                )}
              />
              <button
                type="button"
                onClick={() => setShowCollections((v) => !v)}
                className="flex flex-1 items-center gap-1 text-left text-sm text-slate-200 hover:text-white"
              >
                <span className="truncate">
                  {activeCollection
                    ? activeCollection.name
                    : "All presets"}
                </span>
                <span className="text-[11px] tabular-nums text-slate-500">
                  ({activeCollection
                    ? activeCollection.preset_names.length
                    : names.length})
                </span>
                <ChevronDown
                  className={cn(
                    "h-3.5 w-3.5 text-slate-500 transition-transform",
                    showCollections && "rotate-180",
                  )}
                />
              </button>
              {activeCollectionId ? (
                <button
                  type="button"
                  onClick={() => void setActiveCollection(null)}
                  title="Clear collection scope"
                  className="text-slate-500 hover:text-slate-300"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              ) : null}
            </div>
            {showCollections ? (
              <ul className="mt-2 space-y-0.5 rounded border border-surface-border/60 bg-base-800 p-1">
                <li>
                  <button
                    type="button"
                    onClick={() => {
                      void setActiveCollection(null);
                      setShowCollections(false);
                    }}
                    className={cn(
                      "flex w-full items-center justify-between rounded px-2 py-1 text-left text-sm hover:bg-surface-hover",
                      !activeCollectionId && "bg-accent/10 text-accent",
                    )}
                  >
                    <span>All presets</span>
                    <span className="text-[11px] tabular-nums text-slate-500">
                      {names.length}
                    </span>
                  </button>
                </li>
                {collections.map((c) => (
                  <li key={c.id}>
                    <div className="group flex items-center gap-1">
                      <button
                        type="button"
                        onClick={() => {
                          void setActiveCollection(c.id);
                          setShowCollections(false);
                        }}
                        className={cn(
                          "flex flex-1 items-center justify-between rounded px-2 py-1 text-left text-sm hover:bg-surface-hover",
                          c.id === activeCollectionId && "bg-accent/10 text-accent",
                        )}
                      >
                        <span className="truncate">{c.name}</span>
                        <span className="ml-2 text-[11px] tabular-nums text-slate-500">
                          {c.preset_names.length}
                        </span>
                      </button>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          if (
                            window.confirm(
                              `Delete collection "${c.name}"? Presets stay in the catalog; only this curated list is removed.`,
                            )
                          ) {
                            void deleteCollection(c.id);
                          }
                        }}
                        title="Delete collection"
                        className="opacity-0 transition-opacity group-hover:opacity-100 text-slate-500 hover:text-rose-300 px-1"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </li>
                ))}
                <li className="border-t border-surface-border/40 pt-1 mt-1">
                  {creatingCollection ? (
                    <div className="flex items-center gap-1 px-1">
                      <input
                        ref={newCollectionInputRef}
                        value={newCollectionName}
                        onChange={(e) => setNewCollectionName(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") void handleCreateCollection();
                          if (e.key === "Escape") {
                            setCreatingCollection(false);
                            setNewCollectionName("");
                          }
                        }}
                        placeholder="Collection name"
                        maxLength={64}
                        className="flex-1 rounded border border-surface-border bg-base-900 px-2 py-1 text-xs text-slate-100 placeholder:text-slate-600 focus:border-accent focus:outline-none"
                      />
                      <button
                        type="button"
                        onClick={() => void handleCreateCollection()}
                        className="rounded px-2 py-1 text-xs font-medium text-accent hover:bg-accent/10"
                      >
                        Add
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setCreatingCollection(true)}
                      className="flex w-full items-center gap-1.5 rounded px-2 py-1 text-left text-xs text-slate-400 hover:bg-surface-hover hover:text-slate-200"
                    >
                      <Plus className="h-3.5 w-3.5" />
                      New collection…
                    </button>
                  )}
                </li>
              </ul>
            ) : null}
          </div>

          {/* Search row. */}
          <div className="flex items-center gap-2 border-b border-surface-border px-2.5 py-2">
            <Search className="h-4 w-4 text-slate-500" />
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setVisibleLimit(INITIAL_VISIBLE);
              }}
              placeholder={
                activeCollection
                  ? `Search in "${activeCollection.name}"…`
                  : "Search by name, author, or vibe…"
              }
              className="flex-1 bg-transparent py-1 text-sm text-slate-100 placeholder:text-slate-600 focus:outline-none"
            />
            {query ? (
              <button
                onClick={() => setQuery("")}
                className="text-slate-500 hover:text-slate-300"
                title="Clear"
              >
                <X className="h-4 w-4" />
              </button>
            ) : null}
            <span className="text-[11px] tabular-nums text-slate-500">
              {filtered.length}
              {filtered.length !== names.length ? ` / ${names.length}` : ""}
            </span>
          </div>

          {/* Filter chips for reactivity. Catalog-backed presets only;
              user-installed and render-failures don't surface here. */}
          <div className="flex flex-wrap items-center gap-1.5 border-b border-surface-border px-2.5 py-2">
            <span className="text-[10px] uppercase tracking-widest text-slate-500">
              React
            </span>
            {(Object.keys(REACTIVITY_LABELS) as ReactivityTag[]).map((tag) => {
              const active = activeFilters.has(tag);
              return (
                <button
                  key={tag}
                  type="button"
                  onClick={() => toggleFilter(tag)}
                  className={cn(
                    "rounded-full border px-2 py-0.5 text-[11px] transition-colors",
                    active
                      ? "border-accent/50 bg-accent/15 text-accent"
                      : "border-surface-border bg-surface text-slate-400 hover:text-slate-200",
                  )}
                >
                  {REACTIVITY_LABELS[tag]}
                </button>
              );
            })}
            {activeFilters.size > 0 ? (
              <button
                type="button"
                onClick={() => setActiveFilters(new Set())}
                className="ml-auto text-[11px] text-slate-500 hover:text-slate-300"
              >
                Clear
              </button>
            ) : null}
          </div>

          {/* Results list — virtualized cap at 50 visible by default,
              "show more" expands. Each row: thumb + name + author. */}
          <div className="max-h-[420px] overflow-y-auto">
            {visible.length === 0 ? (
              <div className="px-3 py-6 text-center text-xs text-slate-500">
                {activeCollection && filtered.length === 0 && !query
                  ? `"${activeCollection.name}" is empty. Switch to All presets, then ★ presets to add them here.`
                  : "No presets match — try a different search or clear filters."}
              </div>
            ) : (
              <ul className="divide-y divide-surface-border/40">
                {visible.map((entry) => {
                  const isActive = entry.idx === selectedIndex;
                  const inActive = activeCollectionId
                    ? isInActiveCollection(entry.name)
                    : false;
                  return (
                    <li key={entry.idx} className="group/row flex items-stretch">
                      <button
                        type="button"
                        onClick={() => pick(entry.idx)}
                        className={cn(
                          "flex flex-1 min-w-0 items-center gap-3 px-2.5 py-1.5 text-left hover:bg-surface-hover/60",
                          isActive && "bg-accent/10",
                        )}
                      >
                        <PresetThumb url={entry.thumbnailUrl} size="md" />
                        <div className="min-w-0 flex-1">
                          <div
                            className={cn(
                              "truncate text-sm",
                              isActive
                                ? "font-semibold text-accent"
                                : "text-slate-100",
                            )}
                          >
                            {entry.name}
                          </div>
                          {entry.author ? (
                            <div className="truncate text-[11px] text-slate-500">
                              {entry.author}
                            </div>
                          ) : null}
                        </div>
                      </button>
                      {/* Star toggle — only renders when a collection
                          is active. Always visible (filled) when the
                          preset is in the active collection; hover-only
                          (outline) otherwise so the column doesn't
                          look noisy. */}
                      {activeCollectionId ? (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            void toggleInActiveCollection(entry.name);
                          }}
                          title={
                            inActive
                              ? `Remove from "${activeCollection?.name}"`
                              : `Add to "${activeCollection?.name}"`
                          }
                          className={cn(
                            "flex w-9 shrink-0 items-center justify-center transition-opacity",
                            inActive
                              ? "text-amber-400 opacity-100"
                              : "text-slate-500 opacity-0 hover:text-amber-400 group-hover/row:opacity-100",
                          )}
                        >
                          <Star
                            className="h-4 w-4"
                            fill={inActive ? "currentColor" : "none"}
                          />
                        </button>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            )}
            {hasMore ? (
              <div className="border-t border-surface-border px-2.5 py-2 text-center">
                <button
                  type="button"
                  onClick={() => setVisibleLimit((n) => n + VISIBLE_PAGE_SIZE)}
                  className="text-xs text-slate-400 hover:text-slate-200"
                >
                  Show {Math.min(VISIBLE_PAGE_SIZE, filtered.length - visibleLimit)} more
                </button>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Inline thumbnail for a preset. Two sizes: sm (24×14, in the trigger
 * row) and md (56×32, in the results list). Uses native loading="lazy"
 * so off-screen thumbs in the dropdown never hit the network until
 * scrolled into view.
 */
function PresetThumb({
  url,
  size,
}: {
  url: string | null;
  size: "sm" | "md";
}) {
  const dims = size === "sm"
    ? "h-[14px] w-[24px]"
    : "h-[32px] w-[56px]";
  if (!url) {
    return (
      <div
        aria-hidden
        className={cn(
          "shrink-0 rounded-sm border border-surface-border/60 bg-base-800",
          dims,
        )}
      />
    );
  }
  return (
    <img
      src={url}
      loading="lazy"
      decoding="async"
      alt=""
      className={cn(
        "shrink-0 rounded-sm border border-surface-border/40 object-cover",
        dims,
      )}
    />
  );
}
