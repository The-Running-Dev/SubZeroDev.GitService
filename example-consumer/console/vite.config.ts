import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The example consumer's own build entry (S35.6), consuming the base's
// published `@subzerodev-git/console` package rather than forking it — the
// same `outDir`/`manifest: true` shape the base's own `console/vite.config.ts`
// uses, so `console-integrity.ts`'s hash covers this workspace's own output.
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    manifest: true,
  },
});
