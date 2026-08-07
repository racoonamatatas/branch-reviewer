import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { JobStore } from '../../src/server/jobs.js';
import { createServer } from '../../src/server/server.js';
import { WatchStore } from '../../src/server/trigger.js';
import type { JobId } from '../../src/types/ids.js';

let jobs: JobStore;
let watches: WatchStore;
let server: Server;
let base: string;
let enqueued: JobId[];

beforeEach(async () =>
{
    jobs = new JobStore(':memory:');
    watches = new WatchStore(':memory:');
    enqueued = [];
    server = createServer({ jobs, watches, onEnqueued: id => enqueued.push(id) });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () =>
{
    await new Promise(resolve => server.close(resolve));
    jobs.close();
    watches.close();
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
    it('should enqueue a review job with CLI-mirroring defaults and kick the worker', async () =>
    {
        // Act
        const res = await post('/jobs', reviewRequest);
        const { job } = await res.json() as { job: { id: number; state: string; base: string; params: unknown } };

        // Assert
        expect(res.status).toBe(201);
        expect(job).toMatchObject({ state: 'queued', base: 'main', params: {} });
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

    it('should reject an unknown kind', async () =>
    {
        // Act
        const res = await post('/jobs', { ...reviewRequest, kind: 'verify' });

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
        const created = await post('/jobs', reviewRequest);
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

describe('routing', () =>
{
    it('should 404 an unknown route', async () =>
    {
        // Act + Assert
        expect((await fetch(`${base}/runs`)).status).toBe(404);
    });

    it('should 404 the wrong method on a known path', async () =>
    {
        // Act + Assert
        expect((await fetch(`${base}/jobs/1`, { method: 'DELETE' })).status).toBe(404);
    });
});
