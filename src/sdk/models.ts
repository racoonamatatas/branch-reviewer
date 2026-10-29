// Model policy for the three roles, in one place. The reviewer and verifier
// read whole diffs and hunt evidence — they get the strong default. The
// clustering judge solves a matching problem over short texts; Sonnet handles
// it, and pinning the judge cheap is what keeps rounds+1 judge calls per
// campaign from rivalling the reviews they meter. Each runner resolves its
// own default so no query() ever falls through to the SDK's — the model a
// run used must always be the model somebody chose.

export const DEFAULT_MODEL = 'claude-opus-5';
export const DEFAULT_JUDGE_MODEL = 'claude-sonnet-5';

// The campaign roster nobody narrowed. Same-model recurrence is self-
// agreement, not evidence (an empirically false claim recurred 3× from one
// model), so campaigns rotate unless told otherwise. The partner differs in
// both family and generation from the default reviewer — the most
// independent pairing on offer — and bills below it.
export const DEFAULT_REVIEW_MODELS: readonly string[] = [DEFAULT_MODEL, 'claude-sonnet-5-5'];

export function reviewModel(): string
{
    return process.env.REVIEW_MODEL ?? DEFAULT_MODEL;
}

// The campaign's model-rotation roster: REVIEW_MODELS as a comma-separated
// list; else a set REVIEW_MODEL, a deliberate single-model choice that
// rotation must not override; else DEFAULT_REVIEW_MODELS.
export function reviewModels(): string[]
{
    const roster = process.env.REVIEW_MODELS
        ?.split(',')
        .map(entry => entry.trim())
        .filter(entry => entry !== '');
    if (roster !== undefined && roster.length > 0)
    {
        return roster;
    }
    return process.env.REVIEW_MODEL !== undefined ? [process.env.REVIEW_MODEL] : [...DEFAULT_REVIEW_MODELS];
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
