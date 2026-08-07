<script setup lang="ts">
import type { JobSummary } from '@server/server/jobs';
import type { JobId } from '@server/types/ids';
import { age } from '../format';

defineProps<{ jobs: JobSummary[] }>();

const emit = defineEmits<{
    cancel: [id: JobId];
    promote: [job: JobSummary];
}>();

const GLYPH: Record<JobSummary['state'], string> = {
    running: '▶',
    queued: '●',
    succeeded: '✓',
    aborted: '◼',
    failed: '✕',
    cancelled: '⊘',
};

function targetRoute(job: JobSummary): string
{
    return `/target/${encodeURIComponent(job.owner)}/${encodeURIComponent(job.repo)}/${job.head}`;
}
</script>

<template>
    <section>
        <h2>QUEUE <span class="count">· {{ jobs.length }}</span></h2>
        <div class="tablewrap">
            <table>
                <thead>
                    <tr><th>ID</th><th>KIND</th><th>TARGET</th><th>STATE</th><th>RUNS</th><th>AGE</th><th></th></tr>
                </thead>
                <tbody>
                    <tr v-for="job in jobs" :key="job.id" :class="{ done: !['running', 'queued'].includes(job.state) }">
                        <td class="num">#{{ job.id }}</td>
                        <td>{{ job.kind }}</td>
                        <td class="target">
                            <RouterLink :to="targetRoute(job)">{{ job.target }}</RouterLink>
                        </td>
                        <td class="state" :class="`state-${job.state}`">{{ GLYPH[job.state] }} {{ job.state.toUpperCase() }}</td>
                        <td class="num">{{ job.runCount > 0 ? job.runCount : '–' }}</td>
                        <td class="num">{{ age(job.createdAt) }}</td>
                        <td class="actions">
                            <template v-if="job.state === 'queued'">
                                <button v-if="job.kind === 'review'" class="linkish" @click="emit('promote', job)">↺ campaign</button>
                                <button class="linkish danger" @click="emit('cancel', job.id)">cancel</button>
                            </template>
                        </td>
                    </tr>
                    <tr v-if="jobs.length === 0">
                        <td colspan="7" class="empty">queue is empty — label a PR or enqueue below</td>
                    </tr>
                </tbody>
            </table>
        </div>
    </section>
</template>

<style scoped>
.tablewrap
{
    overflow-x: auto;
}

table
{
    border-collapse: collapse;
    width: 100%;
    font-variant-numeric: tabular-nums;
}

th, td
{
    text-align: left;
    padding: 0.25rem 1.1rem 0.25rem 0;
    white-space: nowrap;
}

th
{
    color: var(--mc-faint);
    font-weight: 400;
    letter-spacing: 0.1em;
    font-size: 0.85em;
    border-bottom: 1px solid var(--mc-line);
}

.num
{
    text-align: right;
    padding-right: 1.6rem;
}

tr.done td, tr.done .target a
{
    color: var(--mc-muted);
}

.target a
{
    color: var(--mc-ink);
    text-decoration: none;
    border-bottom: 1px dotted var(--mc-faint);
}

.target a:hover
{
    color: var(--mc-amber);
    border-bottom-color: var(--mc-amber);
}

.state
{
    font-weight: 700;
}

.state-running   { color: var(--mc-amber); }
.state-queued    { color: var(--mc-queued); }
.state-succeeded { color: var(--mc-ok); }
.state-failed    { color: var(--mc-fail); }
.state-aborted   { color: var(--mc-amber); opacity: 0.7; }
.state-cancelled { color: var(--mc-muted); }

.actions
{
    display: flex;
    gap: 0.8rem;
}

.linkish
{
    background: none;
    border: none;
    padding: 0;
    font: inherit;
    color: var(--mc-amber);
    cursor: pointer;
    border-bottom: 1px dotted currentcolor;
}

.linkish.danger
{
    color: var(--mc-fail);
}

.empty
{
    color: var(--mc-faint);
}
</style>
