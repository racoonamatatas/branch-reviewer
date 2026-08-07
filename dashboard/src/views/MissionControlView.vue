<script setup lang="ts">
// The server-wide screen: queue, watches, targets — what is the machine
// doing right now. Per-target depth lives in the blueprint view.
import { computed, ref } from 'vue';
import type { JobSummary } from '@server/server/jobs';
import type { Watch } from '@server/server/trigger';
import type { TargetSummary } from '@server/store/store';
import type { JobId, WatchId } from '@server/types/ids';
import { api, ApiError } from '../api/client';
import type { NewJobRequest, NewWatchRequest } from '../api/client';
import NewJobForm from '../components/NewJobForm.vue';
import QueuePanel from '../components/QueuePanel.vue';
import TargetsPanel from '../components/TargetsPanel.vue';
import WatchesPanel from '../components/WatchesPanel.vue';
import { usePolling } from '../composables/usePolling';

const jobs = ref<JobSummary[]>([]);
const watches = ref<Watch[]>([]);
const targets = ref<TargetSummary[]>([]);
const connectionError = ref<string>();
const actionError = ref<string>();

function describe(e: unknown): string
{
    if (e instanceof ApiError)
    {
        return `${e.status}: ${e.message}`;
    }
    return e instanceof Error ? e.message : String(e);
}

async function refresh(): Promise<void>
{
    try
    {
        [jobs.value, watches.value, targets.value] = await Promise.all([
            api.listJobs(),
            api.listWatches(),
            api.listTargets(),
        ]);
        connectionError.value = undefined;
    }
    catch (e)
    {
        connectionError.value = describe(e);
    }
}

usePolling(refresh, 3000);

// Every action refreshes immediately — the poll would catch up in seconds,
// but a click should feel synchronous.
async function act(action: () => Promise<unknown>): Promise<void>
{
    actionError.value = undefined;
    try
    {
        await action();
    }
    catch (e)
    {
        actionError.value = describe(e);
    }
    await refresh();
}

const cancel = (id: JobId): Promise<void> => act(() => api.cancelJob(id));
const enqueue = (job: NewJobRequest): Promise<void> => act(() => api.enqueueJob(job));
const addWatch = (watch: NewWatchRequest): Promise<void> => act(() => api.addWatch(watch));
const removeWatch = (id: WatchId): Promise<void> => act(() => api.removeWatch(id));

// Cancel first: if the review started running in the race window, the 409
// stops the promotion before a duplicate campaign is enqueued.
const promote = (job: JobSummary): Promise<void> => act(async () =>
{
    await api.cancelJob(job.id);
    await api.enqueueJob({ kind: 'campaign', owner: job.owner, repo: job.repo, head: job.head, base: job.base });
});

const running = computed(() => jobs.value.find(j => j.state === 'running'));
const queuedCount = computed(() => jobs.value.filter(j => j.state === 'queued').length);
</script>

<template>
    <div class="mc">
        <header>
            <span class="brand">BRANCH-REVIEWER//SERVE</span>
            <span class="sep">│</span>
            <template v-if="connectionError === undefined">
                <span class="kv">
                    worker
                    <b v-if="running" class="busy">RUNNING #{{ running.id }}</b>
                    <b v-else>IDLE</b>
                </span>
                <span class="sep">│</span>
                <span class="kv">queued <b>{{ queuedCount }}</b></span>
                <span class="sep">│</span>
                <span class="kv">watches <b>{{ watches.length }}</b></span>
            </template>
            <span v-else class="offline">OFFLINE — {{ connectionError }}</span>
        </header>

        <p v-if="actionError" class="action-error">{{ actionError }}</p>

        <main>
            <div class="col">
                <QueuePanel :jobs="jobs" @cancel="cancel" @promote="promote" />
                <NewJobForm @enqueue="enqueue" />
            </div>
            <div class="col">
                <WatchesPanel :watches="watches" @add="addWatch" @remove="removeWatch" />
                <TargetsPanel :targets="targets" />
            </div>
        </main>
    </div>
</template>

<style scoped>
/* The mission-control theme. Custom properties cascade into the child
   components, which style themselves against --mc-* only. */
.mc
{
    --mc-ground:  #0b0f14;
    --mc-panel:   #10151c;
    --mc-panel-2: #0d1218;
    --mc-line:    #1d2733;
    --mc-ink:     #c9d4de;
    --mc-muted:   #5f7182;
    --mc-faint:   #3a4756;
    --mc-amber:   #e3a542;
    --mc-ok:      #4cc272;
    --mc-fail:    #e06060;
    --mc-queued:  #5fb4d9;

    min-height: 100vh;
    background: var(--mc-ground);
    color: var(--mc-ink);
    font-family: ui-monospace, 'Cascadia Code', 'Source Code Pro', Menlo, Consolas, monospace;
    font-size: 13px;
    line-height: 1.55;
    display: flex;
    flex-direction: column;
}

header
{
    display: flex;
    align-items: center;
    gap: 1.2rem;
    padding: 0.55rem 1rem;
    border-bottom: 1px solid var(--mc-line);
    background: var(--mc-panel-2);
    white-space: nowrap;
    overflow-x: auto;
}

.brand
{
    color: var(--mc-amber);
    font-weight: 700;
    letter-spacing: 0.08em;
}

.sep
{
    color: var(--mc-faint);
}

.kv
{
    color: var(--mc-muted);
}

.kv b
{
    color: var(--mc-ink);
    font-weight: 400;
}

.kv b.busy
{
    color: var(--mc-amber);
}

.offline
{
    color: var(--mc-fail);
}

.action-error
{
    margin: 0;
    padding: 0.4rem 1rem;
    color: var(--mc-fail);
    border-bottom: 1px solid var(--mc-line);
}

main
{
    flex: 1;
    display: grid;
    grid-template-columns: minmax(0, 1fr) 360px;
    gap: 1px;
    background: var(--mc-line);
}

.col
{
    background: var(--mc-ground);
    display: flex;
    flex-direction: column;
    gap: 1px;
    min-width: 0;
}

.col > :deep(section)
{
    background: var(--mc-panel);
    padding: 0.7rem 1rem 0.9rem;
}

.col > :deep(section h2)
{
    margin: 0 0 0.6rem;
    font-size: 0.85em;
    font-weight: 700;
    letter-spacing: 0.18em;
    color: var(--mc-muted);
}

.col > :deep(section h2 .count)
{
    color: var(--mc-amber);
}

@media (max-width: 900px)
{
    main
    {
        grid-template-columns: minmax(0, 1fr);
    }
}
</style>
