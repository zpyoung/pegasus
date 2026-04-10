import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'sync-models',
    globals: true,
    environment: 'node',
    include: ['__tests__/**/*.test.ts'],
    mockReset: true,
    restoreMocks: true,
    clearMocks: true,
  },
});
