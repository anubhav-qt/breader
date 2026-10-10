import { copyFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

// The marker (tools/marker.ts) as one file for the server image, built the way the server's own
// bundle is (server/build.mjs). jsdom and pdf.js load files of their own at run time, so they stay
// packages beside it (server/Dockerfile copies them), and pg tries pg-native only when asked to.
const here = dirname(fileURLToPath(import.meta.url));
await build({
  absWorkingDir: here,
  entryPoints: ['tools/cli/marker.ts'],
  outfile: 'dist/marker.js',
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  sourcemap: true,
  external: ['jsdom', 'pdfjs-dist', 'pdfjs-dist/*', 'pg-native'],
  // Bundled CommonJS packages still call require().
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  logLevel: 'info',
});

// The listening model's engine loads its WebAssembly from files, which can't be bundled (tools/clap.ts).
const ort = dirname(createRequire(import.meta.url).resolve('onnxruntime-web'));
await mkdir(join(here, 'dist/ort'), { recursive: true });
for (const f of ['ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm']) await copyFile(join(ort, f), join(here, 'dist/ort', f));
