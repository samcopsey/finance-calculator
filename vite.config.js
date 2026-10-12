import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // The app ships as one ~770 kB bundle (mostly recharts); it's served from your own machine, so splitting isn't worth it.
  build: { chunkSizeWarningLimit: 1000 },
})
