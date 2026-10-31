// Database maintenance: fold another machine's review database into this
// one. Nothing here calls the model; it only moves rows between files.

import { existsSync, realpathSync } from 'node:fs';
import { backupDatabase, mergeDatabases, mergeReportLines } from '../store/merge.js';
import { DEFAULT_DB_PATH } from '../store/store.js';

const USAGE = 'Usage: npm run db -- merge <source.db>   (stop npm run serve first)';

function main(): number
{
    const [command, source, ...rest] = process.argv.slice(2);
    if (command !== 'merge' || source === undefined || rest.length > 0)
    {
        throw new Error(USAGE);
    }
    if (!existsSync(source))
    {
        throw new Error(`No such source database: ${source}`);
    }
    if (existsSync(DEFAULT_DB_PATH) && realpathSync(source) === realpathSync(DEFAULT_DB_PATH))
    {
        throw new Error('The source is the target; nothing to merge.');
    }

    // A fresh machine has no target yet: the merge creates it, and there is
    // nothing to back up.
    if (existsSync(DEFAULT_DB_PATH))
    {
        console.log(`backup: ${backupDatabase(DEFAULT_DB_PATH)}`);
    }

    try
    {
        const report = mergeDatabases(DEFAULT_DB_PATH, source);
        console.log(`merged ${source} into ${DEFAULT_DB_PATH}:`);
        for (const line of mergeReportLines(report))
        {
            console.log(line);
        }
        return 0;
    }
    catch (err)
    {
        // The merge runs in one transaction, so a refusal leaves the target
        // as it was; the backup is belt and braces.
        console.error(`merge refused, target unchanged: ${err instanceof Error ? err.message : String(err)}`);
        return 1;
    }
}

try
{
    process.exitCode = main();
}
catch (err)
{
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
}
