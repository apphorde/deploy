import { createServer } from 'node:http';
import { mkdir, rm } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { join, resolve, parse } from 'node:path';
import { createReadStream, createWriteStream, existsSync, statSync } from 'node:fs';

const enableDebug = !!process.env.DEBUG;
const authKey = process.env.API_KEY;
const baseDomain = process.env.BASE_DOMAIN;
const workingDir = process.env.DATA_PATH;
const versionMarker = /^(.+)@(.+)$/g;
const safeNameRegExp = /^(?:@[a-z0-9-_]+[/]?)?[a-z0-9-_]+$/i;
const extensionCandidates = (process.env.EXTENSIONS || 'html,mjs,js,css').split(',').map(s => '.' + s.trim());
const indexFiles = extensionCandidates.map(ext => 'index' + ext);
const mimeTypes = {
    '.css': 'text/css',
    '.html': 'text/html',
    '.js': 'text/javascript',
    '.mjs': 'text/javascript',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpeg': 'image/jpeg',
    '.jpg': 'image/jpeg',
};

createServer(async function (request, response) {
    response.on('finish', () => {
        if (request.url === '/favicon.ico') return;
        console.log(`[${new Date().toISOString().slice(0, 19)}] [${response.statusCode}] ${request.method} ${request.url}`); 
    });

    try {
        if (request.method === 'POST') {
            return onDeploy(request, response);
        }

        if (request.method === 'DELETE') {
            return onRemove(request, response);
        }

        if (request.method === 'COPY') {
            return onBackup(request, response);
        }

        if (['OPTIONS', 'GET', 'HEAD'].includes(request.method) === false) {
            return notFound(response);
        }

        onFetch(request, response);
    } catch (e) {
        console.error(e);
        if (!response.headersSent) {
            response.writeHead(500).end();
        }
    }
}).listen(Number(process.env.PORT || 3000), () => console.log('Started on ' + (process.env.PORT || 3000)));

// Secure Constant-Time Authorization
function isAuthorized(request) {
    const providedKey = request.headers.authorization;
    if (!authKey || !providedKey) return false;

    const bufA = Buffer.from(authKey);
    const bufB = Buffer.from(providedKey);

    if (bufA.length !== bufB.length) return false;
    return timingSafeEqual(bufA, bufB);
}

async function onFetch(request, response) {
    const forwardedHost = request.headers['x-forwarded-host'] || '';
    // Only accept domains matching our layout to minimize header-spoofing vectors
    if (forwardedHost.includes('/') || forwardedHost.includes('\\')) {
        return badRequest(response, 'Invalid host header');
    }

    const url = new URL(request.url, 'http://' + forwardedHost);
    const file = await resolveFile(url);

    if (!file) {
        return notFound(response);
    }

    const extension = parse(file).ext.toLowerCase();
    if (!url.searchParams.has('nocache')) {
        response.setHeader('Cache-Control', 'max-age=86400');
    }

    response.setHeader('Access-Control-Allow-Origin', '*');
    response.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS, POST, HEAD');
    response.setHeader('Content-Type', mimeTypes[extension] || 'text/plain');

    if (request.method === 'HEAD') {
        return response.end();
    }

    createReadStream(file).pipe(response);
}

async function resolveFile(url) {
    const { hostname, pathname } = url;

    let folder =
        hostname === baseDomain
            ? '.'
            : String(hostname)
                  .replace('.' + baseDomain, '')
                  .split('.')[0] || '';

    if (!folder) {
        return null;
    }

    if (folder.startsWith('--')) folder = folder.replace('--', '@');
    if (folder.startsWith('at-')) folder = folder.replace('at-', '@');

    // Ensure folder structure matches clean schemas (or root dot rule)
    if (folder !== '.' && !safeNameRegExp.test(folder)) {
        console.log('Unsafe folder ' + folder);
        return null;
    }

    const baseFolder = join(workingDir, folder);

    // Path Traversal Mitigation: Enforce absolute sub-tree isolation
    if (!baseFolder.startsWith(resolve(workingDir))) {
        console.log('Unsafe folder path ' + folder);
        return null;
    }

    if (folder !== '.' && !existsSync(baseFolder)) {
        console.log('Invalid folder ' + folder);
        return null;
    }

    let candidates = getCandidates(pathname);
    const all = candidates.map(c => join(baseFolder, c));
    const found = all.find(f => f.startsWith(baseFolder) && existsSync(f) && statSync(f).isFile());

    if (!found) {
        return null;
    }

    return found;
}

/**
 * URL pathname possibilities:
 * /
 * /foo.css
 * /foo.css/latest
 * /foo.css/0.0.0
 * /foo-bar
 * /foo-bar@1.0.0
 * /foo-bar@1.0.0.mjs
 * /foo-bar/index.mjs
 * /@scope/foobar
 * /@scope/foobar@latest
 * /@scope/foobar@latest.mjs
 *
 * If pathname is just `/`, test just index files
 * If pathname is `/favicon.icon`, return only that path.
 * /foo.css could be a file, but could also be a folder name with more files inside
 * /foo@bar, aka name and version, is mapped to `foo/bar`
 * /foo@latest maps to /foo@0.0.0, a *special case* for "always latest"
 * after name resolution, all possible candidates are appended with extensions
 *
 * For each of these:
 * foo
 * foo/index
 * foo/0.0.0
 * foo/1.2.3
 * foo/latest
 *
 * We try foo.html, foo.mjs, foo.js, foo/0.0.0.html, foo/0.0.0.mjs, and so on
 *
 * @param {string} pathname
 * @returns {string[]}
 */
function getCandidates(pathname) {
    if (pathname === '/') return indexFiles;
    if (pathname === '/favicon.ico') return [pathname];

    // Strip out potential dot-dot path sequences early
    const sanitizedPathname = resolve('/', pathname).replace(/^\/+/, '');
    const withVersionReplaced = sanitizedPathname.replace(versionMarker, '$1/$2');
    const requestedExtension = parse(sanitizedPathname).ext.toLowerCase();
    const extensions = requestedExtension ? extensionCandidates.concat(requestedExtension) : extensionCandidates;

    const candidates = [
        ...new Set([
            withVersionReplaced,
            withVersionReplaced.replace('latest', '0.0.0'),
            sanitizedPathname + '/index',
            sanitizedPathname + '/0.0.0',
            sanitizedPathname + '/latest',
        ]),
    ];

    return [sanitizedPathname, ...extensions.flatMap(ext => candidates.map(c => c + ext))];
}

function resolveName(request) {
    const forwardedHost = request.headers['x-forwarded-host'] || 'localhost';
    if (forwardedHost.includes('/') || forwardedHost.includes('\\')) return '';

    const url = new URL(request.url, 'http://' + forwardedHost);
    const nameUnresolved =
        (url.hostname === baseDomain
            ? request.headers['x-deploy-name']
            : url.hostname.replace('.' + baseDomain, '').split('.')[0]) || '';

    if (!nameUnresolved || !safeNameRegExp.test(nameUnresolved)) {
        return '';
    }

    return nameUnresolved;
}

async function onBackup(request, response) {
    if (!isAuthorized(request)) {
        console.log('unauthorized key configuration attempt');
        badRequest(response, 'Unauthorized');
        return;
    }

    let name = resolveName(request);
    if (!name) {
        response.writeHead(400).end('Name not specified or contains illegal characters.');
        return;
    }

    const dir = join(workingDir, name);
    if (!dir.startsWith(resolve(workingDir)) || !existsSync(dir) || !statSync(dir).isDirectory()) {
        notFound(response);
        return;
    }

    const sh = spawn('tar', ['c', '-z', '-C', dir, '-f', '-', '.']);

    sh.on('exit', status => {
        if (status) {
            if (!response.headersSent) response.writeHead(500);
            response.end('Failed to generate file');
        }
    });

    response.setHeader('Content-Type', 'application/x-gzip');
    response.setHeader('Content-Disposition', `attachment; filename="${name.replace(/\//g, '-')}.tgz"`);

    sh.stdout.pipe(response);
    sh.stderr.on('data', c => console.error(c.toString()));
}

async function onRemove(request, response) {
    if (!isAuthorized(request)) {
        badRequest(response, 'Unauthorized');
        return;
    }

    let name = resolveName(request);
    if (!name) return badRequest(response, 'Invalid deployment name target');

    const dir = join(workingDir, name);
    if (!dir.startsWith(resolve(workingDir)) || !existsSync(dir) || !statSync(dir).isDirectory()) {
        return notFound(response);
    }

    // Fixed non-existent rmdirSync crash by utilizing async recursive rm wrapper
    await rm(dir, { recursive: true, force: true });
    response.writeHead(202).end();
}

async function onDeploy(request, response) {
    if (!isAuthorized(request)) {
        badRequest(response, 'Unauthorized');
        return;
    }

    let tmpFile;

    try {
        const randomName = randomUUID();
        const name = resolveName(request);
        const targetDir = name ? join(workingDir, name) : join(workingDir, randomName);

        if (!targetDir.startsWith(resolve(workingDir))) {
            throw new Error('Exploit blocked: Target path falls outside data root.');
        }

        if (existsSync(targetDir)) {
            await rm(targetDir, { recursive: true, force: true });
        }

        tmpFile = join(workingDir, randomName + '.tgz');

        await new Promise((r, j) => {
            const s = createWriteStream(tmpFile);
            s.on('close', r);
            s.on('error', j);
            request.pipe(s);
        });

        await mkdir(targetDir, { recursive: true });

        // Hardened tar arguments: restricts extracting symlinks escaping targets, enforces permissions dropping
        const sh = spawnSync('tar', [
            '-xzf',
            tmpFile,
            '--overwrite',
            '--no-same-owner',
            '--no-same-permissions',
            '--directory',
            targetDir,
        ]);

        if (sh.status !== 0) {
            throw new Error('Failed to extract package archive natively.');
        }

        response.writeHead(201).end(
            JSON.stringify({
                status: 'success',
                url: `https://${name || randomName}.${baseDomain}`,
            })
        );
    } catch (error) {
        response.writeHead(400).end(JSON.stringify({ status: 'error', error: String(error.message || error) }));
    } finally {
        if (tmpFile && existsSync(tmpFile)) {
            await rm(tmpFile, { force: true });
        }
    }
}

function notFound(response) {
    response.writeHead(404).end('Not found');
}

function badRequest(response, reason = '') {
    response.writeHead(400).end(reason);
}
