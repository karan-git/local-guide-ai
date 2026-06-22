import { defineConfig } from 'vitest/config';
import { loadEnv } from 'vite';
import { fileURLToPath } from 'node:url';

export default defineConfig(({ mode }) => ({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Load .env / .env.local into the test process so the live cases (which
    // need OPENAI_API_KEY) run instead of skipping. Next.js loads these for the
    // app automatically; Vitest does not, so we do it here.
    env: loadEnv(mode, process.cwd(), ''),
  },
  resolve: {
    // Mirror the tsconfig "@/*" path alias so tests import like the app does.
    alias: {
      '@': fileURLToPath(new URL('./', import.meta.url)),
    },
  },
}));
