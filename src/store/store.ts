// Run history on the built-in node:sqlite (Node ≥ 24) — no native dependency.
// Findings are stored relationally, one row each, because the future
// cross-run comparison needs to query them; a JSON blob would wall that off.

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Finding, Review, Severity } from '../schema/schema.js';
import { clusterId, consolidationId, findingId, runId } from '../types/ids.js';
import type { ClusterId, ConsolidationId, FindingId, RunId } from '../types/ids.js';
import type { TokenUsage } from '../usage/usage.js';

export const DEFAULT_DB_PATH = 'data/reviews.db';

export interface RunRecord
{
    createdAt: string;  // ISO 8601
    owner: string;
    repo: string;
    head: string;
    base: string;
    model: string;
    status: 'submitted' | 'aborted';
    reason?: string;
    review?: Review;
    turns: number;
    costUsd: number;
    usage: TokenUsage;
}

export interface StoredRun extends RunRecord
{
    id: RunId;
}

export interface RunSummary
{
    id: RunId;
    createdAt: string;
    target: string;  // "owner/repo head → base"
    status: 'submitted' | 'aborted';
    findingsCount: number;
    costUsd: number;
}

export interface StoredFinding extends Finding
{
    id: FindingId;
    runId: RunId;
}

export interface ConsolidationRecord
{
    createdAt: string;
    owner: string;
    repo: string;
    head: string;
    base: string;
    runIds: RunId[];
    clusters: Array<{
        memberIds: FindingId[];
        representativeId: FindingId;
        severity: Severity;
        occurrence: number;
    }>;
}

export interface StoredCluster
{
    id: ClusterId;
    severity: Severity;
    occurrence: number;
    verificationStatus: 'pending' | 'confirmed' | 'refuted';
    representative: StoredFinding;
    members: StoredFinding[];
}

export interface StoredConsolidation
{
    id: ConsolidationId;
    createdAt: string;
    owner: string;
    repo: string;
    head: string;
    base: string;
    runIds: RunId[];
    clusters: StoredCluster[];
}

export interface ConsolidationSummary
{
    id: ConsolidationId;
    createdAt: string;
    target: string;
    runIds: RunId[];
    clusterCount: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL,
    owner TEXT NOT NULL,
    repo TEXT NOT NULL,
    head TEXT NOT NULL,
    base TEXT NOT NULL,
    model TEXT NOT NULL,
    status TEXT NOT NULL,
    reason TEXT,
    summary TEXT,
    turns INTEGER NOT NULL,
    cost_usd REAL NOT NULL,
    input_tokens INTEGER NOT NULL,
    output_tokens INTEGER NOT NULL,
    cache_read_tokens INTEGER NOT NULL,
    cache_creation_tokens INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS findings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id INTEGER NOT NULL REFERENCES runs(id),
    file TEXT NOT NULL,
    line INTEGER,
    severity TEXT NOT NULL,
    title TEXT NOT NULL,
    detail TEXT NOT NULL,
    suggestion TEXT
);
CREATE TABLE IF NOT EXISTS consolidations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL,
    owner TEXT NOT NULL,
    repo TEXT NOT NULL,
    head TEXT NOT NULL,
    base TEXT NOT NULL,
    run_ids TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS clusters (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    consolidation_id INTEGER NOT NULL REFERENCES consolidations(id),
    representative_finding_id INTEGER NOT NULL REFERENCES findings(id),
    severity TEXT NOT NULL,
    occurrence INTEGER NOT NULL,
    verification_status TEXT NOT NULL DEFAULT 'pending'
);
CREATE TABLE IF NOT EXISTS cluster_members (
    cluster_id INTEGER NOT NULL REFERENCES clusters(id),
    finding_id INTEGER NOT NULL REFERENCES findings(id)
);
`;

interface RunRow
{
    id: number;
    created_at: string;
    owner: string;
    repo: string;
    head: string;
    base: string;
    model: string;
    status: string;
    reason: string | null;
    summary: string | null;
    turns: number;
    cost_usd: number;
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens: number;
    cache_creation_tokens: number;
}

interface FindingRow
{
    file: string;
    line: number | null;
    severity: string;
    title: string;
    detail: string;
    suggestion: string | null;
}

export class ReviewStore
{
    private readonly db: DatabaseSync;

    constructor(path: string)
    {
        if (path !== ':memory:')
        {
            mkdirSync(dirname(path), { recursive: true });
        }
        this.db = new DatabaseSync(path);
        this.migrateLegacyMergeTables();
        this.db.exec(SCHEMA);
    }

    // Databases from before the terminology sweep carry a `merges` table and
    // a clusters.merge_id column. Rename in place — the stored runs and
    // consolidations are the eval seed data and must survive.
    private migrateLegacyMergeTables(): void
    {
        const legacy = this.db.prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'merges'",
        ).get();
        if (legacy !== undefined)
        {
            this.db.exec('ALTER TABLE merges RENAME TO consolidations');
            this.db.exec('ALTER TABLE clusters RENAME COLUMN merge_id TO consolidation_id');
        }
    }

    saveRun(record: RunRecord): RunId
    {
        this.db.exec('BEGIN');
        try
        {
            const result = this.db.prepare(
                `INSERT INTO runs (created_at, owner, repo, head, base, model, status, reason, summary,
                                   turns, cost_usd, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            ).run(
                record.createdAt, record.owner, record.repo, record.head, record.base,
                record.model, record.status, record.reason ?? null, record.review?.summary ?? null,
                record.turns, record.costUsd,
                record.usage.inputTokens, record.usage.outputTokens,
                record.usage.cacheReadInputTokens, record.usage.cacheCreationInputTokens,
            );
            const id = runId(Number(result.lastInsertRowid));

            const insertFinding = this.db.prepare(
                'INSERT INTO findings (run_id, file, line, severity, title, detail, suggestion) VALUES (?, ?, ?, ?, ?, ?, ?)',
            );
            for (const f of record.review?.findings ?? [])
            {
                insertFinding.run(id, f.file, f.line ?? null, f.severity, f.title, f.detail, f.suggestion ?? null);
            }

            this.db.exec('COMMIT');
            return id;
        }
        catch (error)
        {
            this.db.exec('ROLLBACK');
            throw error;
        }
    }

    listRuns(): RunSummary[]
    {
        const rows = this.db.prepare(
            `SELECT r.id, r.created_at, r.owner, r.repo, r.head, r.base, r.status, r.cost_usd,
                    COUNT(f.id) AS findings_count
             FROM runs r LEFT JOIN findings f ON f.run_id = r.id
             GROUP BY r.id
             ORDER BY r.id DESC`,
        ).all() as unknown as Array<RunRow & { findings_count: number }>;

        return rows.map(row => ({
            id: runId(row.id),
            createdAt: row.created_at,
            target: `${row.owner}/${row.repo} ${row.head} → ${row.base}`,
            status: row.status as RunSummary['status'],
            findingsCount: row.findings_count,
            costUsd: row.cost_usd,
        }));
    }

    getRun(id: RunId): StoredRun | undefined
    {
        const row = this.db.prepare('SELECT * FROM runs WHERE id = ?').get(id) as unknown as RunRow | undefined;
        if (row === undefined)
        {
            return undefined;
        }

        const findingRows = this.db.prepare(
            'SELECT file, line, severity, title, detail, suggestion FROM findings WHERE run_id = ? ORDER BY id',
        ).all(id) as unknown as FindingRow[];

        const findings: Finding[] = findingRows.map(toFinding);

        return {
            id: runId(row.id),
            createdAt: row.created_at,
            owner: row.owner,
            repo: row.repo,
            head: row.head,
            base: row.base,
            model: row.model,
            status: row.status as StoredRun['status'],
            ...(row.reason !== null ? { reason: row.reason } : {}),
            ...(row.summary !== null ? { review: { summary: row.summary, findings } } : {}),
            turns: row.turns,
            costUsd: row.cost_usd,
            usage: {
                inputTokens: row.input_tokens,
                outputTokens: row.output_tokens,
                cacheReadInputTokens: row.cache_read_tokens,
                cacheCreationInputTokens: row.cache_creation_tokens,
            },
        };
    }

    // Findings with their DB identity and run provenance — the consolidation input.
    getFindings(run: RunId): StoredFinding[]
    {
        const rows = this.db.prepare(
            'SELECT id, run_id, file, line, severity, title, detail, suggestion FROM findings WHERE run_id = ? ORDER BY id',
        ).all(run) as unknown as Array<FindingRow & { id: number; run_id: number }>;
        return rows.map(row => ({ id: findingId(row.id), runId: runId(row.run_id), ...toFinding(row) }));
    }

    saveConsolidation(record: ConsolidationRecord): ConsolidationId
    {
        this.db.exec('BEGIN');
        try
        {
            const result = this.db.prepare(
                'INSERT INTO consolidations (created_at, owner, repo, head, base, run_ids) VALUES (?, ?, ?, ?, ?, ?)',
            ).run(
                record.createdAt, record.owner, record.repo, record.head, record.base,
                JSON.stringify(record.runIds),
            );
            const id = consolidationId(Number(result.lastInsertRowid));

            const insertCluster = this.db.prepare(
                'INSERT INTO clusters (consolidation_id, representative_finding_id, severity, occurrence) VALUES (?, ?, ?, ?)',
            );
            const insertMember = this.db.prepare(
                'INSERT INTO cluster_members (cluster_id, finding_id) VALUES (?, ?)',
            );
            for (const cluster of record.clusters)
            {
                const newClusterId = clusterId(Number(insertCluster.run(
                    id, cluster.representativeId, cluster.severity, cluster.occurrence,
                ).lastInsertRowid));
                for (const memberId of cluster.memberIds)
                {
                    insertMember.run(newClusterId, memberId);
                }
            }

            this.db.exec('COMMIT');
            return id;
        }
        catch (error)
        {
            this.db.exec('ROLLBACK');
            throw error;
        }
    }

    listConsolidations(): ConsolidationSummary[]
    {
        const rows = this.db.prepare(
            `SELECT m.id, m.created_at, m.owner, m.repo, m.head, m.base, m.run_ids,
                    COUNT(c.id) AS cluster_count
             FROM consolidations m LEFT JOIN clusters c ON c.consolidation_id = m.id
             GROUP BY m.id
             ORDER BY m.id DESC`,
        ).all() as unknown as Array<{
            id: number; created_at: string; owner: string; repo: string; head: string; base: string;
            run_ids: string; cluster_count: number;
        }>;

        return rows.map(row => ({
            id: consolidationId(row.id),
            createdAt: row.created_at,
            target: `${row.owner}/${row.repo} ${row.head} → ${row.base}`,
            runIds: (JSON.parse(row.run_ids) as number[]).map(runId),
            clusterCount: row.cluster_count,
        }));
    }

    getConsolidation(id: ConsolidationId): StoredConsolidation | undefined
    {
        const row = this.db.prepare('SELECT * FROM consolidations WHERE id = ?').get(id) as unknown as {
            id: number; created_at: string; owner: string; repo: string; head: string; base: string; run_ids: string;
        } | undefined;
        if (row === undefined)
        {
            return undefined;
        }

        const clusterRows = this.db.prepare(
            'SELECT id, representative_finding_id, severity, occurrence, verification_status FROM clusters WHERE consolidation_id = ? ORDER BY id',
        ).all(id) as unknown as Array<{
            id: number; representative_finding_id: number; severity: string; occurrence: number; verification_status: string;
        }>;

        const memberQuery = this.db.prepare(
            `SELECT f.id, f.run_id, f.file, f.line, f.severity, f.title, f.detail, f.suggestion
             FROM cluster_members cm JOIN findings f ON f.id = cm.finding_id
             WHERE cm.cluster_id = ? ORDER BY f.id`,
        );

        const clusters: StoredCluster[] = clusterRows.map(c =>
        {
            const members = (memberQuery.all(c.id) as unknown as Array<FindingRow & { id: number; run_id: number }>)
                .map(m => ({ id: findingId(m.id), runId: runId(m.run_id), ...toFinding(m) }));
            const representative = members.find(m => m.id === c.representative_finding_id);
            if (representative === undefined)
            {
                throw new Error(`Cluster #${c.id}: representative finding ${c.representative_finding_id} is not among its members.`);
            }
            return {
                id: clusterId(c.id),
                severity: c.severity as Severity,
                occurrence: c.occurrence,
                verificationStatus: c.verification_status as StoredCluster['verificationStatus'],
                representative,
                members,
            };
        });

        return {
            id: consolidationId(row.id),
            createdAt: row.created_at,
            owner: row.owner,
            repo: row.repo,
            head: row.head,
            base: row.base,
            runIds: (JSON.parse(row.run_ids) as number[]).map(runId),
            clusters,
        };
    }

    close(): void
    {
        this.db.close();
    }
}

function toFinding(row: FindingRow): Finding
{
    return {
        file: row.file,
        ...(row.line !== null ? { line: row.line } : {}),
        severity: row.severity as Severity,
        title: row.title,
        detail: row.detail,
        ...(row.suggestion !== null ? { suggestion: row.suggestion } : {}),
    };
}
