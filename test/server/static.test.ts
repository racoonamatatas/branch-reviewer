import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EventLog } from '../../src/server/events.js';
import { JobStore } from '../../src/server/jobs.js';
import { createServer } from '../../src/server/server.js';
import { WatchStore } from '../../src/server/trigger.js';
import { ReviewStore } from '../../src/store/store.js';

// A stand-in for dashboard/dist: the entry point, one hashed asset, and a
// secret file OUTSIDE the root that a traversal would reach.
const INDEX_HTML = '<!doctype html><div id="app"></div>';
const ASSET_JS = 'export const x = 1;';

let tmp: string;
let root: string;
let jobs: JobStore;
let watches: WatchStore;
let store: ReviewStore;
let server: Server;
let base: string;

beforeEach(async () =>
{
    tmp = await mkdtemp(join(tmpdir(), 'static-test-'));
    root = join(tmp, 'dist');
    await mkdir(join(root, 'assets'), { recursive: true });
    await writeFile(join(root, 'index.html'), INDEX_HTML);
    await writeFile(join(root, 'assets', 'app-abc123.js'), ASSET_JS);
    await writeFile(join(tmp, 'secret.txt'), 'not served');

    jobs = new JobStore(':memory:');
    watches = new WatchStore(':memory:');
    store = new ReviewStore(':memory:');
    server = createServer({
        jobs, watches, store, staticRoot: root,
        activity: { log: new EventLog(), poll: () => ({ polling: false }) },
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
    await rm(tmp, { recursive: true, force: true });
});

// node:http sends the path verbatim, where fetch would normalize the
// traversal away client-side and never exercise the server at all.
async function rawGet(path: string): Promise<{ status: number | undefined; body: string }>
{
    return new Promise((resolve, reject) =>
    {
        const port = (server.address() as AddressInfo).port;
        request({ host: '127.0.0.1', port, path }, res =>
        {
            let body = '';
            res.setEncoding('utf8');
            res.on('data', chunk => body += chunk);
            res.on('end', () => resolve({ status: res.statusCode, body }));
        }).on('error', reject).end();
    });
}

describe('static dashboard serving', () =>
{
    it('should serve index.html at the root with a revalidating cache header', async () =>
    {
        // Act
        const res = await fetch(`${base}/`);

        // Assert
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
        expect(res.headers.get('cache-control')).toBe('no-cache');
        expect(await res.text()).toBe(INDEX_HTML);
    });

    it('should serve a hashed asset as immutable with its own MIME type', async () =>
    {
        // Act
        const res = await fetch(`${base}/assets/app-abc123.js`);

        // Assert
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
        expect(res.headers.get('cache-control')).toContain('immutable');
        expect(await res.text()).toBe(ASSET_JS);
    });

    it('should answer a client route with index.html, dots in the branch name included', async () =>
    {
        // Act — the blueprint route embeds the head, and heads contain dots.
        const res = await fetch(`${base}/target/acme/widgets/release/v1.2`);

        // Assert
        expect(res.status).toBe(200);
        expect(await res.text()).toBe(INDEX_HTML);
    });

    it('should keep a missing asset a 404 instead of feeding HTML to a script tag', async ()  =>
    {
        // Act
        const res = await fetch(`${base}/assets/gone-def456.js`);

        // Assert
        expect(res.status).toBe(404);
    });

    it('should never serve a file outside the root, whichever layer stops the traversal', async () =>
    {
        // Act — three spellings, two defenses: ../ and %2e%2e/ are dot-dot
        // segments to the WHATWG URL parse in route() and collapse harmlessly
        // into the SPA fallback; ..%2f survives that parse and only becomes
        // ../ inside the static handler, whose containment check must refuse.
        const collapsed = [await rawGet('/../secret.txt'), await rawGet('/%2e%2e/secret.txt')];
        const guarded = await rawGet('/..%2fsecret.txt');

        // Assert
        for (const res of [...collapsed, guarded])
        {
            expect(res.body).not.toContain('not served');
        }
        expect(collapsed.map(r => r.status)).toEqual([200, 200]);
        expect(guarded.status).toBe(404);
    });

    it('should let API routes win over the static tree', async () =>
    {
        // Act
        const res = await fetch(`${base}/targets`);
        const body = await res.json() as { targets: unknown[] };

        // Assert
        expect(res.headers.get('content-type')).toBe('application/json');
        expect(body.targets).toEqual([]);
    });

    it('should not swallow non-GET misses into the SPA fallback', async () =>
    {
        // Act
        const res = await fetch(`${base}/target/acme/widgets/main`, { method: 'POST' });
        const body = await res.json() as { error: string };

        // Assert
        expect(res.status).toBe(404);
        expect(body.error).toBe('No such route.');
    });
});
