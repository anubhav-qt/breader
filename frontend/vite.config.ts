import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

/*
 * ONNX Runtime's bundles name their WebAssembly files with new URL(…, import.meta.url), which
 * makes Vite copy them into the build: 14 and 27 MB, over Cloudflare Pages' 25 MiB file limit.
 * The speech worker hands the runtime its wasm itself (voice/tts.worker.ts), so point those URLs
 * at the CDN copy instead.
 */
const ORT = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.30.0/dist/'

/*
 * The runtime also sets aside 4 GB of memory before it loads a model, which phones refuse: iPhones
 * say "Out of memory", and Chrome on Android, 32-bit on many phones, can't find 4 GB in one piece.
 * Normal's voices run in under 512 MB, so the CPU runtime asks for 1 GB, or 512 MB where even that
 * is refused. Immersive's (the WebGPU runtime) is left alone: its model is 326 MB before it starts.
 */
const MEMORY = 'new WebAssembly.Memory({initial:256,maximum:65536,shared:!0})'
const SMALLER = '(()=>{for(const m of[16384,8192])try{return new WebAssembly.Memory({initial:256,maximum:m,shared:!0})}catch(e){if(m===8192)throw e}})()'

const ortWasm = (): Plugin => ({
  name: 'breader-ort-wasm',
  enforce: 'pre',
  transform(code, id) {
    if (!/onnxruntime-web[\\/]dist[\\/]ort\.[\w.]*mjs$/.test(id)) return null
    const out = code.replace(/new URL\("(ort-wasm[\w.-]*)",\s*import\.meta\.url\)/g, `new URL("${ORT}$1")`)
    if (!/[\\/]ort\.wasm\.bundle[\w.]*mjs$/.test(id)) return out
    if (!out.includes(MEMORY)) this.error('ONNX Runtime sets aside its memory differently now: update MEMORY in vite.config.ts.')
    return out.replace(MEMORY, SMALLER)
  },
})

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), ortWasm()],
  // Module workers, so the speech worker can load one engine or the other on demand.
  worker: { format: 'es', plugins: () => [ortWasm()] },
  // Served as they are: pre-bundling moves files that find their wasm relative to themselves.
  optimizeDeps: { exclude: ['onnxruntime-web', 'phonemizer'] },
  // Error reports name the commit they came from; Cloudflare Pages provides it at build time.
  define: { 'import.meta.env.VITE_RELEASE': JSON.stringify(process.env.CF_PAGES_COMMIT_SHA ?? 'dev') },
  // Bind to IPv4 so both http://localhost:5173 and http://127.0.0.1:5173 work in every browser.
  server: { host: '127.0.0.1', port: 5173 },
})
