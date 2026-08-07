<script setup lang="ts">
// Scaffold stub: loads the target's latest consolidation end to end.
// Chunk 4 replaces the markup with the blueprint sheet.
import { onMounted, ref } from 'vue';
import type { Coverage } from '@server/coverage/coverage';
import type { ConsolidationDetail } from '@server/server/server';
import { api, ApiError } from '../api/client';

const props = defineProps<{ owner: string; repo: string; head: string }>();

const consolidation = ref<ConsolidationDetail>();
const coverage = ref<Coverage>();
const error = ref<string>();

onMounted(async () =>
{
    try
    {
        const consolidations = await api.listConsolidations(props);
        const latest = consolidations[0];
        if (latest === undefined)
        {
            error.value = 'No consolidation for this target yet.';
            return;
        }
        const detail = await api.getConsolidation(latest.id);
        consolidation.value = detail.consolidation;
        coverage.value = detail.coverage;
    }
    catch (e)
    {
        error.value = e instanceof ApiError ? `${e.status}: ${e.message}` : String(e);
    }
});
</script>

<template>
    <main>
        <h1>{{ props.owner }}/{{ props.repo }} · {{ props.head }}</h1>
        <p v-if="error" class="error">{{ error }}</p>
        <template v-else-if="consolidation && coverage">
            <p>
                consolidation #{{ consolidation.id }} · {{ consolidation.runIds.length }} runs ·
                {{ consolidation.clusters.length }} clusters ·
                coverage {{ coverage.observed }} of ≈{{ coverage.estimatedTotal }}
            </p>
            <ul>
                <li v-for="cluster in consolidation.clusters" :key="cluster.id">
                    [{{ cluster.severity }}] {{ cluster.representative.title }}
                    · seen in {{ cluster.occurrence }} · {{ cluster.verificationStatus }}
                </li>
            </ul>
        </template>
    </main>
</template>

<style scoped>
main
{
    padding: 2rem;
    font-family: ui-monospace, Menlo, Consolas, monospace;
}

.error
{
    color: #e06060;
}
</style>
