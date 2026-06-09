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
const SmokeDir = path.join(ArtifactRoot, 'hello-breakpoint');
const AppSourceDir = path.join(SmokeDir, 'src');
const HelperSourceDir = path.join(SmokeDir, 'source-map-helper');
const SharedFrameworkDir = path.join(RepoRoot, 'artifacts/bin/testhost/net11.0-browser-Debug-wasm/shared/Microsoft.NETCore.App/11.0.0');
const AssemblyName = 'HelloBreakpoint';
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

function generateHelloProject() {
    const projectPath = path.join(AppSourceDir, `${AssemblyName}.csproj`);
    const programPath = path.join(AppSourceDir, 'Program.cs');
    const project = `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <AssemblyName>${AssemblyName}</AssemblyName>
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

function buildHelloApp() {
    const { projectPath, programPath } = generateHelloProject();
    const outputDir = path.join(RepoRoot, 'artifacts/bin', AssemblyName, 'Debug', NetVersion);
    const outputDll = path.join(outputDir, `${AssemblyName}.dll`);
    buildProjectIfNeeded(projectPath, outputDll, [programPath], AssemblyName);

    const pdbPath = path.join(outputDir, `${AssemblyName}.pdb`);
    requireFile(pdbPath, 'HelloBreakpoint portable PDB');
    const pdbSignature = fs.readFileSync(pdbPath).subarray(0, 4).toString('ascii');
    if (pdbSignature !== 'BSJB') {
        fail(`HelloBreakpoint PDB has unexpected signature: ${pdbSignature}`);
    }

    for (const extension of ['dll', 'pdb', 'runtimeconfig.json', 'deps.json']) {
        const source = path.join(outputDir, `${AssemblyName}.${extension}`);
        if (fs.existsSync(source)) {
            copyIfNewer(source, path.join(SmokeDir, `${AssemblyName}.${extension}`));
        }
    }

    return path.join(SmokeDir, `${AssemblyName}.dll`);
}

function buildSourceMap(assemblyPath) {
    const { projectPath, programPath } = generateSourceMapHelper();
    const helperDll = path.join(RepoRoot, 'artifacts/bin/PdbSourceMapHelper/Debug', NetVersion, 'PdbSourceMapHelper.dll');
    buildProjectIfNeeded(projectPath, helperDll, [programPath], 'PDB source-map helper');

    const outputPath = path.join(SmokeDir, 'source-location-map.json');
    if (isUpToDate(outputPath, [assemblyPath, helperDll])) {
        return;
    }

    console.log('prepare: generating source-location-map.json...');
    const result = runDotnet(['exec', helperDll, assemblyPath], 'generating source map');
    JSON.parse(result.stdout);
    fs.writeFileSync(outputPath, result.stdout.trimEnd() + '\n');
}

function copyWasmArtifacts() {
    const files = [
        [path.join(ObjDir, 'debug/wasm-dbi-dac/coreclr-dbi-dac.js'), path.join(SmokeDir, 'coreclr-dbi-dac.js')],
        [path.join(ObjDir, 'debug/wasm-dbi-dac/coreclr-dbi-dac.wasm'), path.join(SmokeDir, 'coreclr-dbi-dac.wasm')],
        [path.join(ObjDir, 'hosts/corerun/corerun.js'), path.join(SmokeDir, 'corerun.js')],
        [path.join(ObjDir, 'hosts/corerun/corerun.wasm'), path.join(SmokeDir, 'corerun.wasm')]
    ];

    for (const [source, destination] of files) {
        if (copyIfNewer(source, destination)) {
            console.log(`prepare: copied ${path.basename(source)}`);
        }
    }
}

function makeManifest() {
    requireFile(SharedFrameworkDir, 'browser-wasm shared framework');
    const appFiles = ['dll', 'pdb', 'runtimeconfig.json', 'deps.json']
        .map(extension => `${AssemblyName}.${extension}`)
        .filter(fileName => fs.existsSync(path.join(SmokeDir, fileName)))
        .map(fileName => ({
            url: `/hello-breakpoint/${fileName}`,
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
        runtimeJsUrl: '/hello-breakpoint/corerun.js',
        sidecarJsUrl: '/hello-breakpoint/coreclr-dbi-dac.js',
        appVirtualPath: `/app/${AssemblyName}.dll`,
        sharedFrameworkVirtualPath: SharedFrameworkVirtualPath,
        sourceMapUrl: '/hello-breakpoint/source-location-map.json',
        files: [...appFiles, ...frameworkFiles]
    };
    fs.writeFileSync(path.join(SmokeDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
}

fs.mkdirSync(SmokeDir, { recursive: true });
copyWasmArtifacts();
const assemblyPath = buildHelloApp();
buildSourceMap(assemblyPath);
makeManifest();
console.log(`prepare: ready: ${SmokeDir}`);
