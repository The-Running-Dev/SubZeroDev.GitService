import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// S18.9/S18.11: `outDir` is what `src/server.ts`'s `consoleDir` points boot's
// integrity check at, and `manifest: true` is what gives S19's later
// published-package work a machine-readable asset list — `console-integrity.ts`
// hashes the built files directly rather than reading this manifest, so
// tampering with a build output is caught even if the manifest itself were
// somehow left untouched.
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    manifest: true,
  },
  server: {
    proxy: {
      '/auth': 'http://localhost:8080',
      '/declarations': 'http://localhost:8080',
      '/grants': 'http://localhost:8080',
      '/tokens': 'http://localhost:8080',
      '/clients': 'http://localhost:8080',
      '/operator-sessions': 'http://localhost:8080',
      '/parked-operations': 'http://localhost:8080',
      '/failing-credentials': 'http://localhost:8080',
      '/health': 'http://localhost:8080',
      '/version': 'http://localhost:8080',
    },
  },
});
