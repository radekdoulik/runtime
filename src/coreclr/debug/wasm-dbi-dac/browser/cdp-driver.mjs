#!/usr/bin/env node
// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.
//
// cdp-driver.mjs — standalone Node CDP driver for the WASM CoreCLR
// async-break demo. Plays the IDE/mscordbi role over CDP exactly the
// way our Chrome extension and Playwright spec do — connects to a
// real Chrome started with `--remote-debugging-port=<port>`,
// orchestrates the 8-step demo, then exits.
//
// Same pattern as Mono's BrowserDebugProxy (chrome with the flag +
// external process speaking CDP), bundled into our serve script.
//
// Usage:
//   node cdp-driver.mjs [--port=9222] [--target-url-substring=hello-async-break.html]

const argv = process.argv.slice(2);
let cdpPort = 9222;
let targetSubstring = 'hello-async-break.html';
for (const arg of argv) {
    if (arg.startsWith('--port=')) cdpPort = Number(arg.slice('--port='.length));
    else if (arg.startsWith('--target-url-substring=')) targetSubstring = arg.slice('--target-url-substring='.length);
    else if (arg === '-h' || arg === '--help') {
        console.log('Usage: cdp-driver.mjs [--port=9222] [--target-url-substring=hello-async-break.html]');
        process.exit(0);
    } else {
        console.error('Unknown arg:', arg);
        process.exit(2);
    }
}

function log(text, kind) {
    const prefix = kind === 'err' ? '\x1b[31m[cdp-driver]\x1b[0m' : '\x1b[36m[cdp-driver]\x1b[0m';
    console.log(`${prefix} ${text}`);
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitFor(probe, description, timeoutMs, intervalMs = 100) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const value = await probe();
        if (value !== undefined && value !== null && value !== false) {
            return value;
        }
        await sleep(intervalMs);
    }
    throw new Error(`timed out waiting for ${description} (${timeoutMs}ms)`);
}

async function discoverTarget(port, urlSubstring) {
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
        try {
            const response = await fetch(`http://localhost:${port}/json`);
            if (response.ok) {
                const targets = await response.json();
                const match = targets.find(t =>
                    t.type === 'page' &&
                    typeof t.url === 'string' &&
                    t.url.includes(urlSubstring));
                if (match && match.webSocketDebuggerUrl) {
                    return match;
                }
            }
        } catch {
            // chrome not up yet
        }
        await sleep(250);
    }
    throw new Error(`no chrome target found matching ${urlSubstring} on port ${port}`);
}

// Minimal CDP client over WebSocket. Uses Node's native global
// WebSocket (Node 22+); no third-party deps.
class CdpClient {
    constructor(webSocketDebuggerUrl) {
        this.ws = new WebSocket(webSocketDebuggerUrl);
        this.nextId = 1;
        this.pending = new Map();
        this.eventListeners = new Map();
        this._readyPromise = new Promise((resolve, reject) => {
            this.ws.addEventListener('open', () => resolve());
            this.ws.addEventListener('error', e => reject(new Error('ws error: ' + (e?.message ?? e))));
        });
        this.ws.addEventListener('message', e => this._onMessage(e));
        this.ws.addEventListener('close', () => {
            for (const { reject } of this.pending.values()) {
                reject(new Error('CDP connection closed'));
            }
            this.pending.clear();
        });
    }

    ready() { return this._readyPromise; }

    _onMessage(event) {
        let msg;
        try {
            msg = JSON.parse(event.data);
        } catch {
            return;
        }
        if (msg.id !== undefined) {
            const handler = this.pending.get(msg.id);
            if (handler) {
                this.pending.delete(msg.id);
                if (msg.error) {
                    handler.reject(new Error(`CDP error: ${msg.error.message || JSON.stringify(msg.error)}`));
                } else {
                    handler.resolve(msg.result);
                }
            }
        } else if (msg.method) {
            const listeners = this.eventListeners.get(msg.method);
            if (listeners) {
                for (const listener of [...listeners]) {
                    try { listener(msg.params); } catch (e) { log(`listener error: ${e.message}`, 'err'); }
                }
            }
        }
    }

    send(method, params) {
        return new Promise((resolve, reject) => {
            const id = this.nextId++;
            this.pending.set(id, { resolve, reject });
            this.ws.send(JSON.stringify({ id, method, params: params || {} }));
        });
    }

    on(eventName, listener) {
        let set = this.eventListeners.get(eventName);
        if (!set) { set = new Set(); this.eventListeners.set(eventName, set); }
        set.add(listener);
        return () => set.delete(listener);
    }

    waitForEvent(eventName, predicate, timeoutMs) {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                off();
                reject(new Error(`${eventName} matching predicate did not arrive within ${timeoutMs}ms`));
            }, timeoutMs);
            const listener = async (params) => {
                let matches;
                try { matches = await Promise.resolve(predicate(params)); } catch { matches = false; }
                if (!matches) return;
                clearTimeout(timer);
                off();
                resolve(params);
            };
            const off = this.on(eventName, listener);
        });
    }

    close() { try { this.ws.close(); } catch { /* ignore */ } }
}

async function cdpEvaluate(cdp, expression) {
    const result = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: false });
    if (result.exceptionDetails) {
        throw new Error(`Runtime.evaluate failed: ${result.exceptionDetails.text || JSON.stringify(result.exceptionDetails)} | expr: ${expression}`);
    }
    return result.result.value;
}

async function runDemo(cdp) {
    log('[step 0] Runtime.enable + Debugger.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Debugger.enable');
    await cdp.send('Debugger.setSkipAllPauses', { skip: false });

    // Catch-all incidental-pause auto-resumer.
    // libCorerun's debugger; statement fires for every event the runtime
    // emits (module load, breakpoint, async-break). Resume any libCorerun
    // pause that is NOT the cooperative async-break we're orchestrating.
    let cooperativeHaltSeen = false;
    cdp.on('Debugger.paused', async (params) => {
        if (cooperativeHaltSeen) {
            // already past the cooperative halt step; any subsequent
            // libCorerun pauses are noise — resume immediately
        } else {
            const kind = await cdpEvaluate(cdp, 'globalThis.__lastFiredEventKind || null').catch(() => null);
            if (kind === 'async-break') return; // ours; handled elsewhere
        }
        const isLibCorerun = params.callFrames.some(f =>
            (f.url || '').endsWith('libCorerun.js') ||
            (f.functionName || '').includes('coreClrDebugFireEventToPause'));
        if (!isLibCorerun) return; // user breakpoint perhaps; don't resume
        await cdp.send('Debugger.resume').catch(() => {});
    });

    log('[step 0b] releasing page (__externalDbiReady = true)');
    await cdpEvaluate(cdp, 'globalThis.__externalDbiReady = true');

    log('[step 0c] waiting for page __dbi facade...');
    await waitFor(() => cdpEvaluate(cdp, 'globalThis.__dbiReady === true'), '__dbiReady', 90000);

    log('[step 0d] waiting for managed loop mid-flight (progress > 30)...');
    await waitFor(async () => {
        const p = await cdpEvaluate(cdp, '(globalThis.__smokeProgress | 0)');
        return p > 30 ? p : false;
    }, 'loop progress > 30', 60000);

    log('[step 1] CDP Debugger.pause');
    const initialPaused = cdp.waitForEvent('Debugger.paused', () => true, 15000);
    await cdp.send('Debugger.pause');
    await initialPaused;
    const stateAtPause = await cdpEvaluate(cdp, 'JSON.stringify(globalThis.__dbi.getState())');
    log('[step 1] V8 frozen; state=' + stateAtPause);

    log('[step 2] writing async-break flag atomically into runtime memory');
    const flagResult = await cdpEvaluate(cdp,
        'JSON.stringify({previous: globalThis.__dbi.setAsyncBreakFlag(1), current: globalThis.__dbi.getState().asyncBreakFlagValue})');
    log('[step 2] flag: ' + flagResult);

    log('[step 3] CDP Debugger.resume; runtime runs until next IL safepoint');
    const cooperativePaused = cdp.waitForEvent('Debugger.paused', async (params) => {
        const isLibCorerun = params.callFrames.some(f =>
            (f.url || '').endsWith('libCorerun.js') ||
            (f.functionName || '').includes('coreClrDebugFireEventToPause'));
        if (!isLibCorerun) return false;
        const kind = await cdpEvaluate(cdp, 'globalThis.__lastFiredEventKind || null');
        return kind === 'async-break';
    }, 30000);
    await cdp.send('Debugger.resume');
    await cooperativePaused;
    cooperativeHaltSeen = true;
    log('[step 4] cooperative halt observed at safepoint');

    log('[step 5] polling event + locals via sidecar DAC');
    const event = JSON.parse(await cdpEvaluate(cdp, 'JSON.stringify(globalThis.__dbi.pollAsyncBreakEvent())'));
    const locals = JSON.parse(await cdpEvaluate(cdp, 'JSON.stringify(globalThis.__dbi.pollLocals())'));
    const localCount = locals && locals.record ? locals.record.localCount : 0;
    log('[step 5] event token=' + event.payload.asyncBreakToken + ' locals=' + localCount);

    log('[step 6] rendering pause panel in browser');
    const message = 'Simulating IDE debug pause (5s hold; runtime halted at IL=' + event.payload.ilOffset + ' in method=' + event.payload.funcMetadataToken + ')';
    await cdpEvaluate(cdp,
        'globalThis.__dbi.renderPausePanel(' + JSON.stringify(message) + ', ' + JSON.stringify(event.payload) + ', ' + JSON.stringify(locals.record) + ')');

    log('[step 7] holding 5s (simulated IDE user looking at debugger UI)');
    const progressBeforeHold = await cdpEvaluate(cdp, '(globalThis.__smokeProgress | 0)');
    await sleep(5000);
    const progressAfterHold = await cdpEvaluate(cdp, '(globalThis.__smokeProgress | 0)');
    log('[step 7] hold complete; progress ' + progressBeforeHold + ' -> ' + progressAfterHold + ' (runtime was frozen: ' + (progressAfterHold === progressBeforeHold) + ')');

    log('[step 8] CDP Debugger.resume; runtime continues to completion');
    await cdp.send('Debugger.resume');

    await waitFor(() => cdpEvaluate(cdp, 'globalThis.__smokeResult !== undefined'), '__smokeResult', 60000);
    const result = JSON.parse(await cdpEvaluate(cdp, 'JSON.stringify(globalThis.__smokeResult)'));
    log('demo complete: ' + (result.passed ? 'PASS' : 'FAIL') + ' finalTickCount=' + (result.result?.tickCount ?? '?'), result.passed ? undefined : 'err');
    return result;
}

async function main() {
    log(`discovering CDP target on localhost:${cdpPort} matching "${targetSubstring}"...`);
    const target = await discoverTarget(cdpPort, targetSubstring);
    log(`connecting to ${target.webSocketDebuggerUrl}`);
    const cdp = new CdpClient(target.webSocketDebuggerUrl);
    await cdp.ready();
    try {
        const result = await runDemo(cdp);
        process.exitCode = result.passed ? 0 : 1;
    } finally {
        cdp.close();
    }
}

main().catch(e => {
    log('FATAL: ' + (e.stack || e.message || String(e)), 'err');
    process.exitCode = 1;
});
