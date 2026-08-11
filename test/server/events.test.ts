import { describe, expect, it } from 'vitest';
import { EventLog } from '../../src/server/events.js';

describe('EventLog', () =>
{
    it('should number events monotonically from 1', () =>
    {
        const log = new EventLog();
        expect(log.push('server', 'one').seq).toBe(1);
        expect(log.push('worker', 'two').seq).toBe(2);
        expect(log.push('trigger', 'three').seq).toBe(3);
    });

    it('should return everything for a new client and only the tail for a cursor', () =>
    {
        const log = new EventLog();
        log.push('server', 'one');
        log.push('server', 'two');
        log.push('server', 'three');

        expect(log.since().map(e => e.text)).toEqual(['one', 'two', 'three']);
        expect(log.since(2).map(e => e.text)).toEqual(['three']);
        expect(log.since(3)).toEqual([]);
    });

    it('should evict the oldest events past capacity without renumbering', () =>
    {
        const log = new EventLog(2);
        log.push('server', 'one');
        log.push('server', 'two');
        log.push('server', 'three');

        const kept = log.since();
        expect(kept.map(e => e.text)).toEqual(['two', 'three']);
        // The gap is visible to a client that held cursor 0: seq 1 is gone.
        expect(kept.map(e => e.seq)).toEqual([2, 3]);
    });

    it('should restart a cursor from a previous process life', () =>
    {
        const log = new EventLog();
        log.push('server', 'fresh start');
        // A dashboard that watched the old process holds a cursor far past
        // this ring's numbering; it must not be answered with silence.
        expect(log.since(250).map(e => e.text)).toEqual(['fresh start']);
        expect(log.latest()).toBe(1);
    });

    it('should stamp source and an ISO timestamp on each event', () =>
    {
        const log = new EventLog();
        const event = log.push('trigger', 'poll pass');
        expect(event.source).toBe('trigger');
        expect(Date.parse(event.at)).not.toBeNaN();
    });
});
