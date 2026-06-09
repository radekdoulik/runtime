// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BrowserDir = path.dirname(fileURLToPath(import.meta.url));
const RepoRoot = path.resolve(BrowserDir, '../../../../..');
const ArtifactRoot = path.join(RepoRoot, 'artifacts/wasm-dbi-dac-browser-smoke');
const SharedFrameworkRoot = path.join(RepoRoot, 'artifacts/bin/testhost/net11.0-browser-Debug-wasm/shared/Microsoft.NETCore.App/11.0.0');
const SharedPrefix = '/shared/Microsoft.NETCore.App/11.0.0/';

function parsePort(argv) {
    for (let index = 2; index < argv.length; index++) {
        const arg = argv[index];
        if (arg.startsWith('--port=')) {
            return Number.parseInt(arg.slice('--port='.length), 10);
        }
        if (arg === '--port') {
            return Number.parseInt(argv[++index], 10);
        }
    }

    return 8080;
}

function contentType(filePath) {
    const extension = path.extname(filePath).toLowerCase();
    return {
        '.html': 'text/html; charset=utf-8',
        '.js': 'text/javascript; charset=utf-8',
        '.mjs': 'text/javascript; charset=utf-8',
        '.json': 'application/json; charset=utf-8',
        '.wasm': 'application/wasm',
        '.dll': 'application/octet-stream',
        '.pdb': 'application/octet-stream'
    }[extension] ?? 'application/octet-stream';
}

function safeJoin(root, requestPath) {
    let decoded;
    try {
        decoded = decodeURIComponent(requestPath);
    } catch {
        return null;
    }

    const candidate = path.resolve(root, decoded.replace(/^\/+/, ''));
    return candidate === root || candidate.startsWith(`${root}${path.sep}`) ? candidate : null;
}

function resolveRequest(urlPath) {
    if (urlPath === '/') {
        return { text: 'wasm-dbi-dac browser smoke server\n' };
    }

    if (urlPath.startsWith(SharedPrefix)) {
        const file = safeJoin(SharedFrameworkRoot, urlPath.slice(SharedPrefix.length));
        if (file !== null && fs.existsSync(file) && fs.statSync(file).isFile()) {
            return { file };
        }
    }

    for (const root of [ArtifactRoot, BrowserDir]) {
        const file = safeJoin(root, urlPath);
        if (file !== null && fs.existsSync(file) && fs.statSync(file).isFile()) {
            return { file };
        }
    }

    return null;
}

const port = parsePort(process.argv);
const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
    const resolved = resolveRequest(url.pathname);
    res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    console.log(`${req.method} ${url.pathname} -> ${resolved?.file ?? (resolved?.text !== undefined ? 'text' : '404')}`);

    if (resolved === null) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Not found\n');
        return;
    }

    if (resolved.text !== undefined) {
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(resolved.text);
        return;
    }

    res.writeHead(200, { 'Content-Type': contentType(resolved.file) });
    fs.createReadStream(resolved.file).pipe(res);
});

server.listen(port, '127.0.0.1', () => {
    console.log(`Open http://localhost:${port}/hello-breakpoint.html in Chrome`);
    console.log(`Open http://localhost:${port}/hello-async-break.html in Chrome`);
});
