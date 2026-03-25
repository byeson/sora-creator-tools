# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Chrome Extension (Manifest V3) for Sora video creators. Adds analytics overlays, a drafts workspace, gather/analyze modes, and a dashboard. **Local-first and privacy-focused** — no external network calls, all data stays on-device.

## Commands

```bash
# Run all tests
node --test tests/*.test.js

# Syntax check all JS files
for f in *.js tests/*.js; do node --check "$f"; done

# Whitespace check before commit
git diff --check

# Build release zip
rm -f release.zip && zip -r release.zip manifest.json *.js *.html *.css icons imagery -x "*.DS_Store"
```

No build tooling or package manager required — pure vanilla JS with the Node.js built-in test runner.

## Architecture

**Stack:** Chrome MV3, vanilla JavaScript, no frameworks, no external dependencies.

**Script roles:**
- `manifest.json` — permissions, host (`sora.chatgpt.com`), content script declaration
- `content.js` — bridge between page context and extension; validates/relays `postMessage` → `chrome.runtime.sendMessage`
- `inject.js` — injected into page context; intercepts Sora feed API responses, renders overlays, runs gather/analyze modes
- `api.js` — patches network requests in page context; controls composer and duration UI
- `background.js` — service worker; **sole writer** to `chrome.storage.local`; owns metrics cache (hot/cold split) and message routing
- `uv-drafts-logic.js` — pure shared logic (exported for tests and `uv-drafts-page.js`)
- `uv-drafts-page.js` — `/uv-drafts` page module; drafts grid, filters, search, workspace management
- `dashboard.html/js/css` — analytics dashboard; reads from storage; canvas-based charts, compare mode, CSV export/import

**Data flow:**
1. `inject.js` intercepts API responses → normalizes metrics → `postMessage` to `content.js` (schema-validated)
2. `content.js` → `chrome.runtime.sendMessage` to `background.js`
3. `background.js` writes to `chrome.storage.local`; hot metrics flushed on timer, cold snapshots debounced 8s
4. `dashboard.js` reads from storage directly

**Storage keys:**
- `metrics` — hot, latest-per-post metrics indexed by `userKey → postId`
- `snapshots_<userKey>` — cold historical snapshots
- `metricsStorageVersion` — migration version (currently v2)
- `SORA_UV_BOOKMARKS_V1`, `SORA_UV_PREFS_V1` — drafts state
- `SCT_ULTRA_MODE_V1` — feature flag (localStorage, page context)

## Constraints

- **Do not add external network calls.** All data must stay local to the user's device.
- **Do not change extension permissions, host matches, or injected network hooks** unless explicitly requested.
- `background.js` is the single writer to `chrome.storage.local` — other scripts must not write directly.
- All metrics input must be sanitized (maxLen, regex, numeric bounds) before storage.
- Idempotency guards (`if (window.__sct_api__?.installed) return;`) prevent double-injection on SPA navigation — preserve this pattern.

## Adding New Fields (CRITICAL)

When adding a new data field to the metrics pipeline, **all four of these files must be updated** or the field will be silently dropped:

1. **`inject.js`** — extract the field from the API response and add it to the `batch.push({...})` object
2. **`content.js`** — add it to `sanitizeMetricsItem()` (this is a strict whitelist; unknown fields are silently stripped here)
3. **`background.js`** — sanitize it in `sanitizeMetricsSnapshot()`, persist it on the post object, and include it in `serializePost()`
4. **`dashboard.js`** — add the column to the CSV header and row in the POSTS SUMMARY export

Forgetting `content.js` is the easy mistake — it sits between `inject.js` and `background.js` and acts as a silent schema filter.

## Sora API Notes

- Feed post attachments (`post.attachments[0]`) include `encodings.source.path` — a signed Azure Blob `.mp4` URL (the actual video file). Also present: `encodings.thumbnail.path`, `encodings.source_wm.path`, `encodings.md.path`, `encodings.ld.path`, `encodings.gif.path`.
- Signed URLs are time-limited (typically ~7 days based on `se=` param).

## Testing

Tests live in `tests/` and use Node's built-in runner (`node:test`, `node:assert`).

- `*.unit.test.js` — pure logic
- `*.integration.test.js` — multi-module interactions
- `*.regression.test.js` — specific dashboard/inject regressions

Shared logic in `uv-drafts-logic.js` uses explicit `module.exports` so tests can import it. Run a single test file with `node --test tests/<filename>.test.js`.
