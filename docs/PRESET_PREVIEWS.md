# Preset Previews — Plan

Rendering each of the 1738 MilkDrop presets to a short animated thumbnail so the gallery browser becomes scan-friendly. Today the gallery shows names + authors + reactivity tags; after this lands it shows *moving* previews that tell a user in 2 seconds whether a preset is worth installing.

This doc covers the approach, the compute budget, the output format choice, and the storage plan. The starter script at [`apps/web/scripts/generate-preset-previews.mjs`](../../Stream%20Music%20Tool/apps/web/scripts/generate-preset-previews.mjs) implements the approach but is **not wired into the build**. Running it is a deliberate batch job.

## The loop

For each preset file:

1. Headless Chromium loads a preset-runner HTML page (inline in the script).
2. The page initializes Butterchurn with a 400×225 canvas (16:9, gallery-card-sized).
3. A standardized synthetic audio source (kick + bass + treble + vol, looping) drives the visualizer for a 4-second warm-up.
4. Frames 4.0s–6.5s are captured at 20 FPS → 50 PNG frames.
5. Encode as WebP (animated) or GIF, save to `apps/web/public/presets/previews/<slug>.webp`.
6. Record the path in the catalog.

## Why synthetic audio + why *this* synthetic audio

Real audio clips are copyrighted. A standardized synthetic source is:

- License-free.
- Deterministic — preset A looks the same whether rendered today or next year.
- Exercises the bands the preset author expected. Specifically: 128 BPM kick drum pulse, a sawtooth bass at ~80 Hz, a sustained pad covering 200-2000 Hz, and a sibilant noise burst every 4 beats to hit the treble.

That's the bare minimum to "wake up" most presets. Presets that only react to `vol` (volume envelope) still get coverage from the global amplitude variation.

## Output format

**WebP animated** beats GIF by a wide margin for this content:

- ~5-10× smaller files (50 frames × 225p)
- Better color gradients (GIF is 256-color, preset output is often saturated)
- Supported by every browser we care about (Chromium, Firefox, Safari 14+)

Fallback to GIF only if a viewer's browser lacks WebP support (negligible in 2026).

## Compute budget

Rough numbers, assuming a developer machine (not CI):

- Headless Chromium launch: ~2s amortized (reuse pages across presets)
- Preset load + 4s warm-up + 2.5s capture = ~7s wall time per preset
- GIF/WebP encode: ~0.5s per preset

**~7.5 seconds × 1738 presets ≈ 3.6 hours** sequential, single-worker.

With 4 parallel workers: **~1 hour** wall time. 4 is conservative — GPU contention ceiling, not CPU.

Total output storage: 1738 × ~40 KB WebP ≈ **70 MB**. Under Vercel's free-tier limits. We don't need a CDN switch.

## Running the batch

```bash
cd apps/web
npm install puppeteer
npm run presets:preview         # run the full batch
npm run presets:preview -- --only="slug1,slug2,slug3"
```

The script writes progress to stderr + skips already-rendered slugs. Safe to re-run; it's idempotent.

## Integration points

1. **Catalog generator** (`scripts/generate-preset-catalog.mjs`) stamps `previewUrl` on each entry when `public/presets/previews/<slug>.webp` exists. Gallery cards check for this and render an `<img>` when present.
2. **Gallery card layout** (`preset-gallery.tsx`) grows an aspect-video thumbnail above the name/author block when the preview URL is present. Falls back to a plain card when missing — graceful degradation while the batch progresses.
3. **Git**: like the preset JSON files themselves, previews are **gitignored**. They regenerate from the JSON when someone wants them (this script). For prod, Vercel's build cache keeps them across deploys.

## When to run this

- Before a "preset gallery launch" moment — marketing push, big release, a review of which presets to highlight.
- Periodically if we ingest new packs (Phase 2 of the presets platform).
- NOT in the regular build. 1-hour batch jobs do not belong in CI's critical path.

## Known issues / future work

- **GPU-less environments.** Puppeteer with `--use-gl=swiftshader` renders without a GPU but very slowly. For batch runs use a machine with a real GPU; Vercel-build-time rendering is a non-starter.
- **Preset crash detection.** Some butterchurn presets can hang the visualizer (bad shaders, infinite loops in equations). The script should set a per-preset timeout and log the slugs that fail so we can manually exclude them.
- **Thumbnail "hero frame" vs animation.** Some users would prefer a single high-quality PNG still over a lower-quality animation. Worth experimenting with side-by-side.
- **A / B testing.** Once live, measure whether preview-enabled gallery sessions end in more installs than non-preview. Sanity check the effort.

## Open questions

1. WebP exclusively, or dual-encode to GIF for the ~0.5% legacy browsers?
2. Rendering resolution — 400×225 for retina? Larger = bigger files but better-looking on 1440p displays.
3. Include reactivity overlay (e.g. bass pulse indicator) baked into the preview? Useful signal or visual noise?
