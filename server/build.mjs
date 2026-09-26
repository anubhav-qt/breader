import { build } from 'esbuild';

// One self-contained file per entry point, so the runtime image needs no node_modules.
await build({
  entryPoints: ['src/api.ts', 'src/worker.ts', 'src/migrate.ts'],
  outdir: 'dist',
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  sourcemap: true,
  // pg tries pg-native only when asked to; it isn't installed.
  external: ['pg-native'],
  // Bundled CommonJS packages still call require().
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  logLevel: 'info',
});
