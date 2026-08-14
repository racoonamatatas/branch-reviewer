// Campaign entry point: run a target until discovery dries up, then verify
// the findings only one run saw. --max-runs is the hard cost cap and has a
// default for that reason — a campaign spends real credit per round.

import { campaignCost, runCampaign } from '../campaign/campaign.js';
import type { CampaignResult } from '../campaign/campaign.js';
import type { Target } from '../types/target.js';
import type { Coverage } from '../coverage/coverage.js';
import { GitHubClient } from '../github/github.js';
import { judgeModel, reviewModel, verifyModel } from '../sdk/models.js';
import { DEFAULT_DB_PATH, ReviewStore } from '../store/store.js';
import { requirePositiveInt, requireValue, runMain } from './main.js';
import { printConsolidation, printVerdictProgress } from './render.js';

const USAGE = 'Usage: npm run campaign -- <owner>/<repo> <branch> '
    + '[--base main] [--max-runs N] [--patience K] [--max-turns N] [--no-verify] [--reverify]';

const DEFAULT_MAX_RUNS = 3;

interface CampaignArgs extends Target
{
    maxRuns: number;
    patience?: number;
    maxTurns?: number;
    verify: boolean;
    reverify: boolean;
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
        else if (arg === '--no-verify')
        {
            verify = false;
        }
        else if (arg === '--reverify')
        {
            reverify = true;
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
        owner, repo, head, base, maxRuns, verify, reverify,
        ...(patience !== undefined ? { patience } : {}),
        ...(maxTurns !== undefined ? { maxTurns } : {}),
    };
}

// The estimate is labeled as a ceiling, not a measurement: Chao1 assumes
// independent samples and campaign rounds are correlated (same model, same
// prompt, shared cache), which biases the unseen tail upward.
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

async function main(): Promise<number>
{
    const args = parseArgs(process.argv.slice(2));
    const model = reviewModel();
    const github = new GitHubClient(args.owner, args.repo, process.env.GITHUB_TOKEN);
    const store = new ReviewStore(DEFAULT_DB_PATH);

    console.log(`Campaign on ${args.owner}/${args.repo} "${args.head}" against "${args.base}"`);
    console.log(`models: review ${model}, judge ${judgeModel()}, verify ${verifyModel()}`);
    console.log(`up to ${args.maxRuns} run(s), stopping early after ${args.patience ?? 2} round(s) without a new finding`
        + `${args.verify ? '; occurrence-1 findings verified at the end' : '; verification skipped'}\n`);

    try
    {
        const campaign = await runCampaign(store, github, args, {
            model,
            judgeModel: judgeModel(),
            verifyModel: verifyModel(),
            maxRuns: args.maxRuns,
            verify: args.verify,
            reverify: args.reverify,
            ...(args.patience !== undefined ? { patience: args.patience } : {}),
            ...(args.maxTurns !== undefined ? { maxTurns: args.maxTurns } : {}),
            onBaseline: (id, coverage) =>
            {
                console.log(`baseline from stored runs — consolidation #${id}: ${coverageLine(coverage)}\n`);
            },
            onJudgeDegraded: (violation) =>
            {
                console.error(`  clustering degraded (${violation}) — one cluster per finding this round`);
            },
            onRoundStart: (round, of) =>
            {
                console.log(`round ${round}/${of}: reviewing...`);
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

        const aborted = campaign.rounds.some(r => r.aborted !== undefined || r.failed !== undefined);
        const incomplete = (campaign.verification?.failures ?? 0) > 0;
        return aborted || incomplete ? 2 : 0;
    }
    finally
    {
        store.close();
    }
}

runMain(main);
