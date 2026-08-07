<script setup lang="ts">
import type { TargetSummary } from '@server/store/store';
import { age, usd } from '../format';

defineProps<{ targets: TargetSummary[] }>();

function targetRoute(target: TargetSummary): string
{
    return `/target/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}/${target.head}`;
}
</script>

<template>
    <section>
        <h2>TARGETS <span class="count">· {{ targets.length }}</span></h2>
        <div v-for="target in targets" :key="`${target.owner}/${target.repo}/${target.head}/${target.base}`" class="target">
            <RouterLink :to="targetRoute(target)" class="name">
                {{ target.owner }}/{{ target.repo }} · {{ target.head }} → {{ target.base }}
            </RouterLink>
            <div class="meta">
                {{ target.runCount }} run(s) · last {{ age(target.lastRunAt) }} · {{ usd(target.totalCostUsd) }}
                <span v-if="target.latestConsolidationId === undefined" class="none">· no consolidation yet</span>
            </div>
        </div>
        <p v-if="targets.length === 0" class="empty">no runs stored yet</p>
    </section>
</template>

<style scoped>
.target
{
    padding: 0.35rem 0;
    border-bottom: 1px solid var(--mc-line);
}

.target:last-of-type
{
    border-bottom: none;
}

.name
{
    color: var(--mc-ink);
    text-decoration: none;
    border-bottom: 1px dotted var(--mc-faint);
}

.name:hover
{
    color: var(--mc-amber);
    border-bottom-color: var(--mc-amber);
}

.meta
{
    color: var(--mc-muted);
    font-size: 0.9em;
    font-variant-numeric: tabular-nums;
}

.none
{
    color: var(--mc-faint);
}

.empty
{
    color: var(--mc-faint);
    margin: 0.4rem 0;
}
</style>
