// The entry-point boilerplate every CLI repeated verbatim: the exit-code
// wrapper and the flag-argument guards. Kept apart from render.ts, which is
// output; this is process mechanics.

export function runMain(main: () => Promise<number>): void
{
    main().then(
        (code) =>
        {
            process.exitCode = code;
        },
        (err: unknown) =>
        {
            console.error(err instanceof Error ? err.message : String(err));
            process.exitCode = 1;
        },
    );
}

export function requireValue(value: string | undefined, flag: string, usage: string): string
{
    if (value === undefined)
    {
        throw new Error(`${flag} needs a value.\n${usage}`);
    }
    return value;
}

// Every numeric flag in the project is a positive integer (turn budgets, run
// caps, patience, ports, intervals); Number() alone let `--max-turns abc`
// reach the SDK as NaN.
export function requirePositiveInt(value: string | undefined, flag: string, usage: string): number
{
    const n = Number(requireValue(value, flag, usage));
    if (!Number.isInteger(n) || n < 1)
    {
        throw new Error(`${flag} must be a positive integer.\n${usage}`);
    }
    return n;
}
