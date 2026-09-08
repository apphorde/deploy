import { createServer } from 'node:http';
import { lstat, mkdir, readdir, rename, rm } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { join, resolve, parse } from 'node:path';
import { createReadStream, createWriteStream, existsSync, lstatSync, statSync } from 'node:fs';

const enableDebug = !!process.env.DEBUG;
const authKey = process.env.API_KEY;
const baseDomain = process.env.BASE_DOMAIN?.toLowerCase().replace(/\.$/, '');
const workingDir = process.env.DATA_PATH ? resolve(process.env.DATA_PATH) : '';
const trustProxy = process.env.TRUST_PROXY === 'true';
const maxUploadBytes = Number(process.env.MAX_UPLOAD_BYTES || 100 * 1024 * 1024);
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

if (!baseDomain || !workingDir || !Number.isSafeInteger(maxUploadBytes) || maxUploadBytes <= 0) {
    throw new Error('BASE_DOMAIN, DATA_PATH, and a positive MAX_UPLOAD_BYTES must be configured.');
}

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
    if (request.method === 'GET' && request.url === '/api') {
        return onOpenApi(response);
    }

    const host = getRequestHost(request);
    if (!host) {
        return badRequest(response, 'Invalid host header');
    }

    const url = new URL(request.url, 'http://' + host);
    const file = await resolveFile(url);

    if (!file) {
        return notFound(response);
    }

    const extension = parse(file).ext.toLowerCase();
    if (!url.searchParams.has('nocache')) {
        response.setHeader('Cache-Control', 'max-age=86400');
    }

    response.setHeader('Access-Control-Allow-Origin', '*');
    response.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    response.setHeader('Content-Type', mimeTypes[extension] || 'text/plain');
    response.setHeader('X-Content-Type-Options', 'nosniff');

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

    const baseFolder = resolve(workingDir, folder);

    // Path Traversal Mitigation: Enforce absolute sub-tree isolation
    if (!isWithinWorkingDir(baseFolder)) {
        console.log('Unsafe folder path ' + folder);
        return null;
    }

    if (folder !== '.' && !existsSync(baseFolder)) {
        console.log('Invalid folder ' + folder);
        return null;
    }

    let candidates = getCandidates(pathname);
    const all = candidates.map(c => resolve(baseFolder, c));
    const found = all.find(f => isWithinDirectory(f, baseFolder) && existsSync(f) && statSync(f).isFile() && !isSymbolicLink(f));

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
    const host = getRequestHost(request);
    if (!host) return '';

    const url = new URL(request.url, 'http://' + host);
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
    if (!isWithinWorkingDir(dir) || !existsSync(dir) || !statSync(dir).isDirectory() || isSymbolicLink(dir)) {
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
    if (!isWithinWorkingDir(dir) || !existsSync(dir) || !statSync(dir).isDirectory() || isSymbolicLink(dir)) {
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
    let stagingDir;

    try {
        const randomName = randomUUID();
        const name = resolveName(request);
        const targetDir = resolve(workingDir, name || randomName);

        if (!isWithinWorkingDir(targetDir)) {
            throw new Error('Exploit blocked: Target path falls outside data root.');
        }

        tmpFile = join(workingDir, randomName + '.tgz');

        const contentLength = Number(request.headers['content-length']);
        if (Number.isFinite(contentLength) && contentLength > maxUploadBytes) {
            response.writeHead(413).end('Archive exceeds the upload limit.');
            return;
        }

        await new Promise((resolveWrite, rejectWrite) => {
            let uploadedBytes = 0;
            const s = createWriteStream(tmpFile);
            request.on('data', chunk => {
                uploadedBytes += chunk.length;
                if (uploadedBytes > maxUploadBytes) {
                    request.destroy(new Error('Archive exceeds the upload limit.'));
                }
            });
            s.on('close', resolveWrite);
            s.on('error', rejectWrite);
            request.on('error', rejectWrite);
            request.pipe(s);
        });

        stagingDir = join(workingDir, randomName);
        await mkdir(stagingDir, { recursive: true });

        // Hardened tar arguments: restricts extracting symlinks escaping targets, enforces permissions dropping
        const sh = spawnSync('tar', [
            '-xzf',
            tmpFile,
            '--overwrite',
            '--no-same-owner',
            '--no-same-permissions',
            '--directory',
            stagingDir,
        ]);

        if (sh.status !== 0) {
            throw new Error('Failed to extract package archive natively.');
        }

        if (!(await containsOnlyFilesAndDirectories(stagingDir))) {
            throw new Error('Archive contains unsupported file types.');
        }

        if (existsSync(targetDir)) {
            await rm(targetDir, { recursive: true, force: true });
        }
        await rename(stagingDir, targetDir);

        response.writeHead(201).end(
            JSON.stringify({
                status: 'success',
                url: `https://${name || randomName}.${baseDomain}`,
            })
        );
    } catch (error) {
        const status = String(error.message || error).includes('upload limit') ? 413 : 400;
        response.writeHead(status).end(JSON.stringify({ status: 'error', error: String(error.message || error) }));
    } finally {
        if (tmpFile && existsSync(tmpFile)) {
            await rm(tmpFile, { force: true });
        }
        if (stagingDir && existsSync(stagingDir)) {
            await rm(stagingDir, { recursive: true, force: true });
        }
    }
}

function getRequestHost(request) {
    const rawHost = trustProxy ? request.headers['x-forwarded-host'] : request.headers.host;
    if (typeof rawHost !== 'string' || rawHost.includes(',') || rawHost.includes('/') || rawHost.includes('\\') || rawHost.includes('@')) {
        return '';
    }

    try {
        return new URL(`http://${rawHost}`).hostname.toLowerCase().replace(/\.$/, '');
    } catch {
        return '';
    }
}

function isWithinDirectory(path, directory) {
    return path === directory || path.startsWith(directory + '/');
}

function isWithinWorkingDir(path) {
    return isWithinDirectory(path, workingDir);
}

function isSymbolicLink(path) {
    return lstatSync(path).isSymbolicLink();
}

async function containsOnlyFilesAndDirectories(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        const status = await lstat(path);
        if (status.isSymbolicLink() || !(status.isFile() || status.isDirectory()) || (status.isFile() && status.nlink > 1)) return false;
        if (status.isDirectory() && !(await containsOnlyFilesAndDirectories(path))) return false;
    }
    return true;
}

function onOpenApi(response) {
    const spec = {
        openapi: '3.1.0',
        info: { title: 'Static Assets Server API', version: '1.0.0' },
        paths: {
            '/api': { get: { summary: 'Get this OpenAPI document', responses: { 200: { description: 'OpenAPI document' } } } },
            '/{assetPath}': {
                get: { summary: 'Fetch a static asset', parameters: [{ name: 'assetPath', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: { description: 'Asset content' }, 404: { description: 'Asset not found' } } },
                head: { summary: 'Get static asset headers', responses: { 200: { description: 'Asset headers' }, 404: { description: 'Asset not found' } } },
            },
            '/': {
                get: { summary: 'Fetch the root static asset', responses: { 200: { description: 'Asset content' }, 404: { description: 'Asset not found' } } },
                head: { summary: 'Get root static asset headers', responses: { 200: { description: 'Asset headers' }, 404: { description: 'Asset not found' } } },
                post: { summary: 'Deploy a gzip tar archive', security: [{ ApiKeyAuth: [] }], responses: { 201: { description: 'Deployment created' }, 400: { description: 'Invalid archive or name' }, 413: { description: 'Archive too large' } } },
                delete: { summary: 'Delete a deployment', security: [{ ApiKeyAuth: [] }], responses: { 202: { description: 'Deployment deleted' }, 404: { description: 'Deployment not found' } } },
                copy: { summary: 'Download a deployment as a gzip tar archive', security: [{ ApiKeyAuth: [] }], responses: { 200: { description: 'Deployment archive' }, 404: { description: 'Deployment not found' } } },
            },
        },
        components: { securitySchemes: { ApiKeyAuth: { type: 'apiKey', in: 'header', name: 'Authorization' } } },
    };
    response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }).end(JSON.stringify(spec));
}

function notFound(response) {
    response.writeHead(404).end('Not found');
}

function badRequest(response, reason = '') {
    response.writeHead(400).end(reason);
}
