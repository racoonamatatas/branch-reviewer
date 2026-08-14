// Model policy for the three roles, in one place. The reviewer and verifier
// read whole diffs and hunt evidence — they get the strong default. The
// clustering judge solves a matching problem over short texts; Sonnet handles
// it, and pinning the judge cheap is what keeps rounds+1 judge calls per
// campaign from rivalling the reviews they meter. Each runner resolves its
// own default so no query() ever falls through to the SDK's — the model a
// run used must always be the model somebody chose.

export const DEFAULT_MODEL = 'claude-opus-5';
export const DEFAULT_JUDGE_MODEL = 'claude-sonnet-5';

export function reviewModel(): string
{
    return process.env.REVIEW_MODEL ?? DEFAULT_MODEL;
}

// The campaign's model-rotation roster: REVIEW_MODELS as a comma-separated
// list, falling back to the single reviewer model. Rotation is opt-in by
// construction — until the env names more than one model, the roster has one
// entry and every round bills the model the user already chose.
export function reviewModels(): string[]
{
    const roster = process.env.REVIEW_MODELS
        ?.split(',')
        .map(entry => entry.trim())
        .filter(entry => entry !== '');
    return roster !== undefined && roster.length > 0 ? roster : [reviewModel()];
}

export function judgeModel(): string
{
    return process.env.JUDGE_MODEL ?? DEFAULT_JUDGE_MODEL;
}

// Verification is review-grade work (same tools, same evidence standard), so
// it follows the reviewer's model unless deliberately overridden.
export function verifyModel(): string
{
    return process.env.VERIFY_MODEL ?? process.env.REVIEW_MODEL ?? DEFAULT_MODEL;
}
