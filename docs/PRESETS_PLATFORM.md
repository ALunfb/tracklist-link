# Presets Platform — Plan

This document scopes the "host and sort every free preset, better than the old sites" vision. **Nothing here is implemented yet.** The goal is to have a credible plan before cutting code, so we don't:

- Mass-copy preset files whose licensing we haven't verified and get a DMCA a month later.
- Build a metadata DB that can't answer the searches users actually run.
- Ship a "one-click install" flow that silently overwrites user-added presets.
- Spend budget hosting 50 GB of content that nobody downloads.

## Reality check — why this isn't a weekend build

Four honest problems, each of which has sunk similar projects:

1. **Legal provenance.** Most MilkDrop presets come from Winamp-era communities (2001–2008) with no systematic license attached. Some are public-domain, some are CC-BY, some are "all rights reserved" by authors who are now unreachable. Mass-rehosting without audit puts us at DMCA risk.
2. **Duplicates.** Across Cream of the Crop, milkdrop-presets, projectM archive, and miscellaneous pack releases, the same preset appears dozens of times under slightly different filenames. We need a content-hash dedup layer.
3. **Curation.** "10,000 presets" is not a feature, it's a problem. The old sites failed at ranking + discovery. Genre tags, quality signals, preview thumbnails, and reactivity categorization (bass-heavy, kick-reactive, ambient, tunnel-style) are what make this actually usable.
4. **Browser vs native compatibility.** Some presets rely on MilkDrop 2 features Butterchurn doesn't implement (pixel shader paths). Some are MilkDrop 3 only. A pack page needs to say "runs in browser" vs "needs native projectM" clearly.

## Scope — what "better than the old sites" means to us

Concretely:

- **Searchable** by name, author, tags, year.
- **Filterable** by license, browser-compat, reactivity profile, file size.
- **Sortable** by popularity (downloads + streamer endorsements), recency, alphabetical.
- **Previewable** — each preset gets a 5-second 400×225 GIF rendered on a standard audio sample so you can scroll the gallery and see what you're picking.
- **One-click install** — "Add to my companion" button that hands the file directly to Tracklist Link (via a browser protocol handler or file download with a known path).
- **Attribution-first** — every preset card prominently shows original author + source archive, clickable through to the origin.
- **Community additions** — streamers can submit their own `.milk` files via the dashboard (PR-style moderation, not open dump).
- **License filter default excludes "unknown"** — if we can't verify a license, users see it only when they explicitly opt in.

## Architecture

### Storage

Object storage for the preset files themselves. Choices:

| Option | Pros | Cons |
|--------|------|------|
| Vercel Blob | zero setup, tightly integrated with our deploy | egress cost at scale, 5 GB free tier |
| Cloudflare R2 | free egress, ~$0.015/GB/mo, S3-compatible | separate account, CDN layer extra |
| S3 + CloudFront | industry standard, granular access | most setup, highest fixed cost |
| Static in Vercel `public/` | simplest, CDN-backed by default | bad at 10k+ files (bundle bloat, slow deploys) |

**Recommendation:** Cloudflare R2 behind a CDN. Preset files are 2–20 KB; 10k × 10 KB = 100 MB total, rounds to pennies. The important constraint is we can serve them from a URL the companion's fetcher will accept (HTTPS → our domain).

### Metadata DB

Postgres table (add to the existing Neon DB — one more migration):

```
preset (
  id               uuid primary key,
  content_hash     bytea unique,   -- sha256 of the normalized file; dedup key
  display_name     text not null,
  author_name      text,
  author_url       text,
  license          text not null,  -- controlled vocab: mit|cc0|cc-by|cc-by-sa|unknown|custom
  license_note     text,
  source_archive   text,            -- where we found it
  source_url       text,            -- direct link to the source
  format           text not null,  -- milk2 | milk3 | butterchurn-json
  size_bytes       int not null,
  storage_key      text not null,  -- R2 object key
  preview_gif_key  text,
  submitted_by     text,            -- NULL for archive imports, user id for community
  added_at         timestamptz default now(),
  approved         boolean default false,
  download_count   int default 0
);

preset_tag (
  preset_id        uuid references preset(id),
  tag              text,
  primary key (preset_id, tag)
);

preset_compat (
  preset_id        uuid references preset(id),
  target           text,  -- butterchurn | projectm | milkdrop2-native | milkdrop3
  runs             boolean,
  verified_at      timestamptz,
  primary key (preset_id, target)
);
```

### Ingestion pipeline

Periodic job (cron on a serverless platform or a manual trigger):

1. Crawl source archive (GitHub repo, archive.org mirror, etc.).
2. For each `.milk`/`.milk2`/`.json` file: normalize whitespace, hash, check if `content_hash` exists.
3. If new: parse the file, extract author metadata from header comments, look up license via the archive's `LICENSE` file.
4. Upload to R2 with a content-addressed key (`presets/<hash>.milk`).
5. Render preview GIF via a headless Butterchurn in a worker (~2 sec per preset).
6. Insert row with `approved = false`.
7. Human review queue: we approve batches by author/archive once we've verified the license.

### Companion install flow

Three possible UX paths:

A. **Custom URL scheme** — `tracklist-link://install?url=...`. Browser hands off to the companion which downloads + saves. Problem: requires registering the protocol at companion install, Windows-only until M6 (cross-platform).

B. **Dashboard-mediated** — the dashboard already has localStorage pairing. Add a "Pending installs" list: when you click "Add to companion" on the visualizers site, the preset URL is POSTed to a companion HTTP endpoint (through the token-authed WS). Companion fetches and saves.

C. **Plain download + drag-drop** — user downloads `.milk`, drops into their presets folder. Low-tech, works everywhere, no special hooks.

**Recommendation:** C for MVP, B for polish, A for eventual native feel. All three can coexist.

## Curation strategy

What actually makes this better than the old sites:

1. **Quality triage.** Each newly-imported pack gets a spot-check pass before full approval. Obviously broken presets, duplicates, and ones that immediately crash Butterchurn are filtered at ingestion.
2. **Tag schema.** We commit to a small, stable tag vocabulary (not free-form user tags): `bass-reactive`, `ambient`, `tunnel`, `fractal`, `text`, `photo-reactive`, `minimal`, `maximal`. Max 3 per preset.
3. **Reactivity profile.** Measured by ingestion: "responds to bass / mids / highs / kicks / none". Derived by running the preset against a standardized audio clip and computing which spectrum bands move the visible output most.
4. **Author pages.** Every author gets a page with their presets + external links. Gives credit, keeps attribution visible.
5. **Playlists.** Curated sets ("great for EDM", "chill background", "synthwave") that are actual human selections, not algorithmic.

## Legal posture

- **Default to conservative.** A preset without a clear license is NOT rehosted. We link out to the original archive.
- **Takedown path.** A prominent email + page explaining how authors can request removal. 24-hour SLA.
- **Attribution permanence.** Author attribution travels with the preset in our DB, rendered in the download UI, and cannot be removed by a submitter.
- **Commercial clause.** Our terms make clear the preset downloads are for personal / stream use — we're not sublicensing anything.
- **CC0 encouragement.** Community submissions default to asking for CC0; authors can opt into CC-BY or custom if they want credit.

## Milestones

| Milestone | Scope | Estimate |
|-----------|-------|----------|
| M4.1 | Butterchurn-presets (already bundled) showcase page ✓ | done |
| M4.2 | Schema + Neon migration + R2 bucket + ingestion script | 1 week |
| M4.3 | Ingest butterchurn-presets + 1 CC-clean archive (~200 presets) | 1 week |
| M4.4 | Public gallery page with search/filter/sort | 1 week |
| M4.5 | Preview GIF rendering pipeline | 3-5 days |
| M4.6 | Companion-side auto-install (path B above) | 1 week |
| M4.7 | Community submission + moderation flow | 2 weeks |
| M4.8 | Ingestion of larger archives with full license audit | ongoing |

Total until first public launch: ~6 weeks of focused work.

## Open questions

Requires maintainer decisions before M4.2 starts:

1. R2 vs Vercel Blob? (recommend R2, ~$1/mo at scale)
2. Who does license audits? (maintainer, or do we recruit a trusted contributor?)
3. Is "unknown license → link-out only" the right default, or do we rehost-with-attribution and handle takedowns reactively?
4. Preview GIFs: generate at ingestion (expensive, one-time) or on-demand (cheap per request but slower first load)?
5. Community submission: PRs on a GitHub repo (lo-fi), or a form on the dashboard (hi-fi)?

---

This plan is a proposal. Land in it phases — don't ship M4.2 through M4.8 as one PR.
