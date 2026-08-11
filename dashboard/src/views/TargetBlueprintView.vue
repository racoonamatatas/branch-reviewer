<script setup lang="ts">
// The per-target view, drawn as the pipeline itself: review → consolidate →
// verify → coverage as one engineering sheet, the campaign as the loop band
// above stages 01↔02 (design reference: docs/prototypes/blueprint.html).
// A rev is a consolidation: clusters are one judge call's opinion, so the
// picker switches whole partitions rather than pretending they compose.
import { computed, ref, watch } from 'vue';
import type { Coverage } from '@server/coverage/coverage';
import type { Severity } from '@server/schema/schema';
import type { JobSummary } from '@server/server/jobs';
import type { ConsolidationDetail } from '@server/server/server';
import type { Watch } from '@server/server/trigger';
import type { ConsolidationSummary, Finding, RunSummary } from '@server/store/store';
import type { ClusterId, ConsolidationId, FindingId, JobId, RunId } from '@server/types/ids';
import { api, ApiError } from '../api/client';
import BlueprintCallout from '../components/blueprint/BlueprintCallout.vue';
import type { CalloutSubject } from '../components/blueprint/BlueprintCallout.vue';
import BlueprintIntake from '../components/blueprint/BlueprintIntake.vue';
import LoopBand from '../components/blueprint/LoopBand.vue';
import { usePolling } from '../composables/usePolling';
import { usd } from '../format';

const props = defineProps<{ owner: string; repo: string; head: string }>();

interface Detail
{
    consolidation: ConsolidationDetail;
    coverage: Coverage;
}

const runs = ref<RunSummary[]>([]);
const consolidations = ref<ConsolidationSummary[]>([]);
const jobs = ref<JobSummary[]>([]);
const watches = ref<Watch[]>([]);
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

async function refresh(): Promise<void>
{
    const filter = { owner: props.owner, repo: props.repo, head: props.head };
    try
    {
        [runs.value, consolidations.value, jobs.value, watches.value] = await Promise.all([
            api.listRuns(filter),
            api.listConsolidations(filter),
            api.listJobs(),
            api.listWatches(),
        ]);
        connectionError.value = undefined;
    }
    catch (e)
    {
        connectionError.value = describe(e);
    }
}

usePolling(refresh, 3000);

// The route reuses this component across targets; a target switch resets
// every selection the old target justified.
watch(() => [props.owner, props.repo, props.head], () =>
{
    runs.value = [];
    consolidations.value = [];
    detail.value = undefined;
    selectedRevId.value = undefined;
    selectedClusterId.value = undefined;
    selectedFindingId.value = undefined;
    sampleFindings.value = [];
    pinned.value = false;
    detailCache.clear();
    findingsCache.clear();
    void refresh();
});

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

// Consolidations are immutable rows, so details cache forever; the guard
// keeps a slow response for a rev the user already left from clobbering
// the current one.
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
    jobs.value.filter(j => j.owner === props.owner && j.repo === props.repo && j.head === props.head));
const targetWatches = computed(() =>
    watches.value.filter(w => w.owner === props.owner && w.repo === props.repo));

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
const totalFindings = computed(() => revRuns.value.reduce((sum, r) => sum + r.findingsCount, 0));

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

// ── the loop band's inputs ──────────────────────────────
const campaignJob = computed(() =>
    targetJobs.value.filter(j => j.kind === 'campaign')
        .reduce<JobSummary | undefined>((latest, j) => latest === undefined || j.id > latest.id ? j : latest, undefined));
const hasActiveJob = computed(() => targetJobs.value.some(j => j.state === 'queued' || j.state === 'running'));

const rounds = computed(() =>
    (consolidation.value?.runIds ?? []).map(id => ({
        runId: id,
        novel: (consolidation.value?.clusters ?? []).filter(c => c.members.every(m => m.runId === id)).length,
    })));
const reviewCostUsd = computed(() => revRuns.value.reduce((sum, r) => sum + r.costUsd, 0));
const verifyCostUsd = computed(() =>
    (consolidation.value?.clusters ?? []).reduce(
        (sum, c) => sum + c.verifications.reduce((s, v) => s + (v.source === 'agent' ? v.costUsd : 0), 0), 0));

// ── actions (same shape as mission control) ─────────────
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

// Cancel first: if the review started running in the race window, the 409
// stops the promotion before a duplicate campaign is enqueued.
const promote = (job: JobSummary): Promise<void> => act(async () =>
{
    await api.cancelJob(job.id);
    await api.enqueueJob({ kind: 'campaign', owner: job.owner, repo: job.repo, head: job.head, base: job.base });
});

const resumeCampaign = (): Promise<void> => act(() =>
    api.enqueueJob({ kind: 'campaign', owner: props.owner, repo: props.repo, head: props.head, base: base.value! }));

// A stamp appends to the one thing the forever-cache assumed immutable — the
// rev's verification history — so the cached detail is invalidated and
// refetched in place. Same-id refetch: the selection survives.
const stamp = (verdict: 'confirmed' | 'refuted', rationale: string): Promise<void> => act(async () =>
{
    const cluster = selectedCluster.value;
    const revId = selectedRevId.value;
    if (cluster === undefined || revId === undefined)
    {
        return;
    }
    await api.stampVerdict(cluster.id, { verdict, rationale });
    detailCache.delete(revId);
    const fetched = await api.getConsolidation(revId);
    detailCache.set(revId, fetched);
    detail.value = fetched;
});
</script>

<template>
    <div class="bp">
        <div class="caption">
            <h1>Branch Review Pipeline</h1>
            <div class="subrow">
                <span class="sub caps">{{ props.owner }}/{{ props.repo }} — {{ props.head }} → {{ base ?? '?' }}</span>
                <label class="revlabel caps" for="revpick">rev</label>
                <select id="revpick" v-model="revModel" class="revpick" :disabled="consolidations.length === 0">
                    <option v-if="consolidations.length === 0" :value="undefined">none yet</option>
                    <option v-for="c in consolidations" :key="c.id" :value="c.id">
                        Nº {{ c.id }} · {{ c.runIds.length }} runs · {{ c.clusterCount }} clusters{{ c.id === latestId ? ' · latest' : '' }}
                    </option>
                </select>
                <RouterLink class="back mono" to="/">← mission control</RouterLink>
            </div>
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
                <BlueprintIntake :watches="targetWatches" :jobs="targetJobs" @cancel="cancel" @promote="promote" />

                <div class="connector">
                    <div class="arrow"></div>
                    <span class="n">labeled PR<br>head SHA</span>
                </div>

                <div class="stage">
                    <div class="stage-head">
                        <span class="no">01</span><span class="name">Review</span>
                        <span class="desc caps">{{ consolidation ? `${runCount} runs` : `${runs.length} runs` }}</span>
                    </div>
                    <div class="stage-body">
                        <div v-for="run in (consolidation ? revRuns : runs)" :key="run.id" class="run">
                            <span class="id">#{{ run.id }}</span>
                            <span class="m">{{ run.turns }} turns · {{ usd(run.costUsd) }}</span>
                            <span class="f">{{ run.status === 'aborted' ? 'aborted' : `${run.findingsCount} findings` }}</span>
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
                        <span class="desc caps">{{ orderedClusters.length }} clusters · click for detail</span>
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
                                no consolidation yet — run #{{ sampleRunId }}'s findings shown raw: claims, not facts
                            </div>
                            <div v-else class="vnote">no consolidation yet — no submitted run to sample</div>
                        </template>
                    </div>
                </div>

                <div class="connector">
                    <div class="arrow"></div>
                    <span class="n">{{ seenOnce.length }} seen once</span>
                </div>

                <div class="stage">
                    <div class="stage-head">
                        <span class="no">03</span><span class="name">Verify</span>
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
                            <!-- mirrors coverageOf: the bias-corrected form is the one that stays defined at f₂ = 0 -->
                            <div class="margincalc">
                                f₁ = {{ coverage.f1 }}, f₂ = {{ coverage.f2 }}<br>
                                <template v-if="coverage.f2 > 0">f₁² / 2f₂ = {{ coverage.f1 * coverage.f1 }}/{{ 2 * coverage.f2 }}</template>
                                <template v-else>f₁(f₁−1) / 2 = {{ coverage.f1 * (coverage.f1 - 1) }}/2</template>
                                <span class="c">{{ ' ' }}≈ {{ coverage.undiscovered }} unseen</span><br>
                                <span class="c">capture–recapture</span>
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

        <BlueprintCallout v-if="calloutSubject" :subject="calloutSubject" :run-count="runCount" @stamp="stamp" />

        <div class="titleblockwrap">
            <div class="titleblock">
                <div class="cell"><span class="k">Project</span><span class="v">{{ props.owner }}/{{ props.repo }}</span></div>
                <div class="cell"><span class="k">Target</span><span class="v">{{ props.head }} → {{ base ?? '?' }}</span></div>
                <div class="cell"><span class="k">Rev</span><span class="v">{{ consolidation ? `consolidation ${consolidation.id}` : '—' }}</span></div>
                <div class="cell"><span class="k">Runs</span><span class="v">{{ runCount }}</span></div>
                <div class="cell"><span class="k">Date</span><span class="v">{{ consolidation ? consolidation.createdAt.slice(0, 10) : '—' }}</span></div>
                <div class="cell"><span class="k">Sheet</span><span class="v">1 / 1</span></div>
            </div>
        </div>
    </div>
</template>

<!-- Shared blueprint primitives: unscoped on purpose (all under .bp) so the
     child components can use .bp-btn/.caps/.mono without redefining them. -->
<style>
.bp
{
    color-scheme: dark;
    --sheet:  #123058;
    --sheet-2:#0e2949;
    --grid-1: rgba(220, 232, 248, 0.055);
    --grid-2: rgba(220, 232, 248, 0.11);
    --ink:    #dbe7f5;
    --bright: #ffffff;
    --muted:  #8fa8c8;
    --faint:  #5b779e;
    --chalk:  #f2d479;
    --stamp-ok:  #b7e4c7;
    --stamp-no:  #ffa3a3;
    --stamp-und: #f2d479;
    --rule: rgba(219, 231, 245, 0.75);
    --rule-soft: rgba(219, 231, 245, 0.35);
}

.bp .mono { font-family: ui-monospace, Menlo, Consolas, monospace; }
.bp .caps { text-transform: uppercase; letter-spacing: 0.16em; }
.bp button { font: inherit; cursor: pointer; }
.bp button:disabled { cursor: not-allowed; opacity: 0.45; }
.bp :focus-visible { outline: 2px solid var(--chalk); outline-offset: 1px; }

.bp .bp-btn
{
    background: transparent;
    border: 1px solid var(--rule);
    color: var(--bright);
    font-family: ui-monospace, Menlo, Consolas, monospace;
    font-size: 0.7rem;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    padding: 0.28rem 0.7rem;
}
.bp .bp-btn:hover:not(:disabled) { background: var(--bright); color: var(--sheet); }
.bp .bp-btn.chalk { border-color: var(--chalk); color: var(--chalk); }
.bp .bp-btn.chalk:hover:not(:disabled) { background: var(--chalk); color: var(--sheet); }
.bp .bp-btn.ok { border-color: var(--stamp-ok); color: var(--stamp-ok); }
.bp .bp-btn.ok:hover:not(:disabled) { background: var(--stamp-ok); color: var(--sheet); }
.bp .bp-btn.no { border-color: var(--stamp-no); color: var(--stamp-no); }
.bp .bp-btn.no:hover:not(:disabled) { background: var(--stamp-no); color: var(--sheet); }
.bp .bp-btn.mini { padding: 0.05rem 0.4rem; font-size: 0.62rem; }
</style>

<style scoped>
.bp
{
    min-height: 100vh;
    color: var(--ink);
    background:
        repeating-linear-gradient(0deg,   transparent 0 23px, var(--grid-1) 23px 24px),
        repeating-linear-gradient(90deg,  transparent 0 23px, var(--grid-1) 23px 24px),
        repeating-linear-gradient(0deg,   transparent 0 119px, var(--grid-2) 119px 120px),
        repeating-linear-gradient(90deg,  transparent 0 119px, var(--grid-2) 119px 120px),
        var(--sheet);
    font-family: 'Avenir Next', Avenir, 'Segoe UI', system-ui, sans-serif;
    line-height: 1.5;
    padding: 1.5rem 1.5rem 2rem;
}

/* ── caption + rev picker ───────────────────────────── */
.caption { margin-bottom: 1.2rem; }

.caption h1
{
    margin: 0;
    font-size: 1rem;
    font-weight: 600;
    color: var(--bright);
    text-transform: uppercase;
    letter-spacing: 0.22em;
}

.subrow
{
    display: flex;
    align-items: baseline;
    gap: 0.8rem;
    flex-wrap: wrap;
}

.sub { color: var(--muted); font-size: 0.85rem; letter-spacing: 0.08em; }

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

.back
{
    margin-left: auto;
    color: var(--chalk);
    font-size: 0.75rem;
    text-decoration: none;
    border-bottom: 1px dotted var(--chalk);
}

.msg { margin: 0 0 0.8rem; font-size: 0.85rem; }
.offline { color: var(--stamp-no); }
.action-error { color: var(--stamp-no); }

/* ── the flow ───────────────────────────────────────── */
.flowwrap { overflow-x: auto; padding-bottom: 0.5rem; }

.flow
{
    display: flex;
    align-items: stretch;
    gap: 0;
    min-width: 1180px;
}

.stage
{
    border: 1px solid var(--rule);
    background: rgba(14, 41, 73, 0.55);
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
}

.coverage-stage { max-width: 280px; }

.stage-head
{
    display: flex;
    align-items: baseline;
    gap: 0.6rem;
    border-bottom: 1px solid var(--rule);
    padding: 0.5rem 0.8rem;
}

.stage-head .no
{
    font-family: ui-monospace, Menlo, Consolas, monospace;
    color: var(--chalk);
    font-size: 0.85rem;
}

.stage-head .name
{
    color: var(--bright);
    font-weight: 600;
    font-size: 0.85rem;
    text-transform: uppercase;
    letter-spacing: 0.18em;
}

.stage-head .desc
{
    margin-left: auto;
    color: var(--faint);
    font-size: 0.75rem;
    letter-spacing: 0.06em;
}

.stage-body
{
    padding: 0.7rem 0.8rem 0.9rem;
    flex: 1;
}

.connector
{
    flex: none;
    width: 84px;
    align-self: stretch;
    display: flex;
    flex-direction: column;
    justify-content: center;
    align-items: center;
    gap: 0.3rem;
    padding: 0 4px;
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
.run .id { color: var(--bright); font-family: ui-monospace, Menlo, Consolas, monospace; }
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

/* title block */
.titleblockwrap
{
    display: flex;
    justify-content: flex-end;
    margin-top: 1.4rem;
}

.titleblock
{
    border: 1px solid var(--rule);
    display: grid;
    grid-template-columns: auto auto auto;
    background: rgba(14, 41, 73, 0.7);
    font-size: 0.75rem;
}

.titleblock .cell
{
    border: 1px solid var(--rule-soft);
    padding: 0.35rem 0.9rem 0.4rem;
}

.titleblock .k
{
    display: block;
    color: var(--faint);
    font-size: 0.62rem;
    text-transform: uppercase;
    letter-spacing: 0.18em;
}

.titleblock .v
{
    color: var(--bright);
    font-family: ui-monospace, Menlo, Consolas, monospace;
}
</style>
