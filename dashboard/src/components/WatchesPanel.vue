<script setup lang="ts">
import { ref } from 'vue';
import type { Watch } from '@server/server/trigger';
import type { WatchId } from '@server/types/ids';
import type { NewWatchRequest } from '../api/client';

defineProps<{ watches: Watch[] }>();

const emit = defineEmits<{
    add: [watch: NewWatchRequest];
    remove: [id: WatchId];
}>();

const owner = ref('');
const repo = ref('');
const label = ref('');

function submit(): void
{
    if (owner.value === '' || repo.value === '')
    {
        return;
    }
    emit('add', {
        owner: owner.value,
        repo: repo.value,
        // Omitted label lets the server apply its default trigger label.
        ...(label.value !== '' ? { label: label.value } : {}),
    });
    owner.value = '';
    repo.value = '';
    label.value = '';
}
</script>

<template>
    <section class="stage">
        <div class="stage-head">
            <span class="name">Watches</span>
            <span class="desc caps">{{ watches.length }} polled</span>
        </div>
        <div class="stage-body">
            <div v-for="watch in watches" :key="watch.id" class="watch">
                <div class="repo">
                    {{ watch.owner }}/{{ watch.repo }}
                    <button class="remove" title="stop watching" @click="emit('remove', watch.id)">✕</button>
                </div>
                <div class="meta">label <span class="label mono">{{ watch.label }}</span></div>
            </div>
            <p v-if="watches.length === 0" class="empty">no watches — nothing is polled</p>
            <form @submit.prevent="submit">
                <input v-model.trim="owner" placeholder="owner" required>
                <input v-model.trim="repo" placeholder="repo" required>
                <input v-model.trim="label" placeholder="label (agent-review)">
                <button type="submit" class="bp-btn chalk">+ watch</button>
            </form>
        </div>
    </section>
</template>

<style scoped>
.watch
{
    padding: 0.35rem 0;
    border-bottom: 1px dashed var(--rule-soft);
    font-size: 0.85rem;
}

.repo
{
    color: var(--ink);
    display: flex;
    justify-content: space-between;
    gap: 0.5rem;
}

.meta
{
    color: var(--muted);
    font-size: 0.78rem;
}

.label
{
    color: var(--chalk);
    font-size: 0.78rem;
}

.remove
{
    background: none;
    border: none;
    color: var(--faint);
    font: inherit;
}

.remove:hover
{
    color: var(--stamp-no);
}

.empty
{
    color: var(--faint);
    font-size: 0.8rem;
    margin: 0.4rem 0;
}

form
{
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem;
    margin-top: 0.7rem;
}

input
{
    width: 8.5em;
    min-width: 0;
}
</style>
