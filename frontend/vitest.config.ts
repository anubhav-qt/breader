import { defineConfig } from 'vitest/config';

// Unit tests for the app's own logic, run in Node: src/**/*.test.ts.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
  },
});
