import { useCallback, useEffect, useState } from "react";
import {
  addToPresetCollection,
  createPresetCollection,
  deletePresetCollection,
  listPresetCollections,
  removeFromPresetCollection,
  renamePresetCollection,
  setActivePresetCollection,
  type CollectionsView,
  type PresetCollection,
} from "./tauri";

/**
 * Single source of truth for the streamer's preset collections.
 *
 * Loads on mount, exposes the live list + the active collection id, plus
 * mutation helpers that swap in the freshly-saved view returned by the
 * Rust commands. No optimistic updates — every mutation round-trips
 * through the file write so the local state never drifts from disk.
 *
 * Use one instance of this hook per consumer that needs to react to
 * collection changes (PresetPicker, the eventual management UI, etc.).
 * The cost is one IPC call per mount; the file is small (~few KB even
 * with thousands of preset names per collection).
 */
export function useCollections(): {
  collections: PresetCollection[];
  activeCollectionId: string | null;
  activeCollection: PresetCollection | null;
  loading: boolean;
  error: string | null;
  /** True when the given preset name is in the active collection. */
  isInActiveCollection: (presetName: string) => boolean;
  /**
   * If a collection is active and the preset isn't in it, add it.
   * If it's already in, remove it. No-op when no collection is active.
   * Returns true if a change happened.
   */
  toggleInActiveCollection: (presetName: string) => Promise<boolean>;
  createCollection: (name: string) => Promise<PresetCollection | null>;
  renameCollection: (id: string, name: string) => Promise<void>;
  deleteCollection: (id: string) => Promise<void>;
  setActiveCollection: (id: string | null) => Promise<void>;
  refresh: () => Promise<void>;
} {
  const [collections, setCollections] = useState<PresetCollection[]>([]);
  const [activeCollectionId, setActiveCollectionId] = useState<string | null>(
    null,
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const apply = useCallback((view: CollectionsView) => {
    setCollections(view.collections);
    setActiveCollectionId(view.active_collection_id);
    setError(null);
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const view = await listPresetCollections();
      apply(view);
    } catch (err) {
      setError((err as Error).message ?? "load failed");
    } finally {
      setLoading(false);
    }
  }, [apply]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const activeCollection = activeCollectionId
    ? (collections.find((c) => c.id === activeCollectionId) ?? null)
    : null;

  const isInActiveCollection = useCallback(
    (presetName: string) => {
      if (!activeCollection) return false;
      return activeCollection.preset_names.includes(presetName);
    },
    [activeCollection],
  );

  const toggleInActiveCollection = useCallback(
    async (presetName: string) => {
      if (!activeCollection) return false;
      const id = activeCollection.id;
      const has = activeCollection.preset_names.includes(presetName);
      try {
        const view = has
          ? await removeFromPresetCollection(id, presetName)
          : await addToPresetCollection(id, presetName);
        apply(view);
        return true;
      } catch (err) {
        setError((err as Error).message ?? "toggle failed");
        return false;
      }
    },
    [activeCollection, apply],
  );

  const createCollection = useCallback(
    async (name: string) => {
      try {
        const view = await createPresetCollection(name);
        apply(view);
        // Newly-added collection is always last in the array per Rust
        // append. Surface it back so the caller can immediately set it
        // active or focus its rename input, etc.
        return view.collections[view.collections.length - 1] ?? null;
      } catch (err) {
        setError((err as Error).message ?? "create failed");
        return null;
      }
    },
    [apply],
  );

  const renameCollection = useCallback(
    async (id: string, name: string) => {
      try {
        const view = await renamePresetCollection(id, name);
        apply(view);
      } catch (err) {
        setError((err as Error).message ?? "rename failed");
      }
    },
    [apply],
  );

  const deleteCollection = useCallback(
    async (id: string) => {
      try {
        const view = await deletePresetCollection(id);
        apply(view);
      } catch (err) {
        setError((err as Error).message ?? "delete failed");
      }
    },
    [apply],
  );

  const setActiveCollection = useCallback(
    async (id: string | null) => {
      try {
        const view = await setActivePresetCollection(id);
        apply(view);
      } catch (err) {
        setError((err as Error).message ?? "set active failed");
      }
    },
    [apply],
  );

  return {
    collections,
    activeCollectionId,
    activeCollection,
    loading,
    error,
    isInActiveCollection,
    toggleInActiveCollection,
    createCollection,
    renameCollection,
    deleteCollection,
    setActiveCollection,
    refresh,
  };
}
