<script setup lang="ts">
// Scaffold stub: proves the plumbing (proxy → API → schema parse → render).
// Chunk 3 replaces the markup with the real mission-control screen.
import { onMounted, ref } from 'vue';
import type { JobSummary } from '@server/server/jobs';
import type { Watch } from '@server/server/trigger';
import { api, ApiError } from '../api/client';

const jobs = ref<JobSummary[]>([]);
const watches = ref<Watch[]>([]);
const error = ref<string>();

onMounted(async () =>
{
    try
    {
        [jobs.value, watches.value] = await Promise.all([api.listJobs(), api.listWatches()]);
    }
    catch (e)
    {
        error.value = e instanceof ApiError ? `${e.status}: ${e.message}` : String(e);
    }
});
</script>

<template>
    <main>
        <h1>mission control</h1>
        <p v-if="error" class="error">{{ error }} — is the job server running on :4780?</p>
        <template v-else>
            <h2>queue · {{ jobs.length }}</h2>
            <ul>
                <li v-for="job in jobs" :key="job.id">
                    #{{ job.id }} {{ job.kind }} · {{ job.target }} · {{ job.state }} · {{ job.runCount }} run(s)
                </li>
            </ul>
            <h2>watches · {{ watches.length }}</h2>
            <ul>
                <li v-for="watch in watches" :key="watch.id">
                    {{ watch.owner }}/{{ watch.repo }} · label {{ watch.label }}
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
