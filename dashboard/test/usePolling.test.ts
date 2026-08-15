import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import type { VueWrapper } from '@vue/test-utils';
import { defineComponent, h } from 'vue';
import { usePolling } from '../src/composables/usePolling';

// The stall deadline inside the composable; tests advance fake time past it.
const STALL_MS = 30_000;
const INTERVAL_MS = 1_000;

// A refresh whose settlement the test controls: each call hands back a fresh
// promise and records its resolver — never resolving one is "hung".
function controllableRefresh()
{
    const resolvers: Array<() => void> = [];
    const refresh = vi.fn(() => new Promise<void>((resolve) =>
    {
        resolvers.push(resolve);
    }));
    return { refresh, resolvers };
}

// usePolling registers lifecycle hooks, so it only works inside a component.
function mountPolling(refresh: () => Promise<void>): { wrapper: VueWrapper; refreshNow: () => Promise<void> }
{
    let refreshNow!: () => Promise<void>;
    const Host = defineComponent({
        setup()
        {
            refreshNow = usePolling(refresh, INTERVAL_MS);
            return () => h('div');
        },
    });
    return { wrapper: mount(Host), refreshNow };
}

beforeEach(() =>
{
    vi.useFakeTimers();
});

afterEach(() =>
{
    vi.useRealTimers();
});

describe('usePolling', () =>
{
    it('should release the guard when a refresh outlives the stall deadline, so ticks resume', async () =>
    {
        // Arrange: the mount tick starts refresh #1, which hangs forever.
        const { refresh } = controllableRefresh();
        mountPolling(refresh);
        expect(refresh).toHaveBeenCalledTimes(1);

        // Act: interval ticks inside the deadline are skipped by the guard;
        // past the deadline the hung refresh is abandoned.
        await vi.advanceTimersByTimeAsync(STALL_MS - INTERVAL_MS);
        const callsWhileGuarded = refresh.mock.calls.length;
        await vi.advanceTimersByTimeAsync(STALL_MS);

        // Assert: no tick got through while guarded; after the deadline the
        // poller recovered on its own.
        expect(callsWhileGuarded).toBe(1);
        expect(refresh.mock.calls.length).toBeGreaterThan(1);
    });

    it('should start a queued refresh after the deadline even when its predecessor never settles', async () =>
    {
        // Arrange: refresh #1 (the mount tick) hangs; a caller queues #2 —
        // the shape of a click landing during a dead fetch.
        const { refresh, resolvers } = controllableRefresh();
        const { refreshNow } = mountPolling(refresh);
        const queued = refreshNow();
        expect(refresh).toHaveBeenCalledTimes(1);

        // Act: the enqueue deadline fires; the queued refresh must run and
        // its promise must settle once its own fetch resolves.
        await vi.advanceTimersByTimeAsync(STALL_MS);
        expect(refresh).toHaveBeenCalledTimes(2);
        resolvers[1]!();
        await expect(queued).resolves.toBeUndefined();
    });

    it('should give a queued refresh its full budget from actual start, not from enqueue', async () =>
    {
        // Arrange: refresh #1 hangs; #2 queues at t=0.
        const { refresh, resolvers } = controllableRefresh();
        const { refreshNow } = mountPolling(refresh);
        void refreshNow();

        // Act: #2 starts at the enqueue deadline (t=STALL_MS) and hangs too.
        await vi.advanceTimersByTimeAsync(STALL_MS);
        expect(refresh).toHaveBeenCalledTimes(2);
        // Just short of #2's own full deadline, the guard must still hold —
        // an enqueue-measured budget would have released it long ago.
        await vi.advanceTimersByTimeAsync(STALL_MS - 2 * INTERVAL_MS);
        const callsBeforeSecondDeadline = refresh.mock.calls.length;
        await vi.advanceTimersByTimeAsync(3 * INTERVAL_MS);

        // Assert
        expect(callsBeforeSecondDeadline).toBe(2);
        expect(refresh.mock.calls.length).toBeGreaterThan(2);
        resolvers.forEach(resolve => resolve());
    });

    it('should clear every outstanding timer on unmount and never re-arm after it', async () =>
    {
        // Arrange: a hung refresh holds an armed stall deadline.
        const { refresh } = controllableRefresh();
        const { wrapper, refreshNow } = mountPolling(refresh);
        void refreshNow();

        // Act
        wrapper.unmount();

        // Assert: interval and stall deadlines are all gone — nothing left
        // to fire against an unmounted component.
        expect(vi.getTimerCount()).toBe(0);
    });
});
