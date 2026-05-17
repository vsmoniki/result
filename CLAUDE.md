# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 規約

- コミットメッセージ、PRタイトル・本文、ブランチ名の説明などは全て日本語で作成する

## What This Project Is

**Zwift Result Image Maker** — a vanilla-JS, single-page web app deployed to GitHub Pages. Users drop a `.fit` cycling activity file onto the page; the app parses it in the browser and renders a Zwift-style result image onto an HTML `<canvas>`, which can then be saved as PNG.

Two image modes exist:
- **ライドレポート (Ride Report)** — 1000×642 canvas: timeline graph, power/HR distributions, stats header
- **完走タイム (Finish Time)** — 470×584 canvas: elapsed time + W/kg breakdown by duration

## Commands

```bash
npm run dev        # start Vite dev server (bound to 0.0.0.0:5173)
npm run build      # production build → dist/
npm run preview    # serve the production build locally
npm test           # run tests with Node.js built-in test runner
node scripts/gen-ogp.js  # regenerate public/ogp-20260517.png via Playwright
```

Running a single test file:
```bash
node --test test/sp.test.js
```

## Architecture

There is no framework and no TypeScript. The app is pure ES modules bundled by Vite.

### Source layout

| File | Role |
|------|------|
| `index.html` | All markup; the only HTML file |
| `src/main.js` | Everything: UI event wiring, FIT parsing, metrics extraction, all Canvas drawing (~1500 lines) |
| `src/sp.js` | Pure functions for Normalized Power and Stress Points (TSS equivalent); exported for unit tests |
| `src/ride-title.js` | Derives a ride title string from a FIT filename; exported for unit tests |
| `src/styles.css` | All CSS, including responsive breakpoints |
| `test/*.test.js` | Node.js `node:test` + `node:assert` tests for the pure utility modules |
| `scripts/gen-ogp.{js,py}` | One-off scripts to regenerate `public/ogp-20260517.png` |

### Key patterns in `src/main.js`

**State**: a single `state` object holds parsed FIT data (`sourceData`, `metrics`), the download blob/URL, and `*Touched` flags for the three graph option sliders.

**File selection**: the `fileInputKey` deduplication + `pickerIsActive` guard handle the cross-browser quirks of file-input events firing multiple times (especially on mobile Safari).

**Canvas drawing flow**: `generateImage()` dispatches to `drawFinishResult()` or `drawRideReport()`. The ride report composes: `drawHeader()` → `drawTabs()` → `drawTimeline()` → `drawLegends()` → `drawDistributionPanels()`.

**Graph smoothing**: each slider has a `*Touched` flag. While `false` the slider value resets to the computed default whenever a new file loads or the mode changes; once `true` it stays at the user's choice until "Reset options" is clicked.

**Downsample pipeline**: raw FIT records → `rollingPower()` / `rollingHeartRate()` (sliding window average) → `downsampleSeries()` (reduce to drawable pixel count) → Canvas path.

**Power zones** (`zoneColor()`): six color stops keyed off `power / ftp` ratio (< 0.55 gray, < 0.75 blue, < 0.9 green, < 1.05 yellow, < 1.2 orange, else red).

### Extracted pure utilities

Functions are moved out of `main.js` into separate files only when they need unit tests. `sp.js` is the clearest example: the NP/TSS calculation has no DOM dependency and benefits from test coverage.

## Testing

Tests live in `test/` and use only Node.js built-ins (`node:test`, `node:assert`). No test framework is installed. Tests import directly from `src/` ES modules.

## Deployment

GitHub Actions (`.github/workflows/deploy.yml`) runs `npm ci && npm run build` on every push to `main`, `master`, or `work`, then deploys `dist/` to GitHub Pages.
