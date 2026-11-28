import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

/*
 * ONNX Runtime's bundles name their WebAssembly files with new URL(…, import.meta.url), which
 * makes Vite copy them into the build: 14 and 27 MB, over Cloudflare Pages' 25 MiB file limit.
 * The panel worker hands the runtime its wasm itself (reader/panels.worker.ts), so point those URLs
 * at the CDN copy instead.
 */
const ORT = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.30.0/dist/'

/*
 * The runtime also sets aside 4 GB of memory before it loads a model, which phones refuse: iPhones
 * say "Out of memory", and Chrome on Android, 32-bit on many phones, can't find 4 GB in one piece.
 * What each engine used, measured in Chrome for the voices it ran before Phonon (ADR 0005); the
 * panel model runs in the same room now:
 *
 *   CPU                          about 300 MB: runs in 320 MB, not 288.
 *   WebGPU                       757 MB, all of it while a 326 MB model loads: runs in 768, not 704.
 *
 * So each asks for that with room to spare, and where that's refused, for just enough: the CPU
 * runtime 512 MB, then 384; the WebGPU one 1 GB, then 800 MB. It's room set aside, not memory
 * taken: either takes only what its voice needs.
 */
const MEMORY = 'new WebAssembly.Memory({initial:256,maximum:65536,shared:!0})'
/** The first of these sizes, in MB, that the browser will set aside. */
const oneOf = (mb: number[]) => {
  const pages = mb.map((m) => m * 16)
  return `(()=>{for(const m of[${pages}])try{return new WebAssembly.Memory({initial:256,maximum:m,shared:!0})}catch(e){if(m===${pages[pages.length - 1]})throw e}})()`
}
const SIZED: Array<[RegExp, string]> = [
  [/[\\/]ort\.wasm\.bundle[\w.]*mjs$/, oneOf([512, 384])],
  [/[\\/]ort\.webgpu\.bundle[\w.]*mjs$/, oneOf([1024, 800])],
]

const ortWasm = (): Plugin => ({
  name: 'breader-ort-wasm',
  enforce: 'pre',
  transform(code, id) {
    // The dev server adds ?v=… to it; a build doesn't.
    const file = id.split('?')[0]
    if (!/onnxruntime-web[\\/]dist[\\/]ort\.[\w.]*mjs$/.test(file)) return null
    const out = code.replace(/new URL\("(ort-wasm[\w.-]*)",\s*import\.meta\.url\)/g, `new URL("${ORT}$1")`)
    const sized = SIZED.find(([re]) => re.test(file))
    if (!sized) return out
    if (!out.includes(MEMORY)) this.error('ONNX Runtime sets aside its memory differently now: update MEMORY in vite.config.ts.')
    return out.replace(MEMORY, sized[1])
  },
})

/*
 * Phonon's runtime (phonon-tts/raw) names its 4 MB wasm the same way, for when it's started with no
 * wasm given. Ours is always given it (shared speech.ts, the file catalog.ts hosts), so that path is
 * never taken: it throws instead, and the file stays out of the build.
 */
const PHONON_URL = "new URL('phonon_tts_bg.wasm', import.meta.url)"

const phononWasm = (): Plugin => ({
  name: 'breader-phonon-wasm',
  enforce: 'pre',
  transform(code, id) {
    const file = id.split('?')[0]
    if (!/phonon-tts[\\/]wasm[\\/]phonon_tts\.js$/.test(file)) return null
    if (!code.includes(PHONON_URL)) this.error('Phonon finds its wasm differently now: update PHONON_URL in vite.config.ts.')
    return code.replace(PHONON_URL, `(() => { throw new Error("Phonon is started with its wasm given.") })()`)
  },
})

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), ortWasm(), phononWasm()],
  // Module workers, so the panel worker can load the runtime it needs on demand.
  worker: { format: 'es', plugins: () => [ortWasm(), phononWasm()] },
  // Served as they are: pre-bundling moves files that find their wasm relative to themselves.
  optimizeDeps: { exclude: ['onnxruntime-web', 'phonon-tts'] },
  // Two pages: the app, and the admin page Cloudflare Pages serves at /admin (src/admin).
  // Fonts are never inlined, however small: index.html preloads them by name, and a face kept for
  // other letters (unicode-range) is fetched only if a page has them.
  build: {
    rollupOptions: { input: { main: 'index.html', admin: 'admin.html' } },
    assetsInlineLimit: (file) => (file.endsWith('.woff2') ? false : undefined),
  },
  // Error reports name the commit they came from; Cloudflare Pages provides it at build time.
  define: { 'import.meta.env.VITE_RELEASE': JSON.stringify(process.env.CF_PAGES_COMMIT_SHA ?? 'dev') },
  // Bind to IPv4 so both http://localhost:5173 and http://127.0.0.1:5173 work in every browser.
  server: { host: '127.0.0.1', port: 5173 },
})
