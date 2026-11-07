import { build } from 'esbuild';

// One self-contained file per entry point, so the runtime image needs next to no node_modules.
await build({
  entryPoints: ['src/api.ts', 'src/worker.ts', 'src/migrate.ts', 'src/engine/main.ts', 'src/engine/worker.ts'],
  outdir: 'dist',
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  sourcemap: true,
  // pg tries pg-native only when asked to; it isn't installed. The MP3 encoder is LGPL, so it
  // stays its own package beside the bundle (the Dockerfile copies it) rather than inside it. The
  // cover encoder and ONNX Runtime are native code, installed for the image's own platform (the Dockerfile).
  external: ['pg-native', '@breezystack/lamejs', 'sharp', 'onnxruntime-node'],
  // Bundled CommonJS packages still call require().
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  logLevel: 'info',
});
