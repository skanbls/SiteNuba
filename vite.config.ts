import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

// base './' : l'appli fonctionne quel que soit le dossier où elle est hébergée.
export default defineConfig({
  base: './',
  // Date de construction, affichée dans l'appli pour savoir quelle version tourne sur un appareil.
  define: { __BUILD__: JSON.stringify(process.env.BUILD_STAMP || new Date().toISOString()) },
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icon.svg', 'apple-touch-icon.png'],
      manifest: {
        name: 'Nuba Gestion',
        short_name: 'Nuba',
        description: "L'appli de gestion de la Nuba : pointeuse, planning, checklists, stocks, hygiène, réservations.",
        lang: 'fr',
        display: 'standalone',
        start_url: './',
        scope: './',
        theme_color: '#2D49A6',
        background_color: '#F1F2F7',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: { globPatterns: ['**/*.{js,css,html,svg,png,woff2}'], navigateFallback: 'index.html' },
    }),
  ],
});
