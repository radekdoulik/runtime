// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

const status = document.getElementById('status');
const runButton = document.getElementById('run');

function setStatus(text, cls) {
    status.textContent = text;
    status.className = cls || '';
}

runButton.addEventListener('click', async () => {
    runButton.disabled = true;
    setStatus('starting...');
    try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab || !tab.id) {
            setStatus('no active tab', 'err');
            return;
        }
        const response = await chrome.runtime.sendMessage({ type: 'run-demo', tabId: tab.id });
        if (response.ok) {
            setStatus(response.message || 'demo running — watch the page', 'ok');
        } else {
            setStatus('error: ' + (response.error || 'unknown'), 'err');
        }
    } catch (e) {
        setStatus('error: ' + e.message, 'err');
    } finally {
        runButton.disabled = false;
    }
});

// Live status from the background service worker.
chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === 'demo-progress') {
        setStatus(msg.text, msg.kind);
    }
});
