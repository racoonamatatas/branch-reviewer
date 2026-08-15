import { onMounted, onUnmounted } from 'vue';

// Refresh on an interval while the tab is visible; a hidden dashboard asks
// the server for nothing. An SSE transport would replace this wholesale —
// callers only hand over their refresh function.
//
// Returns the serialized refresh, and callers' own refresh paths (act())
// MUST go through it: two concurrent refreshes read the same event cursor
// and double-append the feed tail. Interval ticks skip when one is already
// in flight (another tick is imminent anyway); a returned-refresh call
// queues behind it instead, because a click's refresh must not be dropped.
// How long an in-flight refresh may hold the guard. A fetch with no timeout
// of its own can hang forever (a dead connection the OS never reports), and
// the in-flight guard would then skip every future tick — a stalled refresh
// must not stall the poller for the life of the tab.
const STALL_MS = 30_000;

export function usePolling(refresh: () => Promise<void>, intervalMs: number): () => Promise<void>
{
    let timer: number | undefined;
    let current: Promise<void> | undefined;
    // Every armed stall deadline, so unmount can disarm the stragglers a
    // still-in-flight refresh would otherwise leave ticking for up to 30s
    // after the component is gone.
    const stallTimers = new Set<number>();

    function refreshNow(): Promise<void>
    {
        let stallTimer: number | undefined;
        // The deadline is armed when the refresh actually starts, not when
        // it is enqueued — a call queued behind an in-flight pass gets its
        // full budget, not whatever the predecessor left of it. Past the
        // deadline the refresh is presumed dead and loses the guard: the
        // next tick starts fresh. If it settles after all, its finally
        // below is a no-op — the double-refresh race this risks is bounded
        // to one abandoned fetch (the view's own generation guard keeps its
        // late writes out), against a poller stalled forever.
        const start = (): Promise<void> =>
        {
            stallTimer = window.setTimeout(() =>
            {
                stallTimers.delete(stallTimer!);
                if (current === guarded)
                {
                    current = undefined;
                }
            }, STALL_MS);
            stallTimers.add(stallTimer);
            return refresh();
        };
        const run = current === undefined
            ? start()
            : current.catch(() => undefined).then(start);
        const guarded = run.finally(() =>
        {
            if (stallTimer !== undefined)
            {
                window.clearTimeout(stallTimer);
                stallTimers.delete(stallTimer);
            }
            if (current === guarded)
            {
                current = undefined;
            }
        });
        current = guarded;
        return guarded;
    }

    function tick(): void
    {
        if (current === undefined)
        {
            void refreshNow();
        }
    }

    function start(): void
    {
        if (timer === undefined)
        {
            timer = window.setInterval(tick, intervalMs);
        }
    }

    function stop(): void
    {
        if (timer !== undefined)
        {
            window.clearInterval(timer);
            timer = undefined;
        }
    }

    function onVisibility(): void
    {
        if (document.hidden)
        {
            stop();
        }
        else
        {
            tick();
            start();
        }
    }

    onMounted(() =>
    {
        tick();
        start();
        document.addEventListener('visibilitychange', onVisibility);
    });

    onUnmounted(() =>
    {
        stop();
        for (const outstanding of stallTimers)
        {
            window.clearTimeout(outstanding);
        }
        stallTimers.clear();
        document.removeEventListener('visibilitychange', onVisibility);
    });

    return refreshNow;
}
