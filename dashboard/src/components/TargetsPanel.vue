<script setup lang="ts">
import { computed } from 'vue';
import type { CampaignSummary, TargetSummary } from '@server/store/store';
import { age, usd } from '../format';

const props = defineProps<{
    targets: TargetSummary[];
    // Live campaign records (running or verifying) for the whole store — the
    // rows here are runs-derived, and a CLI campaign's first round takes
    // minutes, so a campaign is the earlier (sometimes the only) sign of life.
    liveCampaigns: CampaignSummary[];
    selected?: { owner: string; repo: string; head: string };
}>();

interface Triple
{
    owner: string;
    repo: string;
    head: string;
}

function tripleKey(target: Triple): string
{
    return `${target.owner}/${target.repo}/${target.head}`;
}

// Newest campaign per triple (the list arrives newest-first): the marker
// shows one status, and two concurrent loops on one triple must not render
// duplicate rows on the very screen meant to make concurrent spend obvious.
const liveByTriple = computed(() =>
{
    const byTriple = new Map<string, CampaignSummary>();
    for (const campaign of props.liveCampaigns)
    {
        const key = tripleKey(campaign);
        if (!byTriple.has(key))
        {
            byTriple.set(key, campaign);
        }
    }
    return byTriple;
});

function liveCampaignFor(target: Triple): CampaignSummary | undefined
{
    return liveByTriple.value.get(tripleKey(target));
}

// A live campaign on a target with no stored runs yet (round 1 still in
// flight) has no runs-derived row to mark — it gets a synthetic one: the
// moment something starts billing is the moment it must be findable here.
const campaignOnlyTargets = computed(() =>
{
    const known = new Set(props.targets.map(tripleKey));
    return [...liveByTriple.value.values()].filter(campaign => !known.has(tripleKey(campaign)));
});

function isSelected(target: Triple): boolean
{
    return props.selected !== undefined && tripleKey(target) === tripleKey(props.selected);
}

function targetRoute(target: Triple): string
{
    return `/target/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}/${target.head}`;
}
</script>

<template>
    <section class="stage">
        <div class="stage-head">
            <span class="name">Targets</span>
            <span class="desc caps">{{ targets.length }} reviewed</span>
        </div>
        <div class="stage-body">
            <div
                v-for="target in targets"
                :key="`${target.owner}/${target.repo}/${target.head}/${target.base}`"
                class="target"
                :aria-current="isSelected(target)"
            >
                <RouterLink :to="targetRoute(target)" class="name">
                    {{ target.owner }}/{{ target.repo }} · {{ target.head }} → {{ target.base }}
                </RouterLink>
                <div class="meta">
                    <span v-if="liveCampaignFor(target)" class="live"><span class="pulse">●</span> campaign {{ liveCampaignFor(target)!.status }} · </span>
                    {{ target.runCount }} run(s) · last {{ age(target.lastRunAt) }} · {{ usd(target.totalCostUsd) }}
                    <span v-if="target.latestConsolidationId === undefined" class="none">· no consolidation yet</span>
                </div>
            </div>
            <div
                v-for="campaign in campaignOnlyTargets"
                :key="`campaign-${campaign.id}`"
                class="target"
                :aria-current="isSelected(campaign)"
            >
                <RouterLink :to="targetRoute(campaign)" class="name">
                    {{ campaign.owner }}/{{ campaign.repo }} · {{ campaign.head }} → {{ campaign.base }}
                </RouterLink>
                <div class="meta">
                    <span class="live"><span class="pulse">●</span> campaign #{{ campaign.id }} {{ campaign.status }}</span>
                    <span class="none">· no runs stored yet — round 1 in flight</span>
                </div>
            </div>
            <p v-if="targets.length === 0 && campaignOnlyTargets.length === 0" class="empty">no runs stored yet</p>
        </div>
    </section>
</template>

<style scoped>
/* When the parent gives this panel a bounded height (mission control pins
   the side column to the queue column's height), the list scrolls inside
   it instead of growing the page — the header stays put. Unconstrained
   parents are unaffected: the body just takes its natural height. */
.stage
{
    display: flex;
    flex-direction: column;
    min-height: 0;
}

.stage .stage-body
{
    overflow-y: auto;
    min-height: 0;
}

.target
{
    padding: 0.35rem 0 0.35rem 0.4rem;
    /* Reserved transparent edge so selection doesn't shift the rows. */
    border-left: 2px solid transparent;
    border-bottom: 1px dashed var(--rule-soft);
    font-size: 0.85rem;
}

.target[aria-current='true']
{
    border-left-color: var(--chalk);
    background: rgba(242, 212, 121, 0.08);
}

.target:last-of-type
{
    border-bottom: none;
}

.name
{
    color: var(--ink);
    text-decoration: none;
    border-bottom: 1px dotted var(--faint);
}

.name:hover
{
    color: var(--chalk);
    border-bottom-color: var(--chalk);
}

.meta
{
    color: var(--muted);
    font-size: 0.78rem;
    font-variant-numeric: tabular-nums;
}

.live
{
    color: var(--chalk);
}

.live .pulse
{
    font-size: 0.65rem;
    animation: tp-pulse 1.2s ease-in-out infinite;
}

@keyframes tp-pulse
{
    0%, 100% { opacity: 1; }
    50% { opacity: 0.15; }
}

.none
{
    color: var(--faint);
}

.empty
{
    color: var(--faint);
    font-size: 0.8rem;
    margin: 0.4rem 0;
}
</style>
