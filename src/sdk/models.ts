import type { Severity } from '../schema/schema.js';

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

// Nits are verified too (no finding reaches a human unverified) but don't
// earn the strong model's price: a single-model campaign sends every cluster
// to the verifier, and one such campaign's 11 nits of 17 clusters were
// most of a $17.79 pass.
export const DEFAULT_NIT_VERIFY_MODEL = 'claude-sonnet-5-5';

// A record over every severity rather than a default plus exceptions, so a
// new severity fails to compile until someone decides who verifies it.
export type VerifyModels = Readonly<Record<Severity, string>>;

export function verifyModels(): VerifyModels
{
    const strong = verifyModel();
    return { critical: strong, warning: strong, nit: process.env.VERIFY_NIT_MODEL ?? DEFAULT_NIT_VERIFY_MODEL };
}

// A requester who names one verify model (a job's `model`) asked for that
// model on every cluster; the nit tier must not override a deliberate choice.
export function uniformVerifyModels(model: string): VerifyModels
{
    return { critical: model, warning: model, nit: model };
}
