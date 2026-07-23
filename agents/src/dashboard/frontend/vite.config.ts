import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'autoUpdate',
      // The built SPA is entered via Express's GET /dashboard route (not a
      // static /app/ path prefix — see server.ts), so the service worker's
      // controllable scope has to be '/dashboard', not '/'. A root scope
      // would (once achievable — see the server.ts static mount) let the
      // worker intercept /login and /api too.
      scope: '/dashboard',
      includeAssets: ['favicon-32.png', 'apple-touch-icon.png'],
      manifest: {
        id: '/dashboard',
        name: 'LingLang',
        short_name: 'LingLang',
        description: 'Voice-first language tutor.',
        start_url: '/dashboard',
        scope: '/dashboard',
        display: 'standalone',
        background_color: '#060607',
        theme_color: '#0485f7',
        icons: [
          { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: '/icon-maskable-192.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
          { src: '/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
    }),
  ],
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
