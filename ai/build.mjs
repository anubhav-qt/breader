import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

// The marker (tools/marker.ts) as one file for the server image, built the way the server's own
// bundle is (server/build.mjs). jsdom and pdf.js load files of their own at run time, so they stay
// packages beside it (server/Dockerfile copies them), and pg tries pg-native only when asked to.
await build({
  absWorkingDir: dirname(fileURLToPath(import.meta.url)),
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
