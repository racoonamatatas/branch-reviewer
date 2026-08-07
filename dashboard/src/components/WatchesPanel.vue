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
    <section>
        <h2>WATCHES <span class="count">· {{ watches.length }}</span></h2>
        <div v-for="watch in watches" :key="watch.id" class="watch">
            <div class="repo">
                {{ watch.owner }}/{{ watch.repo }}
                <button class="remove" title="stop watching" @click="emit('remove', watch.id)">✕</button>
            </div>
            <div class="meta">label <span class="label">{{ watch.label }}</span></div>
        </div>
        <p v-if="watches.length === 0" class="empty">no watches — nothing is polled</p>
        <form @submit.prevent="submit">
            <input v-model.trim="owner" placeholder="owner" required>
            <input v-model.trim="repo" placeholder="repo" required>
            <input v-model.trim="label" placeholder="label (agent-review)">
            <button type="submit">+ watch</button>
        </form>
    </section>
</template>

<style scoped>
.watch
{
    padding: 0.35rem 0;
    border-bottom: 1px solid var(--mc-line);
}

.repo
{
    color: var(--mc-ink);
    display: flex;
    justify-content: space-between;
    gap: 0.5rem;
}

.meta
{
    color: var(--mc-muted);
    font-size: 0.9em;
}

.label
{
    color: var(--mc-amber);
}

.remove
{
    background: none;
    border: none;
    color: var(--mc-faint);
    cursor: pointer;
    font: inherit;
}

.remove:hover
{
    color: var(--mc-fail);
}

.empty
{
    color: var(--mc-faint);
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
    background: var(--mc-panel-2);
    border: 1px solid var(--mc-line);
    color: var(--mc-ink);
    font: inherit;
    padding: 0.25rem 0.5rem;
    width: 8.5em;
    min-width: 0;
}

input::placeholder
{
    color: var(--mc-faint);
}

button[type='submit']
{
    background: none;
    border: 1px solid var(--mc-amber);
    color: var(--mc-amber);
    font: inherit;
    padding: 0.25rem 0.7rem;
    cursor: pointer;
}

button[type='submit']:hover
{
    background: var(--mc-amber);
    color: var(--mc-ground);
}
</style>
