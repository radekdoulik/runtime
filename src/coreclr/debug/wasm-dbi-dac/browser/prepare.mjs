// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const BrowserDir = path.dirname(fileURLToPath(import.meta.url));
const RepoRoot = path.resolve(BrowserDir, '../../../../..');
const ObjDir = path.join(RepoRoot, 'artifacts/obj/coreclr/browser.wasm.Debug');
const ArtifactRoot = path.join(RepoRoot, 'artifacts/wasm-dbi-dac-browser-smoke');
const BreakpointSmokeName = 'hello-breakpoint';
const AsyncBreakSmokeName = 'hello-async-break';
const BreakpointSmokeDir = path.join(ArtifactRoot, BreakpointSmokeName);
const AsyncBreakSmokeDir = path.join(ArtifactRoot, AsyncBreakSmokeName);
const BreakpointAppSourceDir = path.join(BreakpointSmokeDir, 'src');
const AsyncBreakAppSourceDir = path.join(AsyncBreakSmokeDir, 'src');
const HelperSourceDir = path.join(BreakpointSmokeDir, 'source-map-helper');
const SharedFrameworkDir = path.join(RepoRoot, 'artifacts/bin/testhost/net11.0-browser-Debug-wasm/shared/Microsoft.NETCore.App/11.0.0');
const BreakpointAssemblyName = 'HelloBreakpoint';
const AsyncBreakAssemblyName = 'HelloAsyncBreak';
const NetVersion = 'net11.0';
const SharedFrameworkVirtualPath = '/shared/Microsoft.NETCore.App/11.0.0';

function fail(message) {
    throw new Error(message);
}

function requireFile(filePath, description) {
    if (!fs.existsSync(filePath)) {
        fail(`${description} not found: ${filePath}`);
    }
}

function writeIfChanged(filePath, contents) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const current = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : null;
    if (current !== contents) {
        fs.writeFileSync(filePath, contents);
        return true;
    }

    return false;
}

function copyIfNewer(source, destination) {
    requireFile(source, 'source artifact');
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    if (fs.existsSync(destination)) {
        const sourceStat = fs.statSync(source);
        const destinationStat = fs.statSync(destination);
        if (sourceStat.size === destinationStat.size && destinationStat.mtimeMs >= sourceStat.mtimeMs) {
            return false;
        }
    }

    fs.copyFileSync(source, destination);
    return true;
}

function runDotnet(args, description) {
    const result = spawnSync(path.join(RepoRoot, 'dotnet.sh'), args, {
        cwd: RepoRoot,
        encoding: 'utf8'
    });
    if (result.status !== 0) {
        process.stdout.write(result.stdout);
        process.stderr.write(result.stderr);
        fail(`${description} failed with exit code ${result.status}`);
    }

    return result;
}

function isUpToDate(output, inputs) {
    if (!fs.existsSync(output)) {
        return false;
    }

    const outputTime = fs.statSync(output).mtimeMs;
    return inputs.every(input => fs.existsSync(input) && fs.statSync(input).mtimeMs <= outputTime);
}

function generateHelloBreakpointProject() {
    const projectPath = path.join(BreakpointAppSourceDir, `${BreakpointAssemblyName}.csproj`);
    const programPath = path.join(BreakpointAppSourceDir, 'Program.cs');
    const project = `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <AssemblyName>${BreakpointAssemblyName}</AssemblyName>
    <TargetFramework>${NetVersion}</TargetFramework>
    <DebugType>portable</DebugType>
    <ImplicitUsings>enable</ImplicitUsings>
    <Nullable>enable</Nullable>
  </PropertyGroup>
</Project>
`;
    const program = `// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

using System;
using System.Runtime.CompilerServices;

namespace HelloSmoke;

public static class Program
{
    public static void Main()
    {
        Console.WriteLine("before");
        HelloBreakpointTarget.BreakHereWithLocals();
        Console.WriteLine("after");
    }
}

public static class HelloBreakpointTarget
{
    [MethodImpl(MethodImplOptions.NoInlining)]
    public static void BreakHere() => Console.WriteLine("break here");

    [MethodImpl(MethodImplOptions.NoInlining)]
    public static void BreakHereWithLocals()
    {
        int localInt = 42;
        long localLong = localInt + 1L;
        double localDouble = localLong + 0.5;
        Consume(localInt, localLong, localDouble);
    }

    [MethodImpl(MethodImplOptions.NoInlining)]
    private static void Consume(int localInt, long localLong, double localDouble)
        => Console.WriteLine($"break here {localInt} {localLong} {localDouble}");
}
`;

    const projectChanged = writeIfChanged(projectPath, project);
    const programChanged = writeIfChanged(programPath, program);
    return { projectPath, programPath, changed: projectChanged || programChanged };
}

function generateHelloAsyncBreakProject() {
    const projectPath = path.join(AsyncBreakAppSourceDir, `${AsyncBreakAssemblyName}.csproj`);
    const programPath = path.join(AsyncBreakAppSourceDir, 'Program.cs');
    const project = `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <AssemblyName>${AsyncBreakAssemblyName}</AssemblyName>
    <TargetFramework>${NetVersion}</TargetFramework>
    <DebugType>portable</DebugType>
    <ImplicitUsings>enable</ImplicitUsings>
    <Nullable>enable</Nullable>
  </PropertyGroup>
</Project>
`;
    const program = `// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

using System;
using System.Runtime.CompilerServices;

namespace HelloSmoke;

public static class Program
{
    private const int Iterations = 1_000;
    private const int InnerIterations = 5_000;

    public static int Main()
    {
        AsyncBreakKeepAlive.KeepAlive(Iterations, InnerIterations);
        Console.WriteLine($"keepalive-final {AsyncBreakKeepAlive.Sink}");
        return 0;
    }
}

public static class AsyncBreakKeepAlive
{
    private static volatile int s_sink;

    public static int Sink => s_sink;

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
`;

    const projectChanged = writeIfChanged(projectPath, project);
    const programChanged = writeIfChanged(programPath, program);
    return { projectPath, programPath, changed: projectChanged || programChanged };
}

function generateSourceMapHelper() {
    const projectPath = path.join(HelperSourceDir, 'PdbSourceMapHelper.csproj');
    const programPath = path.join(HelperSourceDir, 'Program.cs');
    const project = `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <AssemblyName>PdbSourceMapHelper</AssemblyName>
    <TargetFramework>${NetVersion}</TargetFramework>
    <ImplicitUsings>enable</ImplicitUsings>
    <Nullable>enable</Nullable>
  </PropertyGroup>
</Project>
`;
    const program = `// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

using System.Reflection.Metadata;
using System.Reflection.Metadata.Ecma335;
using System.Reflection.PortableExecutable;
using System.Text.Json;

static Stream? TryOpenFile(string path)
{
    return File.Exists(path) ? File.Open(path, FileMode.Open, FileAccess.Read, FileShare.Read | FileShare.Delete) : null;
}

static MetadataReaderProvider? TryOpenPortablePdb(PEReader peReader, string assemblyPath)
{
    if (peReader.TryOpenAssociatedPortablePdb(assemblyPath, TryOpenFile, out MetadataReaderProvider? provider, out string? _))
    {
        return provider;
    }

    foreach (DebugDirectoryEntry entry in peReader.ReadDebugDirectory())
    {
        if (entry.Type == DebugDirectoryEntryType.EmbeddedPortablePdb)
        {
            return peReader.ReadEmbeddedPortablePdbDebugDirectoryData(entry);
        }
    }

    return null;
}

if (args.Length != 1)
{
    return 2;
}

string assemblyPath = args[0];
using FileStream peStream = File.Open(assemblyPath, FileMode.Open, FileAccess.Read, FileShare.Read | FileShare.Delete);
using PEReader peReader = new PEReader(peStream);
using MetadataReaderProvider? provider = TryOpenPortablePdb(peReader, assemblyPath);
if (provider is null || peReader.GetMetadataReader() is not MetadataReader peReaderMetadata)
{
    return 3;
}

MetadataReader pdbReader = provider.GetMetadataReader();
List<object> points = new();
foreach (MethodDefinitionHandle methodHandle in peReaderMetadata.MethodDefinitions)
{
    MethodDefinition method = peReaderMetadata.GetMethodDefinition(methodHandle);
    string methodName = peReaderMetadata.GetString(method.Name);
    int methodToken = MetadataTokens.GetToken(methodHandle);
    MethodDebugInformationHandle debugHandle = methodHandle.ToDebugInformationHandle();
    MethodDebugInformation methodInfo = pdbReader.GetMethodDebugInformation(debugHandle);
    if (methodInfo.SequencePointsBlob.IsNil)
    {
        continue;
    }

    foreach (SequencePoint sequencePoint in methodInfo.GetSequencePoints())
    {
        if (sequencePoint.StartLine == SequencePoint.HiddenLine)
        {
            continue;
        }

        string documentName = string.Empty;
        if (!sequencePoint.Document.IsNil)
        {
            documentName = pdbReader.GetString(pdbReader.GetDocument(sequencePoint.Document).Name);
        }

        points.Add(new
        {
            token = unchecked((uint)methodToken),
            method = methodName,
            offset = sequencePoint.Offset,
            line = sequencePoint.StartLine,
            column = sequencePoint.StartColumn,
            document = documentName
        });
    }
}

Console.WriteLine(JsonSerializer.Serialize(new { points }));
return 0;
`;

    const projectChanged = writeIfChanged(projectPath, project);
    const programChanged = writeIfChanged(programPath, program);
    return { projectPath, programPath, changed: projectChanged || programChanged };
}

function buildProjectIfNeeded(projectPath, outputDll, inputs, description) {
    if (isUpToDate(outputDll, [projectPath, ...inputs])) {
        return;
    }

    console.log(`prepare: building ${description}...`);
    runDotnet(['build', projectPath, '-c', 'Debug', '-v:minimal'], `building ${description}`);
    requireFile(outputDll, `${description} output`);
}

function copyAppOutputs(outputDir, smokeDir, assemblyName) {
    for (const extension of ['dll', 'pdb', 'runtimeconfig.json', 'deps.json']) {
        const source = path.join(outputDir, `${assemblyName}.${extension}`);
        if (fs.existsSync(source)) {
            copyIfNewer(source, path.join(smokeDir, `${assemblyName}.${extension}`));
        }
    }
}

function buildHelloBreakpointApp() {
    const { projectPath, programPath } = generateHelloBreakpointProject();
    const outputDir = path.join(RepoRoot, 'artifacts/bin', BreakpointAssemblyName, 'Debug', NetVersion);
    const outputDll = path.join(outputDir, `${BreakpointAssemblyName}.dll`);
    buildProjectIfNeeded(projectPath, outputDll, [programPath], BreakpointAssemblyName);

    const pdbPath = path.join(outputDir, `${BreakpointAssemblyName}.pdb`);
    requireFile(pdbPath, 'HelloBreakpoint portable PDB');
    const pdbSignature = fs.readFileSync(pdbPath).subarray(0, 4).toString('ascii');
    if (pdbSignature !== 'BSJB') {
        fail(`HelloBreakpoint PDB has unexpected signature: ${pdbSignature}`);
    }

    copyAppOutputs(outputDir, BreakpointSmokeDir, BreakpointAssemblyName);

    return path.join(BreakpointSmokeDir, `${BreakpointAssemblyName}.dll`);
}

function buildHelloAsyncBreakApp() {
    const { projectPath, programPath } = generateHelloAsyncBreakProject();
    const outputDir = path.join(RepoRoot, 'artifacts/bin', AsyncBreakAssemblyName, 'Debug', NetVersion);
    const outputDll = path.join(outputDir, `${AsyncBreakAssemblyName}.dll`);
    buildProjectIfNeeded(projectPath, outputDll, [programPath], AsyncBreakAssemblyName);
    copyAppOutputs(outputDir, AsyncBreakSmokeDir, AsyncBreakAssemblyName);

    return path.join(AsyncBreakSmokeDir, `${AsyncBreakAssemblyName}.dll`);
}

function buildSourceMap(assemblyPath) {
    const { projectPath, programPath } = generateSourceMapHelper();
    const helperDll = path.join(RepoRoot, 'artifacts/bin/PdbSourceMapHelper/Debug', NetVersion, 'PdbSourceMapHelper.dll');
    buildProjectIfNeeded(projectPath, helperDll, [programPath], 'PDB source-map helper');

    const outputPath = path.join(BreakpointSmokeDir, 'source-location-map.json');
    if (isUpToDate(outputPath, [assemblyPath, helperDll])) {
        return;
    }

    console.log('prepare: generating source-location-map.json...');
    const result = runDotnet(['exec', helperDll, assemblyPath], 'generating source map');
    JSON.parse(result.stdout);
    fs.writeFileSync(outputPath, result.stdout.trimEnd() + '\n');
}

function copyWasmArtifacts(smokeDir) {
    const files = [
        [path.join(ObjDir, 'debug/wasm-dbi-dac/coreclr-dbi-dac.js'), path.join(smokeDir, 'coreclr-dbi-dac.js')],
        [path.join(ObjDir, 'debug/wasm-dbi-dac/coreclr-dbi-dac.wasm'), path.join(smokeDir, 'coreclr-dbi-dac.wasm')],
        [path.join(ObjDir, 'hosts/corerun/corerun.js'), path.join(smokeDir, 'corerun.js')],
        [path.join(ObjDir, 'hosts/corerun/corerun.wasm'), path.join(smokeDir, 'corerun.wasm')]
    ];

    for (const [source, destination] of files) {
        if (copyIfNewer(source, destination)) {
            console.log(`prepare: copied ${path.basename(source)}`);
        }
    }
}

function makeManifest(smokeDir, smokeName, assemblyName, sourceMapUrl = null) {
    requireFile(SharedFrameworkDir, 'browser-wasm shared framework');
    const appFiles = ['dll', 'pdb', 'runtimeconfig.json', 'deps.json']
        .map(extension => `${assemblyName}.${extension}`)
        .filter(fileName => fs.existsSync(path.join(smokeDir, fileName)))
        .map(fileName => ({
            url: `/${smokeName}/${fileName}`,
            path: `/app/${fileName}`
        }));
    const frameworkFiles = fs.readdirSync(SharedFrameworkDir)
        .filter(fileName => fileName.endsWith('.dll'))
        .sort((left, right) => left.localeCompare(right))
        .map(fileName => ({
            url: `${SharedFrameworkVirtualPath}/${fileName}`,
            path: `${SharedFrameworkVirtualPath}/${fileName}`
        }));
    const manifest = {
        runtimeJsUrl: `/${smokeName}/corerun.js`,
        sidecarJsUrl: `/${smokeName}/coreclr-dbi-dac.js`,
        appVirtualPath: `/app/${assemblyName}.dll`,
        sharedFrameworkVirtualPath: SharedFrameworkVirtualPath,
        files: [...appFiles, ...frameworkFiles]
    };
    if (sourceMapUrl !== null) {
        manifest.sourceMapUrl = sourceMapUrl;
    }

    fs.writeFileSync(path.join(smokeDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
}

fs.mkdirSync(BreakpointSmokeDir, { recursive: true });
copyWasmArtifacts(BreakpointSmokeDir);
const breakpointAssemblyPath = buildHelloBreakpointApp();
buildSourceMap(breakpointAssemblyPath);
makeManifest(BreakpointSmokeDir, BreakpointSmokeName, BreakpointAssemblyName, `/${BreakpointSmokeName}/source-location-map.json`);

fs.mkdirSync(AsyncBreakSmokeDir, { recursive: true });
copyWasmArtifacts(AsyncBreakSmokeDir);
buildHelloAsyncBreakApp();
makeManifest(AsyncBreakSmokeDir, AsyncBreakSmokeName, AsyncBreakAssemblyName);

console.log(`prepare: ready: ${BreakpointSmokeDir}`);
console.log(`prepare: ready: ${AsyncBreakSmokeDir}`);
