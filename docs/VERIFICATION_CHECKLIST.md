# Verification Checklist — v0.5.0 + Stats Tempo Landing

Quick-reference for confirming everything from the big multi-session ship is wired up. Leave this in the repo so we can find it next time a deploy needs smoke-testing.

## 1. Apply the audio-features migration to Neon

Copy-paste this into the Neon SQL editor (not the filename, the SQL itself):

```sql
ALTER TABLE stream_tracks
  ADD COLUMN IF NOT EXISTS tempo            double precision,
  ADD COLUMN IF NOT EXISTS energy           double precision,
  ADD COLUMN IF NOT EXISTS danceability     double precision,
  ADD COLUMN IF NOT EXISTS valence          double precision,
  ADD COLUMN IF NOT EXISTS time_signature   integer;

CREATE INDEX IF NOT EXISTS stream_tracks_streamer_tempo_idx
  ON stream_tracks (streamer_id, tempo)
  WHERE tempo IS NOT NULL;
```

Status as of 2026-04-24: **applied** ✓

## 2. Deploy the worker

The poller now populates tempo / energy / danceability / valence / time_signature on every new track insert. Redeploy the worker however you normally do (droplet SSH + git pull + `npm run build && pm2 restart`, or Vercel function auto-deploy on push, etc.).

After deploy, every new track that plays gets enriched in the same insert cycle. No UI change needed.

## 3. Backfill historical tracks (optional)

To populate tempo for every track that existed before the deploy:

```bash
# From the worker host (has TOKEN_ENCRYPTION_KEY in env):
npm run backfill:audio-features --workspace=@tracklist/worker

# Or one streamer at a time:
npm run backfill:audio-features --workspace=@tracklist/worker -- --streamer=<login>
```

Takes a few minutes at 1000+ tracks. Logs "patched X / attempted Y" per streamer. Safe to re-run — only touches rows with NULL tempo.

**Note**: this script can't run locally because the encryption key for decrypting Spotify refresh tokens is only on the production worker host. If you skip this, new streams accumulate tempo data organically (≈30 enriched tracks per 1-hour stream).

## 4. Verify the stats page

Visit `https://music.blackpearl.gg/<your-twitch-login>/stats` once ≥10 tracks have tempo data. A **Tempo** chapter appears between Catalog and By Category — 8 genre-style buckets (ambient / hiphop / pop / house / techpop / trance / dnb / extreme + unknown) with percent + range labels, median + mean BPM up top.

Hidden entirely when < 10 enriched tracks — which means path-B (organic fill) needs one stream before it shows.

## 5. Verify /visualizer (website)

Open `https://music.blackpearl.gg/visualizer` in a regular tab. Expected: black canvas + a "Visualizer is running without a companion token" footer card (no token in URL).

Known issue fixed in `0fc9896`: SSR of butterchurn was crashing. If this still 500s, investigate the Vercel deploy log.

## 6. Verify companion's Add-to-OBS flow

1. Open the companion → **Visualizer** tab.
2. Purple **Add to OBS** button (top-right of the header). Click it.
3. Modal appears with a URL like `https://music.blackpearl.gg/visualizer?token=<your-32-byte-token>`.
4. **Copy** — confirm the green "Copied" flash.
5. **Preview** — opens the URL in your default browser. HUD should show "Companion paired" with a green dot. Presets cycle every 30 s.

If the Preview opens but shows "Visualizer is running without a companion token," the companion's `get_config` isn't returning the token. Check companion logs — tray's **Open config folder** shows the token in `config.toml`.

## 7. End-to-end OBS smoke test

In OBS:
1. Sources → + → Browser.
2. Paste the copied URL. Width 1920, Height 1080. Tick "Shutdown source when not visible."
3. Click OK.
4. Start any audio on your PC. The preview should pulse on kicks.

If nothing pulses, the companion probably isn't authed — check the companion's Visualizer header (should say "~BPM" when music flows) or the Status tab's WS endpoint.
