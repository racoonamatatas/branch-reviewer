// Folds one machine's database into another's. Both number their rows from
// 1, so every id from the source is reassigned and every reference to it
// (foreign keys, and the JSON run-id lists on consolidations and jobs) is
// rewritten through the same map.
//
// Nobody knows whether the two files share an ancestor (an age-moved copy
// that both machines kept writing to), so top-level rows are matched on
// natural keys — target plus a millisecond created_at — and a match is
// treated as the same row, never a second sighting. Children of a shared
// parent pair up by insertion order; a count mismatch means the copies
// diverged inside one row's lifetime, which nothing here can reconcile, so
// the merge refuses instead of guessing.

import { basename, dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { SQLInputValue, SQLOutputValue } from 'node:sqlite';
import { JobStore } from '../server/jobs.js';
import { WatchStore } from '../server/trigger.js';
import { ReviewStore } from './store.js';

type Row = Record<string, SQLOutputValue>;
type IdMap = Map<number, number>;

export interface TableCount
{
    added: number;
    shared: number;
}

export interface MergeReport
{
    runs: TableCount;
    findings: TableCount;
    consolidations: TableCount;
    clusters: TableCount;
    verifications: TableCount;
    campaigns: TableCount;
    jobs: TableCount;
    // Source jobs still held/queued/running: imported cancelled, because the
    // target's worker would otherwise claim them and bill.
    jobsCancelled: number;
}

const TARGET = ['owner', 'repo', 'head', 'base'] as const;

// Copies the target aside before a merge touches it. VACUUM INTO rather than
// a file copy: it reads inside a transaction, so a writer that is still alive
// can't leave a torn copy. Opened raw, not through a store, so the backup is
// the pre-migration file exactly. VACUUM INTO refuses an existing output
// file, which is the no-overwrite guarantee.
export function backupDatabase(path: string, now: Date = new Date()): string
{
    const stamp = now.toISOString().replace(/[:.]/g, '-');
    const out = join(dirname(path), `${basename(path, '.db')}.backup-${stamp}.db`);
    const db = new DatabaseSync(path, { readOnly: true });
    try
    {
        db.prepare('VACUUM INTO ?').run(out);
    }
    finally
    {
        db.close();
    }
    return out;
}

export function mergeReportLines(report: MergeReport): string[]
{
    const tables = ['runs', 'findings', 'consolidations', 'clusters', 'verifications', 'campaigns', 'jobs'] as const;
    const width = Math.max(...tables.map((table) => table.length));
    const lines = tables.map((table) =>
        `  ${table.padEnd(width)}  ${String(report[table].added).padStart(5)} added  ${String(report[table].shared).padStart(5)} shared`);
    if (report.jobsCancelled > 0)
    {
        lines.push(`  ${report.jobsCancelled} live source job(s) imported as cancelled`);
    }
    return lines;
}

export function mergeDatabases(targetPath: string, sourcePath: string): MergeReport
{
    // Opening each store runs its migrations, so an older file reaches the
    // current schema before any column list is read from it.
    for (const path of [targetPath, sourcePath])
    {
        new ReviewStore(path).close();
        new JobStore(path).close();
        new WatchStore(path).close();
    }

    const db = new DatabaseSync(targetPath);
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec('PRAGMA foreign_keys = ON');
    db.prepare('ATTACH DATABASE ? AS src').run(sourcePath);
    try
    {
        db.exec('BEGIN IMMEDIATE');
        try
        {
            const report = new Merger(db).run();
            db.exec('COMMIT');
            return report;
        }
        catch (error)
        {
            db.exec('ROLLBACK');
            throw error;
        }
    }
    finally
    {
        db.exec('DETACH DATABASE src');
        db.close();
    }
}

class Merger
{
    private readonly runs: IdMap = new Map();
    private readonly findings: IdMap = new Map();
    private readonly consolidations: IdMap = new Map();
    private readonly clusters: IdMap = new Map();
    private readonly campaigns: IdMap = new Map();
    private readonly report: MergeReport = {
        runs: count(), findings: count(), consolidations: count(), clusters: count(),
        verifications: count(), campaigns: count(), jobs: count(), jobsCancelled: 0,
    };

    constructor(private readonly db: DatabaseSync)
    {
    }

    run(): MergeReport
    {
        this.mergeRuns();
        this.mergeConsolidations();
        this.mergeVerifications();
        this.mergeCampaigns();
        this.mergeJobs();
        return this.report;
    }

    private mergeRuns(): void
    {
        for (const run of this.source('runs'))
        {
            const existing = this.match('runs', run, ['created_at', ...TARGET, 'model']);
            if (existing !== undefined)
            {
                this.runs.set(num(run.id), existing);
                this.report.runs.shared++;
                this.pair('findings', 'run_id', num(run.id), existing, this.findings, this.report.findings);
                continue;
            }
            const id = this.insert('runs', run, {});
            this.runs.set(num(run.id), id);
            this.report.runs.added++;
            for (const finding of this.source('findings', 'run_id = ?', run.id))
            {
                this.findings.set(num(finding.id), this.insert('findings', finding, { run_id: id }));
                this.report.findings.added++;
            }
        }
    }

    private mergeConsolidations(): void
    {
        for (const consolidation of this.source('consolidations'))
        {
            const existing = this.match('consolidations', consolidation, ['created_at', ...TARGET]);
            if (existing !== undefined)
            {
                this.consolidations.set(num(consolidation.id), existing);
                this.report.consolidations.shared++;
                this.pair('clusters', 'consolidation_id', num(consolidation.id), existing, this.clusters, this.report.clusters);
                continue;
            }
            const id = this.insert('consolidations', consolidation, {
                run_ids: remapList(this.runs, consolidation.run_ids, 'consolidation run'),
            });
            this.consolidations.set(num(consolidation.id), id);
            this.report.consolidations.added++;
            for (const cluster of this.source('clusters', 'consolidation_id = ?', consolidation.id))
            {
                const clusterId = this.insert('clusters', cluster, {
                    consolidation_id: id,
                    representative_finding_id: required(this.findings, cluster.representative_finding_id, 'representative finding'),
                });
                this.clusters.set(num(cluster.id), clusterId);
                this.report.clusters.added++;
                for (const member of this.source('cluster_members', 'cluster_id = ?', cluster.id, 'rowid'))
                {
                    this.insert('cluster_members', member, {
                        cluster_id: clusterId,
                        finding_id: required(this.findings, member.finding_id, 'cluster member'),
                    });
                }
            }
        }
    }

    // Verifications are matched individually, not paired under their
    // cluster: a shared cluster can have been re-verified on one machine
    // after the copy, and that later verdict is real history to keep.
    private mergeVerifications(): void
    {
        const touched = new Set<number>();
        for (const verification of this.source('verifications'))
        {
            const clusterId = required(this.clusters, verification.cluster_id, 'verified cluster');
            const existing = this.db.prepare(
                'SELECT id FROM main.verifications WHERE cluster_id = ? AND created_at = ? AND source = ?',
            ).get(clusterId, input(verification.created_at), input(verification.source));
            if (existing !== undefined)
            {
                this.report.verifications.shared++;
                continue;
            }
            this.insert('verifications', verification, { cluster_id: clusterId });
            this.report.verifications.added++;
            touched.add(clusterId);
        }
        // A cluster's status is its latest verdict; an imported verification
        // can be newer than anything the target recorded.
        for (const clusterId of touched)
        {
            this.db.prepare(
                `UPDATE main.clusters SET verification_status = (
                    SELECT verdict FROM main.verifications WHERE cluster_id = ? ORDER BY created_at DESC, id DESC LIMIT 1
                ) WHERE id = ?`,
            ).run(clusterId, clusterId);
        }
    }

    private mergeCampaigns(): void
    {
        for (const campaign of this.source('campaigns'))
        {
            const existing = this.match('campaigns', campaign, ['created_at', ...TARGET]);
            if (existing !== undefined)
            {
                this.campaigns.set(num(campaign.id), existing);
                this.report.campaigns.shared++;
                continue;
            }
            const id = this.insert('campaigns', campaign, {
                baseline_consolidation_id: remap(this.consolidations, campaign.baseline_consolidation_id, 'campaign baseline'),
            });
            this.campaigns.set(num(campaign.id), id);
            this.report.campaigns.added++;
            for (const round of this.source('campaign_rounds', 'campaign_id = ?', campaign.id, 'round'))
            {
                this.insert('campaign_rounds', round, {
                    campaign_id: id,
                    run_id: remap(this.runs, round.run_id, 'round run'),
                    consolidation_id: remap(this.consolidations, round.consolidation_id, 'round consolidation'),
                });
            }
        }
    }

    private mergeJobs(): void
    {
        for (const job of this.source('jobs'))
        {
            if (this.match('jobs', job, ['created_at', 'kind', ...TARGET]) !== undefined)
            {
                this.report.jobs.shared++;
                continue;
            }
            const live = job.state === 'held' || job.state === 'queued' || job.state === 'running';
            this.insert('jobs', job, {
                run_ids: remapList(this.runs, job.run_ids, 'job run'),
                consolidation_id: remap(this.consolidations, job.consolidation_id, 'job consolidation'),
                campaign_id: remap(this.campaigns, job.campaign_id, 'job campaign'),
                ...(live ? { state: 'cancelled', error: `imported ${String(job.state)} from another database; never ran here` } : {}),
            });
            this.report.jobs.added++;
            if (live)
            {
                this.report.jobsCancelled++;
            }
        }
    }

    // Children of a row both files hold: the nth source child is the nth
    // target child, since both were inserted in one transaction in order.
    private pair(table: string, parentColumn: string, sourceParent: number, targetParent: number, map: IdMap, tally: TableCount): void
    {
        const ids = (schema: string, parent: number): number[] =>
            this.db.prepare(`SELECT id FROM ${schema}.${table} WHERE ${parentColumn} = ? ORDER BY id`).all(parent).map(r => num(r.id));
        const sourceIds = ids('src', sourceParent);
        const targetIds = ids('main', targetParent);
        if (sourceIds.length !== targetIds.length)
        {
            throw new Error(
                `${parentColumn} ${sourceParent} matches target row ${targetParent} but has ${sourceIds.length} ${table} against ${targetIds.length}: the databases diverged after a copy`,
            );
        }
        sourceIds.forEach((id, i) => map.set(id, targetIds[i] as number));
        tally.shared += sourceIds.length;
    }

    private match(table: string, row: Row, key: readonly string[]): number | undefined
    {
        const where = key.map(column => `${column} = ?`).join(' AND ');
        const found = this.db.prepare(`SELECT id FROM main.${table} WHERE ${where}`).all(...key.map(column => input(row[column])));
        if (found.length > 1)
        {
            throw new Error(`${table} key (${key.join(', ')}) is not unique in the target: ${found.length} rows`);
        }
        return found[0] === undefined ? undefined : num(found[0].id);
    }

    private source(table: string, where = '1', param: SQLOutputValue = null, order = 'id'): Row[]
    {
        const statement = this.db.prepare(`SELECT * FROM src.${table} WHERE ${where} ORDER BY ${order}`);
        return (where === '1' ? statement.all() : statement.all(input(param))) as Row[];
    }

    // Copies every column but id; overrides carry the remapped references.
    private insert(table: string, row: Row, overrides: Record<string, SQLInputValue>): number
    {
        const columns = Object.keys(row).filter(column => column !== 'id');
        const values = columns.map(column => column in overrides ? overrides[column] as SQLInputValue : input(row[column]));
        const result = this.db.prepare(
            `INSERT INTO main.${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
        ).run(...values);
        return Number(result.lastInsertRowid);
    }
}

function count(): TableCount
{
    return { added: 0, shared: 0 };
}

function num(value: SQLOutputValue | undefined): number
{
    if (typeof value !== 'number')
    {
        throw new Error(`Expected a numeric id, got ${String(value)}`);
    }
    return value;
}

function input(value: SQLOutputValue | undefined): SQLInputValue
{
    return value === undefined ? null : value;
}

// A reference the map can't resolve is an orphan in the source — the
// foreign keys should have made that impossible, so it fails loudly.
function remap(map: IdMap, value: SQLOutputValue | undefined, what: string): number | null
{
    if (value === null || value === undefined)
    {
        return null;
    }
    const mapped = map.get(num(value));
    if (mapped === undefined)
    {
        throw new Error(`Source ${what} ${String(value)} references a row the merge never saw`);
    }
    return mapped;
}

function required(map: IdMap, value: SQLOutputValue | undefined, what: string): number
{
    const mapped = remap(map, value, what);
    if (mapped === null)
    {
        throw new Error(`Source ${what} is missing a reference the schema requires`);
    }
    return mapped;
}

function remapList(map: IdMap, value: SQLOutputValue | undefined, what: string): string
{
    const ids: unknown = JSON.parse(String(value));
    if (!Array.isArray(ids))
    {
        throw new Error(`Source ${what} list is not an array: ${String(value)}`);
    }
    return JSON.stringify(ids.map(id =>
    {
        if (typeof id !== 'number')
        {
            throw new Error(`Source ${what} list holds a non-numeric id: ${String(value)}`);
        }
        return required(map, id, what);
    }));
}
