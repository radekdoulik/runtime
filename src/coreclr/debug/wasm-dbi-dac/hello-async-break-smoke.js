// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

const fs = require("fs");
const path = require("path");
const { performance } = require("perf_hooks");
const { pathToFileURL } = require("url");
const { createHash, randomBytes } = require("crypto");
const { connect: tcpConnect } = require("net");
const { spawn, spawnSync } = require("child_process");

const KeepAliveIterations = 180;
const KeepAliveInnerIterations = 75_000;
const PauseTimeoutMs = 5_000;
const QuietDrainMs = 100;
const QuietProbeMs = 300;
const ChildExitTimeoutMs = 45_000;

function fail(message) {
    throw new Error(message);
}

function requireFile(filePath, description) {
    if (!fs.existsSync(filePath)) {
        fail(`${description} not found: ${filePath}`);
    }
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function wsAcceptKey(key) {
    return createHash("sha1")
        .update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11", "ascii")
        .digest("base64");
}

function wsEncodeFrame(opcode, payload) {
    const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
    let headerLength = 2;
    if (data.length >= 126 && data.length <= 0xffff) {
        headerLength += 2;
    } else if (data.length > 0xffff) {
        headerLength += 8;
    }

    const frame = Buffer.alloc(headerLength + 4 + data.length);
    frame[0] = 0x80 | opcode;
    let offset = 2;
    if (data.length < 126) {
        frame[1] = 0x80 | data.length;
    } else if (data.length <= 0xffff) {
        frame[1] = 0x80 | 126;
        frame.writeUInt16BE(data.length, offset);
        offset += 2;
    } else {
        frame[1] = 0x80 | 127;
        frame.writeBigUInt64BE(BigInt(data.length), offset);
        offset += 8;
    }

    const mask = randomBytes(4);
    mask.copy(frame, offset);
    offset += 4;
    for (let index = 0; index < data.length; index++) {
        frame[offset + index] = data[index] ^ mask[index % 4];
    }

    return frame;
}

function wsTryParseFrame(buffer) {
    if (buffer.length < 2) {
        return null;
    }

    const opcode = buffer[0] & 0x0f;
    const masked = (buffer[1] & 0x80) !== 0;
    let payloadLength = buffer[1] & 0x7f;
    let offset = 2;
    if (payloadLength === 126) {
        if (buffer.length < offset + 2) {
            return null;
        }
        payloadLength = buffer.readUInt16BE(offset);
        offset += 2;
    } else if (payloadLength === 127) {
        if (buffer.length < offset + 8) {
            return null;
        }
        const bigLength = buffer.readBigUInt64BE(offset);
        if (bigLength > BigInt(Number.MAX_SAFE_INTEGER)) {
            throw new Error("CDP WebSocket frame is too large");
        }
        payloadLength = Number(bigLength);
        offset += 8;
    }

    let mask;
    if (masked) {
        if (buffer.length < offset + 4) {
            return null;
        }
        mask = buffer.subarray(offset, offset + 4);
        offset += 4;
    }

    if (buffer.length < offset + payloadLength) {
        return null;
    }

    const payload = Buffer.from(buffer.subarray(offset, offset + payloadLength));
    if (masked) {
        for (let index = 0; index < payload.length; index++) {
            payload[index] ^= mask[index % 4];
        }
    }

    return { opcode, payload, totalSize: offset + payloadLength };
}

class RawCdpWebSocket {
    constructor(socket, head) {
        this.socket = socket;
        this.pending = head && head.length !== 0 ? Buffer.from(head) : Buffer.alloc(0);
        this.listeners = new Map();
        this.closed = false;

        socket.on("data", chunk => this.onData(chunk));
        socket.on("close", () => this.emit("close", {}));
        socket.on("error", error => this.emit("error", error));
        if (this.pending.length !== 0) {
            this.consume();
        }
    }

    static async connect(urlText) {
        const url = new URL(urlText);
        const key = randomBytes(16).toString("base64");
        const { socket, head } = await new Promise((resolve, reject) => {
            const socket = tcpConnect({ host: url.hostname, port: Number(url.port) }, () => {
                socket.write(
                    `GET ${url.pathname}${url.search} HTTP/1.1\r\n` +
                    `Host: ${url.hostname}:${url.port}\r\n` +
                    "Upgrade: websocket\r\n" +
                    "Connection: Upgrade\r\n" +
                    `Sec-WebSocket-Key: ${key}\r\n` +
                    "Sec-WebSocket-Version: 13\r\n\r\n");
            });

            socket.once("error", reject);
            let buffer = Buffer.alloc(0);
            const onData = chunk => {
                buffer = Buffer.concat([buffer, chunk]);
                const headerEnd = buffer.indexOf("\r\n\r\n");
                if (headerEnd < 0) {
                    return;
                }

                socket.removeListener("data", onData);
                const header = buffer.subarray(0, headerEnd).toString("ascii");
                const head = buffer.subarray(headerEnd + 4);
                const expectedAccept = wsAcceptKey(key).toLowerCase();
                if (!/^HTTP\/1\.1 101 /.test(header) ||
                    !header.toLowerCase().includes(`sec-websocket-accept: ${expectedAccept}`)) {
                    socket.destroy();
                    reject(new Error(`CDP WebSocket handshake failed: ${header.split("\r\n")[0]}`));
                    return;
                }

                socket.setNoDelay(true);
                resolve({ socket, head });
            };
            socket.on("data", onData);
        });

        return new RawCdpWebSocket(socket, head);
    }

    addEventListener(name, callback, options = {}) {
        const listeners = this.listeners.get(name) ?? [];
        const wrapped = options.once
            ? event => {
                this.removeEventListener(name, wrapped);
                callback(event);
            }
            : callback;
        listeners.push(wrapped);
        this.listeners.set(name, listeners);
    }

    removeEventListener(name, callback) {
        const listeners = this.listeners.get(name);
        if (listeners === undefined) {
            return;
        }
        const index = listeners.indexOf(callback);
        if (index >= 0) {
            listeners.splice(index, 1);
        }
    }

    emit(name, event) {
        if (name === "close") {
            this.closed = true;
        }
        for (const listener of [...(this.listeners.get(name) ?? [])]) {
            listener(event);
        }
    }

    onData(chunk) {
        this.pending = this.pending.length === 0 ? chunk : Buffer.concat([this.pending, chunk]);
        this.consume();
    }

    consume() {
        while (this.pending.length !== 0) {
            const frame = wsTryParseFrame(this.pending);
            if (frame === null) {
                return;
            }
            this.pending = this.pending.subarray(frame.totalSize);
            if (frame.opcode === 0x1) {
                this.emit("message", { data: frame.payload.toString("utf8") });
            } else if (frame.opcode === 0x8) {
                this.close();
                return;
            } else if (frame.opcode === 0x9) {
                this.socket.write(wsEncodeFrame(0xA, frame.payload));
            }
        }
    }

    send(text) {
        if (this.closed) {
            throw new Error("CDP WebSocket closed");
        }
        this.socket.write(wsEncodeFrame(0x1, Buffer.from(text, "utf8")));
    }

    close() {
        if (this.closed) {
            return;
        }
        this.closed = true;
        try {
            this.socket.write(wsEncodeFrame(0x8, Buffer.alloc(0)));
            this.socket.end();
        } catch {
            // Ignore close races with a target process that already exited.
        }
    }
}

function buildHelloWorld(repoRoot) {
    const testDirectory = path.join(repoRoot, "artifacts", "wasm-dbi-dac-smoke", "hello-async-break");
    const assemblyName = "HelloAsyncBreak";
    fs.rmSync(testDirectory, { recursive: true, force: true });
    fs.mkdirSync(testDirectory, { recursive: true });

    const projectPath = path.join(testDirectory, `${assemblyName}.csproj`);
    const programPath = path.join(testDirectory, "Program.cs");

    fs.writeFileSync(projectPath, `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <AssemblyName>${assemblyName}</AssemblyName>
    <TargetFramework>net11.0</TargetFramework>
    <ImplicitUsings>enable</ImplicitUsings>
    <Nullable>enable</Nullable>
  </PropertyGroup>
</Project>
`);

    fs.writeFileSync(programPath, `// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

using System;
using System.Runtime.CompilerServices;

namespace HelloSmoke;

public static class Program
{
    private static volatile int s_sink;

    public static int Main()
    {
        KeepAlive(${KeepAliveIterations}, ${KeepAliveInnerIterations});
        Console.WriteLine($"keepalive-final {s_sink}");
        return 0;
    }

    [MethodImpl(MethodImplOptions.NoInlining | MethodImplOptions.NoOptimization)]
    public static void KeepAlive(int iterations, int innerIterations)
    {
        Console.WriteLine("keepalive-begin");
        int value = 17;
        for (int i = 0; i < iterations; i++)
        {
            for (int j = 0; j < innerIterations; j++)
            {
                value = unchecked((value * 1103515245 + 12345) ^ (i + j));
            }

            s_sink = value;
            Console.WriteLine($"keepalive-tick {i}");
        }

        Console.WriteLine("keepalive-end");
    }
}
`);

    const result = spawnSync(
        path.join(repoRoot, "dotnet.sh"),
        ["build", projectPath, "-c", "Debug", "-v:minimal"],
        { encoding: "utf8" });
    if (result.status !== 0) {
        process.stdout.write(result.stdout);
        process.stderr.write(result.stderr);
        fail(`failed to build HelloWorld async-break test app: ${result.status}`);
    }

    const outputMatch = [...result.stdout.matchAll(/-> (.*\.dll)$/gm)]
        .map(match => match[1])
        .find(outputPath => path.basename(outputPath) === `${assemblyName}.dll`);
    if (outputMatch !== undefined) {
        return outputMatch;
    }

    return path.join(testDirectory, "bin/Debug/net11.0", `${assemblyName}.dll`);
}

async function loadAndRunRuntime(runtimeJsPath, appPath, sharedFrameworkPath, onRuntimeInstantiated, onRuntimeDone = () => {}) {
    const runtimeDirectory = path.dirname(runtimeJsPath);
    let source = fs.readFileSync(runtimeJsPath, "utf8");

    source = source.replaceAll("import.meta.url", JSON.stringify(pathToFileURL(runtimeJsPath).href));
    source = source.replaceAll(
        "dotnetLogger = {};",
        "dotnetLogger = { debug() {}, info() {}, warn() {}, error() {} };");
    source = source.replace(/if \(_isNode\) \{\s*selfRun\(\);\s*\}\s*$/m, "");

    const moduleFactory = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
    const oldInterpMode = process.env.DOTNET_InterpMode;
    const oldReadyToRun = process.env.DOTNET_ReadyToRun;
    process.env.DOTNET_InterpMode = "3";
    process.env.DOTNET_ReadyToRun = "0";
    try {
        await new Promise((resolve, reject) => {
            let runtimeInstance;
            let runtimeDone = false;
            const completeRuntime = () => {
                if (!runtimeDone && runtimeInstance !== undefined) {
                    runtimeDone = true;
                    onRuntimeDone(runtimeInstance);
                }
            };
            const moduleConfig = {
                noExitRuntime: true,
                arguments: ["-c", sharedFrameworkPath, appPath],
                locateFile: fileName => path.join(runtimeDirectory, fileName),
                onAbort: reason => reject(new Error(String(reason))),
                postRun: [completeRuntime],
                print(text) {
                    process.stdout.write(`${text}\n`);
                    if (String(text).startsWith("keepalive-final ")) {
                        setImmediate(completeRuntime);
                    }
                },
                printErr(text) {
                    if (!String(text).startsWith("program exited (with status: 0), but keepRuntimeAlive()")) {
                        process.stderr.write(`${text}\n`);
                    }
                },
                instantiateWasm(imports, receiveInstance) {
                    const wasmPath = path.join(runtimeDirectory, "corerun.wasm");
                    WebAssembly.instantiate(fs.readFileSync(wasmPath), imports).then(({ instance, module }) => {
                        runtimeInstance = instance;
                        onRuntimeInstantiated(instance);
                        receiveInstance(instance, module);
                        resolve();
                    }).catch(reject);

                    return {};
                }
            };

            try {
                const runResult = moduleFactory.selfRun(moduleConfig);
                if (runResult && typeof runResult.then === "function") {
                    runResult.catch(reject);
                }
            } catch (error) {
                reject(error);
            }
        });
    } finally {
        if (oldInterpMode === undefined) {
            delete process.env.DOTNET_InterpMode;
        } else {
            process.env.DOTNET_InterpMode = oldInterpMode;
        }

        if (oldReadyToRun === undefined) {
            delete process.env.DOTNET_ReadyToRun;
        } else {
            process.env.DOTNET_ReadyToRun = oldReadyToRun;
        }
    }
}

class CdpClient {
    constructor(ws) {
        this.ws = ws;
        this.nextId = 1;
        this.pending = new Map();
        this.notificationWaiters = [];
        this.closed = false;

        ws.addEventListener("message", event => this.onMessage(event));
        ws.addEventListener("close", () => this.onClose());
        ws.addEventListener("error", () => this.onClose(new Error("CDP WebSocket error")));
    }

    static async connect(url) {
        if (typeof WebSocket === "function") {
            const ws = new WebSocket(url);
            await new Promise((resolve, reject) => {
                ws.addEventListener("open", resolve, { once: true });
                ws.addEventListener("error", () => reject(new Error(`failed to connect CDP WebSocket ${url}`)), { once: true });
            });
            return new CdpClient(ws);
        }

        const ws = await RawCdpWebSocket.connect(url);
        return new CdpClient(ws);
    }

    onMessage(event) {
        let text;
        if (typeof event.data === "string") {
            text = event.data;
        } else if (event.data instanceof ArrayBuffer) {
            text = Buffer.from(event.data).toString("utf8");
        } else {
            text = Buffer.from(event.data).toString("utf8");
        }

        let message;
        try {
            message = JSON.parse(text);
        } catch {
            return;
        }

        if (typeof message.id === "number") {
            const pending = this.pending.get(message.id);
            if (pending === undefined) {
                return;
            }
            this.pending.delete(message.id);
            if (message.error) {
                pending.reject(new Error(`CDP ${message.error.code}: ${message.error.message}`));
            } else {
                pending.resolve(message.result ?? {});
            }
            return;
        }

        for (let i = 0; i < this.notificationWaiters.length; i++) {
            const waiter = this.notificationWaiters[i];
            if (waiter.method === message.method && waiter.predicate(message)) {
                this.notificationWaiters.splice(i, 1);
                clearTimeout(waiter.timer);
                waiter.resolve(message);
                return;
            }
        }
    }

    onClose(error = new Error("CDP WebSocket closed")) {
        if (this.closed) {
            return;
        }
        this.closed = true;
        for (const pending of this.pending.values()) {
            pending.reject(error);
        }
        this.pending.clear();
        for (const waiter of this.notificationWaiters.splice(0)) {
            clearTimeout(waiter.timer);
            waiter.reject(error);
        }
    }

    post(method, params = {}) {
        if (this.closed) {
            return Promise.reject(new Error("CDP WebSocket closed"));
        }

        const id = this.nextId++;
        const payload = JSON.stringify({ id, method, params });
        return new Promise((resolve, reject) => {
            this.pending.set(id, { resolve, reject });
            this.ws.send(payload);
        });
    }

    waitForNotification(method, timeoutMs, predicate = () => true) {
        return new Promise((resolve, reject) => {
            const waiter = {
                method,
                predicate,
                resolve,
                reject,
                timer: setTimeout(() => {
                    const index = this.notificationWaiters.indexOf(waiter);
                    if (index >= 0) {
                        this.notificationWaiters.splice(index, 1);
                    }
                    reject(new Error(`${method} not observed within ${timeoutMs}ms`));
                }, timeoutMs)
            };
            this.notificationWaiters.push(waiter);
        });
    }

    async pause(timeoutMs) {
        const paused = this.waitForNotification("Debugger.paused", timeoutMs);
        await this.post("Debugger.pause");
        return paused;
    }

    async resume(timeoutMs = 1_000) {
        const resumed = this.waitForNotification("Debugger.resumed", timeoutMs).catch(() => null);
        await this.post("Debugger.resume");
        await resumed;
    }

    close() {
        if (!this.closed) {
            this.ws.close();
            this.onClose();
        }
    }
}

async function runChild() {
    const coreclrObjDirectory = path.resolve(process.argv[3]);
    const appPath = path.resolve(process.argv[4]);
    const sharedFrameworkPath = path.resolve(process.argv[5]);
    const runtimeJsPath = path.join(coreclrObjDirectory, "hosts/corerun/corerun.js");

    requireFile(runtimeJsPath, "runtime JS wrapper");
    requireFile(appPath, "async-break test app");
    requireFile(sharedFrameworkPath, "browser-wasm testhost shared framework");

    let runtimeExports;
    let runtimeDoneResolve;
    const runtimeDone = new Promise(resolve => {
        runtimeDoneResolve = resolve;
    });
    await loadAndRunRuntime(runtimeJsPath, appPath, sharedFrameworkPath, instance => {
        runtimeExports = instance.exports;
        if (typeof runtimeExports.CoreClrWasmDebugSetAsyncBreakInProgress !== "function" ||
            typeof runtimeExports.CoreClrWasmDebugIsAsyncBreakInProgress !== "function") {
            fail("async-break runtime flag exports are missing");
        }

        const previous = runtimeExports.CoreClrWasmDebugSetAsyncBreakInProgress(1) | 0;
        const current = runtimeExports.CoreClrWasmDebugIsAsyncBreakInProgress() | 0;
        globalThis.__wasmAsyncBreakFlagValue = current;
        fs.writeSync(1, `async-break-flag-set prev=${previous} current=${current}\n`);
    }, instance => {
        runtimeExports = instance.exports;
        const previous = runtimeExports.CoreClrWasmDebugSetAsyncBreakInProgress(0) | 0;
        const current = runtimeExports.CoreClrWasmDebugIsAsyncBreakInProgress() | 0;
        globalThis.__wasmAsyncBreakFlagValue = current;
        fs.writeSync(1, `async-break-flag-cleared prev=${previous} current=${current}\n`);
        runtimeDoneResolve();
        process.exit(0);
    });
    await runtimeDone;
    process.exit(0);
}

function trackLine(state, streamName, line) {
    if (line.length === 0) {
        return;
    }

    state.lines.push(`${streamName}: ${line}`);
    if (state.lines.length > 120) {
        state.lines.shift();
    }

    const urlMatch = line.match(/ws:\/\/[^\s]+/);
    if (urlMatch !== null) {
        state.inspectorUrl = urlMatch[0];
    }

    if (line.startsWith("async-break-flag-set")) {
        const match = line.match(/prev=(-?\d+) current=(-?\d+)/);
        state.flagSet = true;
        state.flagSetPrevious = match ? Number(match[1]) : -1;
        state.flagSetCurrent = match ? Number(match[2]) : -1;
    } else if (line.startsWith("async-break-flag-cleared")) {
        const match = line.match(/prev=(-?\d+) current=(-?\d+)/);
        state.flagCleared = true;
        state.flagClearPrevious = match ? Number(match[1]) : -1;
        state.flagClearCurrent = match ? Number(match[2]) : -1;
    } else if (line === "keepalive-begin") {
        state.keepAliveBegin = true;
    } else if (line.startsWith("keepalive-tick ")) {
        state.tickCount++;
        const tick = Number(line.substring("keepalive-tick ".length));
        if (Number.isFinite(tick)) {
            state.lastTick = tick;
        }
    } else if (line === "keepalive-end") {
        state.keepAliveEnd = true;
    }

    for (const waiter of [...state.waiters]) {
        if (waiter.predicate()) {
            state.waiters.splice(state.waiters.indexOf(waiter), 1);
            clearTimeout(waiter.timer);
            waiter.resolve();
        }
    }
}

function pipeLines(stream, state, streamName) {
    let pending = "";
    stream.setEncoding("utf8");
    stream.on("data", chunk => {
        pending += chunk;
        for (;;) {
            const newline = pending.indexOf("\n");
            if (newline < 0) {
                break;
            }
            const line = pending.substring(0, newline).replace(/\r$/, "");
            pending = pending.substring(newline + 1);
            trackLine(state, streamName, line);
        }
    });
    stream.on("end", () => {
        if (pending.length !== 0) {
            trackLine(state, streamName, pending.replace(/\r$/, ""));
            pending = "";
        }
    });
}

function waitForState(state, description, predicate, timeoutMs) {
    if (predicate()) {
        return Promise.resolve();
    }

    return new Promise((resolve, reject) => {
        const waiter = {
            predicate,
            resolve,
            timer: setTimeout(() => {
                const index = state.waiters.indexOf(waiter);
                if (index >= 0) {
                    state.waiters.splice(index, 1);
                }
                reject(new Error(`timed out waiting for ${description}\nRecent child output:\n${state.lines.join("\n")}`));
            }, timeoutMs)
        };
        state.waiters.push(waiter);
    });
}

function waitForChildExit(child, timeoutMs, state) {
    if (child.exitCode !== null || child.signalCode !== null) {
        return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
    }

    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            child.kill("SIGTERM");
            const recent = state ? `\nRecent child output:\n${state.lines.join("\n")}` : "";
            reject(new Error(`child process ${child.pid} did not exit within ${timeoutMs}ms${recent}`));
        }, timeoutMs);
        child.on("exit", (code, signal) => {
            clearTimeout(timer);
            resolve({ code, signal });
        });
        child.on("error", error => {
            clearTimeout(timer);
            reject(error);
        });
    });
}

async function runParent() {
    const coreclrObjDirectory = path.resolve(process.cwd(), process.argv[2] ?? "artifacts/obj/coreclr/browser.wasm.Debug");
    const repoRoot = path.resolve(__dirname, "../../../..");
    const sharedFrameworkPath = path.join(repoRoot, "artifacts/bin/testhost/net11.0-browser-Debug-wasm/shared/Microsoft.NETCore.App/11.0.0");
    const runtimeJsPath = path.join(coreclrObjDirectory, "hosts/corerun/corerun.js");
    const debuggerJsPath = path.join(coreclrObjDirectory, "debug/wasm-dbi-dac/coreclr-dbi-dac-tests.js");

    requireFile(runtimeJsPath, "runtime JS wrapper");
    requireFile(debuggerJsPath, "debugger JS wrapper");
    requireFile(sharedFrameworkPath, "browser-wasm testhost shared framework");

    const appPath = buildHelloWorld(repoRoot);
    const state = {
        inspectorUrl: null,
        flagSet: false,
        flagSetPrevious: -1,
        flagSetCurrent: -1,
        flagCleared: false,
        flagClearPrevious: -1,
        flagClearCurrent: -1,
        keepAliveBegin: false,
        keepAliveEnd: false,
        tickCount: 0,
        lastTick: -1,
        lines: [],
        waiters: []
    };

    const child = spawn(process.execPath, [
        "--inspect=0",
        "--experimental-vm-modules",
        __filename,
        "--child",
        coreclrObjDirectory,
        appPath,
        sharedFrameworkPath
    ], {
        cwd: repoRoot,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env }
    });

    pipeLines(child.stdout, state, "stdout");
    pipeLines(child.stderr, state, "stderr");

    let cdp;
    try {
        await waitForState(state, "child inspector URL", () => state.inspectorUrl !== null, 10_000);
        cdp = await CdpClient.connect(state.inspectorUrl);
        await cdp.post("Runtime.enable");
        await cdp.post("Debugger.enable");

        await waitForState(
            state,
            "KeepAlive loop to start with async-break flag set",
            () => state.flagSet && state.keepAliveBegin && state.tickCount >= 1,
            20_000);

        const ticksBeforePauseRequest = state.tickCount;
        const pauseStart = performance.now();
        await cdp.pause(PauseTimeoutMs);
        const pauseMs = performance.now() - pauseStart;

        await sleep(QuietDrainMs);
        const ticksAtQuietStart = state.tickCount;
        await sleep(QuietProbeMs);
        const ticksAfterQuietProbe = state.tickCount;

        const resumeStart = performance.now();
        await cdp.resume();
        const resumeMs = performance.now() - resumeStart;

        await waitForState(state, "KeepAlive loop to finish after resume", () => state.keepAliveEnd && state.flagCleared, 30_000);
        cdp.close();
        cdp = undefined;
        const exit = await waitForChildExit(child, ChildExitTimeoutMs, state);

        const summary = {
            inspectorUrl: state.inspectorUrl.replace(/\/[^/]+$/, "/<uuid>"),
            pauseMs: Math.round(pauseMs),
            resumeMs: Math.round(resumeMs),
            ticksBeforePauseRequest,
            ticksAtQuietStart,
            ticksAfterQuietProbe,
            finalTickCount: state.tickCount,
            lastTick: state.lastTick,
            asyncBreakFlag: {
                setPrevious: state.flagSetPrevious,
                setCurrent: state.flagSetCurrent,
                clearPrevious: state.flagClearPrevious,
                clearCurrent: state.flagClearCurrent
            },
            childExit: exit
        };
        console.log(JSON.stringify(summary, null, 2));

        if (exit.code !== 0 ||
            exit.signal !== null ||
            state.flagSetPrevious !== 0 ||
            state.flagSetCurrent !== 1 ||
            state.flagClearPrevious !== 1 ||
            state.flagClearCurrent !== 0 ||
            !state.keepAliveBegin ||
            !state.keepAliveEnd ||
            ticksBeforePauseRequest < 1 ||
            ticksAfterQuietProbe !== ticksAtQuietStart ||
            state.tickCount <= ticksAfterQuietProbe ||
            state.lastTick !== KeepAliveIterations - 1) {
            fail(`CDP async-break smoke failed\nRecent child output:\n${state.lines.join("\n")}`);
        }
    } finally {
        if (cdp !== undefined) {
            cdp.close();
        }
        if (child.exitCode === null && !child.killed) {
            child.kill("SIGTERM");
        }
    }
}

if (process.argv[2] === "--child") {
    runChild().catch(error => {
        console.error(error.stack || error);
        process.exit(1);
    });
} else {
    runParent().catch(error => {
        console.error(error.stack || error);
        process.exit(1);
    });
}
