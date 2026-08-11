<script setup lang="ts">
// The one screen: queue, watches, targets — what is the machine doing right
// now — with per-target depth as a pipeline sheet expanding beneath the grid.
// The route is the selection: /target/... renders this same view with the
// sheet open, so refresh, back, and deep links all keep working.
import { computed, nextTick, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import type { ActivityEvent, PollStatus } from '@server/server/events';
import type { JobSummary } from '@server/server/jobs';
import type { Watch } from '@server/server/trigger';
import type { TargetSummary } from '@server/store/store';
import type { JobId, WatchId } from '@server/types/ids';
import { api, ApiError } from '../api/client';
import type { NewJobRequest, NewWatchRequest } from '../api/client';
import ActivityPanel from '../components/ActivityPanel.vue';
import { clock } from '../format';
import NewJobForm from '../components/NewJobForm.vue';
import QueuePanel from '../components/QueuePanel.vue';
import TargetSheet from '../components/TargetSheet.vue';
import TargetsPanel from '../components/TargetsPanel.vue';
import WatchesPanel from '../components/WatchesPanel.vue';
import { usePolling } from '../composables/usePolling';

const props = defineProps<{ owner?: string; repo?: string; head?: string }>();

const router = useRouter();

const selectedTarget = computed(() =>
    props.owner !== undefined && props.repo !== undefined && props.head !== undefined
        ? { owner: props.owner, repo: props.repo, head: props.head }
        : undefined);

const closeSheet = (): Promise<unknown> => router.push('/');

// Selecting a target lands the sheet in view; nextTick because on a fresh
// page load the wrapper only exists after the first render. A target
// *switch* also kicks the remounted sheet's first fill — on initial load
// that's the poller's job (its first tick fires right after mount), and
// kicking here too would duplicate the requests.
const sheetWrap = ref<HTMLElement>();
watch(selectedTarget, async (target, previous) =>
{
    if (target !== undefined)
    {
        await nextTick();
        if (previous !== undefined)
        {
            void sheet.value?.refresh();
        }
        sheetWrap.value?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
}, { immediate: true });

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

// The activity feed accumulates by cursor: each cycle fetches only the tail
// past the last seq we hold. `boot` names the server's process life — when
// it changes, our cursor describes a ring that no longer exists (comparing
// seqs alone can be fooled by a busy new process out-running the cursor).
const events = ref<ActivityEvent[]>([]);
const feedBoot = ref<string>();
const pollStatus = ref<PollStatus>();
const cursor = computed(() => events.value.at(-1)?.seq ?? 0);

// The heartbeat's clock ticks once per refresh — "ago" values move at poll
// granularity, which is exactly the liveness they are meant to prove.
const refreshedAtMs = ref<number>();

// One poller for the whole page: the open sheet's target-specific lists
// refresh in the same cycle, concurrently. The sheet catches its own errors,
// so awaiting it can't throw into ours.
const sheet = ref<InstanceType<typeof TargetSheet>>();

async function refresh(): Promise<void>
{
    const sheetRefresh = sheet.value?.refresh();
    // The feed degrades independently: a hiccup on /events must not blank
    // the queue, and a queue error must not lose feed continuity.
    const feedPromise = api.listEvents(cursor.value).catch(() => undefined);
    try
    {
        [jobs.value, watches.value, targets.value] = await Promise.all([
            api.listJobs(),
            api.listWatches(),
            api.listTargets(),
        ]);
        refreshedAtMs.value = Date.now();
        connectionError.value = undefined;
    }
    catch (e)
    {
        connectionError.value = describe(e);
    }

    let feed = await feedPromise;
    if (feed !== undefined && feedBoot.value !== undefined && feed.boot !== feedBoot.value)
    {
        // New process life: our cursor named the old ring, so this response
        // may be a partial tail. Refetch whole instead of appending lives.
        feed = await api.listEvents(0).catch(() => undefined);
    }
    if (feed !== undefined)
    {
        events.value = feed.boot === feedBoot.value
            ? [...events.value, ...feed.events].slice(-200)
            : feed.events;
        feedBoot.value = feed.boot;
        pollStatus.value = feed.poll;
    }
    await sheetRefresh;
}

const updatedLabel = computed(() =>
    refreshedAtMs.value === undefined ? '…' : clock(refreshedAtMs.value));

const pollLabel = computed(() =>
{
    const poll = pollStatus.value;
    if (poll === undefined || refreshedAtMs.value === undefined)
    {
        return '…';
    }
    if (!poll.polling)
    {
        return 'off';
    }
    const every = `every ${Math.round(poll.intervalMs / 1000)}s`;
    if (poll.lastAt === undefined)
    {
        return `starting · ${every}`;
    }
    const ago = Math.max(0, Math.round((refreshedAtMs.value - Date.parse(poll.lastAt)) / 1000));
    return `${ago}s ago · ${every}`;
});

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
const release = (id: JobId): Promise<void> => act(() => api.releaseJob(id));
const enqueue = (job: NewJobRequest): Promise<void> => act(() => api.enqueueJob(job));
const addWatch = (watch: NewWatchRequest): Promise<void> => act(() => api.addWatch(watch));
const removeWatch = (id: WatchId): Promise<void> => act(() => api.removeWatch(id));

// Cancel first: if the review started running in the race window, the 409
// stops the promotion before a duplicate campaign is enqueued. The campaign
// lands held regardless of the review's posture — promote upgrades the plan,
// ▶ start stays the only click that bills.
const promote = (job: JobSummary): Promise<void> => act(async () =>
{
    await api.cancelJob(job.id);
    await api.enqueueJob({ kind: 'campaign', owner: job.owner, repo: job.repo, head: job.head, base: job.base });
});

const running = computed(() => jobs.value.find(j => j.state === 'running'));
const queuedCount = computed(() => jobs.value.filter(j => j.state === 'queued').length);
const heldCount = computed(() => jobs.value.filter(j => j.state === 'held').length);
</script>

<template>
    <div class="bp mc">
        <div class="caption">
            <h1>Mission Control</h1>
            <div class="subrow">
                <span class="sub caps">branch-reviewer // serve — queue · watches · targets</span>
                <template v-if="connectionError === undefined">
                    <span class="kv caps">worker
                        <b v-if="running" class="busy mono">running #{{ running.id }}</b>
                        <b v-else class="mono">idle</b>
                    </span>
                    <span class="kv caps">queued <b class="mono">{{ queuedCount }}</b></span>
                    <!-- Held is the count that wants a human — it earns the chalk. -->
                    <span v-if="heldCount > 0" class="kv caps">held <b class="mono busy">{{ heldCount }}</b></span>
                    <span class="kv caps">poll <b class="mono">{{ pollLabel }}</b></span>
                    <span class="kv caps">updated <b class="mono">{{ updatedLabel }}</b></span>
                </template>
            </div>
        </div>

        <p v-if="connectionError" class="msg offline">OFFLINE — {{ connectionError }}</p>
        <p v-if="actionError" class="msg action-error">{{ actionError }}</p>

        <main>
            <div class="col">
                <QueuePanel :jobs="jobs" :selected="selectedTarget" @cancel="cancel" @promote="promote" @release="release" />
                <NewJobForm @enqueue="enqueue" />
            </div>
            <div class="col side">
                <WatchesPanel :watches="watches" @add="addWatch" @remove="removeWatch" />
                <TargetsPanel :targets="targets" :selected="selectedTarget" />
            </div>
        </main>

        <!-- Keyed by target: switching targets remounts the sheet, so caches
             and selections from the old target can't leak into the new one.
             The key must cover all of owner/repo/head — the sheet does not
             reset itself on prop changes; the remount IS the reset. -->
        <div v-if="selectedTarget" ref="sheetWrap" class="sheetwrap">
            <TargetSheet
                ref="sheet"
                :key="`${selectedTarget.owner}/${selectedTarget.repo}/${selectedTarget.head}`"
                :owner="selectedTarget.owner"
                :repo="selectedTarget.repo"
                :head="selectedTarget.head"
                :jobs="jobs"
                :watches="watches"
                @close="closeSheet"
                @cancel="cancel"
                @promote="promote"
                @release="release"
                @enqueue="enqueue"
            />
        </div>

        <!-- Below the sheet on purpose: the feed's height breathes as lines
             arrive, and nothing being read should shift under the reader. -->
        <div class="activitywrap">
            <ActivityPanel :events="events" />
        </div>

        <div class="titleblockwrap">
            <div class="titleblock">
                <div class="cell"><span class="k">Server</span><span class="v">branch-reviewer//serve</span></div>
                <div class="cell"><span class="k">Worker</span><span class="v">{{ running ? `running #${running.id}` : 'idle' }}</span></div>
                <div class="cell"><span class="k">Queued</span><span class="v">{{ queuedCount }}</span></div>
                <div class="cell"><span class="k">Watches</span><span class="v">{{ watches.length }}</span></div>
                <div class="cell"><span class="k">Targets</span><span class="v">{{ targets.length }}</span></div>
                <div class="cell"><span class="k">Sheet</span><span class="v">1 / 1</span></div>
            </div>
        </div>
    </div>
</template>

<!-- Blueprint tokens and primitives come from src/blueprint.css; the panels
     render themselves as .stage boxes. Only this sheet's grid lives here. -->
<style scoped>
.mc
{
    display: flex;
    flex-direction: column;
}

.kv { color: var(--faint); font-size: 0.75rem; }
.kv b { font-weight: 400; color: var(--bright); font-size: 0.78rem; }
.kv b.busy { color: var(--chalk); }

main
{
    flex: 1;
    display: flex;
    align-items: flex-start;
    gap: 1.2rem;
}

.col
{
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 1.2rem;
}

.col.side { flex: none; width: 360px; }

.sheetwrap { scroll-margin-top: 1rem; }

.activitywrap { margin-top: 1.2rem; }

@media (max-width: 900px)
{
    main { flex-direction: column; align-items: stretch; }
    .col.side { width: auto; }
}
</style>
