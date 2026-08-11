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
    <section class="stage">
        <div class="stage-head">
            <span class="name">New Job</span>
            <span class="desc caps">manual enqueue</span>
        </div>
        <div class="stage-body">
            <form @submit.prevent="submit">
                <select v-model="kind">
                    <option value="review">review</option>
                    <option value="campaign">campaign</option>
                </select>
                <input v-model.trim="owner" placeholder="owner" required>
                <input v-model.trim="repo" placeholder="repo" required>
                <input v-model.trim="head" placeholder="branch or SHA" required class="wide">
                <input v-model.trim="base" placeholder="base (main)">
                <button type="submit" class="bp-btn chalk">enqueue ▶</button>
            </form>
            <p class="note">a job bills subscription credit when the worker picks it up — cancel is only possible while queued</p>
        </div>
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
    width: 8.5em;
    min-width: 0;
}

.wide
{
    width: 14em;
}

.note
{
    color: var(--faint);
    font-size: 0.75rem;
    letter-spacing: 0.04em;
    margin: 0.6rem 0 0;
}
</style>
