import { defineConfig } from 'vite'
import { readFileSync } from 'node:fs'
import react from '@vitejs/plugin-react'

const API_PORT = process.env.RADIANT_PORT || 5834

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))

export default defineConfig({
  // the phone's Settings shows the version, and reading package.json at build
  // time is the only source that cannot drift from what actually shipped
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  plugins: [react()],
  server: {
    // ⚠️ THE BACKEND PORT IS AN OVERRIDE, NOT A CONSTANT. Radiant.app owns 5834
    // whenever it is running, so a dev server that hardcodes it silently drives
    // the REAL app against the REAL ~/.radiant — which is how a board smoke test
    // once wrote its fixtures into Tony's actual chats. RADIANT_PORT lets a test
    // point the UI at a throwaway server on a throwaway RADIANT_DIR.
    proxy: {
      '/api': `http://127.0.0.1:${API_PORT}`,
      '/term': { target: `ws://127.0.0.1:${API_PORT}`, ws: true }
    }
  }
})
