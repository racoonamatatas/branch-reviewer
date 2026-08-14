// Review lenses: the per-round focus a campaign rotates into the reviewer's
// prompt. Identically-prompted rounds of the same model are correlated
// samples — they walk the same files in the same order and miss the same
// things — which is exactly the independence Chao1 assumes and campaigns
// lack. A lens redirects where a round looks first; it never narrows what
// may be reported, so the recall-first contract survives rotation.

export interface Lens
{
    name: string;
    instruction: string;
}

export const LENSES: readonly Lens[] = [
    {
        name: 'security',
        instruction: 'Start from the attacker\'s side of the diff: trust boundaries it crosses, '
            + 'injection and path traversal, authentication and authorization gaps, secrets in '
            + 'code or config, unsafe deserialization, anything user-controlled reaching a shell, '
            + 'query, or filesystem path.',
    },
    {
        name: 'concurrency',
        instruction: 'Start from ordering and shared state: races, missing awaits, promises '
            + 'dropped without a handler, re-entrancy, retries that are not idempotent, and '
            + 'cleanup that error paths skip.',
    },
    {
        name: 'config-and-deploy',
        instruction: 'Start from where the code actually runs: configuration, environment '
            + 'templates, CI and deploy manifests, migrations, and defaults that differ between '
            + 'environments. Use list_files to find where overrides actually live instead of '
            + 'assuming application config is the whole story.',
    },
    {
        name: 'tests',
        instruction: 'Start from what the tests would miss: changed behavior with no covering '
            + 'test, assertions weakened or deleted alongside the change, tests that cannot fail, '
            + 'and fixtures or mocks that have drifted from the code they stand in for.',
    },
];

// Round 1 is deliberately lens-free: the generalist pass samples the whole
// surface the way every stored run did, keeping the campaign's baseline
// comparable with its own history. Later rounds cycle the lenses, and the
// cycle re-enters the generalist slot so long campaigns keep sampling it.
export function lensFor(round: number): Lens | undefined
{
    const slot = (round - 1) % (LENSES.length + 1);
    return slot === 0 ? undefined : LENSES[slot - 1];
}
