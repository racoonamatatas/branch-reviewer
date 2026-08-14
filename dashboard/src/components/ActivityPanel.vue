<script setup lang="ts">
import { computed } from 'vue';
import type { ActivityEvent } from '@server/server/events';
import { clock } from '../format';

const props = defineProps<{ events: ActivityEvent[] }>();

// Newest first: this panel answers "is anything happening right now", and
// the answer should never require scrolling. The parent holds the full ring;
// the display caps what one glance can use. A jump in seq between neighbours
// means the ring evicted events before we fetched — rendered as a gap,
// because a feed that hides its holes reads as complete.
const SHOWN = 50;
const rows = computed(() =>
    props.events
        .slice(-SHOWN)
        .map((event, i, all) => ({
            event,
            gapBefore: i === 0 ? 0 : event.seq - all[i - 1]!.seq - 1,
        }))
        .reverse());
</script>

<template>
    <section class="stage">
        <div class="stage-head">
            <span class="name">Activity</span>
            <span class="desc caps">liveness feed · dies with the server</span>
        </div>
        <div class="stage-body log">
            <template v-for="row in rows" :key="row.event.seq">
                <div class="line mono">
                    <span class="t">{{ clock(row.event.at) }}</span>
                    <span class="src caps" :class="`src-${row.event.source}`">{{ row.event.source }}</span>
                    <span class="txt">{{ row.event.text }}</span>
                </div>
                <!-- Below the line: the list is newest-first, so the gap sits
                     between this event and the older one under it. -->
                <div v-if="row.gapBefore > 0" class="gap mono">· · · {{ row.gapBefore }} event(s) evicted before this was fetched</div>
            </template>
            <div v-if="events.length === 0" class="empty">
                nothing yet — the feed starts with the server process (restart `npm run serve` if this stays empty)
            </div>
        </div>
    </section>
</template>

<style scoped>
/* Height comes from the parent grid (the fill slot bounds it and adds the
   scroll); the panel itself only caps how much one glance can use (SHOWN). */
.log
{
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

.gap
{
    color: var(--faint);
    font-size: 0.7rem;
    padding: 0.12rem 0;
    border-bottom: 1px dashed var(--rule-soft);
}

.empty
{
    color: var(--faint);
    font-size: 0.8rem;
}
</style>
