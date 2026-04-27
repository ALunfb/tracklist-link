import { useEffect, useMemo, useRef, useState } from "react";
import { Search, X, Star, Plus, Trash2 } from "lucide-react";
import { cn } from "../lib/cn";
import {
  getPresetEntry,
  type ReactivityTag,
} from "../lib/preset-catalog";
import { useCollections } from "../lib/use-collections";

/**
 * Persistent preset grid that lives below the visualizer canvas.
 *
 * Replaces the previous dropdown picker outright — at 1738 presets a
 * dropdown is the wrong primitive. Streamers want to scan thumbnails
 * (the preview GIFs we shipped to R2 last session), star ones that
 * work for their music, and click to load.
 *
 * Layout, top → bottom:
 *   1. Collection chip rail — All / Faves / Bass Heavy / + New, with
 *      hover-revealed delete on each non-default chip.
 *   2. Search input + reactivity filter chips (Bass / Mid / Treb / Vol).
 *   3. Tile grid: 2/3/4/5 cols by viewport. Each tile is a thumbnail
 *      + name + persistent star button corner. Currently-loaded preset
 *      gets an accent border. Click anywhere on a tile = load.
 *   4. "Show 50 more" button below the cap when filtered set exceeds
 *      visibleLimit.
 *
 * Performance:
 *   - Hard cap at INITIAL_VISIBLE = 60 thumbnails so the browser never
 *     decodes 1700 GIFs at once. Each card uses loading="lazy" + a
 *     decoding=async hint as belt-and-suspenders.
 *   - Indexed lookup is O(1) per preset (catalog hash map).
 *   - Score sort runs on every keystroke but only over the filtered
 *     set; cheap enough at 1700 items that a debounce isn't worth the
 *     UX penalty.
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

const INITIAL_VISIBLE = 60;
const VISIBLE_PAGE_SIZE = 60;

function parseAuthor(name: string): { author: string | null; title: string } {
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

export function PresetGrid({ names, selectedIndex, onSelect }: Props) {
  const [query, setQuery] = useState("");
  const [activeFilters, setActiveFilters] = useState<Set<ReactivityTag>>(
    new Set(),
  );
  const [visibleLimit, setVisibleLimit] = useState(INITIAL_VISIBLE);
  const [creatingCollection, setCreatingCollection] = useState(false);
  const [newCollectionName, setNewCollectionName] = useState("");
  const newCollectionInputRef = useRef<HTMLInputElement | null>(null);

  // viewMode is purely local: "all" shows the entire catalog; "collection"
  // scopes to the active collection. Critically separate from
  // activeCollectionId (the persistent star target) — earlier UI
  // conflated the two and produced a catch-22 where creating a
  // collection scoped the grid to that (empty) collection, leaving
  // nothing to star.
  const [viewMode, setViewMode] = useState<"all" | "collection">("collection");

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

  // When the picker first mounts and there's a saved active collection,
  // default to viewing it (matches a streamer's expectation of "show me
  // what I was working with last session"). When there's no saved
  // active collection, default to viewing all.
  useEffect(() => {
    if (!activeCollectionId) {
      setViewMode("all");
    }
    // Only run this on initial activeCollectionId resolution, not on
    // every change — explicit user actions below set viewMode directly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Membership set for the active collection — pre-built so the
  // indexed loop below can do an O(1) check per preset rather than
  // .includes() on a 1700-name array.
  const activeCollectionSet = useMemo(() => {
    if (!activeCollection) return null;
    return new Set(activeCollection.preset_names);
  }, [activeCollection]);

  // Build the searchable index once per `names` change. Each entry
  // pulls thumbnail + reactivity tags + author from the catalog;
  // falls back to filename-parsed author + empty tags for user-
  // installed presets (◯ prefix) that aren't in the catalog.
  const indexed = useMemo<Omit<ScoredEntry, "score">[]>(() => {
    return names.map((name, idx) => {
      const entry = getPresetEntry(name);
      const author = entry?.author ?? parseAuthor(name).author;
      const reactivity = entry?.reactivity ?? [];
      const thumbnailUrl = entry?.previewUrl ?? null;
      return { idx, name, author, reactivity, thumbnailUrl };
    });
  }, [names]);

  // Score each preset against the current query + filters. Same
  // weighted multi-token AND algorithm we use in the web gallery so
  // the two surfaces feel identical.
  const filtered = useMemo<ScoredEntry[]>(() => {
    const q = query.trim().toLowerCase();
    const tokens = q.length > 0 ? q.split(/\s+/) : [];
    const out: ScoredEntry[] = [];

    for (const entry of indexed) {
      // Active-collection scope hard-filters BEFORE anything else, but
      // ONLY when the streamer is viewing the collection. Viewing "All
      // presets" with an active collection set keeps the full catalog
      // visible while stars stay enabled for the active target.
      if (
        viewMode === "collection" &&
        activeCollectionSet &&
        !activeCollectionSet.has(entry.name)
      ) {
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
        score = 1;
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
          if (
            (t === "bass" || t === "mid" || t === "treb" || t === "vol") &&
            entry.reactivity.includes(t as ReactivityTag)
          ) {
            score += 1;
            tokenHit = true;
          }
          if (!tokenHit) {
            allTokensMatched = false;
            break;
          }
        }
        if (!allTokensMatched) continue;
      }

      out.push({ ...entry, score });
    }

    out.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.name.localeCompare(b.name);
    });
    return out;
  }, [indexed, query, activeFilters, activeCollectionSet, viewMode]);

  const visible = filtered.slice(0, visibleLimit);
  const hasMore = filtered.length > visibleLimit;

  function toggleFilter(tag: ReactivityTag) {
    setActiveFilters((prev) => {
      const next = new Set(prev);
      if (next.has(tag)) next.delete(tag);
      else next.add(tag);
      return next;
    });
    setVisibleLimit(INITIAL_VISIBLE);
  }

  async function handleCreateCollection() {
    const name = newCollectionName.trim();
    if (!name) {
      setCreatingCollection(false);
      return;
    }
    const created = await createCollection(name);
    if (created) {
      await setActiveCollection(created.id);
      // After creating a new (empty) collection, default the view to
      // "all" so the streamer can immediately scan all 1738 presets
      // and star into the new collection. Otherwise they'd land on an
      // empty grid and have to manually switch — the catch-22 the user
      // hit before this fix.
      setViewMode("all");
    }
    setNewCollectionName("");
    setCreatingCollection(false);
  }

  useEffect(() => {
    if (creatingCollection) {
      newCollectionInputRef.current?.focus();
    }
  }, [creatingCollection]);

  // Reset visible cap when any filter input changes — otherwise a
  // streamer who scrolled deep, then narrowed, sees a half-empty
  // result list before the "show more" button.
  useEffect(() => {
    setVisibleLimit(INITIAL_VISIBLE);
  }, [query, activeCollectionId, viewMode]);

  return (
    <div className="space-y-3">
      {/* Collection chip rail. "All presets" is always first + present;
          user collections render in creation order; "+ New" at the
          end (or transforms into an inline input when active).

          Two-axis state encoded in chip styling:
          - viewMode === "all": "All presets" chip is highlighted
          - viewMode === "collection" AND active matches: that chip
            is highlighted
          - When viewMode === "all" but activeCollectionId is set, the
            active collection chip gets a subtle "★ target" badge so
            the streamer knows where stars will go even though the grid
            shows everything. */}
      <div className="flex flex-wrap items-center gap-1.5">
        <CollectionChip
          label="All presets"
          count={names.length}
          active={viewMode === "all"}
          onClick={() => setViewMode("all")}
        />
        {collections.map((c) => {
          const isActiveTarget = c.id === activeCollectionId;
          const isViewing = isActiveTarget && viewMode === "collection";
          return (
            <CollectionChip
              key={c.id}
              label={c.name}
              count={c.preset_names.length}
              active={isViewing}
              isStarTarget={isActiveTarget && viewMode === "all"}
              onClick={() => {
                void setActiveCollection(c.id);
                setViewMode("collection");
              }}
              onDelete={() => {
                if (
                  window.confirm(
                    `Delete collection "${c.name}"? Presets stay in the catalog; only the curated list is removed.`,
                  )
                ) {
                  void deleteCollection(c.id);
                }
              }}
            />
          );
        })}
        {creatingCollection ? (
          <div className="flex items-center gap-1 rounded-full border border-accent/50 bg-accent/10 px-2 py-0.5">
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
              className="w-44 bg-transparent py-0.5 text-xs text-slate-100 placeholder:text-slate-500 focus:outline-none"
            />
            <button
              type="button"
              onClick={() => void handleCreateCollection()}
              className="text-xs text-accent hover:text-white"
            >
              Add
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setCreatingCollection(true)}
            className="flex items-center gap-1 rounded-full border border-dashed border-surface-border px-3 py-0.5 text-xs text-slate-400 hover:border-accent/50 hover:text-accent"
          >
            <Plus className="h-3 w-3" />
            New collection
          </button>
        )}
      </div>

      {/* Search + reactivity filters. Single row on desktop, wraps on
          narrow widths. Single source of search state for the grid. */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex min-w-0 flex-1 items-center gap-2 rounded-md border border-surface-border bg-base-800 px-2.5">
          <Search className="h-3.5 w-3.5 text-slate-500" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={
              activeCollection
                ? `Search in "${activeCollection.name}"…`
                : "Search by name, author, or vibe…"
            }
            className="flex-1 bg-transparent py-1.5 text-sm text-slate-100 placeholder:text-slate-600 focus:outline-none"
          />
          {query ? (
            <button
              onClick={() => setQuery("")}
              className="text-slate-500 hover:text-slate-300"
              title="Clear"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          ) : null}
        </div>
        <div className="flex items-center gap-1.5">
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
        </div>
        <span className="text-[11px] tabular-nums text-slate-500">
          {filtered.length}
          {filtered.length !== names.length ? ` / ${names.length}` : ""}
        </span>
      </div>

      {/* The grid. Empty state coaches the streamer through the
          common "I just made a collection and it's empty" path. */}
      {visible.length === 0 ? (
        <div className="rounded-md border border-dashed border-surface-border bg-base-900/40 px-6 py-10 text-center text-sm text-slate-500">
          {viewMode === "collection" &&
          activeCollection &&
          filtered.length === 0 &&
          !query &&
          activeFilters.size === 0 ? (
            <>
              <p className="mb-2 text-slate-400">
                &ldquo;{activeCollection.name}&rdquo; is empty.
              </p>
              <p>
                <button
                  type="button"
                  onClick={() => setViewMode("all")}
                  className="text-accent hover:underline"
                >
                  Switch to All presets
                </button>
                {" — stars on every tile go into this collection."}
              </p>
            </>
          ) : (
            "No presets match — try a different search or clear filters."
          )}
        </div>
      ) : (
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
          {visible.map((entry) => {
            const isCurrent = entry.idx === selectedIndex;
            const inActive = activeCollectionId
              ? isInActiveCollection(entry.name)
              : false;
            return (
              <li key={entry.idx}>
                <PresetTile
                  name={entry.name}
                  author={entry.author}
                  thumbnailUrl={entry.thumbnailUrl}
                  isCurrent={isCurrent}
                  inActiveCollection={inActive}
                  hasActiveCollection={!!activeCollectionId}
                  onPick={() => onSelect(entry.idx)}
                  onToggleStar={() =>
                    void toggleInActiveCollection(entry.name)
                  }
                  activeCollectionName={activeCollection?.name ?? null}
                />
              </li>
            );
          })}
        </ul>
      )}

      {hasMore ? (
        <div className="flex justify-center">
          <button
            type="button"
            onClick={() => setVisibleLimit((n) => n + VISIBLE_PAGE_SIZE)}
            className="rounded-md border border-surface-border bg-surface px-3 py-1.5 text-xs text-slate-300 hover:bg-surface-hover hover:text-white"
          >
            Show {Math.min(VISIBLE_PAGE_SIZE, filtered.length - visibleLimit)} more
          </button>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Single chip in the collection rail. The "All presets" chip uses
 * onDelete = undefined to suppress the trash hover affordance — it's
 * not deletable.
 */
function CollectionChip({
  label,
  count,
  active,
  isStarTarget,
  onClick,
  onDelete,
}: {
  label: string;
  count: number;
  active: boolean;
  /** When true, the chip isn't the current view but IS the active
   *  star target — show a small star icon to communicate that. */
  isStarTarget?: boolean;
  onClick: () => void;
  onDelete?: () => void;
}) {
  return (
    <div className="group/chip relative flex items-center">
      <button
        type="button"
        onClick={onClick}
        title={
          isStarTarget && !active
            ? `Active star target — click to view "${label}"`
            : undefined
        }
        className={cn(
          "flex items-center gap-1.5 rounded-full border px-3 py-0.5 text-xs transition-colors",
          active
            ? "border-accent/50 bg-accent/15 text-accent"
            : isStarTarget
              ? "border-amber-500/40 bg-amber-500/10 text-amber-300 hover:bg-amber-500/15"
              : "border-surface-border bg-surface text-slate-300 hover:bg-surface-hover hover:text-white",
          onDelete && "pr-6",
        )}
      >
        {isStarTarget && !active ? (
          <Star className="h-3 w-3" fill="currentColor" strokeWidth={2} />
        ) : null}
        <span className="font-medium">{label}</span>
        <span className="tabular-nums opacity-70">{count}</span>
      </button>
      {onDelete ? (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
          title={`Delete "${label}"`}
          className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-slate-500 opacity-0 transition-opacity hover:text-rose-300 group-hover/chip:opacity-100"
        >
          <Trash2 className="h-3 w-3" />
        </button>
      ) : null}
    </div>
  );
}

/**
 * Single preset tile. Click anywhere = load preset. Star button is
 * persistent in the corner so streamers can star without hovering;
 * its appearance changes based on whether a collection is active and
 * whether this preset is in it.
 */
function PresetTile({
  name,
  author,
  thumbnailUrl,
  isCurrent,
  inActiveCollection,
  hasActiveCollection,
  onPick,
  onToggleStar,
  activeCollectionName,
}: {
  name: string;
  author: string | null;
  thumbnailUrl: string | null;
  isCurrent: boolean;
  inActiveCollection: boolean;
  hasActiveCollection: boolean;
  onPick: () => void;
  onToggleStar: () => void;
  activeCollectionName: string | null;
}) {
  const starTooltip = !hasActiveCollection
    ? "Pick a collection first to star presets"
    : inActiveCollection
      ? `Remove from "${activeCollectionName}"`
      : `Add to "${activeCollectionName}"`;
  return (
    <div
      className={cn(
        "group/tile relative overflow-hidden rounded-md border bg-base-900 transition-all hover:border-slate-500/60",
        isCurrent
          ? "border-accent shadow-md shadow-accent/20"
          : "border-surface-border",
      )}
    >
      <button
        type="button"
        onClick={onPick}
        className="block w-full text-left"
      >
        <div className="relative aspect-video w-full bg-base-800">
          {thumbnailUrl ? (
            <img
              src={thumbnailUrl}
              alt=""
              loading="lazy"
              decoding="async"
              className="h-full w-full object-cover"
            />
          ) : (
            <div className="flex h-full w-full items-center justify-center text-[10px] uppercase tracking-widest text-slate-600">
              No preview
            </div>
          )}
          {/* Subtle gradient at the bottom so the name overlay reads
              against busy thumbnails without needing a solid bar. */}
          <div
            aria-hidden
            className="pointer-events-none absolute inset-x-0 bottom-0 h-12 bg-gradient-to-t from-black/70 to-transparent"
          />
          <div className="absolute inset-x-0 bottom-0 px-2 pb-1.5">
            <div
              className={cn(
                "truncate text-[11px] font-medium leading-tight",
                isCurrent ? "text-accent" : "text-slate-100",
              )}
            >
              {name}
            </div>
            {author ? (
              <div className="truncate text-[10px] text-slate-400">
                {author}
              </div>
            ) : null}
          </div>
          {isCurrent ? (
            <div
              className="absolute left-1.5 top-1.5 rounded-full bg-accent px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-widest text-base-900"
            >
              Now
            </div>
          ) : null}
        </div>
      </button>
      {/* Star button as a sibling button so its click doesn't trigger
          the parent button's onClick (no nesting buttons in HTML). */}
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          if (!hasActiveCollection) return;
          onToggleStar();
        }}
        title={starTooltip}
        disabled={!hasActiveCollection}
        className={cn(
          "absolute right-1.5 top-1.5 flex h-7 w-7 items-center justify-center rounded-full bg-black/50 backdrop-blur transition-colors",
          hasActiveCollection
            ? inActiveCollection
              ? "text-amber-400 hover:bg-black/70"
              : "text-slate-300 hover:text-amber-400 hover:bg-black/70"
            : "cursor-not-allowed text-slate-600",
        )}
      >
        <Star
          className="h-3.5 w-3.5"
          fill={inActiveCollection ? "currentColor" : "none"}
          strokeWidth={2}
        />
      </button>
    </div>
  );
}
