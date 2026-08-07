import { onMounted, onUnmounted } from 'vue';

// Refresh on an interval while the tab is visible; a hidden dashboard asks
// the server for nothing. An SSE transport would replace this wholesale —
// callers only hand over their refresh function.
export function usePolling(refresh: () => Promise<void>, intervalMs: number): void
{
    let timer: number | undefined;

    function tick(): void
    {
        void refresh();
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
