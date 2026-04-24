/**
 * Hook: subscribes to the Rust backend's audio-fft-64 + audio-level events
 * and writes the latest frame into caller-owned refs.
 *
 * Using refs (not state) on purpose — FFT frames land at ~50 Hz. Driving
 * a React re-render 50 times per second would stutter the visualizer and
 * pin CPU for no benefit; the consumer reads the ref inside its own RAF
 * loop.
 */

import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useEffect } from "react";
import type { BeatEvent, FftEvent, LevelEvent } from "./tauri";

export function useLiveFft(
  bandsRef: React.MutableRefObject<number[] | null>,
  levelRef?: React.MutableRefObject<{ rms: number; peak: number } | null>,
) {
  useEffect(() => {
    const cleanups: Array<Promise<UnlistenFn>> = [];
    cleanups.push(
      listen<FftEvent>("audio-fft-64", (evt) => {
        bandsRef.current = evt.payload.bands;
      }),
    );
    if (levelRef) {
      cleanups.push(
        listen<LevelEvent>("audio-level", (evt) => {
          levelRef.current = {
            rms: evt.payload.rms,
            peak: evt.payload.peak,
          };
        }),
      );
    }
    return () => {
      for (const p of cleanups) {
        void p.then((fn) => fn());
      }
    };
  }, [bandsRef, levelRef]);
}

/**
 * Subscribe to beat events. Calls the handler on every detected beat with
 * `{ t_ms, confidence }`. Fire-and-forget — consumers that need to animate
 * on beats should set a ref or trigger a CSS state change from the
 * handler rather than schlep full state through React on each hit.
 */
export function useLiveBeat(onBeat: (evt: BeatEvent) => void) {
  useEffect(() => {
    const unlisten = listen<BeatEvent>("audio-beat", (evt) => {
      onBeat(evt.payload);
    });
    return () => {
      void unlisten.then((fn) => fn());
    };
    // Consumers should wrap onBeat in useCallback if they care about
    // reference stability. Re-listening on every render would blow up
    // the event system; depend on a stable callback.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
