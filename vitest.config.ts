import { defineConfig } from 'vitest/config';

// The root suite is node-only (no DOM, no network, no model calls); the
// dashboard's tests need happy-dom and run under dashboard/vitest.config.ts
// (`npm test` in dashboard/) — including them here would fail on `document`.
export default defineConfig({
    test: {
        include: ['test/**/*.test.ts'],
    },
});
