import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import vue from '@vitejs/plugin-vue';

// The dashboard's own unit config — composables need a DOM (timers on
// `window`, component lifecycle), which the root suite deliberately lacks.
export default defineConfig({
    plugins: [vue()],
    resolve: {
        alias: {
            '@server': fileURLToPath(new URL('../src', import.meta.url)),
        },
    },
    test: {
        environment: 'happy-dom',
    },
});
