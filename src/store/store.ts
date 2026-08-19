// Run history on the built-in node:sqlite (Node ≥ 24) — no native dependency.
// Findings are stored relationally, one row each, because the future
// cross-run comparison needs to query them; a JSON blob would wall that off.

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Coverage } from '../coverage/coverage.js';
import type { NewFinding, Review, Severity } from '../schema/schema.js';
import type { Created, Identified, New } from '../types/common.js';
import { campaignId, clusterId, consolidationId, findingId, runId, verificationId } from '../types/ids.js';
import type { CampaignId, ClusterId, ConsolidationId, FindingId, RunId, VerificationId } from '../types/ids.js';
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
    // 'empty' mirrors ReviewResult's third member: the compare listed no
    // files, no model ran, there is no review and no abort reason. Readers
    // discriminate on the status — never on filesChanged === 0, which on
    // legacy rows means "unknown", not "empty".
    status: 'submitted' | 'aborted' | 'empty';
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
// would silently mix branches. base is the exception: callers navigate by
// the triple, but one head reviewed against two bases is two review series,
// so a caller that knows its base can pin the comparison too.
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
    clusters: Cluster[];
}

export interface Cluster extends Identified<'Cluster'>
{
    severity: Severity;
    occurrence: number;
    verificationStatus: VerificationStatus;
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

// Why a campaign stops. 'empty-diff' is a stop, not a failure: the compare
// listed no files, and every later round would compare the same base/head —
// but it is also not saturation, so it must never masquerade as 'dry'.
// 'no-consolidation' is the judge's counterpart to 'no-usable-runs': the
// union is unusable without a judge, so a persistently failing one must not
// keep billing review credit for rounds nothing can consolidate. Defined
// here rather than in the campaign module because it is persisted vocabulary
// (like JobState) and the campaign already imports the store.
export type StoppedBy = 'dry' | 'max-runs' | 'no-usable-runs' | 'empty-diff' | 'no-consolidation';

// One campaign round as the loop saw it when it happened. Deliberately a
// snapshot, not a derivation: a later judge call can merge away a round's
// novel cluster and a later refutation changes the coverage input, so
// re-deriving from the consolidation would answer a different question than
// "what did the campaign see when it decided to stop". The coverage numbers
// are stored whole (including the derivable tail) for the same reason — a
// future estimator tweak must not rewrite history.
export interface CampaignRound
{
    round: number;
    runId?: RunId;      // absent when the review threw before anything could be stored
    findings: number;
    turns: number;
    costUsd: number;
    aborted?: string;   // the SDK ended the run early (max turns)
    failed?: string;    // the round threw — network, API, or a save that did not land
    consolidationFailed?: string;   // the run saved but the judge call threw — no consolidation this round
    consolidationId?: ConsolidationId;
    coverage?: Coverage;    // present exactly when consolidationId is — enforced by CHECK
    novelClusters: number;  // clusters only this run reported — the round's marginal yield
}

// Status is a discriminated union, not optional fields: a finished campaign
// always knows why it stopped, a failed one always carries its error, and a
// running one may claim neither. The CHECKs restate the same rule in SQL.
interface CampaignBase extends Identified<'Campaign'>, Created
{
    owner: string;
    repo: string;
    head: string;
    base: string;
    // The consolidation of runs already stored before round 1 — the yardstick
    // this campaign's own contribution is measured against. Absent when the
    // target had fewer than two prior runs.
    baselineConsolidationId?: ConsolidationId;
    rounds: CampaignRound[];
}

export interface RunningCampaign extends CampaignBase
{
    status: 'running';
}

export interface FinishedCampaign extends CampaignBase
{
    status: 'finished';
    stoppedBy: StoppedBy;
    finishedAt: string;
}

export interface FailedCampaign extends CampaignBase
{
    status: 'failed';
    error: string;
    finishedAt: string;
}

export type Campaign = RunningCampaign | FinishedCampaign | FailedCampaign;

// Everything beyond New<T>'s subtraction is lifecycle, assigned as the
// campaign progresses; a create call supplies only the target.
type CampaignLifecycle = 'status' | 'baselineConsolidationId' | 'rounds';
export type NewCampaign = Omit<New<RunningCampaign>, CampaignLifecycle>;

export interface CampaignSummary extends Pick<CampaignBase, 'id' | 'createdAt' | 'owner' | 'repo' | 'head' | 'base'>
{
    target: string;  // "owner/repo head → base"
    status: Campaign['status'];
    stoppedBy?: StoppedBy;
    roundCount: number;
    reviewCostUsd: number;  // sum of round costs; verification bills to the consolidation's clusters, not here
}

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
CREATE TABLE IF NOT EXISTS campaigns (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL,
    owner TEXT NOT NULL,
    repo TEXT NOT NULL,
    head TEXT NOT NULL,
    base TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'finished', 'failed')),
    stopped_by TEXT,
    error TEXT,
    finished_at TEXT,
    baseline_consolidation_id INTEGER REFERENCES consolidations(id),
    CHECK ((status = 'finished') = (stopped_by IS NOT NULL)),
    CHECK ((status = 'failed') = (error IS NOT NULL)),
    CHECK ((status = 'running') = (finished_at IS NULL))
);
CREATE TABLE IF NOT EXISTS campaign_rounds (
    campaign_id INTEGER NOT NULL REFERENCES campaigns(id),
    round INTEGER NOT NULL,
    run_id INTEGER REFERENCES runs(id),
    findings INTEGER NOT NULL,
    turns INTEGER NOT NULL,
    cost_usd REAL NOT NULL,
    aborted TEXT,
    failed TEXT,
    consolidation_failed TEXT,
    consolidation_id INTEGER REFERENCES consolidations(id),
    novel_clusters INTEGER NOT NULL,
    observed INTEGER,
    f1 INTEGER,
    f2 INTEGER,
    undiscovered INTEGER,
    estimated_total INTEGER,
    PRIMARY KEY (campaign_id, round),
    CHECK ((consolidation_id IS NULL) = (observed IS NULL)),
    CHECK ((observed IS NULL) = (f1 IS NULL) AND (f1 IS NULL) = (f2 IS NULL)
       AND (f2 IS NULL) = (undiscovered IS NULL) AND (undiscovered IS NULL) = (estimated_total IS NULL)),
    CHECK (consolidation_id IS NULL OR consolidation_failed IS NULL)
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
    files_changed: number | null;
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

interface CampaignRow
{
    id: number;
    created_at: string;
    owner: string;
    repo: string;
    head: string;
    base: string;
    status: string;
    stopped_by: string | null;
    error: string | null;
    finished_at: string | null;
    baseline_consolidation_id: number | null;
}

interface CampaignRoundRow
{
    round: number;
    run_id: number | null;
    findings: number;
    turns: number;
    cost_usd: number;
    aborted: string | null;
    failed: string | null;
    consolidation_failed: string | null;
    consolidation_id: number | null;
    novel_clusters: number;
    observed: number | null;
    f1: number | null;
    f2: number | null;
    undiscovered: number | null;
    estimated_total: number | null;
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
        this.migrateLegacyMergeTables();
        this.migrateVerificationProvenance();
        this.db.exec(SCHEMA);
        this.migrateRunFilesChanged();
        this.migrateEmptyRuns();
    }

    // Rows written while the empty-diff short-circuit fabricated a submitted
    // review (briefly, on the slice-11 branch): the status now carries what
    // those rows encoded as submitted + files_changed = 0. The predicate is
    // pinned to the short-circuit's full signature — zero turns, zero cost —
    // because pre-branch code measured filesChanged and ran the model
    // anyway, so a genuine (billed, turns ≥ 2) review of an empty compare
    // can exist and must stay submitted: this UPDATE is irreversible and a
    // relabeled run's findings would silently leave every future union.
    // Idempotent; legacy NULLs stay submitted — "unknown", not "empty".
    private migrateEmptyRuns(): void
    {
        this.db.exec("UPDATE runs SET status = 'empty' WHERE status = 'submitted' AND files_changed = 0 AND turns = 0 AND cost_usd = 0");
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
                'INSERT INTO findings (run_id, file, line, severity, title, detail, suggestion) VALUES (?, ?, ?, ?, ?, ?, ?)',
            );
            for (const f of run.review?.findings ?? [])
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

    listRuns(filter?: TargetFilter): RunSummary[]
    {
        const [where, params] = filterClause(filter, 'r');
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
        const rows = this.db.prepare(
            `SELECT r.owner, r.repo, r.head, r.base,
                    COUNT(*) AS run_count,
                    MAX(r.created_at) AS last_run_at,
                    SUM(r.cost_usd) AS total_cost_usd,
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
            'SELECT file, line, severity, title, detail, suggestion FROM findings WHERE run_id = ? ORDER BY id',
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
            'SELECT id, run_id, file, line, severity, title, detail, suggestion FROM findings WHERE run_id = ? ORDER BY id',
        ).all(run) as unknown as Array<FindingRow & { id: number; run_id: number }>;
        return rows.map(row => ({ id: findingId(row.id), runId: runId(row.run_id), ...toFinding(row) }));
    }

    saveConsolidation(consolidation: NewConsolidation): ConsolidationId
    {
        // Verdicts are earned by a defect, not by the cluster row that
        // happened to represent it, so a re-clustering of the same findings
        // starts from what is already known instead of re-buying it. Exact
        // member-set matches only: a group the judge split or merged is a
        // different claim, and pending is the honest answer there.
        const inherited = this.verdictsByMemberSet();

        this.db.exec('BEGIN');
        try
        {
            const result = this.db.prepare(
                'INSERT INTO consolidations (created_at, owner, repo, head, base, run_ids) VALUES (?, ?, ?, ?, ?, ?)',
            ).run(
                new Date().toISOString(), consolidation.owner, consolidation.repo, consolidation.head, consolidation.base,
                JSON.stringify(consolidation.runIds),
            );
            const id = consolidationId(Number(result.lastInsertRowid));

            const insertCluster = this.db.prepare(
                `INSERT INTO clusters (consolidation_id, representative_finding_id, severity, occurrence, verification_status)
                 VALUES (?, ?, ?, ?, ?)`,
            );
            const insertMember = this.db.prepare(
                'INSERT INTO cluster_members (cluster_id, finding_id) VALUES (?, ?)',
            );
            for (const cluster of consolidation.clusters)
            {
                const newClusterId = clusterId(Number(insertCluster.run(
                    id, cluster.representativeId, cluster.severity, cluster.occurrence,
                    inherited.get(memberSetKey(cluster.memberIds)) ?? 'pending',
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
        const [where, params] = filterClause(filter, 'm');
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

    // A campaign row exists before its first round: the loop is visible as a
    // campaign from the moment it starts, not once it has something to show —
    // CLI campaigns rendered as "no campaign yet" mid-loop until this landed.
    createCampaign(campaign: NewCampaign): CampaignId
    {
        const result = this.db.prepare(
            'INSERT INTO campaigns (created_at, owner, repo, head, base) VALUES (?, ?, ?, ?, ?)',
        ).run(new Date().toISOString(), campaign.owner, campaign.repo, campaign.head, campaign.base);
        return campaignId(Number(result.lastInsertRowid));
    }

    recordCampaignBaseline(id: CampaignId, consolidation: ConsolidationId): void
    {
        this.requireRunningCampaign(id, 'record a baseline on');
        this.db.prepare(
            "UPDATE campaigns SET baseline_consolidation_id = ? WHERE id = ? AND status = 'running'",
        ).run(consolidation, id);
    }

    // Rounds append as they happen, so an interrupted campaign keeps every
    // round it paid for. The composite primary key rejects a duplicate round
    // number — the loop is the only writer, so a collision is a bug, not a race.
    appendCampaignRound(id: CampaignId, round: CampaignRound): void
    {
        this.requireRunningCampaign(id, 'append a round to');
        this.db.prepare(
            `INSERT INTO campaign_rounds (campaign_id, round, run_id, findings, turns, cost_usd,
                                          aborted, failed, consolidation_failed, consolidation_id, novel_clusters,
                                          observed, f1, f2, undiscovered, estimated_total)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
            id, round.round, round.runId ?? null, round.findings, round.turns, round.costUsd,
            round.aborted ?? null, round.failed ?? null, round.consolidationFailed ?? null,
            round.consolidationId ?? null, round.novelClusters,
            round.coverage?.observed ?? null, round.coverage?.f1 ?? null, round.coverage?.f2 ?? null,
            round.coverage?.undiscovered ?? null, round.coverage?.estimatedTotal ?? null,
        );
    }

    finishCampaign(id: CampaignId, stoppedBy: StoppedBy): void
    {
        this.requireRunningCampaign(id, 'finish');
        this.db.prepare(
            "UPDATE campaigns SET status = 'finished', stopped_by = ?, finished_at = ? WHERE id = ? AND status = 'running'",
        ).run(stoppedBy, new Date().toISOString(), id);
    }

    failCampaign(id: CampaignId, error: string): void
    {
        this.requireRunningCampaign(id, 'fail');
        this.db.prepare(
            "UPDATE campaigns SET status = 'failed', error = ?, finished_at = ? WHERE id = ? AND status = 'running'",
        ).run(error, new Date().toISOString(), id);
    }

    getCampaign(id: CampaignId): Campaign | undefined
    {
        const row = this.db.prepare('SELECT * FROM campaigns WHERE id = ?').get(id) as unknown as CampaignRow | undefined;
        if (row === undefined)
        {
            return undefined;
        }
        const rounds = (this.db.prepare(
            'SELECT * FROM campaign_rounds WHERE campaign_id = ? ORDER BY round',
        ).all(id) as unknown as CampaignRoundRow[]).map(toCampaignRound);
        return toCampaign(row, rounds);
    }

    listCampaigns(filter?: TargetFilter): CampaignSummary[]
    {
        const [where, params] = filterClause(filter, 'c');
        const rows = this.db.prepare(
            `SELECT c.id, c.created_at, c.owner, c.repo, c.head, c.base, c.status, c.stopped_by,
                    COUNT(r.round) AS round_count, COALESCE(SUM(r.cost_usd), 0) AS review_cost_usd
             FROM campaigns c LEFT JOIN campaign_rounds r ON r.campaign_id = c.id
             ${where}
             GROUP BY c.id
             ORDER BY c.id DESC`,
        ).all(...params) as unknown as Array<CampaignRow & { round_count: number; review_cost_usd: number }>;

        return rows.map(row => ({
            id: campaignId(row.id),
            createdAt: row.created_at,
            owner: row.owner,
            repo: row.repo,
            head: row.head,
            base: row.base,
            target: `${row.owner}/${row.repo} ${row.head} → ${row.base}`,
            status: row.status as Campaign['status'],
            ...(row.stopped_by !== null ? { stoppedBy: row.stopped_by as StoppedBy } : {}),
            roundCount: row.round_count,
            reviewCostUsd: row.review_cost_usd,
        }));
    }

    private requireRunningCampaign(id: CampaignId, action: string): void
    {
        const row = this.db.prepare('SELECT status FROM campaigns WHERE id = ?').get(id) as unknown as { status: string } | undefined;
        if (row === undefined)
        {
            throw new Error(`No campaign #${id}.`);
        }
        if (row.status !== 'running')
        {
            throw new Error(`Cannot ${action} campaign #${id}: it is ${row.status}, not running.`);
        }
    }

    close(): void
    {
        this.db.close();
    }
}

// The CHECK constraints guarantee each status's fields are present; the casts
// restate what the row's status already proved.
function toCampaign(row: CampaignRow, rounds: CampaignRound[]): Campaign
{
    const common = {
        id: campaignId(row.id),
        createdAt: row.created_at,
        owner: row.owner,
        repo: row.repo,
        head: row.head,
        base: row.base,
        ...(row.baseline_consolidation_id !== null
            ? { baselineConsolidationId: consolidationId(row.baseline_consolidation_id) }
            : {}),
        rounds,
    };
    switch (row.status)
    {
        case 'running':
            return { ...common, status: 'running' };
        case 'finished':
            return { ...common, status: 'finished', stoppedBy: row.stopped_by as StoppedBy, finishedAt: row.finished_at as string };
        case 'failed':
            return { ...common, status: 'failed', error: row.error as string, finishedAt: row.finished_at as string };
        default:
            throw new Error(`Campaign #${row.id} has unknown status '${row.status}'.`);
    }
}

function toCampaignRound(row: CampaignRoundRow): CampaignRound
{
    return {
        round: row.round,
        ...(row.run_id !== null ? { runId: runId(row.run_id) } : {}),
        findings: row.findings,
        turns: row.turns,
        costUsd: row.cost_usd,
        ...(row.aborted !== null ? { aborted: row.aborted } : {}),
        ...(row.failed !== null ? { failed: row.failed } : {}),
        ...(row.consolidation_failed !== null ? { consolidationFailed: row.consolidation_failed } : {}),
        // The all-or-nothing CHECK ties the coverage columns to
        // consolidation_id, so one null test speaks for all six.
        ...(row.consolidation_id !== null
            ? {
                consolidationId: consolidationId(row.consolidation_id),
                coverage: {
                    observed: row.observed as number,
                    f1: row.f1 as number,
                    f2: row.f2 as number,
                    undiscovered: row.undiscovered as number,
                    estimatedTotal: row.estimated_total as number,
                },
            }
            : {}),
        novelClusters: row.novel_clusters,
    };
}

// The list methods' shared WHERE builder: the triple always binds together,
// base joins only when the caller pinned it.
function filterClause(filter: TargetFilter | undefined, alias: string): [string, string[]]
{
    if (filter === undefined)
    {
        return ['', []];
    }
    const base = filter.base !== undefined ? [filter.base] : [];
    return [
        `WHERE ${alias}.owner = ? AND ${alias}.repo = ? AND ${alias}.head = ?${base.length > 0 ? ` AND ${alias}.base = ?` : ''}`,
        [filter.owner, filter.repo, filter.head, ...base],
    ];
}

function toFinding(row: FindingRow): NewFinding
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
