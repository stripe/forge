import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/**/*.ts', '!src/**/*.test.ts', '!src/**/__tests__/**'],
  format: ['esm'],
  // Preserve module-relative asset paths and shared module instances.
  bundle: false,
  platform: 'node',
  target: 'es2022',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
});
