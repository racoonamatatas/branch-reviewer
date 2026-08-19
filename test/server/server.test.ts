import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { NewFinding } from '../../src/schema/schema.js';
import { EventLog } from '../../src/server/events.js';
import { JobStore } from '../../src/server/jobs.js';
import { createServer } from '../../src/server/server.js';
import { WatchStore } from '../../src/server/trigger.js';
import { ReviewStore } from '../../src/store/store.js';
import type { ClusterId, RunId } from '../../src/types/ids.js';
import type { JobId } from '../../src/types/ids.js';

let jobs: JobStore;
let watches: WatchStore;
let store: ReviewStore;
let server: Server;
let base: string;
let enqueued: JobId[];
let activityLog: EventLog;

beforeEach(async () =>
{
    jobs = new JobStore(':memory:');
    watches = new WatchStore(':memory:');
    store = new ReviewStore(':memory:');
    enqueued = [];
    activityLog = new EventLog();
    server = createServer({
        jobs, watches, store,
        onEnqueued: id => enqueued.push(id),
        activity: { log: activityLog, poll: () => ({ polling: false }) },
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () =>
{
    await new Promise(resolve => server.close(resolve));
    jobs.close();
    watches.close();
    store.close();
});

async function post(path: string, body?: unknown): Promise<Response>
{
    return fetch(`${base}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
}

const reviewRequest = { kind: 'review', owner: 'acme', repo: 'widgets', head: 'feature/x' };

describe('POST /jobs', () =>
{
    it('should enqueue held by default and leave the worker asleep', async () =>
    {
        // Act
        const res = await post('/jobs', reviewRequest);
        const { job } = await res.json() as { job: { id: number; state: string; base: string; params: unknown } };

        // Assert: CLI-mirroring defaults, but no billing without a click —
        // the worker is not kicked for a job it may not claim.
        expect(res.status).toBe(201);
        expect(job).toMatchObject({ state: 'held', base: 'main', params: {} });
        expect(enqueued).toEqual([]);
    });

    it('should enqueue queued and kick the worker when start is explicit', async () =>
    {
        // Act
        const res = await post('/jobs', { ...reviewRequest, start: true });
        const { job } = await res.json() as { job: { id: number; state: string } };

        // Assert
        expect(res.status).toBe(201);
        expect(job.state).toBe('queued');
        expect(enqueued).toEqual([job.id]);
    });

    it('should default a campaign to 3 runs with verification on', async () =>
    {
        // Act
        const res = await post('/jobs', { ...reviewRequest, kind: 'campaign' });
        const { job } = await res.json() as { job: { params: unknown } };

        // Assert
        expect(res.status).toBe(201);
        expect(job.params).toEqual({ maxRuns: 3, verify: true });
    });

    it('should keep explicit campaign params over the defaults', async () =>
    {
        // Act
        const res = await post('/jobs', {
            ...reviewRequest,
            kind: 'campaign',
            params: { maxRuns: 5, patience: 2, verify: false },
        });
        const { job } = await res.json() as { job: { params: unknown } };

        // Assert
        expect(job.params).toEqual({ maxRuns: 5, patience: 2, verify: false });
    });

    it('should reject a body that fails the schema, naming the violation', async () =>
    {
        // Act
        const res = await post('/jobs', { kind: 'review', owner: 'acme' });
        const body = await res.json() as { error: string };

        // Assert
        expect(res.status).toBe(400);
        expect(body.error).toContain('repo');
        expect(enqueued).toEqual([]);
    });

    it('should enqueue a verify job with empty params by default', async () =>
    {
        // Act
        const res = await post('/jobs', { ...reviewRequest, kind: 'verify' });
        const { job } = await res.json() as { job: { state: string; kind: string; params: unknown } };

        // Assert
        expect(res.status).toBe(201);
        expect(job).toMatchObject({ kind: 'verify', state: 'held', params: {} });
    });

    it('should reject an unknown kind', async () =>
    {
        // Act: 'verify' used to be the exemplar here, until it became real.
        const res = await post('/jobs', { ...reviewRequest, kind: 'deploy' });

        // Assert
        expect(res.status).toBe(400);
    });

    it('should reject fields the schema does not know', async () =>
    {
        // Act
        const res = await post('/jobs', { ...reviewRequest, urgent: true });

        // Assert
        expect(res.status).toBe(400);
    });

    it('should reject malformed JSON without crashing', async () =>
    {
        // Act
        const res = await fetch(`${base}/jobs`, { method: 'POST', body: '{not json' });
        const body = await res.json() as { error: string };

        // Assert
        expect(res.status).toBe(400);
        expect(body.error).toContain('not valid JSON');
    });

    it('should refuse an oversized body', async () =>
    {
        // Act
        const res = await post('/jobs', { ...reviewRequest, head: 'x'.repeat(70_000) });

        // Assert
        expect(res.status).toBe(413);
    });
});

describe('GET /jobs', () =>
{
    it('should list job summaries newest first', async () =>
    {
        // Arrange
        await post('/jobs', reviewRequest);
        await post('/jobs', { ...reviewRequest, head: 'feature/y' });

        // Act
        const res = await fetch(`${base}/jobs`);
        const body = await res.json() as { jobs: Array<{ target: string }> };

        // Assert
        expect(res.status).toBe(200);
        expect(body.jobs.map(j => j.target)).toEqual([
            'acme/widgets feature/y → main',
            'acme/widgets feature/x → main',
        ]);
    });
});

describe('GET /jobs/:id', () =>
{
    it('should return the full job', async () =>
    {
        // Arrange
        const created = await post('/jobs', reviewRequest);
        const { job } = await created.json() as { job: { id: number } };

        // Act
        const res = await fetch(`${base}/jobs/${job.id}`);
        const body = await res.json() as { job: { head: string; runIds: number[] } };

        // Assert
        expect(res.status).toBe(200);
        expect(body.job).toMatchObject({ head: 'feature/x', runIds: [] });
    });

    it('should 404 an unknown id', async () =>
    {
        // Act + Assert
        expect((await fetch(`${base}/jobs/99`)).status).toBe(404);
    });

    it('should 404 an id that cannot exist', async () =>
    {
        // Act + Assert
        expect((await fetch(`${base}/jobs/0`)).status).toBe(404);
    });
});

describe('POST /jobs/:id/cancel', () =>
{
    it('should cancel a queued job', async () =>
    {
        // Arrange
        const created = await post('/jobs', reviewRequest);
        const { job } = await created.json() as { job: { id: number } };

        // Act
        const res = await post(`/jobs/${job.id}/cancel`);
        const body = await res.json() as { job: { state: string } };

        // Assert
        expect(res.status).toBe(200);
        expect(body.job.state).toBe('cancelled');
    });

    it('should 409 a job that is already running: its credit is spent', async () =>
    {
        // Arrange
        const created = await post('/jobs', { ...reviewRequest, start: true });
        const { job } = await created.json() as { job: { id: number } };
        jobs.claimNext();

        // Act
        const res = await post(`/jobs/${job.id}/cancel`);
        const body = await res.json() as { error: string };

        // Assert
        expect(res.status).toBe(409);
        expect(body.error).toContain('running');
    });

    it('should 404 an unknown id', async () =>
    {
        // Act + Assert
        expect((await post('/jobs/99/cancel')).status).toBe(404);
    });
});

describe('watches', () =>
{
    it('should create a watch with the default trigger label', async () =>
    {
        // Act
        const res = await post('/watches', { owner: 'acme', repo: 'widgets' });
        const { watch } = await res.json() as { watch: { id: number; label: string } };

        // Assert
        expect(res.status).toBe(201);
        expect(watch).toMatchObject({ owner: 'acme', repo: 'widgets', label: 'agent-review' });
        expect(watches.list()).toHaveLength(1);
    });

    it('should keep an explicit label', async () =>
    {
        // Act
        const res = await post('/watches', { owner: 'acme', repo: 'widgets', label: 'security-review' });
        const { watch } = await res.json() as { watch: { label: string } };

        // Assert
        expect(watch.label).toBe('security-review');
    });

    it('should 409 a duplicate watch', async () =>
    {
        // Arrange
        await post('/watches', { owner: 'acme', repo: 'widgets' });

        // Act
        const res = await post('/watches', { owner: 'acme', repo: 'widgets' });
        const body = await res.json() as { error: string };

        // Assert
        expect(res.status).toBe(409);
        expect(body.error).toContain('Already watching');
    });

    it('should 400 a watch without a repo', async () =>
    {
        // Act + Assert
        expect((await post('/watches', { owner: 'acme' })).status).toBe(400);
    });

    it('should list watches', async () =>
    {
        // Arrange
        await post('/watches', { owner: 'acme', repo: 'widgets' });

        // Act
        const res = await fetch(`${base}/watches`);
        const body = await res.json() as { watches: Array<{ owner: string }> };

        // Assert
        expect(body.watches).toHaveLength(1);
    });

    it('should delete a watch and 404 an unknown one', async () =>
    {
        // Arrange
        const created = await post('/watches', { owner: 'acme', repo: 'widgets' });
        const { watch } = await created.json() as { watch: { id: number } };

        // Act
        const res = await fetch(`${base}/watches/${watch.id}`, { method: 'DELETE' });

        // Assert
        expect(res.status).toBe(200);
        expect(watches.list()).toEqual([]);
        expect((await fetch(`${base}/watches/${watch.id}`, { method: 'DELETE' })).status).toBe(404);
        expect((await fetch(`${base}/watches/0`, { method: 'DELETE' })).status).toBe(404);
    });
});

// Seeds one submitted run of a target with the given findings; the review
// history endpoints below read what these write.
function seedRun(head: string, findings: NewFinding[]): RunId
{
    return store.saveRun({
        owner: 'acme', repo: 'widgets', head, base: 'main', model: 'test-model',
        status: 'submitted',
        review: { summary: 'a summary', findings },
        turns: 5,
        costUsd: 1.25,
        usage: { inputTokens: 10, outputTokens: 20, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
    });
}

const finding = (title: string): NewFinding =>
    ({ file: 'src/a.ts', line: 1, severity: 'warning', title, detail: 'because' });

describe('GET /targets', () =>
{
    it('should aggregate runs per target, newest target first', async () =>
    {
        // Arrange
        seedRun('feature/x', [finding('one')]);
        seedRun('feature/x', [finding('two')]);
        seedRun('feature/y', []);

        // Act
        const res = await fetch(`${base}/targets`);
        const body = await res.json() as { targets: Array<{ head: string; runCount: number; totalCostUsd: number }> };

        // Assert
        expect(res.status).toBe(200);
        expect(body.targets.map(t => [t.head, t.runCount])).toEqual([['feature/y', 1], ['feature/x', 2]]);
        expect(body.targets[1]?.totalCostUsd).toBeCloseTo(2.5);
    });

    it('should point at the latest consolidation when one exists', async () =>
    {
        // Arrange
        const run = seedRun('feature/x', [finding('one')]);
        const found = store.getFindings(run);
        const id = store.saveConsolidation({
            owner: 'acme', repo: 'widgets', head: 'feature/x', base: 'main', runIds: [run],
            clusters: [{
                memberIds: found.map(f => f.id),
                representativeId: found[0]!.id,
                severity: 'warning',
                occurrence: 1,
            }],
        });

        // Act
        const res = await fetch(`${base}/targets`);
        const body = await res.json() as { targets: Array<{ latestConsolidationId?: number }> };

        // Assert
        expect(body.targets[0]?.latestConsolidationId).toBe(id);
    });
});

describe('GET /runs', () =>
{
    it('should list all runs without a filter and only the target\'s with one', async () =>
    {
        // Arrange
        seedRun('feature/x', [finding('one')]);
        seedRun('feature/y', []);

        // Act
        const all = await (await fetch(`${base}/runs`)).json() as { runs: unknown[] };
        const filtered = await (await fetch(`${base}/runs?owner=acme&repo=widgets&head=feature/x`))
            .json() as { runs: Array<{ target: string; findingsCount: number }> };

        // Assert
        expect(all.runs).toHaveLength(2);
        expect(filtered.runs).toHaveLength(1);
        expect(filtered.runs[0]).toMatchObject({ target: 'acme/widgets feature/x → main', findingsCount: 1 });
    });

    it('should 400 a partial target filter instead of guessing', async () =>
    {
        // Act + Assert
        expect((await fetch(`${base}/runs?owner=acme`)).status).toBe(400);
    });

    it('should 400 a lone base instead of silently widening the query', async () =>
    {
        // Arrange
        seedRun('feature/x', []);

        // Act + Assert: base rides on a complete triple, never alone.
        expect((await fetch(`${base}/runs?base=develop`)).status).toBe(400);
    });

    it('should 400 an empty base instead of pinning to a base that cannot exist', async () =>
    {
        // Act + Assert
        expect((await fetch(`${base}/runs?owner=acme&repo=widgets&head=feature/x&base=`)).status).toBe(400);
    });

    it('should pin the base when the query carries one', async () =>
    {
        // Arrange: same triple, two bases — two review series.
        seedRun('feature/x', []);
        store.saveRun({
            owner: 'acme', repo: 'widgets', head: 'feature/x', base: 'develop', model: 'test-model',
            status: 'submitted',
            review: { summary: 'a summary', findings: [] },
            turns: 5,
            costUsd: 1.25,
            usage: { inputTokens: 10, outputTokens: 20, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
        });

        // Act
        const triple = await (await fetch(`${base}/runs?owner=acme&repo=widgets&head=feature/x`))
            .json() as { runs: unknown[] };
        const pinned = await (await fetch(`${base}/runs?owner=acme&repo=widgets&head=feature/x&base=develop`))
            .json() as { runs: Array<{ target: string }> };

        // Assert
        expect(triple.runs).toHaveLength(2);
        expect(pinned.runs).toHaveLength(1);
        expect(pinned.runs[0]?.target).toBe('acme/widgets feature/x → develop');
    });
});

describe('GET /runs/:id/findings', () =>
{
    it('should return the run\'s findings with ids and provenance', async () =>
    {
        // Arrange
        const id = seedRun('feature/x', [finding('one'), finding('two')]);

        // Act
        const res = await fetch(`${base}/runs/${id}/findings`);
        const body = await res.json() as { findings: Array<{ id: number; runId: number; title: string }> };

        // Assert
        expect(res.status).toBe(200);
        expect(body.findings).toHaveLength(2);
        expect(body.findings[0]).toMatchObject({ runId: id, title: 'one' });
    });

    it('should 404 a run that does not exist', async () =>
    {
        // Act + Assert
        expect((await fetch(`${base}/runs/999/findings`)).status).toBe(404);
    });
});

describe('GET /consolidations', () =>
{
    it('should list summaries filtered by target', async () =>
    {
        // Arrange
        const run = seedRun('feature/x', [finding('one')]);
        const found = store.getFindings(run);
        store.saveConsolidation({
            owner: 'acme', repo: 'widgets', head: 'feature/x', base: 'main', runIds: [run],
            clusters: [{
                memberIds: found.map(f => f.id),
                representativeId: found[0]!.id,
                severity: 'warning',
                occurrence: 1,
            }],
        });

        // Act
        const match = await (await fetch(`${base}/consolidations?owner=acme&repo=widgets&head=feature/x`))
            .json() as { consolidations: Array<{ clusterCount: number }> };
        const miss = await (await fetch(`${base}/consolidations?owner=acme&repo=widgets&head=feature/z`))
            .json() as { consolidations: unknown[] };

        // Assert
        expect(match.consolidations).toHaveLength(1);
        expect(match.consolidations[0]?.clusterCount).toBe(1);
        expect(miss.consolidations).toHaveLength(0);
    });
});

describe('GET /consolidations/:id', () =>
{
    it('should return clusters with verification history and computed coverage', async () =>
    {
        // Arrange — two runs; one cluster seen by both, one seen once and verified.
        const first = seedRun('feature/x', [finding('shared'), finding('only-here')]);
        const second = seedRun('feature/x', [finding('shared again')]);
        const [shared, onlyHere] = store.getFindings(first);
        const [sharedAgain] = store.getFindings(second);
        const id = store.saveConsolidation({
            owner: 'acme', repo: 'widgets', head: 'feature/x', base: 'main', runIds: [first, second],
            clusters: [
                {
                    memberIds: [shared!.id, sharedAgain!.id],
                    representativeId: shared!.id,
                    severity: 'warning',
                    occurrence: 2,
                },
                {
                    memberIds: [onlyHere!.id],
                    representativeId: onlyHere!.id,
                    severity: 'warning',
                    occurrence: 1,
                },
            ],
        });
        const singleton = store.getConsolidation(id)!.clusters.find(c => c.occurrence === 1)!;
        store.saveVerification({
            source: 'agent',
            clusterId: singleton.id,
            verdict: 'confirmed',
            rationale: 'the guard is real',
            confidence: 'high',
            costUsd: 0.4,
        });

        // Act
        const res = await fetch(`${base}/consolidations/${id}`);
        const body = await res.json() as {
            consolidation: { clusters: Array<{ occurrence: number; verificationStatus: string; verifications: Array<{ verdict: string; rationale: string }> }> };
            coverage: { observed: number; f1: number; f2: number; undiscovered: number; estimatedTotal: number };
        };

        // Assert
        expect(res.status).toBe(200);
        const verified = body.consolidation.clusters.find(c => c.occurrence === 1);
        expect(verified).toMatchObject({ verificationStatus: 'confirmed' });
        expect(verified?.verifications).toMatchObject([{ verdict: 'confirmed', rationale: 'the guard is real' }]);
        expect(body.consolidation.clusters.find(c => c.occurrence === 2)?.verifications).toEqual([]);
        expect(body.coverage).toEqual({ observed: 2, f1: 1, f2: 1, undiscovered: 1, estimatedTotal: 3 });
    });

    it('should 404 an unknown consolidation and an id that cannot exist', async () =>
    {
        // Act + Assert
        expect((await fetch(`${base}/consolidations/99`)).status).toBe(404);
        expect((await fetch(`${base}/consolidations/0`)).status).toBe(404);
    });
});

describe('POST /clusters/:id/verdict', () =>
{
    function seedCluster(): ClusterId
    {
        const run = seedRun('feature/x', [finding('suspicious')]);
        const [f] = store.getFindings(run);
        const id = store.saveConsolidation({
            owner: 'acme', repo: 'widgets', head: 'feature/x', base: 'main', runIds: [run],
            clusters: [{ memberIds: [f!.id], representativeId: f!.id, severity: 'warning', occurrence: 1 }],
        });
        return store.getConsolidation(id)!.clusters[0]!.id;
    }

    it('should append a human verdict and return the full history', async () =>
    {
        // Arrange — the agent ruled undetermined; the human overrules.
        const clusterId = seedCluster();
        store.saveVerification({
            source: 'agent', clusterId, verdict: 'undetermined',
            rationale: 'Needs human eyes.', confidence: 'Low.', costUsd: 0.3,
        });

        // Act
        const res = await post(`/clusters/${clusterId}/verdict`, {
            verdict: 'refuted',
            rationale: 'Checked the file mode myself: 100755.',
        });
        const body = await res.json() as { verifications: Array<{ source: string; verdict: string }> };

        // Assert — appended, not overwritten, and the cluster shows the ruling.
        expect(res.status).toBe(201);
        expect(body.verifications.map(v => [v.source, v.verdict])).toEqual([
            ['agent', 'undetermined'],
            ['human', 'refuted'],
        ]);
    });

    it('should reject an undetermined stamp: humans rule or abstain', async () =>
    {
        // Arrange
        const clusterId = seedCluster();

        // Act + Assert
        const res = await post(`/clusters/${clusterId}/verdict`, { verdict: 'undetermined', rationale: 'hmm' });
        expect(res.status).toBe(400);
    });

    it('should reject a stamp without a rationale', async () =>
    {
        // Arrange
        const clusterId = seedCluster();

        // Act + Assert
        const res = await post(`/clusters/${clusterId}/verdict`, { verdict: 'confirmed', rationale: '' });
        expect(res.status).toBe(400);
    });

    it('should 404 an unknown cluster without writing anything', async () =>
    {
        // Act + Assert
        expect((await post('/clusters/999/verdict', { verdict: 'confirmed', rationale: 'x' })).status).toBe(404);
        expect((await post('/clusters/0/verdict', { verdict: 'confirmed', rationale: 'x' })).status).toBe(404);
    });
});

describe('POST /jobs/:id/release', () =>
{
    it('should release a held job and kick the worker', async () =>
    {
        // Arrange
        const created = await post('/jobs', reviewRequest);
        const { job } = await created.json() as { job: { id: number } };
        expect(enqueued).toEqual([]);

        // Act
        const res = await post(`/jobs/${job.id}/release`);
        const body = await res.json() as { job: { state: string } };

        // Assert
        expect(res.status).toBe(200);
        expect(body.job.state).toBe('queued');
        expect(enqueued).toEqual([job.id]);
    });

    it('should 404 a job that does not exist', async () =>
    {
        expect((await post('/jobs/999/release')).status).toBe(404);
    });

    it('should 409 a job that is not held, without kicking the worker', async () =>
    {
        // Arrange: started jobs are already queued; releasing again is a
        // state error, not a no-op.
        const created = await post('/jobs', { ...reviewRequest, start: true });
        const { job } = await created.json() as { job: { id: number } };

        // Act
        const res = await post(`/jobs/${job.id}/release`);

        // Assert
        expect(res.status).toBe(409);
        expect(enqueued).toEqual([job.id]);
    });
});

describe('GET /events', () =>
{
    it('should return the feed and the poll status', async () =>
    {
        activityLog.push('worker', 'job #1: claimed');
        activityLog.push('trigger', 'poll pass: 1 watch(es) — 0 enqueued, 0 seen before, 0 deferred');

        const res = await fetch(`${base}/events`);
        expect(res.status).toBe(200);
        const body = await res.json() as { events: Array<{ seq: number; source: string; text: string }>; poll: { polling: boolean } };
        expect(body.events.map(e => e.source)).toEqual(['worker', 'trigger']);
        expect(body.poll).toEqual({ polling: false });
    });

    it('should tail from a cursor so a caught-up client gets nothing', async () =>
    {
        activityLog.push('server', 'one');
        const two = activityLog.push('server', 'two');

        const tail = await fetch(`${base}/events?after=1`);
        const body = await tail.json() as { events: Array<{ seq: number; text: string }> };
        expect(body.events.map(e => e.text)).toEqual(['two']);

        const caughtUp = await fetch(`${base}/events?after=${two.seq}`);
        expect(((await caughtUp.json()) as { events: unknown[] }).events).toEqual([]);
    });

    it('should reject a cursor that is not a non-negative integer', async () =>
    {
        expect((await fetch(`${base}/events?after=abc`)).status).toBe(400);
        expect((await fetch(`${base}/events?after=-1`)).status).toBe(400);
        expect((await fetch(`${base}/events?after=1.5`)).status).toBe(400);
    });
});

describe('routing', () =>
{
    it('should 404 an unknown route', async () =>
    {
        // Act + Assert
        expect((await fetch(`${base}/nope`)).status).toBe(404);
    });

    it('should 404 the wrong method on a known path', async () =>
    {
        // Act + Assert
        expect((await fetch(`${base}/jobs/1`, { method: 'DELETE' })).status).toBe(404);
    });
});
