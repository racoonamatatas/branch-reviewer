// Static serving for the built dashboard: the job server hands out
// dashboard/dist so the app and the API are literally same-origin — the
// same-origin paths the dev proxy fakes (see dashboard/vite.config.ts) are
// real in production, and no CORS layer exists anywhere.

import { readFile } from 'node:fs/promises';
import type { ServerResponse } from 'node:http';
import { extname, resolve, sep } from 'node:path';

// Everything Vite emits into dist today, plus the obvious near-misses.
// Anything else is served as octet-stream rather than rejected — an unknown
// extension is a download, not an error.
const MIME_TYPES: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json',
    '.map': 'application/json',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.ico': 'image/x-icon',
    '.woff2': 'font/woff2',
};

// Vite content-hashes every file under assets/, so those never change under
// their name; index.html is the one mutable entry point and must revalidate,
// or a redeploy would keep serving the old asset graph.
const IMMUTABLE = 'public, max-age=31536000, immutable';
const REVALIDATE = 'no-cache';

// Serves one GET from the built app. The SPA fallback is deliberately broad:
// any miss outside assets/ answers with index.html, because client routes
// embed branch names and those contain dots ("release/v1.2") — an
// extension-based fallback rule would 404 exactly the routes the dashboard
// links to. A miss under assets/ stays a 404: falling back there would feed
// HTML to a <script> tag and mask a broken build.
export async function serveStatic(root: string, pathname: string, res: ServerResponse): Promise<void>
{
    const target = resolveWithin(root, pathname);
    if (target === undefined)
    {
        return notFound(res);
    }

    const file = await tryRead(target);
    if (file !== undefined)
    {
        return send(res, target, file);
    }
    if (pathname.startsWith('/assets/'))
    {
        return notFound(res);
    }

    const index = resolve(root, 'index.html');
    const fallback = await tryRead(index);
    return fallback === undefined
        ? notFound(res)
        : send(res, index, fallback);
}

// Maps a URL path onto a file inside root, or refuses. resolve() collapses
// any ../ segments, so containment is a plain prefix check afterwards; the
// decode comes first because %2e%2e is still a dot-dot to the filesystem.
function resolveWithin(root: string, pathname: string): string | undefined
{
    let decoded: string;
    try
    {
        decoded = decodeURIComponent(pathname);
    }
    catch
    {
        return undefined;
    }
    if (decoded.includes('\0'))
    {
        return undefined;
    }

    const target = resolve(root, `.${decoded.endsWith('/') ? `${decoded}index.html` : decoded}`);
    return target === root || target.startsWith(root + sep) ? target : undefined;
}

// dist files are a few hundred kilobytes at most — a whole-file read beats
// stream plumbing. A directory hit (EISDIR) is a miss like any other.
async function tryRead(path: string): Promise<Buffer | undefined>
{
    try
    {
        return await readFile(path);
    }
    catch
    {
        return undefined;
    }
}

function send(res: ServerResponse, path: string, body: Buffer): void
{
    res.writeHead(200, {
        'content-type': MIME_TYPES[extname(path)] ?? 'application/octet-stream',
        'cache-control': path.includes(`${sep}assets${sep}`) ? IMMUTABLE : REVALIDATE,
    });
    res.end(body);
}

// JSON like every other 404 this server sends: the miss may be an API typo,
// and an HTML error page would trip the dashboard client's JSON parse.
function notFound(res: ServerResponse): void
{
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'No such file.' }));
}
