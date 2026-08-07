<script setup lang="ts">
import { ref } from 'vue';
import type { NewJobRequest } from '../api/client';

const emit = defineEmits<{
    enqueue: [job: NewJobRequest];
}>();

const kind = ref<'review' | 'campaign'>('review');
const owner = ref('');
const repo = ref('');
const head = ref('');
const base = ref('');

function submit(): void
{
    if (owner.value === '' || repo.value === '' || head.value === '')
    {
        return;
    }
    emit('enqueue', {
        kind: kind.value,
        owner: owner.value,
        repo: repo.value,
        head: head.value,
        // Omitted base lets the server default to main, same as the CLI.
        ...(base.value !== '' ? { base: base.value } : {}),
    });
    head.value = '';
}
</script>

<template>
    <section>
        <h2>NEW JOB</h2>
        <form @submit.prevent="submit">
            <select v-model="kind">
                <option value="review">review</option>
                <option value="campaign">campaign</option>
            </select>
            <input v-model.trim="owner" placeholder="owner" required>
            <input v-model.trim="repo" placeholder="repo" required>
            <input v-model.trim="head" placeholder="branch or SHA" required class="wide">
            <input v-model.trim="base" placeholder="base (main)">
            <button type="submit">enqueue ▶</button>
        </form>
        <p class="note">a job bills subscription credit when the worker picks it up — cancel is only possible while queued</p>
    </section>
</template>

<style scoped>
form
{
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem;
}

select, input
{
    background: var(--mc-panel-2);
    border: 1px solid var(--mc-line);
    color: var(--mc-ink);
    font: inherit;
    padding: 0.25rem 0.5rem;
    width: 8.5em;
    min-width: 0;
}

.wide
{
    width: 14em;
}

input::placeholder
{
    color: var(--mc-faint);
}

button
{
    background: none;
    border: 1px solid var(--mc-amber);
    color: var(--mc-amber);
    font: inherit;
    padding: 0.25rem 0.7rem;
    cursor: pointer;
}

button:hover
{
    background: var(--mc-amber);
    color: var(--mc-ground);
}

.note
{
    color: var(--mc-faint);
    font-size: 0.85em;
    margin: 0.6rem 0 0;
}
</style>
