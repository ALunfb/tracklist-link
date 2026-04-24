/**
 * Lightweight BPM estimator from beat timestamps.
 *
 * Keeps the last ~8 beats in a rolling buffer, drops anything older than
 * ~12 seconds (tempo recognition degrades rapidly past that), computes
 * median inter-beat interval, and returns BPM. Returns null while the
 * buffer is still filling or if the audio goes quiet enough that no
 * beats have landed recently — "showing nothing" is much less noisy
 * than showing a stale number.
 *
 * Median over mean so a single missed beat (double the expected gap)
 * doesn't halve the reported BPM for a couple of seconds.
 */

const MAX_BEATS = 8;
const STALE_WINDOW_MS = 12_000;
const MIN_BEATS_FOR_ESTIMATE = 4;

export class BpmEstimator {
  private ts: number[] = [];

  push(tMs: number): void {
    this.ts.push(tMs);
    if (this.ts.length > MAX_BEATS) this.ts.shift();
    const cutoff = tMs - STALE_WINDOW_MS;
    while (this.ts.length > 0 && (this.ts[0] ?? 0) < cutoff) {
      this.ts.shift();
    }
  }

  /**
   * Current BPM estimate or null. Also returns null if the most recent
   * beat is stale relative to `nowMs` — lets the caller render a grey
   * "—" instead of a lying number for a silent stream.
   */
  estimate(nowMs: number = Date.now()): number | null {
    if (this.ts.length < MIN_BEATS_FOR_ESTIMATE) return null;
    const last = this.ts[this.ts.length - 1] ?? 0;
    if (nowMs - last > STALE_WINDOW_MS) return null;

    const intervals: number[] = [];
    for (let i = 1; i < this.ts.length; i++) {
      intervals.push((this.ts[i] ?? 0) - (this.ts[i - 1] ?? 0));
    }
    intervals.sort((a, b) => a - b);
    const median = intervals[Math.floor(intervals.length / 2)] ?? 0;
    if (median <= 0) return null;
    const raw = 60_000 / median;
    // Snap wild transients (< 30 or > 300) to null — probably noise,
    // not music.
    if (raw < 30 || raw > 300) return null;
    return Math.round(raw);
  }

  reset(): void {
    this.ts = [];
  }
}
