// The activity feed: a liveness signal, not a record. The ring lives in
// process memory and dies with the process on purpose — the database stays
// the durable truth about what happened; this exists so a human watching the
// dashboard can tell "working" from "frozen". Anything worth keeping is
// already a row somewhere else.

import { randomUUID } from 'node:crypto';

export type EventSource = 'server' | 'worker' | 'trigger';

export interface ActivityEvent
{
    seq: number;
    at: string;
    source: EventSource;
    text: string;
}

// What the poller is up to, for the dashboard's heartbeat line. Discriminated
// on `polling` because a fixture server has no poller at all — that is a
// different fact from "hasn't polled yet" (lastAt absent: JSON drops
// undefined, so absence is the wire shape of "not yet").
export type PollStatus =
    | { polling: false }
    | { polling: true; intervalMs: number; lastAt?: string };

export class EventLog
{
    // Names this process life. Sequence numbers restart with the process, so
    // a client comparing seqs across a restart can be fooled whenever the new
    // life out-runs its old cursor before the next poll (run 21 finding,
    // confirmed); the boot id changing is unambiguous.
    readonly boot: string = randomUUID();

    private readonly capacity: number;
    private readonly buffer: ActivityEvent[] = [];
    private seq = 0;

    constructor(capacity = 200)
    {
        this.capacity = capacity;
    }

    push(source: EventSource, text: string): ActivityEvent
    {
        const event: ActivityEvent = { seq: ++this.seq, at: new Date().toISOString(), source, text };
        this.buffer.push(event);
        if (this.buffer.length > this.capacity)
        {
            this.buffer.shift();
        }
        return event;
    }

    // Everything after a cursor the client already holds; the whole ring for
    // a new client. seq stays monotonic across evictions, so a client that
    // fell behind sees a gap in the numbering, never a stale repeat. A cursor
    // beyond latest() means the client is holding a previous process's
    // numbering — it gets the whole ring again, and the overlap in seq tells
    // it to start over rather than append.
    since(after = 0): ActivityEvent[]
    {
        const effective = after > this.seq ? 0 : after;
        return this.buffer.filter(e => e.seq > effective);
    }

    latest(): number
    {
        return this.seq;
    }
}
