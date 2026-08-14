// Run history on the built-in node:sqlite (Node ≥ 24) — no native dependency.
// Findings are stored relationally, one row each, because the future
// cross-run comparison needs to query them; a JSON blob would wall that off.

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Confidence, NewFinding, Review, Severity } from '../schema/schema.js';
import type { Created, Identified, New } from '../types/common.js';
import { clusterId, consolidationId, findingId, runId, verificationId } from '../types/ids.js';
import type { ClusterId, ConsolidationId, FindingId, RunId, VerificationId } from '../types/ids.js';
import type { TokenUsage } from '../usage/usage.js';

export const DEFAULT_DB_PATH = 'data/reviews.db';

// Entities carry the bare noun; New* shapes for the create calls derive down
// from them by subtraction. createdAt is store-assigned, exactly like id —
// saveRun and saveConsolidation stamp it, callers never pass it.

export interface Run extends Identified<'Run'>, Created
{
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
    // How many files the branch diff touched. Absent on rows saved before
    // the column existed; 0 is the empty-diff tell (merged or stale head).
    filesChanged?: number;
}

export type NewRun = New<Run>;

export interface RunSummary extends Pick<Run, 'id' | 'createdAt' | 'status' | 'turns' | 'costUsd' | 'filesChanged'>
{
    target: string;  // "owner/repo head → base"
    findingsCount: number;
}

// The dashboard's coordinates for "this branch" — the same triple the trigger
// dedupes jobs on. All-or-nothing at the HTTP edge: filtering by owner alone
// would silently mix branches. `base` is the optional fourth coordinate:
// review series of one head against different bases are different
// experiments, and internal callers (consolidation, verification reuse) pin
// it; the HTTP edge keys on the triple the dashboard navigates by.
export interface TargetFilter
{
    owner: string;
    repo: string;
    head: string;
    base?: string;
}

// One reviewed branch aggregated across its runs. A view, not an entity:
// nothing here owns an id or a createdAt — every field is derived from runs
// and consolidations, so there is no Identified/Created mixin to earn.
export interface TargetSummary extends TargetFilter
{
    base: string;
    runCount: number;
    lastRunAt: string;
    totalCostUsd: number;
    latestConsolidationId?: ConsolidationId;
}

export interface Finding extends Identified<'Finding'>
{
    runId: RunId;
    file: string;
    line?: number;
    severity: Severity;
    confidence?: Confidence;  // absent on findings stored before the field existed
    title: string;
    detail: string;
    suggestion?: string;
}

export interface Consolidation extends Identified<'Consolidation'>, Created
{
    owner: string;
    repo: string;
    head: string;
    base: string;
    runIds: RunId[];
    // What the clustering judge billed, retries included. Absent on
    // consolidations from before judge calls were metered.
    costUsd?: number;
    clusters: Cluster[];
}

export interface Cluster extends Identified<'Cluster'>
{
    severity: Severity;
    occurrence: number;
    verificationStatus: VerificationStatus;
    // A verdict a strict subset of this cluster's members earned in an
    // earlier consolidation, which re-clustering lapsed: the merged group is
    // a different claim, so the verdict does not inherit — but without this
    // trace the cluster would sit pending forever, invisible to the
    // occurrence-1 verification gate. Context for the verifier, never status.
    lapsedVerdict?: Verdict;
    representative: Finding;
    members: Finding[];
}

export type Verdict = 'confirmed' | 'refuted' | 'undetermined';
export type VerificationStatus = 'pending' | Verdict;  // a verdict, or not yet

// Provenance is a discriminated union, not optional fields: an agent verdict
// always has a confidence self-assessment and a price, a human verdict never
// does, and no row may claim both halves. Humans stamp confirmed or refuted
// only — undetermined is the machine's honest "I don't know", and a human who
// doesn't know simply doesn't stamp.
interface VerificationBase extends Identified<'Verification'>, Created
{
    clusterId: ClusterId;
    verdict: Verdict;
    rationale: string;
}

export interface AgentVerification extends VerificationBase
{
    source: 'agent';
    confidence: string;
    costUsd: number;
}

export interface HumanVerification extends VerificationBase
{
    source: 'human';
    verdict: Exclude<Verdict, 'undetermined'>;
}

export type Verification = AgentVerification | HumanVerification;

export type NewVerification = New<AgentVerification> | New<HumanVerification>;

// A defect's stable identity across consolidations. Cluster rows are one
// judge call's opinion and get new ids every time the same runs are
// re-clustered; the set of findings they group does not. Sorted so two
// judges listing the same members in different orders still match.
export function memberSetKey(findingIds: FindingId[]): string
{
    return [...findingIds].sort((a, b) => a - b).join(',');
}

// A cluster at create time references its findings by id; the entity carries
// them materialized. That difference is real shape, not server assignment,
// so NewCluster is declared rather than derived.
export interface NewCluster
{
    memberIds: FindingId[];
    representativeId: FindingId;
    severity: Severity;
    occurrence: number;
}

export type NewConsolidation = Omit<New<Consolidation>, 'clusters'> & { clusters: NewCluster[] };

export interface ConsolidationSummary extends Pick<Consolidation, 'id' | 'createdAt' | 'runIds'>
{
    target: string;
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
    cache_creation_tokens INTEGER NOT NULL,
    files_changed INTEGER
);
CREATE TABLE IF NOT EXISTS findings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id INTEGER NOT NULL REFERENCES runs(id),
    file TEXT NOT NULL,
    line INTEGER,
    severity TEXT NOT NULL,
    confidence TEXT,
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
    run_ids TEXT NOT NULL,
    cost_usd REAL
);
CREATE TABLE IF NOT EXISTS clusters (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    consolidation_id INTEGER NOT NULL REFERENCES consolidations(id),
    representative_finding_id INTEGER NOT NULL REFERENCES findings(id),
    severity TEXT NOT NULL,
    occurrence INTEGER NOT NULL,
    verification_status TEXT NOT NULL DEFAULT 'pending',
    lapsed_verdict TEXT
);
CREATE TABLE IF NOT EXISTS cluster_members (
    cluster_id INTEGER NOT NULL REFERENCES clusters(id),
    finding_id INTEGER NOT NULL REFERENCES findings(id)
);
CREATE TABLE IF NOT EXISTS verifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cluster_id INTEGER NOT NULL REFERENCES clusters(id),
    created_at TEXT NOT NULL,
    source TEXT NOT NULL CHECK (source IN ('agent', 'human')),
    verdict TEXT NOT NULL,
    rationale TEXT NOT NULL,
    confidence TEXT,
    cost_usd REAL,
    CHECK ((source = 'agent') = (confidence IS NOT NULL AND cost_usd IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_findings_run ON findings(run_id);
CREATE INDEX IF NOT EXISTS idx_clusters_consolidation ON clusters(consolidation_id);
CREATE INDEX IF NOT EXISTS idx_cluster_members_cluster ON cluster_members(cluster_id);
CREATE INDEX IF NOT EXISTS idx_verifications_cluster ON verifications(cluster_id);
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
    files_changed: number | null;
}

interface FindingRow
{
    file: string;
    line: number | null;
    severity: string;
    confidence: string | null;
    title: string;
    detail: string;
    suggestion: string | null;
}

interface VerificationRow
{
    id: number;
    cluster_id: number;
    created_at: string;
    source: string;
    verdict: string;
    rationale: string;
    confidence: string | null;
    cost_usd: number | null;
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
        // The server runs two connections against one file (the worker here,
        // HTTP handlers in JobStore); a locked write must wait, not throw
        // SQLITE_BUSY.
        this.db.exec('PRAGMA busy_timeout = 5000');
        // Off by default in SQLite, per connection — without this every
        // REFERENCES in the schema is decorative and an orphan row is found
        // at read time instead of refused at write time.
        this.db.exec('PRAGMA foreign_keys = ON');
        this.migrateLegacyMergeTables();
        this.migrateVerificationProvenance();
        this.db.exec(SCHEMA);
        this.migrateRunFilesChanged();
        this.migrateFindingConfidence();
        this.migrateClusterLapsedVerdict();
        this.migrateConsolidationCost();
    }

    // Databases from before the recall-first prompt lack the column; old
    // findings honestly stay NULL — "the reviewer was not asked", not "low".
    private migrateFindingConfidence(): void
    {
        const columns = this.db.prepare('SELECT name FROM pragma_table_info(?)').all('findings') as unknown as Array<{ name: string }>;
        if (!columns.some(c => c.name === 'confidence'))
        {
            this.db.exec('ALTER TABLE findings ADD COLUMN confidence TEXT');
        }
    }

    // Old cluster rows never tracked lapsed verdicts; NULL is accurate for
    // them — the tracking did not exist when they were written.
    private migrateClusterLapsedVerdict(): void
    {
        const columns = this.db.prepare('SELECT name FROM pragma_table_info(?)').all('clusters') as unknown as Array<{ name: string }>;
        if (!columns.some(c => c.name === 'lapsed_verdict'))
        {
            this.db.exec('ALTER TABLE clusters ADD COLUMN lapsed_verdict TEXT');
        }
    }

    // Judge calls billed real credit before anyone metered them; NULL says
    // "unmetered", which is the truth about those rows — not zero.
    private migrateConsolidationCost(): void
    {
        const columns = this.db.prepare('SELECT name FROM pragma_table_info(?)').all('consolidations') as unknown as Array<{ name: string }>;
        if (!columns.some(c => c.name === 'cost_usd'))
        {
            this.db.exec('ALTER TABLE consolidations ADD COLUMN cost_usd REAL');
        }
    }

    // Databases from before the empty-diff tell existed lack the column; the
    // nullable ADD COLUMN is the whole migration, and old rows honestly stay
    // NULL — "unknown", not "zero".
    private migrateRunFilesChanged(): void
    {
        const columns = this.db.prepare('SELECT name FROM pragma_table_info(?)').all('runs') as unknown as Array<{ name: string }>;
        if (!columns.some(c => c.name === 'files_changed'))
        {
            this.db.exec('ALTER TABLE runs ADD COLUMN files_changed INTEGER');
        }
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

    // Databases from before human verdicts existed lack the source column,
    // and every row in them was written by the verifier. SQLite cannot relax
    // NOT NULL in place, so the table is rebuilt around the new CHECKed
    // shape; ids are copied verbatim because member-set inheritance and the
    // latest-wins rule both order by them.
    private migrateVerificationProvenance(): void
    {
        const table = this.db.prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'verifications'",
        ).get();
        if (table === undefined)
        {
            return;
        }
        const columns = this.db.prepare('SELECT name FROM pragma_table_info(?)').all('verifications') as unknown as Array<{ name: string }>;
        if (columns.some(c => c.name === 'source'))
        {
            return;
        }
        this.db.exec(`
            BEGIN;
            ALTER TABLE verifications RENAME TO verifications_legacy;
            CREATE TABLE verifications (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                cluster_id INTEGER NOT NULL REFERENCES clusters(id),
                created_at TEXT NOT NULL,
                source TEXT NOT NULL CHECK (source IN ('agent', 'human')),
                verdict TEXT NOT NULL,
                rationale TEXT NOT NULL,
                confidence TEXT,
                cost_usd REAL,
                CHECK ((source = 'agent') = (confidence IS NOT NULL AND cost_usd IS NOT NULL))
            );
            INSERT INTO verifications (id, cluster_id, created_at, source, verdict, rationale, confidence, cost_usd)
                SELECT id, cluster_id, created_at, 'agent', verdict, rationale, confidence, cost_usd
                FROM verifications_legacy;
            DROP TABLE verifications_legacy;
            COMMIT;
        `);
    }

    saveRun(run: NewRun): RunId
    {
        this.db.exec('BEGIN');
        try
        {
            const result = this.db.prepare(
                `INSERT INTO runs (created_at, owner, repo, head, base, model, status, reason, summary,
                                   turns, cost_usd, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
                                   files_changed)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            ).run(
                new Date().toISOString(), run.owner, run.repo, run.head, run.base,
                run.model, run.status, run.reason ?? null, run.review?.summary ?? null,
                run.turns, run.costUsd,
                run.usage.inputTokens, run.usage.outputTokens,
                run.usage.cacheReadInputTokens, run.usage.cacheCreationInputTokens,
                run.filesChanged ?? null,
            );
            const id = runId(Number(result.lastInsertRowid));

            const insertFinding = this.db.prepare(
                'INSERT INTO findings (run_id, file, line, severity, confidence, title, detail, suggestion) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            );
            for (const f of run.review?.findings ?? [])
            {
                insertFinding.run(id, f.file, f.line ?? null, f.severity, f.confidence ?? null, f.title, f.detail, f.suggestion ?? null);
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

    listRuns(filter?: TargetFilter): RunSummary[]
    {
        const where = filter === undefined
            ? ''
            : `WHERE r.owner = ? AND r.repo = ? AND r.head = ?${filter.base !== undefined ? ' AND r.base = ?' : ''}`;
        const params = filter === undefined
            ? []
            : [filter.owner, filter.repo, filter.head, ...(filter.base !== undefined ? [filter.base] : [])];
        const rows = this.db.prepare(
            `SELECT r.id, r.created_at, r.owner, r.repo, r.head, r.base, r.status, r.turns, r.cost_usd, r.files_changed,
                    COUNT(f.id) AS findings_count
             FROM runs r LEFT JOIN findings f ON f.run_id = r.id
             ${where}
             GROUP BY r.id
             ORDER BY r.id DESC`,
        ).all(...params) as unknown as Array<RunRow & { findings_count: number }>;

        return rows.map(row => ({
            id: runId(row.id),
            createdAt: row.created_at,
            target: `${row.owner}/${row.repo} ${row.head} → ${row.base}`,
            status: row.status as RunSummary['status'],
            findingsCount: row.findings_count,
            turns: row.turns,
            costUsd: row.cost_usd,
            ...(row.files_changed !== null ? { filesChanged: row.files_changed } : {}),
        }));
    }

    // Grouped by the full quad (base included) so two review series of one
    // branch against different bases stay separate rows; the filter methods
    // key on the triple because that is what callers navigate by.
    listTargets(): TargetSummary[]
    {
        // The total is everything the target has billed: runs, judge calls
        // (NULL for pre-metering rows — honestly uncounted), and agent
        // verifications, which hang off each consolidation's own cluster rows
        // so re-clustering never double-counts them.
        const rows = this.db.prepare(
            `SELECT r.owner, r.repo, r.head, r.base,
                    COUNT(*) AS run_count,
                    MAX(r.created_at) AS last_run_at,
                    SUM(r.cost_usd)
                    + COALESCE((SELECT SUM(c.cost_usd) FROM consolidations c
                                WHERE c.owner = r.owner AND c.repo = r.repo AND c.head = r.head AND c.base = r.base), 0)
                    + COALESCE((SELECT SUM(v.cost_usd) FROM verifications v
                                JOIN clusters cl ON cl.id = v.cluster_id
                                JOIN consolidations c2 ON c2.id = cl.consolidation_id
                                WHERE c2.owner = r.owner AND c2.repo = r.repo AND c2.head = r.head AND c2.base = r.base), 0)
                    AS total_cost_usd,
                    (SELECT MAX(c.id) FROM consolidations c
                     WHERE c.owner = r.owner AND c.repo = r.repo AND c.head = r.head AND c.base = r.base) AS latest_consolidation_id
             FROM runs r
             GROUP BY r.owner, r.repo, r.head, r.base
             ORDER BY MAX(r.id) DESC`,
        ).all() as unknown as Array<{
            owner: string; repo: string; head: string; base: string;
            run_count: number; last_run_at: string; total_cost_usd: number;
            latest_consolidation_id: number | null;
        }>;

        return rows.map(row => ({
            owner: row.owner,
            repo: row.repo,
            head: row.head,
            base: row.base,
            runCount: row.run_count,
            lastRunAt: row.last_run_at,
            totalCostUsd: row.total_cost_usd,
            ...(row.latest_consolidation_id !== null
                ? { latestConsolidationId: consolidationId(row.latest_consolidation_id) }
                : {}),
        }));
    }

    getRun(id: RunId): Run | undefined
    {
        const row = this.db.prepare('SELECT * FROM runs WHERE id = ?').get(id) as unknown as RunRow | undefined;
        if (row === undefined)
        {
            return undefined;
        }

        const findingRows = this.db.prepare(
            'SELECT file, line, severity, confidence, title, detail, suggestion FROM findings WHERE run_id = ? ORDER BY id',
        ).all(id) as unknown as FindingRow[];

        const findings: NewFinding[] = findingRows.map(toFinding);

        return {
            id: runId(row.id),
            createdAt: row.created_at,
            owner: row.owner,
            repo: row.repo,
            head: row.head,
            base: row.base,
            model: row.model,
            status: row.status as Run['status'],
            ...(row.reason !== null ? { reason: row.reason } : {}),
            ...(row.summary !== null ? { review: { summary: row.summary, findings } } : {}),
            ...(row.files_changed !== null ? { filesChanged: row.files_changed } : {}),
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
    getFindings(run: RunId): Finding[]
    {
        const rows = this.db.prepare(
            'SELECT id, run_id, file, line, severity, confidence, title, detail, suggestion FROM findings WHERE run_id = ? ORDER BY id',
        ).all(run) as unknown as Array<FindingRow & { id: number; run_id: number }>;
        return rows.map(row => ({ id: findingId(row.id), runId: runId(row.run_id), ...toFinding(row) }));
    }

    saveConsolidation(consolidation: NewConsolidation): ConsolidationId
    {
        // Verdicts are earned by a defect, not by the cluster row that
        // happened to represent it, so a re-clustering of the same findings
        // starts from what is already known instead of re-buying it. Exact
        // member-set matches only: a group the judge split or merged is a
        // different claim, and pending is the honest answer there. But a
        // merge must not bury the old answer either — a refuted singleton
        // absorbed into a bigger cluster would otherwise sit pending forever,
        // past the occurrence-1 verification gate. Strict supersets record
        // the lapsed verdict so the queue can re-test them with that context.
        const inherited = this.verdictsByMemberSet();
        const adjudicated = [...inherited].map(([key, verdict]) => ({
            ids: key.split(',').map(Number),
            verdict,
        }));

        this.db.exec('BEGIN');
        try
        {
            const result = this.db.prepare(
                'INSERT INTO consolidations (created_at, owner, repo, head, base, run_ids, cost_usd) VALUES (?, ?, ?, ?, ?, ?, ?)',
            ).run(
                new Date().toISOString(), consolidation.owner, consolidation.repo, consolidation.head, consolidation.base,
                JSON.stringify(consolidation.runIds), consolidation.costUsd ?? null,
            );
            const id = consolidationId(Number(result.lastInsertRowid));

            const insertCluster = this.db.prepare(
                `INSERT INTO clusters (consolidation_id, representative_finding_id, severity, occurrence, verification_status, lapsed_verdict)
                 VALUES (?, ?, ?, ?, ?, ?)`,
            );
            const insertMember = this.db.prepare(
                'INSERT INTO cluster_members (cluster_id, finding_id) VALUES (?, ?)',
            );
            for (const cluster of consolidation.clusters)
            {
                const status = inherited.get(memberSetKey(cluster.memberIds));
                // Only when nothing inherits exactly: iteration order is
                // verification order, so of several lapsed subsets the most
                // recently earned verdict wins — same latest-wins rule as
                // inheritance itself.
                let lapsed: Verdict | undefined;
                if (status === undefined)
                {
                    const memberSet = new Set<number>(cluster.memberIds);
                    for (const past of adjudicated)
                    {
                        if (past.ids.length < memberSet.size && past.ids.every(fid => memberSet.has(fid)))
                        {
                            lapsed = past.verdict;
                        }
                    }
                }
                const newClusterId = clusterId(Number(insertCluster.run(
                    id, cluster.representativeId, cluster.severity, cluster.occurrence,
                    status ?? 'pending', lapsed ?? null,
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

    listConsolidations(filter?: TargetFilter): ConsolidationSummary[]
    {
        const where = filter === undefined
            ? ''
            : `WHERE m.owner = ? AND m.repo = ? AND m.head = ?${filter.base !== undefined ? ' AND m.base = ?' : ''}`;
        const params = filter === undefined
            ? []
            : [filter.owner, filter.repo, filter.head, ...(filter.base !== undefined ? [filter.base] : [])];
        const rows = this.db.prepare(
            `SELECT m.id, m.created_at, m.owner, m.repo, m.head, m.base, m.run_ids,
                    COUNT(c.id) AS cluster_count
             FROM consolidations m LEFT JOIN clusters c ON c.consolidation_id = m.id
             ${where}
             GROUP BY m.id
             ORDER BY m.id DESC`,
        ).all(...params) as unknown as Array<{
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

    getConsolidation(id: ConsolidationId): Consolidation | undefined
    {
        const row = this.db.prepare('SELECT * FROM consolidations WHERE id = ?').get(id) as unknown as {
            id: number; created_at: string; owner: string; repo: string; head: string; base: string; run_ids: string;
            cost_usd: number | null;
        } | undefined;
        if (row === undefined)
        {
            return undefined;
        }

        const clusterRows = this.db.prepare(
            'SELECT id, representative_finding_id, severity, occurrence, verification_status, lapsed_verdict FROM clusters WHERE consolidation_id = ? ORDER BY id',
        ).all(id) as unknown as Array<{
            id: number; representative_finding_id: number; severity: string; occurrence: number;
            verification_status: string; lapsed_verdict: string | null;
        }>;

        const memberQuery = this.db.prepare(
            `SELECT f.id, f.run_id, f.file, f.line, f.severity, f.confidence, f.title, f.detail, f.suggestion
             FROM cluster_members cm JOIN findings f ON f.id = cm.finding_id
             WHERE cm.cluster_id = ? ORDER BY f.id`,
        );

        const clusters: Cluster[] = clusterRows.map(c =>
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
                verificationStatus: c.verification_status as Cluster['verificationStatus'],
                ...(c.lapsed_verdict !== null ? { lapsedVerdict: c.lapsed_verdict as Verdict } : {}),
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
            ...(row.cost_usd !== null ? { costUsd: row.cost_usd } : {}),
            clusters,
        };
    }

    // Append-only: re-running verification adds a row, nothing is overwritten.
    // The cluster's verification_status mirrors the LATEST verdict — deliberately
    // the store's first UPDATE, a derived column, not a mutation of history.
    saveVerification(verification: NewVerification): VerificationId
    {
        this.db.exec('BEGIN');
        try
        {
            // Status first: its changes count is the existence check, giving a
            // named error before the INSERT's foreign key fires a generic one.
            const updated = this.db.prepare(
                'UPDATE clusters SET verification_status = ? WHERE id = ?',
            ).run(verification.verdict, verification.clusterId);
            if (updated.changes === 0)
            {
                throw new Error(`No cluster #${verification.clusterId}.`);
            }

            const result = this.db.prepare(
                'INSERT INTO verifications (cluster_id, created_at, source, verdict, rationale, confidence, cost_usd) VALUES (?, ?, ?, ?, ?, ?, ?)',
            ).run(
                verification.clusterId, new Date().toISOString(), verification.source, verification.verdict,
                verification.rationale,
                verification.source === 'agent' ? verification.confidence : null,
                verification.source === 'agent' ? verification.costUsd : null,
            );
            const id = verificationId(Number(result.lastInsertRowid));

            this.db.exec('COMMIT');
            return id;
        }
        catch (error)
        {
            this.db.exec('ROLLBACK');
            throw error;
        }
    }

    // The latest verdict for every member set that has ever been adjudicated.
    // Ordered by verification id so the most recently earned verdict wins when
    // two cluster rows over the same findings disagree — the same latest-wins
    // rule the per-cluster status follows.
    private verdictsByMemberSet(): Map<string, Verdict>
    {
        const adjudicated = this.db.prepare(
            'SELECT cluster_id, verdict FROM verifications ORDER BY id',
        ).all() as unknown as Array<{ cluster_id: number; verdict: string }>;
        const members = this.db.prepare('SELECT finding_id FROM cluster_members WHERE cluster_id = ?');

        const verdicts = new Map<string, Verdict>();
        for (const row of adjudicated)
        {
            const findingIds = (members.all(row.cluster_id) as unknown as Array<{ finding_id: number }>)
                .map(m => findingId(m.finding_id));
            verdicts.set(memberSetKey(findingIds), row.verdict as Verdict);
        }
        return verdicts;
    }

    getVerifications(cluster: ClusterId): Verification[]
    {
        const rows = this.db.prepare(
            'SELECT id, cluster_id, created_at, source, verdict, rationale, confidence, cost_usd FROM verifications WHERE cluster_id = ? ORDER BY id',
        ).all(cluster) as unknown as VerificationRow[];

        return rows.map((row) =>
        {
            const base = {
                id: verificationId(row.id),
                clusterId: clusterId(row.cluster_id),
                createdAt: row.created_at,
                rationale: row.rationale,
            };
            // The CHECK constraint guarantees the halves line up; the casts
            // restate what the row's source already proved.
            return row.source === 'human'
                ? { ...base, source: 'human' as const, verdict: row.verdict as Exclude<Verdict, 'undetermined'> }
                : { ...base, source: 'agent' as const, verdict: row.verdict as Verdict, confidence: row.confidence as string, costUsd: row.cost_usd as number };
        });
    }

    close(): void
    {
        this.db.close();
    }
}

function toFinding(row: FindingRow): NewFinding
{
    return {
        file: row.file,
        ...(row.line !== null ? { line: row.line } : {}),
        severity: row.severity as Severity,
        ...(row.confidence !== null ? { confidence: row.confidence as Confidence } : {}),
        title: row.title,
        detail: row.detail,
        ...(row.suggestion !== null ? { suggestion: row.suggestion } : {}),
    };
}
