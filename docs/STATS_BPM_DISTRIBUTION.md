# Stats Page — BPM-by-Genre Distribution

Persistent per-streamer stat: "what tempos do you actually play?" Shown as a bucketed histogram with genre labels. Live BPM in the companion + overlay is useful while streaming; the stats page answers the bigger-picture question — **what kind of music is this channel, really?**

This doc scopes the implementation. **Nothing here is shipped yet.** Plan doc only.

## The feature

Stats page (`/[username]/stats`) grows a new panel:

> **Tempo profile** — 40% dance / house, 25% chill, 20% pop, 10% hardstyle, 5% unknown. Over 2,146 tracks played across 47 sessions.
>
> [bar chart of BPM buckets, labeled with genre hints]

Clicking a bucket filters the session archive to tracks in that range. Seeing a streamer's tempo identity at a glance is the goal.

## BPM source of truth

Not the companion's real-time detector. That's fine for live visual effects, but it's:

- approximate (energy-onset, noisy on sparse music)
- session-scoped (no history)
- not tied to the track (just the audio stream mixed with voice chat)

The right source is **Spotify's audio-features API**, which returns a `tempo` field (float, BPM) per track. Spotify's algorithm is well-calibrated and we already have Spotify tokens for every track we log.

## Schema

New column on `stream_tracks`:

```sql
ALTER TABLE stream_tracks
  ADD COLUMN tempo real,              -- Spotify audio-features tempo (BPM)
  ADD COLUMN energy real,             -- 0..1
  ADD COLUMN danceability real,       -- 0..1
  ADD COLUMN valence real,            -- 0..1 musical positivity
  ADD COLUMN time_signature smallint; -- usually 4
```

All nullable; backfill is optional. `tempo` alone is enough to ship the BPM panel; the others come along because we're already fetching `/audio-features` so the marginal DB cost is zero and future features (energy-based DJ playlists, valence trend lines) get free groundwork.

## Ingestion

In the worker / track-logger:

```ts
// After inserting a stream_track row, fetch audio-features for its URI
// and patch the row. One HTTP call per new track. Batchable up to 100.
const features = await spotify.getAudioFeatures(trackUri);
await db.update(streamTracks)
  .set({
    tempo: features.tempo,
    energy: features.energy,
    danceability: features.danceability,
    valence: features.valence,
    timeSignature: features.time_signature,
  })
  .where(eq(streamTracks.id, trackId));
```

Rate limits: Spotify's audio-features is generous — ~1000/min for our key. At even 100 tracks/min across all streamers we're nowhere near the ceiling.

Batch endpoint `/audio-features?ids=uri1,uri2,...` accepts up to 100 URIs per call. Use it when backfilling historical data.

## Bucketing

Not every BPM belongs to every genre (90 BPM is as often a hip-hop tempo as a power ballad), but tempo *alone* gives a serviceable first-cut categorization:

| Bucket | BPM range | Typical genres |
|--------|-----------|----------------|
| Ambient / chill | < 80 | ambient, downtempo, ballad, classical |
| Hip-hop / lofi | 80-100 | hip-hop, lo-fi, some R&B |
| Pop / rock | 100-120 | pop, indie rock, funk |
| House / dance | 120-130 | deep house, nu-disco |
| Tech house / dance-pop | 130-140 | tech house, synth-pop, high-energy dance |
| Trance / hard dance | 140-155 | trance, hardstyle intros, EDM |
| Drum & bass / fast | 160-180 | D&B, breakbeat, speed garage |
| Extreme | > 180 | hardstyle drops, gabber, footwork, metal |

Exact boundaries are arbitrary — what matters is that the *same streamer* sees a consistent picture across sessions. The buckets are a display concern, not a data concern; all tracks store the raw tempo and the stats panel derives the label at render time.

## Render

Server-side aggregation query:

```sql
SELECT
  CASE
    WHEN tempo IS NULL THEN 'unknown'
    WHEN tempo < 80 THEN 'ambient-chill'
    WHEN tempo < 100 THEN 'hiphop-lofi'
    WHEN tempo < 120 THEN 'pop-rock'
    WHEN tempo < 130 THEN 'house-dance'
    WHEN tempo < 140 THEN 'tech-pop-dance'
    WHEN tempo < 155 THEN 'trance-hard'
    WHEN tempo < 180 THEN 'dnb-fast'
    ELSE 'extreme'
  END AS bucket,
  count(*)::int AS plays
FROM stream_tracks
WHERE streamer_id = $1
GROUP BY bucket
ORDER BY bucket;
```

Rendered as a horizontal bar chart + percent labels. Hovering a bar shows the BPM range and a sample of tracks in it. Clicking filters the session archive.

## Integration with the companion's live BPM

The companion's live BPM readout stays in the Visualizer + dashboard tiles as a "what's playing right now" signal. Zero coupling to the stats page — different scope (live visual vs historical identity), different source (energy-onset vs Spotify), different consumer.

Down the line, **comparing them** is interesting — if the companion's detected BPM stays >10% off Spotify's tempo for extended stretches, that's a signal the detector needs tuning (or the streamer's mic bleed is confusing it).

## Scope / milestones

1. **Migration** — add the 5 audio-features columns (1 PR).
2. **Ingestion** — fetch audio-features on every new track insertion (1 PR). Verify Spotify API availability under the Feb 2026 migration.
3. **Backfill** — one-time script that iterates existing tracks in batches of 100 (1 PR). Resumable; safe to re-run.
4. **Tempo panel** — new `<TempoProfile />` component on `/[username]/stats` (1 PR). Server component, server-side aggregation, static chart.
5. **Interactivity** — click a bucket → session-archive filter (1 PR). Separate from #4 so #4 can ship first.
6. **Compare live vs track** — the debug-signal panel that surfaces companion-detected BPM drift vs Spotify tempo (future, low-priority).

Each step independent; ship each as its own release.

## Open questions

1. Bucket labels — "house / dance" vs "EDM" vs "dance"? Genre naming is contentious. Err toward descriptive + inclusive.
2. Backfill priority — is it worth backfilling every historical track, or start from "today" and let data accumulate? Spotify's free-tier rate limit is ~1000/min which means ~6 hours to backfill a million tracks. Not a blocker.
3. Unknown-tempo handling — some Spotify URIs have no tempo (classical piano pieces, occasional edge cases). Group all as "unknown" with a small footer count, don't pretend they're 0 BPM.
4. Do we want the companion's *detected* BPM aggregated separately? Useful as a quality signal for the detector itself, but clutter on the main stats page. Probably a dashboard-debug-only view.
