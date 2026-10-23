import { defineConfig } from 'vite';

// Unique ID for every production build. The client compares it with
// dist/version.json (fetched with no-store) and reloads once when a newer
// build has been deployed, so home-screen / bookmark users do not stay
// stuck on a cached old version.
const buildId = new Date().toISOString();

function appVersionPlugin() {
  return {
    name: 'app-version',
    generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: 'version.json',
        source: JSON.stringify({ version: buildId }),
      });
    },
  };
}

export default defineConfig({
  base: './',
  define: {
    __APP_VERSION__: JSON.stringify(buildId),
  },
  plugins: [appVersionPlugin()],
});
