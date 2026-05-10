# result

Personal utility project.

## Development

```bash
npm install
npm run dev
```

## Screenshot capture

Playwright's bundled Chromium download can be blocked in some sandboxed environments. To avoid that dependency, the screenshot script uses the locally installed Google Chrome channel instead.

1. Install Google Chrome if it is not already available as `google-chrome`.
2. Start the Vite dev server in one terminal:

   ```bash
   npm run dev
   ```

3. Capture the default page in another terminal:

   ```bash
   npm run screenshot
   ```

The screenshot is written to `/tmp/zwift-default-report.png`.
