<script setup lang="ts">
import { computed } from 'vue';
import type { JobSummary } from '@server/server/jobs';
import type { JobId } from '@server/types/ids';
import { age } from '../format';

const props = defineProps<{
    jobs: JobSummary[];
    selected?: { owner: string; repo: string; head: string };
}>();

function isSelected(job: JobSummary): boolean
{
    return props.selected !== undefined
        && job.owner === props.selected.owner
        && job.repo === props.selected.repo
        && job.head === props.selected.head;
}

// The server returns the full ledger; mission control shows the pending work
// and only a tail of history. Active jobs run oldest-first, so ascending id
// is execution order and the running job sorts to the top on its own.
const ACTIVE = new Set<JobSummary['state']>(['running', 'queued']);
const active = computed(() =>
    props.jobs.filter(j => ACTIVE.has(j.state)).sort((a, b) => a.id - b.id));
const recent = computed(() => props.jobs.filter(j => !ACTIVE.has(j.state)));

const RECENT_SHOWN = 8;
const recentShown = computed(() => recent.value.slice(0, RECENT_SHOWN));
const olderCount = computed(() => recent.value.length - recentShown.value.length);

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
    <section class="stage">
        <div class="stage-head">
            <span class="name">Queue</span>
            <span class="desc caps">{{ active.length }} active</span>
        </div>
        <div class="stage-body tablewrap">
            <table>
                <thead>
                    <tr><th>Nº</th><th>Kind</th><th>Target</th><th>State</th><th>Runs</th><th>Age</th><th></th></tr>
                </thead>
                <tbody>
                    <tr v-for="job in active" :key="job.id" :aria-current="isSelected(job)">
                        <td class="num mono">#{{ job.id }}</td>
                        <td>{{ job.kind }}</td>
                        <td class="target">
                            <RouterLink :to="targetRoute(job)">{{ job.target }}</RouterLink>
                        </td>
                        <td class="state mono" :class="`state-${job.state}`">{{ GLYPH[job.state] }} {{ job.state.toUpperCase() }}</td>
                        <td class="num">{{ job.runCount > 0 ? job.runCount : '–' }}</td>
                        <td class="num">{{ age(job.createdAt) }}</td>
                        <td class="actions">
                            <template v-if="job.state === 'queued'">
                                <button v-if="job.kind === 'review'" class="bp-btn mini chalk" @click="emit('promote', job)">↺ campaign</button>
                                <button class="bp-btn mini" @click="emit('cancel', job.id)">cancel</button>
                            </template>
                        </td>
                    </tr>
                    <tr v-if="active.length === 0">
                        <td colspan="7" class="empty">nothing queued — label a PR or enqueue below</td>
                    </tr>
                    <!-- Subhead as a spanning row so both sections share column alignment. -->
                    <tr v-if="recent.length > 0" class="subhead">
                        <td colspan="7" class="caps">Recent · {{ recent.length }}</td>
                    </tr>
                    <tr v-for="job in recentShown" :key="job.id" class="done" :aria-current="isSelected(job)">
                        <td class="num mono">#{{ job.id }}</td>
                        <td>{{ job.kind }}</td>
                        <td class="target">
                            <RouterLink :to="targetRoute(job)">{{ job.target }}</RouterLink>
                        </td>
                        <td class="state mono" :class="`state-${job.state}`">{{ GLYPH[job.state] }} {{ job.state.toUpperCase() }}</td>
                        <td class="num">{{ job.runCount > 0 ? job.runCount : '–' }}</td>
                        <td class="num">{{ age(job.createdAt) }}</td>
                        <td></td>
                    </tr>
                    <tr v-if="olderCount > 0">
                        <td colspan="7" class="empty">+{{ olderCount }} older job(s) in the ledger</td>
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
    font-size: 0.82rem;
    font-variant-numeric: tabular-nums;
}

th, td
{
    text-align: left;
    padding: 0.28rem 1.1rem 0.28rem 0;
    white-space: nowrap;
}

th
{
    color: var(--faint);
    font-weight: 400;
    text-transform: uppercase;
    letter-spacing: 0.16em;
    font-size: 0.7rem;
    border-bottom: 1px solid var(--rule-soft);
}

/* Border on the row, not the cells: per-cell dashed borders restart the
   dash pattern at every column edge and render as broken stubs. */
tbody tr
{
    border-bottom: 1px dashed var(--rule-soft);
}

tbody tr:last-of-type { border-bottom: 0; }

/* Reserved transparent edge so selection doesn't shift the columns. */
tbody td:first-child { border-left: 2px solid transparent; padding-left: 0.3rem; }

tbody tr[aria-current='true'] { background: rgba(242, 212, 121, 0.08); }
tbody tr[aria-current='true'] td:first-child { border-left-color: var(--chalk); }

.num
{
    text-align: right;
    padding-right: 1.6rem;
}

.mono { font-size: 0.78rem; }

.subhead td
{
    padding-top: 0.9rem;
    color: var(--faint);
    font-size: 0.7rem;
}

tr.done td, tr.done .target a
{
    color: var(--muted);
}

.target a
{
    color: var(--ink);
    text-decoration: none;
    border-bottom: 1px dotted var(--faint);
}

.target a:hover
{
    color: var(--chalk);
    border-bottom-color: var(--chalk);
}

.state-running   { color: var(--chalk); }
.state-queued    { color: var(--bright); }
.state-succeeded { color: var(--stamp-ok); }
.state-failed    { color: var(--stamp-no); }
.state-aborted   { color: var(--stamp-und); opacity: 0.7; }
.state-cancelled { color: var(--muted); }

/* No flex here — a td that stops being a table-cell breaks border painting. */
.actions button + button
{
    margin-left: 0.35rem;
}

.empty
{
    color: var(--faint);
}
</style>
