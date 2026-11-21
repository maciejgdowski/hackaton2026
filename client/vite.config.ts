import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  base: './', // relative asset URLs: works at the site root or under any BASE_PATH
  server: {
    host: true,
    proxy: { '/api': 'http://localhost:3000' } // npm run dev: the API runs on :3000
  },
  // maplibre-gl (~1 MB) is loaded lazily in its own chunk
  // two pages: the game (/) and the standalone sonar test (/sonar/)
  build: {
    outDir: 'dist', emptyOutDir: true, chunkSizeWarningLimit: 1100,
    rollupOptions: { input: { main: 'index.html', sonar: 'sonar/index.html' } }
  }
});
