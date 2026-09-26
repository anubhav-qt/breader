import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // Error reports name the commit they came from; Cloudflare Pages provides it at build time.
  define: { 'import.meta.env.VITE_RELEASE': JSON.stringify(process.env.CF_PAGES_COMMIT_SHA ?? 'dev') },
  // Bind to IPv4 so both http://localhost:5173 and http://127.0.0.1:5173 work in every browser.
  server: { host: '127.0.0.1', port: 5173 },
})
