<script setup lang="ts">
// The campaign loop drawn above stages 01↔02. Round novelty is derived from
// the displayed partition — clusters whose members all come from one run —
// because per-round outcomes are not persisted; measuring inside one
// partition is also the honest retrospective (comparing partitions would
// measure the judge, not the branch). The stamp is the campaign job's state:
// stoppedBy (dry vs max-runs) is not stored either.
import { computed } from 'vue';
import type { JobSummary } from '@server/server/jobs';
import { usd } from '../../format';

const props = defineProps<{
    campaign?: JobSummary;
    rounds: Array<{ runId: number; novel: number }>;
    reviewCostUsd: number;
    verifyCostUsd: number;
}>();

const STAMP_CLASS: Record<JobSummary['state'], string> = {
    succeeded: 'ok',
    running: 'und',
    queued: 'und',
    aborted: 'no',
    failed: 'no',
    cancelled: 'pend',
};

const stampClass = computed(() => props.campaign === undefined ? undefined : STAMP_CLASS[props.campaign.state]);
</script>

<template>
    <div class="loopband">
        <span class="glyph">↺</span>
        <div class="what">
            <div v-if="campaign" class="name">Campaign #{{ campaign.id }} — stages 01↔02 repeat until dry</div>
            <div v-else class="name">Ad-hoc runs — no campaign yet</div>
            <div class="m caps">sole-source clusters per run · in this rev</div>
        </div>
        <div class="rounds">
            <div v-for="(round, i) in rounds" :key="round.runId" class="round" :class="{ barren: round.novel === 0 }" :title="`run ${round.runId}`">
                <span class="r">r{{ i + 1 }}</span><span class="v">{{ round.novel }}</span>
            </div>
        </div>
        <span v-if="campaign" class="statestamp" :class="stampClass">{{ campaign.state.toUpperCase() }}</span>
        <span class="cost">reviews {{ usd(reviewCostUsd) }} · verification {{ usd(verifyCostUsd) }}</span>
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

.cost
{
    margin-left: auto;
    color: var(--muted);
    font-size: 0.75rem;
    font-family: ui-monospace, Menlo, Consolas, monospace;
}
</style>
