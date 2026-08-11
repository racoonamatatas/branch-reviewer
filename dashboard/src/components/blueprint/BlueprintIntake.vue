<script setup lang="ts">
// The rail to the left of stage 01: what feeds this target — its watches
// (matched on owner/repo, any label) and its jobs. Actions mirror mission
// control: cancel a queued job, promote a queued review to a campaign.
import type { JobSummary } from '@server/server/jobs';
import type { Watch } from '@server/server/trigger';
import type { JobId } from '@server/types/ids';
import { age } from '../../format';

defineProps<{ watches: Watch[]; jobs: JobSummary[] }>();

const emit = defineEmits<{
    cancel: [id: JobId];
    promote: [job: JobSummary];
    release: [id: JobId];
}>();

const GLYPH: Record<JobSummary['state'], string> = {
    held: '◌',
    running: '▶',
    queued: '●',
    succeeded: '✓',
    aborted: '◼',
    failed: '✕',
    cancelled: '⊘',
};
</script>

<template>
    <div class="intake">
        <span class="caps">Intake</span>
        <div v-for="watch in watches" :key="watch.id" class="item">
            <div class="mono">watch #{{ watch.id }}</div>
            <div class="m">{{ watch.owner }}/{{ watch.repo }} · {{ watch.label }}</div>
        </div>
        <div v-if="watches.length === 0" class="item m">no watch on this repo</div>
        <div class="divider"></div>
        <span class="caps">Jobs</span>
        <div v-for="job in jobs" :key="job.id" class="item">
            <div class="mono">#{{ job.id }} {{ GLYPH[job.state] }} {{ job.state }} · {{ job.kind }}</div>
            <div class="m">{{ age(job.createdAt) }} · {{ job.runCount }} runs</div>
            <div v-if="job.state === 'held' || job.state === 'queued'" class="actions">
                <button v-if="job.state === 'held'" class="bp-btn mini chalk" @click="emit('release', job.id)">▶ start</button>
                <button v-if="job.kind === 'review'" class="bp-btn mini" @click="emit('promote', job)">↺ promote to campaign</button>
                <button class="bp-btn mini" @click="emit('cancel', job.id)">cancel</button>
            </div>
        </div>
        <div v-if="jobs.length === 0" class="item m">no jobs for this target</div>
    </div>
</template>

<style scoped>
.intake
{
    flex: none;
    width: 210px;
    border: 1px dashed var(--rule-soft);
    padding: 0.7rem 0.8rem;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
}

.caps
{
    font-size: 0.7rem;
    color: var(--faint);
}

.item
{
    font-size: 0.8rem;
}

.item .mono
{
    color: var(--bright);
    font-size: 0.78rem;
}

.item .m, .item.m
{
    color: var(--muted);
    font-size: 0.75rem;
}

.divider
{
    border-top: 1px dashed var(--rule-soft);
    margin: 0.2rem 0;
}

.actions
{
    display: flex;
    gap: 0.35rem;
    margin-top: 0.2rem;
    flex-wrap: wrap;
}
</style>
