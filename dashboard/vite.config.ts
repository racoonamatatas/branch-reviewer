import { fileURLToPath } from 'node:url';
import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vite';

// Dev-only wiring: the app talks same-origin paths and Vite forwards them to
// the job server, so no CORS layer exists anywhere — in production the job
// server serves the built app itself and the paths are literally same-origin.
const API_PATHS = ['/jobs', '/watches', '/targets', '/runs', '/consolidations', '/clusters', '/events'];

export default defineConfig({
    plugins: [vue()],
    resolve: {
        // Mirrors the tsconfig paths entry. Views import server types
        // (type-only, erased at build); the ids module is the one deliberate
        // value import — pure code, and the source of branded-id parsing.
        // Anything else from @server that reaches the bundle fails the build
        // on its node:* imports, which is the guard working.
        alias: { '@server': fileURLToPath(new URL('../src', import.meta.url)) },
    },
    server: {
        proxy: Object.fromEntries(API_PATHS.map(path => [path, 'http://127.0.0.1:4780'])),
    },
});
