<script setup lang="ts">
// The campaign loop drawn above stages 01↔02. With a stored campaign the
// band shows the record: rounds as the loop saw them when it decided to
// stop (a later judge call can merge away a round's novel cluster, so
// re-deriving would answer a different question), and the stamp is the
// campaign's own status — stoppedBy included, which no job state carries.
// Without one — ad-hoc CLI runs from before campaigns were persisted, or a
// campaign job still held — novelty is derived from the displayed partition
// (clusters whose members all come from one run; measuring inside one
// partition is the honest retrospective) and the stamp falls back to the
// campaign job, whose held state is real information the record cannot
// have yet.
import { computed } from 'vue';
import { novelClusters } from '@server/coverage/coverage';
import type { JobSummary } from '@server/server/jobs';
import type { Campaign, CampaignRound, StoppedBy } from '@server/store/store';
import type { RunId } from '@server/types/ids';
import { usd } from '../../format';

const props = defineProps<{
    campaign?: Campaign;
    job?: JobSummary;
    // The campaign data could not be refreshed for several cycles — the
    // record shown may be behind the store.
    stale?: boolean;
    // The displayed rev's inputs for the derived fallback.
    revRunIds: RunId[];
    revClusters: Array<{ members: Array<{ runId: RunId }> }>;
    reviewCostUsd: number;
    verifyCostUsd: number;
}>();

const STAMP_CLASS: Record<JobSummary['state'], string> = {
    held: 'pend',
    succeeded: 'ok',
    running: 'und',
    queued: 'und',
    aborted: 'no',
    failed: 'no',
    cancelled: 'pend',
};

// Dry, cap, and empty compare are completions of the sampling plan; the
// two-strike stops are the loop's own abort paths — same split the worker
// applies to campaign jobs.
const STOP_CLASS: Record<StoppedBy, string> = {
    'dry': 'ok',
    'max-runs': 'ok',
    'empty-diff': 'ok',
    'no-usable-runs': 'no',
    'no-consolidation': 'no',
};

const JOB_LIVE = new Set<JobSummary['state']>(['held', 'queued', 'running']);

const stamp = computed(() =>
{
    const campaign = props.campaign;
    const job = props.job;
    // A live job outranks a terminal record: a held/queued campaign job on
    // a target whose previous campaign finished is the NEXT loop's state,
    // and stamping last time's DRY over it would hide the pending decision.
    const jobLive = job !== undefined && JOB_LIVE.has(job.state);
    const campaignLive = campaign !== undefined && (campaign.status === 'running' || campaign.status === 'verifying');
    if (campaign !== undefined && (campaignLive || !jobLive))
    {
        switch (campaign.status)
        {
            case 'running':
                return { text: 'RUNNING', cls: 'und', title: `campaign #${campaign.id}, started ${campaign.createdAt}` };
            case 'verifying':
                return { text: 'VERIFYING', cls: 'und', title: `loop stopped (${campaign.stoppedBy}) — adversarial verification still billing` };
            case 'failed':
                return { text: 'FAILED', cls: 'no', title: campaign.error };
            case 'finished':
                return { text: campaign.stoppedBy.toUpperCase(), cls: STOP_CLASS[campaign.stoppedBy], title: `finished ${campaign.finishedAt}` };
        }
    }
    return job === undefined
        ? undefined
        : { text: job.state.toUpperCase(), cls: STAMP_CLASS[job.state], title: `campaign job #${job.id}` };
});

// An unusable round has no novelty to show — it cost a slot, and the × says
// so without pretending "0 new findings" was measured.
function unusable(round: CampaignRound): boolean
{
    return round.aborted !== undefined || round.failed !== undefined;
}

function roundValue(round: CampaignRound): string
{
    return unusable(round) ? '×' : String(round.novelClusters);
}

// Barren and unusable are different facts and style differently: barren is
// what the patience rule counts, unusable deliberately is not — and the
// classes branch on the data, never on the rendered string, so a formatting
// change can't silently detach the styling.
function roundClass(round: CampaignRound): Record<string, boolean>
{
    return {
        unusable: unusable(round),
        barren: !unusable(round) && round.novelClusters === 0,
    };
}

function roundTitle(round: CampaignRound): string
{
    if (round.failed !== undefined)
    {
        return `round ${round.round} failed: ${round.failed}`;
    }
    if (round.aborted !== undefined)
    {
        return `run ${round.runId} aborted: ${round.aborted}`;
    }
    if (round.consolidationFailed !== undefined)
    {
        return `run ${round.runId} — judge call failed, no consolidation this round`;
    }
    return `run ${round.runId}`;
}

const derivedRounds = computed(() =>
    props.revRunIds.map(id => ({ runId: id, novel: novelClusters(props.revClusters, id) })));

// A stored campaign's review spend is its own rounds' sum — baseline runs
// predate it. The fallback keeps the rev-wide figure, which is all it has.
const reviewsCost = computed(() =>
    props.campaign !== undefined
        ? props.campaign.rounds.reduce((sum, r) => sum + r.costUsd, 0)
        : props.reviewCostUsd);
</script>

<template>
    <div class="loopband">
        <span class="glyph">↺</span>
        <div class="what">
            <div v-if="campaign" class="name">Campaign #{{ campaign.id }} — stages 01↔02 repeat until dry</div>
            <div v-else class="name">Ad-hoc runs — no campaign yet</div>
            <!-- "latest campaign": the band's subject is the newest record,
                 which is not necessarily the one behind the pinned rev. -->
            <div class="m caps">{{ campaign ? 'latest campaign · novel clusters per round · as the loop saw them' : 'sole-source clusters per run · in this rev' }}</div>
        </div>
        <div class="rounds">
            <template v-if="campaign">
                <div
                    v-for="round in campaign.rounds"
                    :key="round.round"
                    class="round"
                    :class="roundClass(round)"
                    :title="roundTitle(round)"
                >
                    <span class="r">r{{ round.round }}</span><span class="v">{{ roundValue(round) }}</span>
                </div>
                <!-- "in flight" is a running-only claim: a failed campaign's
                     structural death (baseline judge throw) also yields zero
                     rounds, and the stamp beside it says FAILED. -->
                <div v-if="campaign.rounds.length === 0" class="none caps">
                    {{ campaign.status === 'running' ? 'no rounds yet — round 1 in flight' : 'no rounds recorded' }}
                </div>
            </template>
            <template v-else>
                <div v-for="(round, i) in derivedRounds" :key="round.runId" class="round" :class="{ barren: round.novel === 0 }" :title="`run ${round.runId}`">
                    <span class="r">r{{ i + 1 }}</span><span class="v">{{ round.novel }}</span>
                </div>
            </template>
        </div>
        <span v-if="stamp" class="statestamp" :class="stamp.cls" :title="stamp.title">{{ stamp.text }}</span>
        <!-- Persistent campaign-read failures must not freeze this band
             silently — it is the panel whose job is making live spend
             visible. Quiet on purpose: the sheet stays usable. -->
        <span v-if="stale" class="stale caps" title="the campaign record could not be refreshed for several poll cycles — what is shown may be behind the store">campaign data stale</span>
        <!-- The two figures have different scopes when a campaign shows:
             reviews are the campaign's own rounds, verification bills to the
             displayed rev's clusters — the labels say so instead of letting
             one line imply one population. -->
        <span v-if="campaign" class="cost">campaign reviews {{ usd(reviewsCost) }} · rev verification {{ usd(verifyCostUsd) }}</span>
        <span v-else class="cost">reviews {{ usd(reviewsCost) }} · verification {{ usd(verifyCostUsd) }}</span>
    </div>
</template>

<style scoped>
.loopband
{
    border: 1px dashed var(--rule);
    background: rgba(14, 41, 73, 0.55);
    margin-bottom: 1rem;
    padding: 0.6rem 0.9rem 0.7rem;
    display: flex;
    align-items: center;
    gap: 1.1rem;
    flex-wrap: wrap;
}

.glyph
{
    font-size: 1.3rem;
    color: var(--chalk);
    flex: none;
}

.what
{
    flex: none;
}

.what .name
{
    color: var(--bright);
    font-weight: 600;
    font-size: 0.8rem;
    text-transform: uppercase;
    letter-spacing: 0.18em;
}

.what .m
{
    color: var(--faint);
    font-size: 0.72rem;
    letter-spacing: 0.06em;
}

.rounds
{
    display: flex;
    gap: 0.4rem;
    align-items: center;
    flex-wrap: wrap;
}

.none
{
    color: var(--faint);
    font-size: 0.72rem;
    letter-spacing: 0.1em;
}

.round
{
    border: 1px solid var(--rule-soft);
    padding: 0.15rem 0.5rem 0.25rem;
    text-align: center;
    min-width: 3.2em;
}

.round .r
{
    display: block;
    color: var(--faint);
    font-size: 0.62rem;
    text-transform: uppercase;
    letter-spacing: 0.12em;
}

.round .v
{
    font-family: ui-monospace, Menlo, Consolas, monospace;
    color: var(--bright);
    font-size: 0.9rem;
}

.round.barren
{
    border-style: dashed;
}

.round.barren .v
{
    color: var(--faint);
}

/* Unusable ≠ barren: this round measured nothing (aborted or failed), and
   the patience rule deliberately ignores it. */
.round.unusable
{
    border-style: dotted;
}

.round.unusable .v
{
    color: var(--stamp-und);
}

.statestamp
{
    font-family: ui-monospace, Menlo, Consolas, monospace;
    font-size: 0.7rem;
    letter-spacing: 0.14em;
    border: 2px solid currentColor;
    padding: 0.15rem 0.5rem;
    transform: rotate(-3deg);
    flex: none;
}

.statestamp.ok   { color: var(--stamp-ok); }
.statestamp.no   { color: var(--stamp-no); }
.statestamp.und  { color: var(--stamp-und); border-style: dashed; }
.statestamp.pend { color: var(--faint); border: 1px dashed var(--faint); transform: none; }

.stale
{
    color: var(--stamp-und);
    font-size: 0.7rem;
    letter-spacing: 0.12em;
    border-bottom: 1px dashed var(--stamp-und);
}

.cost
{
    margin-left: auto;
    color: var(--muted);
    font-size: 0.75rem;
    font-family: ui-monospace, Menlo, Consolas, monospace;
}
</style>
