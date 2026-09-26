import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // Bind to IPv4 so both http://localhost:5173 and http://127.0.0.1:5173 work in every browser.
  server: { host: '127.0.0.1', port: 5173 },
})
