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
import type { FftEvent, LevelEvent, SilenceEvent } from "./tauri";

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
 * Subscribe to silence state-change events (audio/silence). Edge-
 * triggered — the handler fires ONLY when silence begins or ends, not
 * per-frame. Consumers that need "currently silent?" state should
 * track the boolean themselves.
 */
export function useLiveSilence(onSilence: (evt: SilenceEvent) => void) {
  useEffect(() => {
    const unlisten = listen<SilenceEvent>("audio-silence", (evt) => {
      onSilence(evt.payload);
    });
    return () => {
      void unlisten.then((fn) => fn());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
