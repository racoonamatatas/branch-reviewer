import { createRouter, createWebHistory } from 'vue-router';

// Both routes render mission control — the target route is the same screen
// with the pipeline sheet expanded beneath the grid. The route carries the
// selection so refresh, back, and deep links survive.
// head is (.*): branch names contain slashes, and the route takes a branch
// name or a pinned SHA equally — same vocabulary as the job model.
export const router = createRouter({
    history: createWebHistory(),
    routes: [
        {
            path: '/',
            name: 'mission-control',
            component: () => import('./views/MissionControlView.vue'),
        },
        {
            path: '/target/:owner/:repo/:head(.*)',
            name: 'target',
            component: () => import('./views/MissionControlView.vue'),
            props: true,
        },
    ],
});
