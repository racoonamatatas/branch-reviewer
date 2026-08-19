import { onMounted, onUnmounted } from 'vue';

// Refresh on an interval while the tab is visible; a hidden dashboard asks
// the server for nothing. An SSE transport would replace this wholesale —
// callers only hand over their refresh function.
export function usePolling(refresh: () => Promise<void>, intervalMs: number): void
{
    let timer: number | undefined;

    // One refresh at a time: a tick landing while the last one is still in
    // flight (slow server, tab woken mid-cycle) would double every request
    // and race the caller's own state. Skipped, not queued — the next
    // interval tick refreshes soon enough.
    let inFlight = false;

    function tick(): void
    {
        if (inFlight)
        {
            return;
        }
        inFlight = true;
        void refresh().finally(() =>
        {
            inFlight = false;
        });
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
        document.removeEventListener('visibilitychange', onVisibility);
    });
}
