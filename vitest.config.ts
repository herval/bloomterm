import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          // Some start real processes (a fake agent, then the real `bt mcp`): quick alone, not on a
          // busy machine or a Windows runner.
          testTimeout: 30_000,
          // Integrations keep their tests in their own folder, next to the fixtures (packages/integrations/CLAUDE.md).
          include: ['packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.ts', 'packages/integrations/src/**/*.test.ts'],
          exclude: ['**/*.browser.test.ts', '**/*.headed.test.ts', '**/node_modules/**'],
        },
      },
      {
        // Drives one long-lived headless Chrome (test/shared-chrome.ts) against a local fake site.
        test: {
          name: 'browser',
          globalSetup: ['./test/shared-chrome.ts'],
          include: ['packages/*/test/**/*.browser.test.ts', 'apps/*/test/**/*.browser.test.ts'],
          testTimeout: 60_000,
          hookTimeout: 60_000,
          expect: { poll: { timeout: 10_000 } },
          fileParallelism: false,
        },
      },
      {
        // Shows real windows; skipped unless BLOOMTERM_HEADED_TESTS=1.
        test: {
          name: 'headed',
          include: ['packages/*/test/**/*.headed.test.ts', 'apps/*/test/**/*.headed.test.ts'],
          testTimeout: 60_000,
          hookTimeout: 60_000,
          fileParallelism: false,
        },
      },
    ],
  },
});
