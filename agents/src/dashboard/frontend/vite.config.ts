import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: '../public/app',
    // 2026-06-25: BUGFIX. Previously `emptyOutDir: true` caused Vite to
    // wipe out the *parent* public/ directory (login.html, dashboard.html,
    // index.html, css/, js/) on every build, because Vite resolves
    // outDir relatively and treats it as a project root. Set to false and
    // manually clean the outDir child dir in the npm script if needed —
    // better to keep non-bundled assets safe.
    emptyOutDir: false,
    rollupOptions: {
      output: {
        entryFileNames: 'assets/[name].js',
        chunkFileNames: 'assets/[name].js',
        assetFileNames: 'assets/[name].[ext]',
      },
    },
  },
  server: {
    port: 5174,
    proxy: {
      '/api': 'http://localhost:8392',
      '/login': 'http://localhost:8392',
    },
  },
});
