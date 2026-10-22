import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globalSetup: ['./test/globalSetup.ts'],
    testTimeout: 60_000,
    hookTimeout: 120_000,
    pool: 'forks',
    fileParallelism: false,
    env: { NODE_ENV: 'test', LOG_LEVEL: 'silent', ALLOW_MOCK_PROVIDERS: 'true', RUN_WORKER_IN_PROCESS: 'false' },
  },
});
