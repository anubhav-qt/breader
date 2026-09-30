import { copyFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { build } from 'esbuild';

// One self-contained file per entry point, so the runtime image needs next to no node_modules.
await build({
  entryPoints: ['src/api.ts', 'src/worker.ts', 'src/migrate.ts', 'src/speech/worker.ts'],
  outdir: 'dist',
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  sourcemap: true,
  // pg tries pg-native only when asked to; it isn't installed. The MP3 encoder is LGPL, so it
  // stays its own package beside the bundle (the Dockerfile copies it) rather than inside it.
  external: ['pg-native', '@breezystack/lamejs'],
  // Bundled CommonJS packages still call require().
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  logLevel: 'info',
});

// The server voice's engine loads its WebAssembly from files, which can't be bundled (speech/worker.ts).
const ort = dirname(createRequire(import.meta.url).resolve('onnxruntime-web'));
await mkdir('dist/ort', { recursive: true });
for (const f of ['ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm']) await copyFile(join(ort, f), join('dist/ort', f));
