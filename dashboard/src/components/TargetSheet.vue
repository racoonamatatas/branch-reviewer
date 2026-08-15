<script setup lang="ts">
// The per-target sheet, drawn as the pipeline itself: review → consolidate →
// verify → coverage as one engineering sheet, the campaign as the loop band
// above stages 01↔02 (design reference: docs/prototypes/blueprint.html).
// Embedded beneath the mission-control grid; the parent keys this component
// by target, so a target switch remounts it with fresh state. That key MUST
// cover all of owner/repo/head — nothing in here resets on a prop change, so
// a partial key would show one target's cached revs under another's heading
// (run 18 finding, confirmed). The parent
// also owns the poll: jobs and watches arrive as props, and the parent
// drives the exposed refresh() for the target-specific lists — one poller,
// no duplicate requests. Job actions are emitted up for the same reason:
// they mutate the parent's data.
// A rev is a consolidation: clusters are one judge call's opinion, so the
// picker switches whole partitions rather than pretending they compose.
import { computed, ref, watch } from 'vue';
// A value import from the server's pure coverage module — same standing as
// the ids module: no node:* reachable, and it keeps the "novel" number here
// computed by the exact code the campaign's stopping rule runs.
import { novelClusters } from '@server/coverage/coverage';
import type { Coverage } from '@server/coverage/coverage';
import type { Severity } from '@server/schema/schema';
import type { JobSummary } from '@server/server/jobs';
import type { ConsolidationDetail } from '@server/server/server';
import type { Watch } from '@server/server/trigger';
import type { ConsolidationSummary, Finding, RunSummary } from '@server/store/store';
import type { ClusterId, ConsolidationId, FindingId, JobId, RunId } from '@server/types/ids';
import { api, ApiError } from '../api/client';
import type { NewJobRequest } from '../api/client';
import { usd } from '../format';
import BlueprintCallout from './blueprint/BlueprintCallout.vue';
import type { CalloutSubject } from './blueprint/BlueprintCallout.vue';
import BlueprintIntake from './blueprint/BlueprintIntake.vue';
import LoopBand from './blueprint/LoopBand.vue';

const props = defineProps<{
    owner: string;
    repo: string;
    head: string;
    jobs: JobSummary[];
    watches: Watch[];
}>();

const emit = defineEmits<{
    close: [];
    cancel: [id: JobId];
    promote: [job: JobSummary];
    release: [id: JobId];
    enqueue: [job: NewJobRequest];
}>();

interface Detail
{
    consolidation: ConsolidationDetail;
    coverage: Coverage;
}

const runs = ref<RunSummary[]>([]);
const consolidations = ref<ConsolidationSummary[]>([]);
const detail = ref<Detail>();
const connectionError = ref<string>();
const actionError = ref<string>();

const selectedRevId = ref<ConsolidationId>();
const pinned = ref(false);
const selectedClusterId = ref<ClusterId>();
const selectedFindingId = ref<FindingId>();

function describe(e: unknown): string
{
    if (e instanceof ApiError)
    {
        return `${e.status}: ${e.message}`;
    }
    return e instanceof Error ? e.message : String(e);
}

// The parent's poller abandons a pass that outlives its stall deadline, but
// the delegated sheet refresh keeps running — without its own stamp, a late
// settle would overwrite runs/consolidations a fresher pass already wrote
// (the parent's generation guard cannot see into this component — rev 21).
let refreshGeneration = 0;

async function refresh(): Promise<void>
{
    const generation = ++refreshGeneration;
    const filter = { owner: props.owner, repo: props.repo, head: props.head };
    // The selected rev's detail re-fetches every cycle: a consolidation row is
    // immutable but its verification history is not — agent verdicts and human
    // stamps both append after the fact, so a cached detail goes stale while
    // it's on screen. The cache only smooths rev switches now.
    const revId = selectedRevId.value;
    try
    {
        const [runList, revList, revDetail] = await Promise.all([
            api.listRuns(filter),
            api.listConsolidations(filter),
            revId !== undefined ? api.getConsolidation(revId) : undefined,
        ]);
        if (generation !== refreshGeneration)
        {
            return;
        }
        runs.value = runList;
        consolidations.value = revList;
        if (revId !== undefined && revDetail !== undefined)
        {
            detailCache.set(revId, revDetail);
            if (selectedRevId.value === revId)
            {
                detail.value = revDetail;
            }
        }
        connectionError.value = undefined;
    }
    catch (e)
    {
        if (generation !== refreshGeneration)
        {
            return;
        }
        connectionError.value = describe(e);
    }
}

// No self-fetch on mount: the parent's poller fires its first tick right
// after this component mounts (usePolling's onMounted), and its target-switch
// watcher kicks refresh() on remounts between ticks — a setup fetch here
// would duplicate both (run 18 finding, confirmed).
defineExpose({ refresh });

// Follow the newest rev until the user pins an older one from the picker.
const latestId = computed(() => consolidations.value[0]?.id);
watch(latestId, (id) =>
{
    if (!pinned.value && id !== undefined)
    {
        selectedRevId.value = id;
    }
}, { immediate: true });

const revModel = computed({
    get: () => selectedRevId.value,
    set: (id: ConsolidationId | undefined) =>
    {
        selectedRevId.value = id;
        pinned.value = id !== latestId.value;
    },
});

// The cache makes switching back to a seen rev instant; refresh() keeps the
// selected entry current (verifications append, so "immutable" only covers
// the partition itself). The guard keeps a slow response for a rev the user
// already left from clobbering the current one.
const detailCache = new Map<ConsolidationId, Detail>();
watch(selectedRevId, async (id) =>
{
    selectedClusterId.value = undefined;
    if (id === undefined)
    {
        detail.value = undefined;
        return;
    }
    const cached = detailCache.get(id);
    if (cached !== undefined)
    {
        detail.value = cached;
        return;
    }
    try
    {
        const fetched = await api.getConsolidation(id);
        detailCache.set(id, fetched);
        if (selectedRevId.value === id)
        {
            detail.value = fetched;
        }
    }
    catch (e)
    {
        connectionError.value = describe(e);
    }
}, { immediate: true });

const consolidation = computed(() => detail.value?.consolidation);
const coverage = computed(() => detail.value?.coverage);

// The single-run fallback: with no consolidation to display, the sheet shows
// the latest submitted run's own findings — labeled unverified, because
// verification hangs off clusters and these rows have never faced the
// adversarial pass. Findings are immutable once written, so they cache by
// run id exactly like consolidation details do.
const sampleFindings = ref<Finding[]>([]);
const findingsCache = new Map<RunId, Finding[]>();
const sampleRunId = computed(() =>
    consolidations.value.length > 0 ? undefined : runs.value.find(r => r.status === 'submitted')?.id);
watch(sampleRunId, async (id) =>
{
    if (id === undefined)
    {
        sampleFindings.value = [];
        return;
    }
    const cached = findingsCache.get(id);
    if (cached !== undefined)
    {
        sampleFindings.value = cached;
        return;
    }
    try
    {
        const fetched = await api.getRunFindings(id);
        findingsCache.set(id, fetched);
        if (sampleRunId.value === id)
        {
            sampleFindings.value = fetched;
        }
    }
    catch (e)
    {
        connectionError.value = describe(e);
    }
}, { immediate: true });

const targetJobs = computed(() =>
    props.jobs.filter(j => j.owner === props.owner && j.repo === props.repo && j.head === props.head));
const targetWatches = computed(() =>
    props.watches.filter(w => w.owner === props.owner && w.repo === props.repo));

// Base comes from the rev when there is one; a fresh target only has jobs.
const base = computed(() => consolidation.value?.base ?? targetJobs.value[0]?.base);

// ── stage data, all derived from the selected rev ───────
const runById = computed(() => new Map(runs.value.map(r => [r.id, r])));
const revRuns = computed(() =>
    (consolidation.value?.runIds ?? []).flatMap((id) =>
    {
        const run = runById.value.get(id);
        return run === undefined ? [] : [run];
    }));
const runCount = computed(() => consolidation.value?.runIds.length ?? 0);
const extraRunCount = computed(() =>
{
    const inRev = new Set(consolidation.value?.runIds ?? []);
    return runs.value.filter(r => !inRev.has(r.id)).length;
});
// Connector labels follow what the sheet displays: rev totals when a rev is
// selected, the sample run's findings in the no-consolidation fallback.
const totalFindings = computed(() =>
    consolidation.value !== undefined
        ? revRuns.value.reduce((sum, r) => sum + r.findingsCount, 0)
        : sampleFindings.value.length);

const SEVERITIES: Severity[] = ['critical', 'warning', 'nit'];
const groups = computed(() =>
    SEVERITIES
        .map(severity => ({
            severity,
            clusters: (consolidation.value?.clusters ?? [])
                .filter(c => c.severity === severity)
                .sort((a, b) => b.occurrence - a.occurrence || a.id - b.id),
        }))
        .filter(g => g.clusters.length > 0));
const orderedClusters = computed(() => groups.value.flatMap(g => g.clusters));
const seenOnce = computed(() => orderedClusters.value.filter(c => c.occurrence === 1));
// The server's coverage excludes these; the margin calc says so, because a
// fraction whose parts don't visibly add up reads as a bug.
const refutedCount = computed(() =>
    (consolidation.value?.clusters ?? []).filter(c => c.verificationStatus === 'refuted').length);

const selectedCluster = computed(() =>
    orderedClusters.value.find(c => c.id === selectedClusterId.value)
    ?? orderedClusters.value.find(c => c.verifications.length > 0)
    ?? orderedClusters.value[0]);

// Fallback groups mirror the cluster grouping; no occurrence sort because
// occurrence does not exist at n = 1.
const findingGroups = computed(() =>
    SEVERITIES
        .map(severity => ({ severity, findings: sampleFindings.value.filter(f => f.severity === severity) }))
        .filter(g => g.findings.length > 0));

const selectedFinding = computed(() =>
    sampleFindings.value.find(f => f.id === selectedFindingId.value) ?? sampleFindings.value[0]);

const calloutSubject = computed<CalloutSubject | undefined>(() =>
    selectedCluster.value !== undefined ? { kind: 'cluster', cluster: selectedCluster.value }
        : selectedFinding.value !== undefined ? { kind: 'finding', finding: selectedFinding.value }
            : undefined);

// The callout's "verify now": one verify job for the whole target —
// consolidates the submitted runs if the latest rev doesn't cover them,
// then runs the adversarial pass over pending clusters. start: true — the
// button is the billing click.
function verifyNow(): void
{
    if (base.value === undefined)
    {
        return;
    }
    emit('enqueue', { kind: 'verify', owner: props.owner, repo: props.repo, head: props.head, base: base.value, start: true });
}

// ── the loop band's inputs ──────────────────────────────
const campaignJob = computed(() =>
    targetJobs.value.filter(j => j.kind === 'campaign')
        .reduce<JobSummary | undefined>((latest, j) => latest === undefined || j.id > latest.id ? j : latest, undefined));

// Liveness pulses on the stage heads, keyed by kind per stage — never by
// "anything is running", so a future job kind (verify) cannot light stages
// it does not touch. A review touches stage 01; a campaign loops through
// review, consolidate, and verify, so all three pulse. Stamps stay PENDING
// while the dot blinks: "in motion" and "no verdict yet" are both true.
const runningKind = computed(() => targetJobs.value.find(j => j.state === 'running')?.kind);
const reviewing = computed(() => runningKind.value === 'review' || runningKind.value === 'campaign');
const verifying = computed(() => runningKind.value === 'campaign' || runningKind.value === 'verify');
const hasActiveJob = computed(() => targetJobs.value.some(j => j.state === 'queued' || j.state === 'running'));
// A held verify job blocks "verify now" too: the worker auto-proposes one
// after a review with findings, and a click here would stack a second job —
// the held job's ▶ in the queue is the release path.
const hasOpenVerify = computed(() => targetJobs.value.some(
    j => j.kind === 'verify' && (j.state === 'held' || j.state === 'queued' || j.state === 'running')));

const rounds = computed(() =>
    (consolidation.value?.runIds ?? []).map(id => ({
        runId: id,
        novel: novelClusters(consolidation.value?.clusters ?? [], id),
    })));
const reviewCostUsd = computed(() => revRuns.value.reduce((sum, r) => sum + r.costUsd, 0));
const verifyCostUsd = computed(() =>
    (consolidation.value?.clusters ?? []).reduce(
        (sum, c) => sum + c.verifications.reduce((s, v) => s + (v.source === 'agent' ? v.costUsd : 0), 0), 0));

// ── actions ─────────────────────────────────────────────
// Job actions (cancel, promote, enqueue) are emitted to the parent, whose
// act() owns the API call, the error display, and the immediate refresh.
// Stamping stays here: it touches the rev's verification history, which is
// this sheet's data, nobody else's.
// start: true — this button IS the billing click (chalk, tooltip says so);
// parking it held would just demand a second click somewhere else.
function resumeCampaign(): void
{
    if (base.value === undefined)
    {
        return;
    }
    emit('enqueue', { kind: 'campaign', owner: props.owner, repo: props.repo, head: props.head, base: base.value, start: true });
}

// A stamp appends to the one thing the forever-cache assumed immutable — the
// rev's verification history — so the cached detail is invalidated and
// refetched in place. Same-id refetch: the selection survives.
async function stamp(verdict: 'confirmed' | 'refuted', rationale: string): Promise<void>
{
    const cluster = selectedCluster.value;
    const revId = selectedRevId.value;
    if (cluster === undefined || revId === undefined)
    {
        return;
    }
    actionError.value = undefined;
    try
    {
        await api.stampVerdict(cluster.id, { verdict, rationale });
        detailCache.delete(revId);
        const fetched = await api.getConsolidation(revId);
        detailCache.set(revId, fetched);
        detail.value = fetched;
        // The stamp is the freshest truth on screen; a refresh already in
        // flight predates it and must not overwrite it when it settles.
        refreshGeneration++;
    }
    catch (e)
    {
        actionError.value = describe(e);
    }
}
</script>

<template>
    <div class="sheet">
        <div class="strip">
            <span class="label caps">Pipeline</span>
            <span class="sub caps">{{ props.owner }}/{{ props.repo }} — {{ props.head }} → {{ base ?? '?' }}</span>
            <label class="revlabel caps" for="revpick">rev</label>
            <!-- Story first, db id last: "which snapshot" is the question the
                 picker answers; Nº survives because the CLI addresses revs by it. -->
            <select id="revpick" v-model="revModel" class="revpick" :disabled="consolidations.length === 0">
                <option v-if="consolidations.length === 0" :value="undefined">none yet</option>
                <option v-for="c in consolidations" :key="c.id" :value="c.id">
                    {{ c.runIds.length }} {{ c.runIds.length === 1 ? 'run' : 'runs' }} · {{ c.clusterCount }} clusters{{ c.id === latestId ? ' · latest' : '' }} · Nº {{ c.id }}
                </option>
            </select>
            <button class="bp-btn mini close" @click="emit('close')">✕ close</button>
        </div>

        <p v-if="connectionError" class="msg offline">OFFLINE — {{ connectionError }}</p>
        <p v-if="actionError" class="msg action-error">{{ actionError }}</p>

        <LoopBand
            v-if="consolidation"
            :campaign="campaignJob"
            :rounds="rounds"
            :review-cost-usd="reviewCostUsd"
            :verify-cost-usd="verifyCostUsd"
        />

        <div class="flowwrap">
            <div class="flow">
                <BlueprintIntake
                    :watches="targetWatches"
                    :jobs="targetJobs"
                    @cancel="emit('cancel', $event)"
                    @promote="emit('promote', $event)"
                    @release="emit('release', $event)"
                />

                <div class="connector">
                    <div class="arrow"></div>
                    <span class="n">labeled PR<br>head SHA</span>
                </div>

                <div class="stage">
                    <div class="stage-head">
                        <span class="no">01</span><span class="name">Review</span>
                        <span v-if="reviewing" class="pulse" title="a job for this target is running">●</span>
                        <span class="desc caps">{{ consolidation ? `${runCount} runs` : `${runs.length} runs` }}</span>
                    </div>
                    <div class="stage-body">
                        <!-- Round ordinals answer "when in the campaign"; the db id is
                             demoted to small print because only the CLI needs it. Rounds
                             exist only inside a rev — the fallback list has no R numbers. -->
                        <div v-for="(run, i) in (consolidation ? revRuns : runs)" :key="run.id" class="run">
                            <span v-if="consolidation" class="id">R{{ i + 1 }}</span>
                            <span class="dbid">run {{ run.id }}</span>
                            <span class="m">{{ run.turns }} turns · {{ usd(run.costUsd) }}</span>
                            <!-- An empty compare is a review of nothing (merged or stale
                                 head) — it must not read as a clean bill of health. -->
                            <span class="f">{{ run.status === 'aborted' ? 'aborted'
                                : run.filesChanged === 0 ? 'empty diff — reviewed nothing'
                                    : `${run.findingsCount} findings` }}</span>
                        </div>
                        <div v-if="runs.length === 0" class="vnote">no runs recorded for this target yet</div>
                        <div v-if="consolidation && extraRunCount > 0" class="vnote">
                            +{{ extraRunCount }} run(s) outside this rev (aborted or newer)
                        </div>
                        <div class="vnote">one run is a sample, not a survey — the union is the artifact</div>
                    </div>
                </div>

                <div class="connector">
                    <div class="arrow"></div>
                    <span class="n">{{ totalFindings }} findings</span>
                </div>

                <div class="stage">
                    <div class="stage-head">
                        <span class="no">02</span><span class="name">Consolidate</span>
                        <span v-if="verifying" class="pulse" title="a job for this target is running">●</span>
                        <!-- The desc names what the body shows: clusters when a rev
                             exists, raw unclustered findings in the fallback. -->
                        <span class="desc caps">{{ consolidation ? `${orderedClusters.length} clusters · click for detail` : `${sampleFindings.length} findings · unclustered` }}</span>
                    </div>
                    <div class="stage-body">
                        <div v-for="group in groups" :key="group.severity" class="sevgroup">
                            <div class="caps">{{ group.severity }} · {{ group.clusters.length }}</div>
                            <button
                                v-for="cluster in group.clusters"
                                :key="cluster.id"
                                class="cl"
                                :aria-current="cluster.id === selectedCluster?.id"
                                @click="selectedClusterId = cluster.id"
                            >
                                <span class="t">{{ cluster.representative.title }}</span>
                                <!-- occurrence as dots against the rev's run count; past eight the dots stop reading -->
                                <span v-if="runCount <= 8" class="occ">{{ '●'.repeat(cluster.occurrence) }}<span class="empty">{{ '●'.repeat(runCount - cluster.occurrence) }}</span></span>
                                <span v-else class="occ">{{ cluster.occurrence }}/{{ runCount }}</span>
                            </button>
                        </div>
                        <template v-if="!consolidation">
                            <div v-for="group in findingGroups" :key="group.severity" class="sevgroup">
                                <div class="caps">{{ group.severity }} · {{ group.findings.length }}</div>
                                <button
                                    v-for="f in group.findings"
                                    :key="f.id"
                                    class="cl"
                                    :aria-current="f.id === selectedFinding?.id"
                                    @click="selectedFindingId = f.id"
                                >
                                    <span class="t">{{ f.title }}</span>
                                    <span class="stamp stamp-pend">UNVERIFIED</span>
                                </button>
                            </div>
                            <div v-if="sampleFindings.length > 0" class="vnote">
                                no consolidation yet — run {{ sampleRunId }}'s findings shown raw: claims, not facts
                            </div>
                            <div v-else class="vnote">no consolidation yet — no submitted run to sample</div>
                        </template>
                    </div>
                </div>

                <div class="connector">
                    <div class="arrow"></div>
                    <!-- "0 seen once" would be a rev-derived claim; without a rev
                         nothing flows to verify at all, and the dash says so. -->
                    <span class="n">{{ consolidation ? `${seenOnce.length} seen once` : '—' }}</span>
                </div>

                <div class="stage">
                    <div class="stage-head">
                        <span class="no">03</span><span class="name">Verify</span>
                        <span v-if="verifying" class="pulse" title="a job for this target is running">●</span>
                        <span class="desc caps">adversarial</span>
                    </div>
                    <div class="stage-body">
                        <button
                            v-for="cluster in seenOnce"
                            :key="cluster.id"
                            class="vrow"
                            :aria-current="cluster.id === selectedCluster?.id"
                            @click="selectedClusterId = cluster.id"
                        >
                            <span class="t">{{ cluster.representative.title }}</span>
                            <span class="stamp" :class="`stamp-${cluster.verificationStatus === 'pending' ? 'pend' : { confirmed: 'ok', refuted: 'no', undetermined: 'und' }[cluster.verificationStatus]}`">
                                {{ cluster.verificationStatus.toUpperCase() }}
                            </span>
                        </button>
                        <div v-if="consolidation" class="vnote">
                            only occurrence-1 clusters are queued — recurrence corroborates the other
                            {{ orderedClusters.length - seenOnce.length }}.<br>undetermined ≠ refuted: it means human eyes.
                        </div>
                        <div v-else class="vnote">
                            verification hangs off clusters — consolidate the run (or start a campaign)
                            to put its findings through the adversarial pass
                        </div>
                    </div>
                </div>

                <div class="connector">
                    <div class="arrow"></div>
                    <span class="n">occurrence<br>counts</span>
                </div>

                <div class="stage coverage-stage">
                    <div class="stage-head">
                        <span class="no">04</span><span class="name">Coverage</span>
                        <span class="desc caps">estimate</span>
                    </div>
                    <div class="stage-body">
                        <template v-if="coverage">
                            <div class="fraction">{{ coverage.observed }} <span class="of">of</span> <span class="est">≈{{ coverage.estimatedTotal }}</span></div>
                            <!-- mirrors coverageOf exactly: one bias-corrected form for every
                                 input, no classic-form branch — the engine dropped that seam
                                 (losing the only doubleton must not lower the estimate). -->
                            <div class="margincalc">
                                f₁ = {{ coverage.f1 }}, f₂ = {{ coverage.f2 }}<br>
                                f₁(f₁−1) / 2(f₂+1) = {{ coverage.f1 * (coverage.f1 - 1) }}/{{ 2 * (coverage.f2 + 1) }}
                                <span class="c">{{ ' ' }}≲ {{ coverage.undiscovered }} unseen</span><br>
                                <span class="c">capture–recapture ceiling — runs are correlated{{ refutedCount > 0 ? ` · ${refutedCount} refuted excluded` : '' }}</span>
                            </div>
                        </template>
                        <div v-else class="vnote">no estimate yet — coverage reads occurrence counts across runs</div>
                        <!-- Outside the coverage gate on purpose: the moment a campaign is most
                             wanted is a one-run target, which has no coverage to show yet. -->
                        <div v-if="campaignJob" class="verdictline">campaign #{{ campaignJob.id }}: {{ campaignJob.state }}</div>
                        <div class="cta">
                            <button
                                class="bp-btn chalk"
                                :disabled="hasActiveJob || base === undefined"
                                :title="hasActiveJob ? 'A job for this target is already queued or running.'
                                    : base === undefined ? 'No base known for this target yet.'
                                        : 'Enqueue a campaign for this target — bills subscription credit.'"
                                @click="resumeCampaign"
                            >↺ {{ campaignJob ? 'resume' : 'start' }} campaign</button>
                        </div>
                    </div>
                </div>
            </div>
        </div>

        <BlueprintCallout
            v-if="calloutSubject"
            :subject="calloutSubject"
            :run-count="runCount"
            :rev-run-ids="consolidation?.runIds"
            :can-verify="!hasActiveJob && !hasOpenVerify && base !== undefined"
            @stamp="stamp"
            @verify="verifyNow"
        />
    </div>
</template>

<!-- Blueprint tokens and primitives come from src/blueprint.css; only this
     sheet's own structure — the strip, flow, connectors, stamps — lives here. -->
<style scoped>
.sheet
{
    margin-top: 1.4rem;
    border-top: 2px solid var(--rule);
    padding-top: 0.8rem;
}

/* ── header strip + rev picker ──────────────────────── */
.strip
{
    display: flex;
    align-items: baseline;
    gap: 0.8rem;
    flex-wrap: wrap;
    margin-bottom: 1rem;
}

.strip .label
{
    color: var(--bright);
    font-weight: 600;
    font-size: 0.85rem;
    letter-spacing: 0.22em;
}

.revlabel { color: var(--faint); font-size: 0.7rem; }

.revpick
{
    background: transparent;
    border: 1px solid var(--rule);
    color: var(--bright);
    font-family: ui-monospace, Menlo, Consolas, monospace;
    font-size: 0.75rem;
    padding: 0.15rem 0.4rem;
}

.close { margin-left: auto; }

.pulse
{
    color: var(--chalk);
    font-size: 0.7rem;
    animation: bp-pulse 1.2s ease-in-out infinite;
}

@keyframes bp-pulse
{
    0%, 100% { opacity: 1; }
    50% { opacity: 0.15; }
}

/* ── the flow ───────────────────────────────────────── */
.flowwrap { overflow-x: auto; padding-bottom: 0.5rem; }

.flow
{
    display: flex;
    align-items: stretch;
    gap: 0;
    min-width: 1300px;
}

.coverage-stage { max-width: 280px; }

/* Sized by the widest label ("OCCURRENCE") plus breathing room on both
   sides — at 84px the 03→04 label touched both stage borders. */
.connector
{
    flex: none;
    width: 132px;
    align-self: stretch;
    display: flex;
    flex-direction: column;
    justify-content: center;
    align-items: center;
    gap: 0.3rem;
    padding: 0 6px;
}

.connector .arrow
{
    width: 100%;
    display: flex;
    align-items: center;
    color: var(--rule);
}

.connector .arrow::before
{
    content: '';
    flex: 1;
    border-top: 2px dashed var(--rule-soft);
}

.connector .arrow::after
{
    content: '▶';
    font-size: 0.7rem;
    margin-left: 2px;
}

.connector .n
{
    color: var(--chalk);
    font-size: 0.72rem;
    text-align: center;
    letter-spacing: 0.08em;
    text-transform: uppercase;
}

/* stage 1: runs */
.run
{
    display: flex;
    gap: 0.7rem;
    align-items: baseline;
    border-bottom: 1px dashed var(--rule-soft);
    padding: 0.32rem 0;
    font-size: 0.85rem;
    font-variant-numeric: tabular-nums;
}

.run:last-of-type { border-bottom: 0; }
.run .id { color: var(--chalk); font-family: ui-monospace, Menlo, Consolas, monospace; }
.run .dbid { color: var(--faint); font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 0.78rem; }
.run .m { color: var(--muted); }
.run .f { margin-left: auto; color: var(--ink); }

/* stage 2: clusters */
.sevgroup { margin-bottom: 0.6rem; }
.sevgroup:last-of-type { margin-bottom: 0; }
.sevgroup .caps { font-size: 0.7rem; color: var(--faint); margin-bottom: 0.2rem; }

.cl
{
    display: flex;
    gap: 0.6rem;
    align-items: baseline;
    width: 100%;
    background: transparent;
    border: 0;
    border-left: 2px solid transparent;
    color: inherit;
    text-align: left;
    padding: 0.18rem 0.3rem;
    font-size: 0.82rem;
}

.cl:hover { background: rgba(219, 231, 245, 0.08); }
.cl[aria-current="true"] { border-left-color: var(--chalk); background: rgba(242, 212, 121, 0.08); }
.cl .t { color: var(--ink); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cl .occ { margin-left: auto; flex: none; color: var(--chalk); font-size: 0.75rem; letter-spacing: 0.15em; }
.cl .occ .empty { color: var(--faint); }

/* stage 3: verify */
.vrow
{
    display: flex;
    gap: 0.6rem;
    align-items: center;
    width: 100%;
    background: transparent;
    border: 0;
    border-left: 2px solid transparent;
    border-bottom: 1px dashed var(--rule-soft);
    color: inherit;
    text-align: left;
    padding: 0.42rem 0.3rem;
    font-size: 0.82rem;
}

.vrow:hover { background: rgba(219, 231, 245, 0.08); }
.vrow[aria-current="true"] { border-left-color: var(--chalk); background: rgba(242, 212, 121, 0.08); }
.vrow .t { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.stamp
{
    margin-left: auto;
    flex: none;
    font-family: ui-monospace, Menlo, Consolas, monospace;
    font-size: 0.68rem;
    letter-spacing: 0.14em;
    border: 2px solid currentColor;
    padding: 0.08rem 0.45rem;
    transform: rotate(-4deg);
}

.stamp-ok  { color: var(--stamp-ok); }
.stamp-no  { color: var(--stamp-no); }
.stamp-und { color: var(--stamp-und); border-style: dashed; }
.stamp-pend { color: var(--faint); border: 1px dashed var(--faint); transform: none; }

.vnote
{
    color: var(--faint);
    font-size: 0.75rem;
    margin-top: 0.6rem;
    letter-spacing: 0.04em;
}

/* stage 4: coverage */
.fraction
{
    font-family: ui-monospace, Menlo, Consolas, monospace;
    font-size: 2.3rem;
    color: var(--bright);
    line-height: 1.1;
}

.fraction .est { color: var(--chalk); }
.fraction .of { color: var(--faint); font-size: 1.3rem; }

.margincalc
{
    margin-top: 0.7rem;
    font-family: ui-monospace, Menlo, Consolas, monospace;
    color: var(--chalk);
    font-size: 0.8rem;
    line-height: 1.7;
    border-left: 2px solid var(--chalk);
    padding-left: 0.7rem;
}

.margincalc .c { color: var(--muted); }

.verdictline
{
    margin-top: 0.8rem;
    font-size: 0.78rem;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--stamp-ok);
}

.cta { margin-top: 0.9rem; }
</style>
