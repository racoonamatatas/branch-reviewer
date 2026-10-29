// Run history on the built-in node:sqlite (Node ≥ 24) — no native dependency.
// Findings are stored relationally, one row each, because the future
// cross-run comparison needs to query them; a JSON blob would wall that off.

import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Coverage } from '../coverage/coverage.js';
import type { Confidence, NewFinding, Review, Severity } from '../schema/schema.js';
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
    // The campaign lens this run reviewed under (src/review/lenses.ts).
    // Absent on generalist runs and on rows from before rotation existed —
    // both honestly mean "no lens was asked for".
    lens?: string;
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

// Why a campaign stops. 'empty-diff' is a stop, not a failure: the compare
// listed no files, and every later round would compare the same base/head —
// but it is also not saturation, so it must never masquerade as 'dry'.
// 'no-consolidation' is the judge's counterpart to 'no-usable-runs': the
// union is unusable without a judge, so a persistently failing one must not
// keep billing review credit for rounds nothing can consolidate. Defined
// 'stopped' is a shutdown cutting the plan short (only the server's worker
// can raise it; Ctrl-C kills the CLI outright): completed rounds and verdicts
// stay saved, but the plan did not complete. Defined here rather than in the
// campaign module because it is persisted vocabulary (like JobState) and the
// campaign already imports the store.
export type StoppedBy = 'dry' | 'max-runs' | 'no-usable-runs' | 'empty-diff' | 'no-consolidation' | 'stopped';

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
    lens?: string;      // the rotation's focus this round; absent = generalist
    model?: string;     // resolved review model, when the caller chose one
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
// 'verifying' is the loop's tail made visible: the sampling is over (so
// stoppedBy is already durable — a verification failure can never lose why
// the loop stopped) but credit is still burning on adversarial passes, and
// campaign #1's verification phase proved that span must stay covered by
// liveness and billing gates — the record read 'finished' while the CLI
// process billed five more dollars, and every gate reopened.
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
    // Whether the loop proved it holds this row's liveness lease. Starts
    // false and is marked true only on successful acquisition — so a crash
    // in the gap fails safe (unprovable, unsweepable) instead of unsafe
    // (sweepable while possibly alive). A live row with leased false is the
    // degraded mode the UI must be able to explain, because nothing but an
    // operator's force-fail can ever retire it.
    leased: boolean;
    rounds: CampaignRound[];
}

export interface RunningCampaign extends CampaignBase
{
    status: 'running';
}

export interface VerifyingCampaign extends CampaignBase
{
    status: 'verifying';
    stoppedBy: StoppedBy;
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
    // Present exactly when the failure hit during verification: the loop's
    // outcome was already durable and must not be lost to a verify crash.
    stoppedBy?: StoppedBy;
    finishedAt: string;
}

export type Campaign = RunningCampaign | VerifyingCampaign | FinishedCampaign | FailedCampaign;

// Everything beyond New<T>'s subtraction is lifecycle, assigned as the
// campaign progresses; a create call supplies only the target.
type CampaignLifecycle = 'status' | 'baselineConsolidationId' | 'rounds' | 'leased';
export type NewCampaign = Omit<New<RunningCampaign>, CampaignLifecycle>;

export interface CampaignSummary extends Pick<CampaignBase, 'id' | 'createdAt' | 'owner' | 'repo' | 'head' | 'base' | 'leased'>
{
    target: string;  // "owner/repo head → base"
    status: Campaign['status'];
    stoppedBy?: StoppedBy;
    roundCount: number;
    reviewCostUsd: number;  // sum of round costs; verification bills to the consolidation's clusters, not here
}

// The duplicate gate's refusal, typed so the campaign recorder can tell
// policy from persistence: this one error must escape the observational
// write-guard and stop the loop before credit moves — a swallowed gate
// would run the duplicate loop it exists to prevent, just unrecorded.
export class DuplicateCampaignError extends Error
{
    constructor(
        public readonly campaignId: CampaignId,
        status: Campaign['status'],
        leased: boolean,
    )
    {
        super(`Campaign #${campaignId} is already ${status} for this target — a second loop would double-bill it. `
            + (leased
                ? 'Wait for it to finish, or investigate why it is stuck.'
                : `Its liveness is unprovable (never leased); if it is dead, retire it with: npm run campaign -- --force-fail ${campaignId}`));
    }
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

// Shared with migrateCampaignVerifying's rebuild: CHECKs live in the table
// definition, so changing them means recreating the table, and two copies of
// this DDL would drift apart.
function campaignsTable(name: string): string
{
    return `
CREATE TABLE IF NOT EXISTS ${name} (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL,
    owner TEXT NOT NULL,
    repo TEXT NOT NULL,
    head TEXT NOT NULL,
    base TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'verifying', 'finished', 'failed')),
    stopped_by TEXT,
    error TEXT,
    finished_at TEXT,
    baseline_consolidation_id INTEGER REFERENCES consolidations(id),
    leased INTEGER NOT NULL DEFAULT 0,
    CHECK ((status IN ('verifying', 'finished')) = (stopped_by IS NOT NULL) OR (status = 'failed')),
    CHECK ((status = 'failed') = (error IS NOT NULL)),
    CHECK ((status IN ('running', 'verifying')) = (finished_at IS NULL))
);`;
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
    files_changed INTEGER,
    lens TEXT
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
${campaignsTable('campaigns')}
CREATE TABLE IF NOT EXISTS campaign_rounds (
    campaign_id INTEGER NOT NULL REFERENCES campaigns(id),
    round INTEGER NOT NULL,
    run_id INTEGER REFERENCES runs(id),
    findings INTEGER NOT NULL,
    turns INTEGER NOT NULL,
    cost_usd REAL NOT NULL,
    lens TEXT,
    model TEXT,
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
    lens: string | null;
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
    leased: number;
}

interface CampaignRoundRow
{
    round: number;
    run_id: number | null;
    lens: string | null;
    model: string | null;
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

    // Where campaign liveness leases live — beside the database file,
    // because they make claims about rows in it and must travel with it
    // (an age-moved copy arrives with no live leases, which is the truth).
    // undefined for :memory:: a store that dies with the process has no
    // cross-process liveness to prove.
    readonly leaseDir: string | undefined;

    constructor(path: string)
    {
        this.leaseDir = path === ':memory:' ? undefined : join(dirname(path), 'leases');
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
        // A merges→consolidations rename migration used to run first here;
        // removed deliberately in slice C after every known database (both
        // machines and the age-encrypted copy) was verified on the new
        // schema. A pre-rename database would now fail on its NOT NULL
        // merge_id at the first save — acceptable, since none exist.
        this.migrateVerificationProvenance();
        this.db.exec(SCHEMA);
        this.migrateRunFilesChanged();
        this.migrateRunLens();
        this.migrateFindingConfidence();
        this.migrateClusterLapsedVerdict();
        this.migrateConsolidationCost();
        this.migrateEmptyRuns();
        this.migrateCampaignVerifying();
        this.migrateCampaignLeased();
        this.migrateCampaignRoundRotation();
    }

    // Rounds recorded before the diversity knobs (lens rotation, model
    // cycling) carry neither; NULL is the truth about them — the rotation
    // did not exist — and reads as the generalist, caller-default round.
    private migrateCampaignRoundRotation(): void
    {
        const columns = this.db.prepare('SELECT name FROM pragma_table_info(?)').all('campaign_rounds') as unknown as Array<{ name: string }>;
        if (!columns.some(c => c.name === 'lens'))
        {
            this.db.exec('ALTER TABLE campaign_rounds ADD COLUMN lens TEXT');
            this.db.exec('ALTER TABLE campaign_rounds ADD COLUMN model TEXT');
        }
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

    // Databases rebuilt for 'verifying' before the leased column existed
    // lack it; the defaulted ADD COLUMN is the whole migration. Old rows
    // read unproven — for terminal rows the flag is inert, and any live row
    // from before the column cannot testify anyway.
    private migrateCampaignLeased(): void
    {
        const columns = this.db.prepare('SELECT name FROM pragma_table_info(?)').all('campaigns') as unknown as Array<{ name: string }>;
        if (!columns.some(c => c.name === 'leased'))
        {
            this.db.exec('ALTER TABLE campaigns ADD COLUMN leased INTEGER NOT NULL DEFAULT 0');
        }
    }

    // Databases from before the 'verifying' phase carry CHECKs that reject
    // it; CHECKs live in the table definition, so the fix is a rebuild in
    // place — same columns, rows copied verbatim (every old row already
    // satisfies the new constraints). Detected from the stored DDL: the old
    // shape is the one whose status CHECK does not name 'verifying'.
    // campaign_rounds is not rebuilt: its CHECKs have never changed, and
    // its only later columns (lens, model) arrive by ADD COLUMN — the day
    // its CHECKs change, it gets its own rebuild.
    private migrateCampaignVerifying(): void
    {
        const table = this.db.prepare(
            "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'campaigns'",
        ).get() as unknown as { sql: string } | undefined;
        if (table === undefined || table.sql.includes("'verifying'"))
        {
            return;
        }
        // New-table-first, unlike the verifications rebuild: renaming the
        // old table aside would drag campaign_rounds' REFERENCES along with
        // it (RENAME rewrites dependents since SQLite 3.25) and then drop
        // the name they point at. Dropping and re-creating under the
        // original name leaves that reference text untouched and true.
        // FK enforcement is suspended for the dance (node:sqlite enables it
        // by default, unlike raw SQLite): dropping a parent whose rounds
        // still reference it would otherwise refuse — the rows all point at
        // the same ids the re-created table holds again two statements
        // later. The pragma is a no-op inside a transaction, so it brackets
        // one rather than joining it. Columns are named on both sides of
        // the copy: a legacy shape that no longer matches must fail loudly,
        // never shuffle TEXT values into the wrong TEXT columns. A mid-dance
        // failure rolls back, so it cannot leave an open transaction behind
        // the restored pragma.
        const columns = 'id, created_at, owner, repo, head, base, status, stopped_by, error, finished_at, baseline_consolidation_id';
        this.db.exec('PRAGMA foreign_keys = OFF');
        try
        {
            this.db.exec(`
                BEGIN;
                ${campaignsTable('campaigns_new')}
                INSERT INTO campaigns_new (${columns}) SELECT ${columns} FROM campaigns;
                DROP TABLE campaigns;
                ALTER TABLE campaigns_new RENAME TO campaigns;
                COMMIT;
            `);
        }
        catch (error)
        {
            try
            {
                this.db.exec('ROLLBACK');
            }
            catch
            {
                // No transaction to roll back — the BEGIN itself failed.
            }
            throw error;
        }
        finally
        {
            this.db.exec('PRAGMA foreign_keys = ON');
        }
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

    // Databases from before lens rotation lack the column; NULL is the same
    // fact for old rows as for new generalist ones — no lens was asked for.
    private migrateRunLens(): void
    {
        const columns = this.db.prepare('SELECT name FROM pragma_table_info(?)').all('runs') as unknown as Array<{ name: string }>;
        if (!columns.some(c => c.name === 'lens'))
        {
            this.db.exec('ALTER TABLE runs ADD COLUMN lens TEXT');
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
                                   files_changed, lens)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            ).run(
                new Date().toISOString(), run.owner, run.repo, run.head, run.base,
                run.model, run.status, run.reason ?? null, run.review?.summary ?? null,
                run.turns, run.costUsd,
                run.usage.inputTokens, run.usage.outputTokens,
                run.usage.cacheReadInputTokens, run.usage.cacheCreationInputTokens,
                run.filesChanged ?? null,
                run.lens ?? null,
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

    // The campaign rotation's tally (src/campaign/rotation.ts): every run of
    // the target that spent a slot. Aborted runs count — they billed, and
    // left out, a lens that reliably aborts reads as unsampled forever and
    // opens every later campaign only to die at the abort tolerance (run-132
    // finding). Empty runs never reviewed anything, so they spent no slot.
    rotationSamples(filter: TargetFilter): Array<Pick<Run, 'model' | 'lens'>>
    {
        const [where, params] = filterClause(filter, 'r');
        const rows = this.db.prepare(
            `SELECT r.model, r.lens FROM runs r ${where} AND r.status IN ('submitted', 'aborted') ORDER BY r.id`,
        ).all(...params) as unknown as Array<Pick<RunRow, 'model' | 'lens'>>;
        return rows.map(row => ({ model: row.model, ...(row.lens !== null ? { lens: row.lens } : {}) }));
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
            ...(row.lens !== null ? { lens: row.lens } : {}),
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
        const adjudicated = [...inherited].map(([key, latest]) => ({
            ids: key.split(',').map(Number),
            ...latest,
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
                const status = inherited.get(memberSetKey(cluster.memberIds))?.verdict;
                // Only when nothing inherits exactly: of several lapsed
                // subsets, the verdict earned by the latest verification
                // wins — compared by verification id, not map order, because
                // a Map keeps first-insertion order per key and a
                // re-adjudicated set therefore iterates at its original
                // position (smoke rev 14, confirmed).
                let lapsed: { verdict: Verdict; verificationId: number } | undefined;
                if (status === undefined)
                {
                    const memberSet = new Set<number>(cluster.memberIds);
                    for (const past of adjudicated)
                    {
                        if (past.ids.length < memberSet.size && past.ids.every(fid => memberSet.has(fid))
                            && (lapsed === undefined || past.verificationId > lapsed.verificationId))
                        {
                            lapsed = past;
                        }
                    }
                }
                const newClusterId = clusterId(Number(insertCluster.run(
                    id, cluster.representativeId, cluster.severity, cluster.occurrence,
                    status ?? 'pending', lapsed?.verdict ?? null,
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

    // The latest verdict for every member set that has ever been adjudicated,
    // with the verification id that earned it. Later rows overwrite earlier
    // ones (latest wins), and the id rides along because Map iteration keeps
    // first-insertion order per key — anything comparing recency across sets
    // must compare ids, never positions.
    private verdictsByMemberSet(): Map<string, { verdict: Verdict; verificationId: number }>
    {
        const adjudicated = this.db.prepare(
            'SELECT id, cluster_id, verdict FROM verifications ORDER BY id',
        ).all() as unknown as Array<{ id: number; cluster_id: number; verdict: string }>;
        const members = this.db.prepare('SELECT finding_id FROM cluster_members WHERE cluster_id = ?');

        const verdicts = new Map<string, { verdict: Verdict; verificationId: number }>();
        for (const row of adjudicated)
        {
            const findingIds = (members.all(row.cluster_id) as unknown as Array<{ finding_id: number }>)
                .map(m => findingId(m.finding_id));
            verdicts.set(memberSetKey(findingIds), { verdict: row.verdict as Verdict, verificationId: row.id });
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
    // Creation IS the duplicate gate, and it is atomic: BEGIN IMMEDIATE
    // takes SQLite's single writer lock across processes, so two loops
    // entering the same millisecond serialize here — the second sees the
    // first's row and gets the typed refusal, never a duplicate billing
    // loop (a bare pre-check in the caller was check-then-act, run-60
    // finding). leased is written explicitly, never left to the column
    // default: a row born claiming a provable lease it does not hold yet
    // would make a crash in the create→acquire gap sweepable while
    // possibly alive — the unsafe direction.
    createCampaign(campaign: NewCampaign): CampaignId
    {
        this.db.exec('BEGIN IMMEDIATE');
        try
        {
            const live = this.db.prepare(
                `SELECT id, status, leased FROM campaigns
                 WHERE owner = ? AND repo = ? AND head = ? AND base = ? AND status IN ('running', 'verifying')
                 LIMIT 1`,
            ).get(campaign.owner, campaign.repo, campaign.head, campaign.base) as unknown as { id: number; status: string; leased: number } | undefined;
            if (live !== undefined)
            {
                throw new DuplicateCampaignError(campaignId(live.id), campaignStatus(live.id, live.status), live.leased === 1);
            }
            const result = this.db.prepare(
                'INSERT INTO campaigns (created_at, owner, repo, head, base, leased) VALUES (?, ?, ?, ?, ?, 0)',
            ).run(new Date().toISOString(), campaign.owner, campaign.repo, campaign.head, campaign.base);
            this.db.exec('COMMIT');
            return campaignId(Number(result.lastInsertRowid));
        }
        catch (error)
        {
            try
            {
                this.db.exec('ROLLBACK');
            }
            catch
            {
                // No transaction to roll back — the BEGIN itself failed.
            }
            throw error;
        }
    }

    recordCampaignBaseline(id: CampaignId, consolidation: ConsolidationId): void
    {
        this.transition(id, ['running'], 'record a baseline on',
            "UPDATE campaigns SET baseline_consolidation_id = ? WHERE id = ? AND status = 'running'",
            consolidation, id);
    }

    // Rounds append as they happen, so an interrupted campaign keeps every
    // round it paid for. The composite primary key rejects a duplicate round
    // number — the loop is the only writer, so a collision is a bug, not a
    // race. The INSERT carries its own running-status guard (the rounds
    // table has no status column to guard on), so a sweep racing the append
    // is a named error, never a round quietly attached to a terminal row.
    appendCampaignRound(id: CampaignId, round: CampaignRound): void
    {
        this.requireRunningCampaign(id, 'append a round to');
        const result = this.db.prepare(
            `INSERT INTO campaign_rounds (campaign_id, round, run_id, lens, model, findings, turns, cost_usd,
                                          aborted, failed, consolidation_failed, consolidation_id, novel_clusters,
                                          observed, f1, f2, undiscovered, estimated_total)
             SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
             WHERE EXISTS (SELECT 1 FROM campaigns WHERE id = ? AND status = 'running')`,
        ).run(
            id, round.round, round.runId ?? null, round.lens ?? null, round.model ?? null, round.findings, round.turns, round.costUsd,
            round.aborted ?? null, round.failed ?? null, round.consolidationFailed ?? null,
            round.consolidationId ?? null, round.novelClusters,
            round.coverage?.observed ?? null, round.coverage?.f1 ?? null, round.coverage?.f2 ?? null,
            round.coverage?.undiscovered ?? null, round.coverage?.estimatedTotal ?? null,
            id,
        );
        if (result.changes === 0)
        {
            throw new Error(`Cannot append a round to campaign #${id}: it changed state concurrently.`);
        }
    }

    finishCampaign(id: CampaignId, stoppedBy: StoppedBy): void
    {
        this.transition(id, ['running'], 'finish',
            "UPDATE campaigns SET status = 'finished', stopped_by = ?, finished_at = ? WHERE id = ? AND status = 'running'",
            stoppedBy, new Date().toISOString(), id);
    }

    // The loop is over and knows why — stoppedBy becomes durable HERE, before
    // any verification credit is spent, so a verify crash can never lose it.
    beginCampaignVerification(id: CampaignId, stoppedBy: StoppedBy): void
    {
        this.transition(id, ['running'], 'begin verification on',
            "UPDATE campaigns SET status = 'verifying', stopped_by = ? WHERE id = ? AND status = 'running'",
            stoppedBy, id);
    }

    // stoppedBy is re-stated only when verification itself changed the
    // answer: a shutdown that cut the pass short turns a completed plan into
    // 'stopped', and the row must agree with the result the caller is handed.
    finishVerifiedCampaign(id: CampaignId, stoppedBy?: StoppedBy): void
    {
        this.transition(id, ['verifying'], 'finish verification on',
            "UPDATE campaigns SET status = 'finished', finished_at = ?, stopped_by = COALESCE(?, stopped_by) WHERE id = ? AND status = 'verifying'",
            new Date().toISOString(), stoppedBy ?? null, id);
    }

    // Fails from either live phase; a stopped_by already recorded (the loop
    // completed, verification died) survives the transition.
    failCampaign(id: CampaignId, error: string): void
    {
        this.transition(id, ['running', 'verifying'], 'fail',
            "UPDATE campaigns SET status = 'failed', error = ?, finished_at = ? WHERE id = ? AND status IN ('running', 'verifying')",
            error, new Date().toISOString(), id);
    }

    // The loop's proof of protection: recorded only after the lease is
    // actually held, so "lease acquirable" testifies about exactly the rows
    // that once held one. Rows that never mark stay unprovable and the
    // sweep refuses to judge them.
    markCampaignLeased(id: CampaignId): void
    {
        this.transition(id, ['running'], 'mark leased',
            "UPDATE campaigns SET leased = 1 WHERE id = ? AND status = 'running'", id);
    }

    // The sweep's question and nothing more: which campaigns claim to be
    // alive, since when, and whether their lease can testify. listCampaigns
    // aggregates rounds and costs over the whole table — history-sized work
    // a per-poll maintenance task must not do.
    openCampaigns(): Array<{ id: CampaignId; createdAt: string; leased: boolean }>
    {
        const rows = this.db.prepare(
            "SELECT id, created_at, leased FROM campaigns WHERE status IN ('running', 'verifying') ORDER BY id",
        ).all() as unknown as Array<{ id: number; created_at: string; leased: number }>;
        return rows.map(row => ({ id: campaignId(row.id), createdAt: row.created_at, leased: row.leased === 1 }));
    }

    // Check-then-act made honest: the UPDATE's own status guard is the act,
    // and zero changed rows means another process transitioned the row in
    // the race window — reported as the same named error the check throws,
    // never a silent no-op the caller reads as success.
    private transition(id: CampaignId, expected: Array<Campaign['status']>, action: string, sql: string, ...params: Array<string | number | null>): void
    {
        this.requireCampaignState(id, expected, action);
        const result = this.db.prepare(sql).run(...params);
        if (result.changes === 0)
        {
            throw new Error(`Cannot ${action} campaign #${id}: it changed state concurrently.`);
        }
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

    // liveOnly bounds the aggregate to running/verifying rows — the
    // dashboard's per-poll question — instead of joining every campaign
    // ever stored to answer it.
    listCampaigns(filter?: TargetFilter, opts: { liveOnly?: boolean } = {}): CampaignSummary[]
    {
        const [where, params] = filterClause(filter, 'c');
        const live = "c.status IN ('running', 'verifying')";
        const clause = opts.liveOnly !== true ? where
            : where === '' ? `WHERE ${live}` : `${where} AND ${live}`;
        // The row type names exactly what the SELECT fetches — a CampaignRow
        // cast would claim columns this query never reads.
        interface SummaryRow
        {
            id: number;
            created_at: string;
            owner: string;
            repo: string;
            head: string;
            base: string;
            status: string;
            stopped_by: string | null;
            leased: number;
            round_count: number;
            review_cost_usd: number;
        }
        const rows = this.db.prepare(
            `SELECT c.id, c.created_at, c.owner, c.repo, c.head, c.base, c.status, c.stopped_by, c.leased,
                    COUNT(r.round) AS round_count, COALESCE(SUM(r.cost_usd), 0) AS review_cost_usd
             FROM campaigns c LEFT JOIN campaign_rounds r ON r.campaign_id = c.id
             ${clause}
             GROUP BY c.id
             ORDER BY c.id DESC`,
        ).all(...params) as unknown as SummaryRow[];

        return rows.map(row => ({
            id: campaignId(row.id),
            createdAt: row.created_at,
            owner: row.owner,
            repo: row.repo,
            head: row.head,
            base: row.base,
            target: `${row.owner}/${row.repo} ${row.head} → ${row.base}`,
            status: campaignStatus(row.id, row.status),
            ...(row.stopped_by !== null ? { stoppedBy: row.stopped_by as StoppedBy } : {}),
            leased: row.leased === 1,
            roundCount: row.round_count,
            reviewCostUsd: row.review_cost_usd,
        }));
    }

    private requireRunningCampaign(id: CampaignId, action: string): void
    {
        this.requireCampaignState(id, ['running'], action);
    }

    private requireCampaignState(id: CampaignId, expected: Array<Campaign['status']>, action: string): void
    {
        const row = this.db.prepare('SELECT status FROM campaigns WHERE id = ?').get(id) as unknown as { status: string } | undefined;
        if (row === undefined)
        {
            throw new Error(`No campaign #${id}.`);
        }
        if (!expected.includes(row.status as Campaign['status']))
        {
            throw new Error(`Cannot ${action} campaign #${id}: it is ${row.status}, not ${expected.join(' or ')}.`);
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
        leased: row.leased === 1,
        rounds,
    };
    switch (campaignStatus(row.id, row.status))
    {
        case 'running':
            return { ...common, status: 'running' };
        case 'verifying':
            return { ...common, status: 'verifying', stoppedBy: row.stopped_by as StoppedBy };
        case 'finished':
            return { ...common, status: 'finished', stoppedBy: row.stopped_by as StoppedBy, finishedAt: row.finished_at as string };
        case 'failed':
            return {
                ...common, status: 'failed', error: row.error as string, finishedAt: row.finished_at as string,
                ...(row.stopped_by !== null ? { stoppedBy: row.stopped_by as StoppedBy } : {}),
            };
    }
}

// One trust posture for the status column, wherever it is read: the CHECK
// makes an unknown value unreachable today, and this keeps a future value or
// a hand-edited row a named error at the boundary instead of a Zod surprise
// on the dashboard.
const CAMPAIGN_STATUSES: ReadonlyArray<Campaign['status']> = ['running', 'verifying', 'finished', 'failed'];

function campaignStatus(id: number, status: string): Campaign['status']
{
    if (!CAMPAIGN_STATUSES.includes(status as Campaign['status']))
    {
        throw new Error(`Campaign #${id} has unknown status '${status}'.`);
    }
    return status as Campaign['status'];
}

function toCampaignRound(row: CampaignRoundRow): CampaignRound
{
    return {
        round: row.round,
        ...(row.run_id !== null ? { runId: runId(row.run_id) } : {}),
        ...(row.lens !== null ? { lens: row.lens } : {}),
        ...(row.model !== null ? { model: row.model } : {}),
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
        ...(row.confidence !== null ? { confidence: row.confidence as Confidence } : {}),
        title: row.title,
        detail: row.detail,
        ...(row.suggestion !== null ? { suggestion: row.suggestion } : {}),
    };
}
