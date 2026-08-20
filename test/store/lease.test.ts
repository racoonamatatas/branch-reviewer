import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { acquireCampaignLease, sweepInterruptedCampaigns } from '../../src/store/lease.js';
import { ReviewStore } from '../../src/store/store.js';
import type { CampaignId } from '../../src/types/ids.js';

// Lease tests need a real file: the whole mechanism is the kernel's fcntl
// lock on the lock database, which :memory: stores deliberately opt out of.
let dir: string;
let store: ReviewStore;

beforeEach(() =>
{
    dir = mkdtempSync(join(tmpdir(), 'lease-test-'));
    store = new ReviewStore(join(dir, 'reviews.db'));
});

afterEach(() =>
{
    store.close();
    rmSync(dir, { recursive: true, force: true });
});

const target = { owner: 'acme', repo: 'widgets', head: 'feature/x', base: 'main' };

function lockPathOf(id: CampaignId): string
{
    return join(store.leaseDir!, `campaign-${id}.lock`);
}

describe('acquireCampaignLease', () =>
{
    it('should opt out for an in-memory store: nothing outlives the process there', () =>
    {
        // Arrange
        const memory = new ReviewStore(':memory:');
        const id = memory.createCampaign(target);

        // Act + Assert
        expect(memory.leaseDir).toBeUndefined();
        expect(acquireCampaignLease(memory.leaseDir, id)).toBeUndefined();
        expect(sweepInterruptedCampaigns(memory)).toEqual([]);
        memory.close();
    });

    it('should survive a double release', () =>
    {
        // Arrange
        const id = store.createCampaign(target);
        const lease = acquireCampaignLease(store.leaseDir, id)!;

        // Act + Assert: idempotent, and the lock file is tidied away.
        lease.release();
        lease.release();
        expect(existsSync(lockPathOf(id))).toBe(false);
    });
});

describe('sweepInterruptedCampaigns', () =>
{
    it('should leave a held lease alone — even probed from the same process', () =>
    {
        // Arrange: fcntl locks are per-process (the classic footgun), so
        // this asserts SQLite's own per-inode tracking makes a same-process
        // probe see the truth — the serve process sweeps while its worker
        // holds a campaign.
        const id = store.createCampaign(target);
        const lease = acquireCampaignLease(store.leaseDir, id)!;

        // Act
        const swept = sweepInterruptedCampaigns(store);

        // Assert
        expect(swept).toEqual([]);
        expect(store.getCampaign(id)?.status).toBe('running');
        lease.release();
    });

    it('should fail a running campaign whose lease was released', () =>
    {
        // Arrange
        const id = store.createCampaign(target);
        acquireCampaignLease(store.leaseDir, id)!.release();

        // Act
        const swept = sweepInterruptedCampaigns(store);

        // Assert
        expect(swept).toEqual([id]);
        expect(store.getCampaign(id)).toMatchObject({
            status: 'failed',
            error: expect.stringContaining('liveness lease') as string,
        });
    });

    it('should fail a running campaign that never held a lease: degraded liveness is sweepable by design', () =>
    {
        // Arrange
        const id = store.createCampaign(target);

        // Act + Assert
        expect(sweepInterruptedCampaigns(store)).toEqual([id]);
    });

    it('should never probe finished or failed campaigns', () =>
    {
        // Arrange: neither row is running, neither holds a lease.
        const finished = store.createCampaign(target);
        store.finishCampaign(finished, 'dry');
        const failed = store.createCampaign(target);
        store.failCampaign(failed, 'boom');

        // Act + Assert
        expect(sweepInterruptedCampaigns(store)).toEqual([]);
    });

    it('should reclaim a lease from a SIGKILLed process: the kernel releases what no handler could', async () =>
    {
        // Arrange: a child process takes the lease exactly as a campaign
        // loop would, then dies without any chance to clean up. The leases
        // directory is normally acquireCampaignLease's job; the child opens
        // the lock file bare, so it is made here.
        const id = store.createCampaign(target);
        mkdirSync(store.leaseDir!, { recursive: true });
        const script = `
            const { DatabaseSync } = require('node:sqlite');
            const db = new DatabaseSync(process.argv[1]);
            db.exec('PRAGMA busy_timeout = 0');
            db.exec('BEGIN EXCLUSIVE');
            console.log('held');
            setInterval(() => {}, 1000);
        `;
        // NODE_OPTIONS is stripped: the test runner injects loaders meant
        // for its own workers, and they break a bare `node -e` child.
        const child = spawn(process.execPath, ['--no-warnings', '-e', script, lockPathOf(id)], {
            stdio: ['ignore', 'pipe', 'pipe'],
            env: { ...process.env, NODE_OPTIONS: '' },
        });
        let childErr = '';
        child.stderr.on('data', (chunk: Buffer) => childErr += chunk.toString());
        await new Promise<void>((resolve, reject) =>
        {
            child.stdout.on('data', (chunk: Buffer) =>
            {
                if (chunk.toString().includes('held'))
                {
                    resolve();
                }
            });
            child.once('exit', () => reject(new Error(`child exited before acquiring the lease: ${childErr}`)));
        });

        // Assert: while the child lives, the campaign is provably alive.
        expect(sweepInterruptedCampaigns(store)).toEqual([]);

        // Act: SIGKILL — no signal handler runs, only the kernel cleans up.
        child.kill('SIGKILL');
        await new Promise(resolve => child.once('exit', resolve));

        // Assert
        expect(sweepInterruptedCampaigns(store)).toEqual([id]);
        expect(store.getCampaign(id)?.status).toBe('failed');
    });
});
