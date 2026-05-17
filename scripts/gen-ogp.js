#!/usr/bin/env node
/**
 * Generates public/ogp-20260517.png (1200×630) for Open Graph / Twitter Card previews.
 * Run: node scripts/gen-ogp.js
 */
import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outPath = path.resolve(__dirname, '../public/ogp-20260517.png');

const html = String.raw`<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    width: 1200px;
    height: 630px;
    background: #0e1117;
    font-family: 'Segoe UI', Arial, sans-serif;
    color: #fff;
    overflow: hidden;
  }
  .bg-stripe {
    position: absolute;
    inset: 0;
    background:
      linear-gradient(135deg, #ff6a00 0%, #ee0979 30%, #0e1117 55%);
    opacity: 0.18;
  }
  .grid {
    position: absolute;
    inset: 0;
    background-image:
      linear-gradient(rgba(255,255,255,.04) 1px, transparent 1px),
      linear-gradient(90deg, rgba(255,255,255,.04) 1px, transparent 1px);
    background-size: 60px 60px;
  }
  .content {
    position: relative;
    display: flex;
    flex-direction: column;
    justify-content: center;
    height: 100%;
    padding: 0 96px;
  }
  .badge {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    background: rgba(255,106,0,.2);
    border: 1px solid rgba(255,106,0,.5);
    border-radius: 6px;
    padding: 6px 16px;
    font-size: 22px;
    font-weight: 600;
    color: #ff6a00;
    letter-spacing: .04em;
    text-transform: uppercase;
    margin-bottom: 28px;
    width: fit-content;
  }
  h1 {
    font-size: 76px;
    font-weight: 800;
    line-height: 1.1;
    letter-spacing: -.02em;
    margin-bottom: 28px;
    background: linear-gradient(90deg, #fff 0%, #ccc 100%);
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
  }
  .desc {
    font-size: 30px;
    color: #9ca3af;
    line-height: 1.5;
    max-width: 820px;
  }
  .corner-deco {
    position: absolute;
    right: 80px;
    bottom: 60px;
    width: 220px;
    height: 220px;
    border: 3px solid rgba(255,106,0,.3);
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .corner-deco::before {
    content: '';
    position: absolute;
    inset: 14px;
    border: 2px solid rgba(255,106,0,.2);
    border-radius: 50%;
  }
  .icon {
    font-size: 80px;
    line-height: 1;
  }
  .url {
    position: absolute;
    bottom: 36px;
    left: 96px;
    font-size: 22px;
    color: #4b5563;
    letter-spacing: .04em;
  }
</style>
</head>
<body>
  <div class="bg-stripe"></div>
  <div class="grid"></div>
  <div class="content">
    <div class="badge">🚴 Zwift Tool</div>
    <h1>Zwift風<br>リザルト画像メーカー</h1>
    <p class="desc">FITファイルをブラウザ内で解析し、<br>Zwiftスタイルのリザルト画像をPNGで生成</p>
  </div>
  <div class="corner-deco">
    <span class="icon">🏁</span>
  </div>
  <div class="url">vsmoniki.github.io/result</div>
</body>
</html>`;

const browser = await chromium.launch();
const page = await browser.newPage();
await page.setViewportSize({ width: 1200, height: 630 });
await page.setContent(html, { waitUntil: 'networkidle' });
const buf = await page.screenshot({ type: 'png' });
await browser.close();

writeFileSync(outPath, buf);
console.log(`✓ OGP image saved: ${outPath}`);
