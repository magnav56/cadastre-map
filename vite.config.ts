import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  // Relative base so the build works at any URL, e.g. username.github.io/cadastre-map/.
  base: './',
  plugins: [
    VitePWA({
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      registerType: 'autoUpdate',
      manifest: false, // public/manifest.webmanifest is used as is
      injectManifest: {
        globPatterns: ['**/*.{html,js,mjs,css,png,webmanifest}'],
      },
    }),
  ],
});
