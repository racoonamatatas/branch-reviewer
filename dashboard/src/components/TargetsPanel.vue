<script setup lang="ts">
import type { TargetSummary } from '@server/store/store';
import { age, usd } from '../format';

const props = defineProps<{
    targets: TargetSummary[];
    selected?: { owner: string; repo: string; head: string };
}>();

function isSelected(target: TargetSummary): boolean
{
    return props.selected !== undefined
        && target.owner === props.selected.owner
        && target.repo === props.selected.repo
        && target.head === props.selected.head;
}

function targetRoute(target: TargetSummary): string
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
                    {{ target.runCount }} run(s) · last {{ age(target.lastRunAt) }} · {{ usd(target.totalCostUsd) }}
                    <span v-if="target.latestConsolidationId === undefined" class="none">· no consolidation yet</span>
                </div>
            </div>
            <p v-if="targets.length === 0" class="empty">no runs stored yet</p>
        </div>
    </section>
</template>

<style scoped>
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
