// The quad naming one review series: a head reviewed against a base in one
// repository. Review runs, consolidations, verification, campaigns, and the
// job queue all coordinate on these four fields — they used to do it through
// three structurally-identical interfaces (CampaignTarget, ConsolidationTarget
// and friends) that matched only by luck. One declared type makes the
// relationship a fact instead of a coincidence. The tools' ReviewTarget
// ({ base, head }) stays separate on purpose: a RepoClient is already bound
// to owner/repo, so the tools genuinely need only the ref pair.

export interface Target
{
    owner: string;
    repo: string;
    head: string;
    base: string;
}
