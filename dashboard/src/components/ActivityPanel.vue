<script setup lang="ts">
import { computed } from 'vue';
import type { ActivityEvent } from '@server/server/events';

const props = defineProps<{ events: ActivityEvent[] }>();

// Newest first: this panel answers "is anything happening right now", and
// the answer should never require scrolling. The parent holds the full ring;
// the display caps what one glance can use.
const SHOWN = 50;
const shown = computed(() => props.events.slice(-SHOWN).reverse());
</script>

<template>
    <section class="stage">
        <div class="stage-head">
            <span class="name">Activity</span>
            <span class="desc caps">liveness feed · dies with the server</span>
        </div>
        <div class="stage-body log">
            <div v-for="e in shown" :key="e.seq" class="line mono">
                <span class="t">{{ e.at.slice(11, 19) }}</span>
                <span class="src caps" :class="`src-${e.source}`">{{ e.source }}</span>
                <span class="txt">{{ e.text }}</span>
            </div>
            <div v-if="events.length === 0" class="empty">
                nothing yet — the feed starts with the server process (restart `npm run serve` if this stays empty)
            </div>
        </div>
    </section>
</template>

<style scoped>
.log
{
    max-height: 15rem;
    overflow-y: auto;
    font-size: 0.75rem;
}

.line
{
    display: flex;
    gap: 0.7rem;
    align-items: baseline;
    padding: 0.12rem 0;
    border-bottom: 1px dashed var(--rule-soft);
}

.line:last-of-type { border-bottom: 0; }

.t { color: var(--faint); flex: none; }

.src
{
    flex: none;
    width: 4.5em;
    font-size: 0.68rem;
}

.src-server  { color: var(--muted); }
.src-worker  { color: var(--chalk); }
.src-trigger { color: var(--stamp-ok); }

.txt
{
    color: var(--ink);
    min-width: 0;
    overflow-wrap: anywhere;
}

.empty
{
    color: var(--faint);
    font-size: 0.8rem;
}
</style>
