// Campaign entry point: run a target until discovery dries up, then verify
// the findings only one run saw. --max-runs is the hard cost cap and has a
// default for that reason — a campaign spends real credit per round.

import { campaignCost, runCampaign } from '../campaign/campaign.js';
import type { CampaignResult } from '../campaign/campaign.js';
import type { Target } from '../types/target.js';
import type { Coverage } from '../coverage/coverage.js';
import { GitHubClient } from '../github/github.js';
import { judgeModel, reviewModels, verifyModel } from '../sdk/models.js';
import { sweepInterruptedCampaigns } from '../store/lease.js';
import { DEFAULT_DB_PATH, ReviewStore } from '../store/store.js';
import { campaignId } from '../types/ids.js';
import { requirePositiveInt, requireValue, runMain } from './main.js';
import { printConsolidation, printVerdictProgress } from './render.js';

const USAGE = 'Usage: npm run campaign -- <owner>/<repo> <branch> '
    + '[--base main] [--max-runs N] [--patience K] [--max-turns N] [--no-verify] [--reverify]'
    + ' [--verify-all] [--models a,b] [--no-lenses]\n'
    + '       npm run campaign -- --force-fail <campaign-id>   (retire a wedged live record)';

const DEFAULT_MAX_RUNS = 3;

interface CampaignArgs extends Target
{
    maxRuns: number;
    patience?: number;
    maxTurns?: number;
    verify: boolean;
    reverify: boolean;
    verifyAll: boolean;
    models?: string[];
    lenses: boolean;
}

function parseArgs(argv: string[]): CampaignArgs
{
    const positional: string[] = [];
    let base = 'main';
    let maxRuns = DEFAULT_MAX_RUNS;
    let patience: number | undefined;
    let maxTurns: number | undefined;
    let verify = true;
    let reverify = false;
    let verifyAll = false;
    let models: string[] | undefined;
    let lenses = true;

    for (let i = 0; i < argv.length; i++)
    {
        const arg = argv[i]!;
        if (arg === '--base')
        {
            base = requireValue(argv[++i], arg, USAGE);
        }
        else if (arg === '--max-runs')
        {
            maxRuns = requirePositiveInt(argv[++i], arg, USAGE);
        }
        else if (arg === '--patience')
        {
            patience = requirePositiveInt(argv[++i], arg, USAGE);
        }
        else if (arg === '--max-turns')
        {
            maxTurns = requirePositiveInt(argv[++i], arg, USAGE);
        }
        else if (arg === '--models')
        {
            models = requireValue(argv[++i], arg, USAGE).split(',').map(m => m.trim()).filter(m => m !== '');
            if (models.length === 0)
            {
                throw new Error(USAGE);
            }
        }
        else if (arg === '--no-lenses')
        {
            lenses = false;
        }
        else if (arg === '--no-verify')
        {
            verify = false;
        }
        else if (arg === '--reverify')
        {
            reverify = true;
        }
        else if (arg === '--verify-all')
        {
            verifyAll = true;
        }
        else
        {
            positional.push(arg);
        }
    }

    const [repoSpec, head] = positional;
    const [owner, repo] = (repoSpec ?? '').split('/');
    if (owner === undefined || owner === '' || repo === undefined || repo === '' || head === undefined)
    {
        throw new Error(USAGE);
    }
    return {
        owner, repo, head, base, maxRuns, verify, reverify, verifyAll, lenses,
        ...(models !== undefined ? { models } : {}),
        ...(patience !== undefined ? { patience } : {}),
        ...(maxTurns !== undefined ? { maxTurns } : {}),
    };
}

// The estimate is labeled as a ceiling, not a measurement: Chao1 assumes
// independent samples and campaign rounds are correlated — the same model
// repeats its systematic blind spots and the same prompt repeats the same
// walk — which biases the unseen tail upward.
function coverageLine(coverage: Coverage): string
{
    return `${coverage.observed} distinct finding(s), seen-once ${coverage.f1} / seen-twice ${coverage.f2}`
        + ` → at most ~${coverage.undiscovered} unseen (optimistic ceiling: runs are correlated)`;
}

function printSummary(campaign: CampaignResult, args: CampaignArgs): void
{
    const reason = {
        'dry': 'discovery dried up',
        'max-runs': `run cap reached (${args.maxRuns})`,
        'no-usable-runs': 'consecutive runs aborted',
        'empty-diff': 'the compare listed no files — nothing to sample',
        'no-consolidation': 'consecutive judge calls failed — union unusable',
        // The CLI wires no stop signal (Ctrl-C kills the process outright);
        // only the server path can produce this.
        'stopped': 'stopped by shutdown',
    }[campaign.stoppedBy];

    const cost = campaignCost(campaign);
    console.log(`\ncampaign complete: ${campaign.rounds.length} run(s) fired — ${reason}`);
    console.log(`  reviews: $${cost.reviews.toFixed(4)}, clustering judge: $${cost.judge.toFixed(4)}`);
    if (campaign.verification !== undefined)
    {
        const v = campaign.verification;
        console.log(`  verification: $${v.costUsd.toFixed(4)} — ${v.verified} verdict(s), ${v.failures} incomplete`);
    }
    console.log(`  total: $${cost.total.toFixed(4)}`);
    if (campaign.consolidationId !== undefined)
    {
        console.log(`  final consolidation #${campaign.consolidationId} unions ${campaign.runIds.length} run(s) `
            + `[${campaign.runIds.join(', ')}]`);
    }
}

// The operator's way out of a wedged record: a live row whose liveness is
// unprovable (never leased, or a broken lock file) is deliberately never
// swept, but it holds the duplicate-campaign gates shut — this is the only
// write that can retire it. failCampaign's own guard refuses terminal rows,
// so the command cannot rewrite history.
function forceFail(raw: string | undefined): number
{
    const n = Number(raw);
    if (raw === undefined || !Number.isInteger(n) || n < 1)
    {
        throw new Error(`--force-fail needs a campaign id.\n${USAGE}`);
    }
    const store = new ReviewStore(DEFAULT_DB_PATH);
    try
    {
        store.failCampaign(campaignId(n), 'Manually failed: operator force-fail — the record was wedged or could not close on its own.');
        console.log(`campaign #${n} marked failed — its rounds survive`);
        return 0;
    }
    finally
    {
        store.close();
    }
}

async function main(): Promise<number>
{
    const argv = process.argv.slice(2);
    // Honored only as the leading argument: a destructive write must be the
    // whole command, never a stray flag that silently hijacks a campaign
    // request it happens to ride along with (run-60 finding).
    if (argv[0] === '--force-fail')
    {
        return forceFail(argv[1]);
    }
    const args = parseArgs(argv);
    // --models wins; otherwise REVIEW_MODELS (or the single reviewer model).
    // One entry means every round bills the same model, exactly as before.
    const models = args.models ?? reviewModels();
    const github = new GitHubClient(args.owner, args.repo, process.env.GITHUB_TOKEN);
    const store = new ReviewStore(DEFAULT_DB_PATH);

    // Writer-startup sweep: any live campaign whose liveness lease is
    // acquirable lost its owner (the kernel released it on death) and gets
    // its terminal state now, before this campaign adds a new running row.
    // Guarded: maintenance must never block the campaign the user asked for.
    try
    {
        for (const swept of sweepInterruptedCampaigns(store, { onWarning: message => console.error(`  sweep: ${message}`) }))
        {
            console.error(`campaign #${swept} was left running by a dead process; marked failed — its rounds survive`);
        }
    }
    catch (error)
    {
        console.error(`campaign sweep failed (continuing): ${error instanceof Error ? error.message : String(error)}`);
    }

    console.log(`Campaign on ${args.owner}/${args.repo} "${args.head}" against "${args.base}"`);
    console.log(`models: review ${models.length > 1 ? `${models.join(' / ')} (rotating per round)` : models[0]}, `
        + `judge ${judgeModel()}, verify ${verifyModel()}`);
    console.log(`up to ${args.maxRuns} run(s), stopping early after ${args.patience ?? 2} round(s) without a new finding`
        + `${args.lenses ? '; lens rotates per round' : '; lenses off'}`
        + `${args.verify ? '; occurrence-1 findings verified at the end' : '; verification skipped'}\n`);

    try
    {
        const campaign = await runCampaign(store, github, args, {
            models,
            rotateLenses: args.lenses,
            judgeModel: judgeModel(),
            verifyModel: verifyModel(),
            maxRuns: args.maxRuns,
            verify: args.verify,
            reverify: args.reverify,
            verifyAll: args.verifyAll,
            ...(args.patience !== undefined ? { patience: args.patience } : {}),
            ...(args.maxTurns !== undefined ? { maxTurns: args.maxTurns } : {}),
            // No exit handlers: the record's liveness lease is released by
            // the kernel on any death — Ctrl-C, SIGKILL, power loss alike —
            // and the next writer startup (or the server's poll-interval
            // sweep) marks the abandoned row failed. One mechanism, no
            // signal-handler special cases.
            onCampaign: (id) =>
            {
                console.log(`recorded as campaign #${id}\n`);
            },
            onWarning: (message) =>
            {
                console.error(`  warning: ${message}`);
            },
            onBaseline: (id, coverage) =>
            {
                console.log(`baseline from stored runs — consolidation #${id}: ${coverageLine(coverage)}\n`);
            },
            onJudgeDegraded: (violation) =>
            {
                console.error(`  clustering degraded (${violation}) — one cluster per finding this round`);
            },
            onBaselineFailed: (error) =>
            {
                console.error(`baseline consolidation failed: ${error} — rounds will proceed; if this is a`
                    + ' configuration problem it will hit them too');
            },
            onRoundStart: (round, of, lens, roundModel) =>
            {
                const focus = lens ?? 'generalist';
                const withModel = models.length > 1 ? `, ${roundModel}` : '';
                console.log(`round ${round}/${of}: reviewing (${focus}${withModel})...`);
            },
            onReviewProgress: (event) =>
            {
                console.log(`  ${event}`);
            },
            onRun: (outcome) =>
            {
                if (outcome.failed !== undefined)
                {
                    console.error(`  round failed: ${outcome.failed} — nothing stored for this round`);
                    return;
                }
                if (outcome.aborted !== undefined)
                {
                    console.error(`  run #${outcome.runId} aborted: ${outcome.aborted} — not usable for consolidation`);
                    return;
                }
                console.log(`  run #${outcome.runId} saved — ${outcome.findings} finding(s), `
                    + `${outcome.turns} turn(s), $${outcome.costUsd.toFixed(4)}`);
                if (outcome.consolidationFailed !== undefined)
                {
                    console.error(`  consolidation failed: ${outcome.consolidationFailed}`
                        + ' — the run is stored and joins the next round\'s union');
                }
                if (outcome.coverage !== undefined)
                {
                    console.log(`  consolidation #${outcome.consolidationId}: `
                        + `${outcome.novelClusters} finding(s) only this run saw — ${coverageLine(outcome.coverage)}\n`);
                }
            },
            verifyReporting: printVerdictProgress(),
        });

        printSummary(campaign, args);

        if (campaign.consolidationId !== undefined)
        {
            printConsolidation(store.getConsolidation(campaign.consolidationId)!);
        }

        const aborted = campaign.rounds.some(r =>
            r.aborted !== undefined || r.failed !== undefined || r.consolidationFailed !== undefined);
        const incomplete = (campaign.verification?.failures ?? 0) > 0;
        return aborted || incomplete ? 2 : 0;
    }
    finally
    {
        store.close();
    }
}

runMain(main);
