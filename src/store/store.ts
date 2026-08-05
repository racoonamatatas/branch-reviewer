// Run history on the built-in node:sqlite (Node ≥ 24) — no native dependency.
// Findings are stored relationally, one row each, because the future
// cross-run comparison needs to query them; a JSON blob would wall that off.

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Finding, Review, Severity } from '../schema/schema.js';
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
    id: number;
}

export interface RunSummary
{
    id: number;
    createdAt: string;
    target: string;  // "owner/repo head → base"
    status: 'submitted' | 'aborted';
    findingsCount: number;
    costUsd: number;
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
        this.db.exec(SCHEMA);
    }

    saveRun(record: RunRecord): number
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
            const runId = Number(result.lastInsertRowid);

            const insertFinding = this.db.prepare(
                'INSERT INTO findings (run_id, file, line, severity, title, detail, suggestion) VALUES (?, ?, ?, ?, ?, ?, ?)',
            );
            for (const f of record.review?.findings ?? [])
            {
                insertFinding.run(runId, f.file, f.line ?? null, f.severity, f.title, f.detail, f.suggestion ?? null);
            }

            this.db.exec('COMMIT');
            return runId;
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
            id: row.id,
            createdAt: row.created_at,
            target: `${row.owner}/${row.repo} ${row.head} → ${row.base}`,
            status: row.status as RunSummary['status'],
            findingsCount: row.findings_count,
            costUsd: row.cost_usd,
        }));
    }

    getRun(id: number): StoredRun | undefined
    {
        const row = this.db.prepare('SELECT * FROM runs WHERE id = ?').get(id) as unknown as RunRow | undefined;
        if (row === undefined)
        {
            return undefined;
        }

        const findingRows = this.db.prepare(
            'SELECT file, line, severity, title, detail, suggestion FROM findings WHERE run_id = ? ORDER BY id',
        ).all(id) as unknown as FindingRow[];

        const findings: Finding[] = findingRows.map(f => ({
            file: f.file,
            ...(f.line !== null ? { line: f.line } : {}),
            severity: f.severity as Severity,
            title: f.title,
            detail: f.detail,
            ...(f.suggestion !== null ? { suggestion: f.suggestion } : {}),
        }));

        return {
            id: row.id,
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

    close(): void
    {
        this.db.close();
    }
}
