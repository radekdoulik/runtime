// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.
//
// background.js — Chrome MV3 service worker that drives the
// IDE/mscordbi side of the WASM CoreCLR DBI/DAC async-break demo.
//
// Flow on action button click:
//   1. Reload the active tab with ?wait-for-external-dbi=1 if needed
//      so the page blocks before loading sidecar/runtime.
//   2. chrome.debugger.attach + Debugger.enable BEFORE the page
//      instantiates the runtime/sidecar wasm modules. This matches
//      the Playwright spec's attach-before-page-load ordering.
//   3. Set globalThis.__externalDbiReady = true via Runtime.evaluate
//      to release the page so it loads sidecar + runtime.
//   4. Wait for the page to expose its __dbi facade and the loop to
//      be mid-flight (progress > 30).
//   5. Run the 8-step IDE/DBI orchestration:
//      Debugger.pause -> setAsyncBreakFlag via memory write ->
//      Debugger.resume -> wait for cooperative halt at safepoint ->
//      poll event + locals via sidecar DAC -> render pause panel in
//      page DOM -> 5s hold -> Debugger.resume -> loop completes.

const target = (tabId) => ({ tabId });
const PROTOCOL_VERSION = '1.3';
const PAGE_PATH = '/hello-async-break.html';

function sendProgress(text, kind) {
    chrome.runtime.sendMessage({ type: 'demo-progress', text, kind }).catch(() => {});
    console.log('[ext]', text);
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function evaluate(t, expression) {
    const response = await chrome.debugger.sendCommand(t, 'Runtime.evaluate', { expression, returnByValue: true, awaitPromise: false });
    if (response.exceptionDetails) {
        throw new Error('Runtime.evaluate failed: ' + (response.exceptionDetails.text || JSON.stringify(response.exceptionDetails)) + ' | expr: ' + expression);
    }
    return response.result.value;
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
    throw new Error('timed out waiting for ' + description + ' (' + timeoutMs + 'ms)');
}

function waitForDebuggerPaused(tabId, predicate, timeoutMs) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            chrome.debugger.onEvent.removeListener(onEvent);
            reject(new Error('Debugger.paused matching predicate did not arrive within ' + timeoutMs + 'ms'));
        }, timeoutMs);
        async function onEvent(source, method, params) {
            if (source.tabId !== tabId || method !== 'Debugger.paused') return;
            const matches = await Promise.resolve(predicate(params));
            if (!matches) return;
            clearTimeout(timer);
            chrome.debugger.onEvent.removeListener(onEvent);
            resolve(params);
        }
        chrome.debugger.onEvent.addListener(onEvent);
    });
}

// Catch-all incidental-pause auto-resumer. Module-load events also
// fire through libCorerun's `debugger;` wrapper — auto-resume any
// pause that is NOT the cooperative async-break we are orchestrating.
function installAutoResume(tabId, isOurCooperativePause) {
    async function onEvent(source, method, params) {
        if (source.tabId !== tabId || method !== 'Debugger.paused') return;
        const ours = await Promise.resolve(isOurCooperativePause(params));
        if (ours) return;
        const isLibCorerun = params.callFrames.some(f =>
            (f.url || '').endsWith('libCorerun.js') ||
            (f.functionName || '').includes('coreClrDebugFireEventToPause'));
        if (!isLibCorerun) {
            // Not a libCorerun-issued pause; user might be debugging
            // manually. Don't resume out from under them.
            return;
        }
        try {
            await chrome.debugger.sendCommand({ tabId }, 'Debugger.resume');
        } catch (e) {
            console.warn('[ext] auto-resume failed:', e);
        }
    }
    chrome.debugger.onEvent.addListener(onEvent);
    return () => chrome.debugger.onEvent.removeListener(onEvent);
}

async function ensurePageWithWaitParam(tabId) {
    const tab = await chrome.tabs.get(tabId);
    if (!tab.url) {
        throw new Error('tab has no URL');
    }
    let url;
    try {
        url = new URL(tab.url);
    } catch {
        throw new Error('tab URL is not parseable: ' + tab.url);
    }
    if (!url.pathname.endsWith(PAGE_PATH)) {
        throw new Error('active tab is not the demo page; expected URL ending with ' + PAGE_PATH + ', got ' + tab.url);
    }
    if (url.searchParams.get('wait-for-external-dbi') === '1') {
        return; // already on the right URL
    }
    url.searchParams.set('wait-for-external-dbi', '1');
    await chrome.tabs.update(tabId, { url: url.toString() });
    // Wait for navigation to complete (status === 'complete').
    await waitFor(async () => {
        const t = await chrome.tabs.get(tabId);
        return t.status === 'complete';
    }, 'tab navigation to complete', 30000, 200);
}

async function runDemo(tabId) {
    sendProgress('reloading tab with ?wait-for-external-dbi=1');
    await ensurePageWithWaitParam(tabId);

    sendProgress('attaching CDP...');
    const t = target(tabId);
    try {
        await chrome.debugger.attach(t, PROTOCOL_VERSION);
    } catch (e) {
        if (!String(e.message || '').includes('Another debugger')) {
            throw e;
        }
        // Already attached (manual DevTools open?) — proceed.
    }

    try {
        sendProgress('[step 0] Runtime.enable + Debugger.enable BEFORE sidecar/runtime instantiate');
        await chrome.debugger.sendCommand(t, 'Runtime.enable');
        await chrome.debugger.sendCommand(t, 'Debugger.enable');
        await chrome.debugger.sendCommand(t, 'Debugger.setSkipAllPauses', { skip: false });

        // Track whether we have already moved past the cooperative-halt
        // step so the auto-resumer can resume all libCorerun pauses
        // after that point (the demo is done).
        let cooperativeHaltSeen = false;
        const uninstallAutoResume = installAutoResume(tabId, async (params) => {
            if (cooperativeHaltSeen) return false;
            const isLibCorerun = params.callFrames.some(f =>
                (f.url || '').endsWith('libCorerun.js') ||
                (f.functionName || '').includes('coreClrDebugFireEventToPause'));
            if (!isLibCorerun) return false;
            const kind = await evaluate(t, 'globalThis.__lastFiredEventKind || null');
            return kind === 'async-break';
        });

        try {
            sendProgress('[step 0b] releasing page (__externalDbiReady = true)');
            await evaluate(t, 'globalThis.__externalDbiReady = true');

            sendProgress('[step 0c] waiting for page __dbi facade...');
            await waitFor(() => evaluate(t, 'globalThis.__dbiReady === true'), '__dbiReady', 90000);

            sendProgress('[step 0d] waiting for managed loop mid-flight (progress > 30)...');
            await waitFor(async () => {
                const p = await evaluate(t, '(globalThis.__smokeProgress | 0)');
                return p > 30 ? p : false;
            }, 'loop progress > 30', 60000);

            sendProgress('[step 1] CDP Debugger.pause');
            const initialPaused = waitForDebuggerPaused(tabId, () => true, 15000);
            await chrome.debugger.sendCommand(t, 'Debugger.pause');
            await initialPaused;
            const stateAtPause = await evaluate(t, 'JSON.stringify(globalThis.__dbi.getState())');
            sendProgress('[step 1] V8 frozen; state=' + stateAtPause);

            sendProgress('[step 2] writing async-break flag atomically into runtime memory');
            const flagResult = await evaluate(t, 'JSON.stringify({previous: globalThis.__dbi.setAsyncBreakFlag(1), current: globalThis.__dbi.getState().asyncBreakFlagValue})');
            sendProgress('[step 2] flag: ' + flagResult);

            sendProgress('[step 3] CDP Debugger.resume; runtime runs until next IL safepoint');
            const cooperativePaused = waitForDebuggerPaused(tabId, async (params) => {
                const isLibCorerun = params.callFrames.some(f =>
                    (f.url || '').endsWith('libCorerun.js') ||
                    (f.functionName || '').includes('coreClrDebugFireEventToPause'));
                if (!isLibCorerun) return false;
                const kind = await evaluate(t, 'globalThis.__lastFiredEventKind || null');
                return kind === 'async-break';
            }, 30000);
            await chrome.debugger.sendCommand(t, 'Debugger.resume');
            await cooperativePaused;
            cooperativeHaltSeen = true;
            sendProgress('[step 4] cooperative halt observed at safepoint');

            sendProgress('[step 5] polling event + locals via sidecar DAC');
            const event = JSON.parse(await evaluate(t, 'JSON.stringify(globalThis.__dbi.pollAsyncBreakEvent())'));
            const locals = JSON.parse(await evaluate(t, 'JSON.stringify(globalThis.__dbi.pollLocals())'));
            const localCount = locals && locals.record ? locals.record.localCount : 0;
            sendProgress('[step 5] event token=' + event.payload.asyncBreakToken + ' locals=' + localCount);

            sendProgress('[step 6] rendering pause panel in browser');
            const message = 'Simulating IDE debug pause (5s hold; runtime halted at IL=' + event.payload.ilOffset + ' in method=' + event.payload.funcMetadataToken + ')';
            await evaluate(t, 'globalThis.__dbi.renderPausePanel(' + JSON.stringify(message) + ', ' + JSON.stringify(event.payload) + ', ' + JSON.stringify(locals.record) + ')');

            sendProgress('[step 7] holding 5s (simulated IDE user looking at debugger UI)');
            const progressBeforeHold = await evaluate(t, '(globalThis.__smokeProgress | 0)');
            await sleep(5000);
            const progressAfterHold = await evaluate(t, '(globalThis.__smokeProgress | 0)');
            sendProgress('[step 7] hold complete; progress ' + progressBeforeHold + ' -> ' + progressAfterHold + ' (runtime was frozen: ' + (progressAfterHold === progressBeforeHold) + ')');

            sendProgress('[step 8] CDP Debugger.resume; runtime continues to completion');
            await chrome.debugger.sendCommand(t, 'Debugger.resume');

            await waitFor(() => evaluate(t, 'globalThis.__smokeResult !== undefined'), '__smokeResult', 60000);
            const result = JSON.parse(await evaluate(t, 'JSON.stringify(globalThis.__smokeResult)'));
            sendProgress('demo complete: ' + (result.passed ? 'PASS' : 'FAIL') + ' finalTickCount=' + (result.result?.tickCount ?? '?'), result.passed ? 'ok' : 'err');
        } finally {
            uninstallAutoResume();
        }
    } finally {
        try {
            await chrome.debugger.detach(t);
        } catch {
            // ignore
        }
    }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || msg.type !== 'run-demo') return false;
    (async () => {
        try {
            await runDemo(msg.tabId);
            sendResponse({ ok: true, message: 'demo finished — check the page' });
        } catch (e) {
            console.error('[ext] runDemo failed:', e);
            sendResponse({ ok: false, error: e.message || String(e) });
        }
    })();
    return true; // keep sendResponse alive for async
});
