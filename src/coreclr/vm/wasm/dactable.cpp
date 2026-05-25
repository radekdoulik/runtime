// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

#include "common.h"
#include "threads.h"

#include <emscripten.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

DLLEXPORT DacGlobals g_dacTable;

struct WasmDbiDacTestData
{
    uint32_t Magic;
    int32_t Int32Value;
    double DoubleValue;
    uint32_t VectorLanes[4];
    char Message[16];
};

static_assert(sizeof(WasmDbiDacTestData) == 48);

constexpr uint32_t WasmDebugMessageBufferSize = 256;

WasmDbiDacTestData g_wasmDbiDacTestData =
{
    0x43445744,
    123456789,
    1234.5,
    { 0x01234567, 0x89abcdef, 0xfedcba98, 0x76543210 },
    "wasm-dbi-dac"
};

uint8_t g_wasmDebugLastCommand[WasmDebugMessageBufferSize];
uint32_t g_wasmDebugLastCommandLength;
uint8_t g_wasmDebugLastEvent[WasmDebugMessageBufferSize];
uint32_t g_wasmDebugLastEventLength;
char g_wasmDebugBreakpointMethodName[64];
uint32_t g_wasmDebugBreakpointMethodToken;
bool g_wasmDebugBreakpointArmed;
uint32_t g_wasmDebugBreakpointHitCount;

void SetWasmDebugEvent(const char* event)
{
    size_t eventLength = strlen(event);
    if (eventLength > WasmDebugMessageBufferSize)
    {
        eventLength = WasmDebugMessageBufferSize;
    }

    memcpy(g_wasmDebugLastEvent, event, eventLength);
    g_wasmDebugLastEventLength = static_cast<uint32_t>(eventLength);
}

void ArmWasmDebugBreakpointFromCommand(const char* command)
{
    static constexpr char Prefix[] = "dbi-command:set-breakpoint";
    static constexpr char NamePrefix[] = ":name=";
    static constexpr char TokenPrefix[] = ":token=0x";

    if (strncmp(command, Prefix, sizeof(Prefix) - 1) != 0)
    {
        return;
    }

    const char* name = command + sizeof(Prefix) - 1;
    if (strncmp(name, NamePrefix, sizeof(NamePrefix) - 1) == 0)
    {
        name += sizeof(NamePrefix) - 1;
    }
    else if (strncmp(name, TokenPrefix, sizeof(TokenPrefix) - 1) == 0)
    {
        name += sizeof(TokenPrefix) - 1;
        g_wasmDebugBreakpointMethodToken = static_cast<uint32_t>(strtoul(name, nullptr, 16));
        name = "";
    }
    else
    {
        g_wasmDebugBreakpointMethodToken = 0;
        name = "";
    }

    size_t nameLength = strlen(name);
    if (nameLength >= sizeof(g_wasmDebugBreakpointMethodName))
    {
        nameLength = sizeof(g_wasmDebugBreakpointMethodName) - 1;
    }

    memcpy(g_wasmDebugBreakpointMethodName, name, nameLength);
    g_wasmDebugBreakpointMethodName[nameLength] = 0;
    if (nameLength != 0)
    {
        g_wasmDebugBreakpointMethodToken = 0;
    }
    g_wasmDebugBreakpointHitCount = 0;
    g_wasmDebugLastEventLength = 0;
    g_wasmDebugBreakpointArmed = true;
}

void DacGlobals::InitializeEntries()
{
    memset(this, 0, sizeof(*this));
    ThreadStore__s_pThreadStore = PTR_TO_TADDR(&ThreadStore::s_pThreadStore);
}

void DacGlobals::Initialize()
{
    g_dacTable.InitializeEntries();
}

extern "C" EMSCRIPTEN_KEEPALIVE void* Getg_dacTable()
{
    static bool s_initialized = false;
    if (!s_initialized)
    {
        DacGlobals::Initialize();
        s_initialized = true;
    }

    return &g_dacTable;
}

extern "C" EMSCRIPTEN_KEEPALIVE void* GetWasmDbiDacTestData()
{
    return &g_wasmDbiDacTestData;
}

extern "C" EMSCRIPTEN_KEEPALIVE int32_t CoreClrWasmDebugReceiveCommand(const uint8_t* command, uint32_t commandLength)
{
    if ((command == nullptr && commandLength != 0) || commandLength >= WasmDebugMessageBufferSize)
    {
        return -1;
    }

    g_wasmDebugLastCommandLength = commandLength;
    if (commandLength != 0)
    {
        memcpy(g_wasmDebugLastCommand, command, commandLength);
    }
    g_wasmDebugLastCommand[commandLength] = 0;

    ArmWasmDebugBreakpointFromCommand(reinterpret_cast<const char*>(g_wasmDebugLastCommand));

    return 0;
}

extern "C" EMSCRIPTEN_KEEPALIVE uint32_t CoreClrWasmDebugGetLastCommandLength()
{
    return g_wasmDebugLastCommandLength;
}

extern "C" EMSCRIPTEN_KEEPALIVE int32_t CoreClrWasmDebugCopyLastCommand(uint8_t* buffer, uint32_t bufferLength)
{
    if ((buffer == nullptr && bufferLength != 0) || bufferLength < g_wasmDebugLastCommandLength)
    {
        return -1;
    }

    if (g_wasmDebugLastCommandLength != 0)
    {
        memcpy(buffer, g_wasmDebugLastCommand, g_wasmDebugLastCommandLength);
    }

    return 0;
}

extern "C" EMSCRIPTEN_KEEPALIVE uint32_t CoreClrWasmDebugGetLastEventLength()
{
    return g_wasmDebugLastEventLength;
}

extern "C" EMSCRIPTEN_KEEPALIVE int32_t CoreClrWasmDebugCopyLastEvent(uint8_t* buffer, uint32_t bufferLength)
{
    if ((buffer == nullptr && bufferLength != 0) || bufferLength < g_wasmDebugLastEventLength)
    {
        return -1;
    }

    if (g_wasmDebugLastEventLength != 0)
    {
        memcpy(buffer, g_wasmDebugLastEvent, g_wasmDebugLastEventLength);
    }

    return 0;
}

extern "C" EMSCRIPTEN_KEEPALIVE uint32_t CoreClrWasmDebugGetBreakpointHitCount()
{
    return g_wasmDebugBreakpointHitCount;
}

extern "C" void CoreClrWasmDebugMaybeHitInterpreterMethod(MethodDesc* methodDesc, uint32_t ilOffset)
{
    if (!g_wasmDebugBreakpointArmed || methodDesc == nullptr || ilOffset != 0)
    {
        return;
    }

    LPCUTF8 methodName = methodDesc->GetName();
    mdMethodDef methodToken = methodDesc->GetMemberDef();
    if (g_wasmDebugBreakpointMethodToken != 0 &&
        g_wasmDebugBreakpointMethodToken != methodToken)
    {
        return;
    }

    if (g_wasmDebugBreakpointMethodToken == 0 &&
        g_wasmDebugBreakpointMethodName[0] != 0 &&
        strstr(methodName, g_wasmDebugBreakpointMethodName) == nullptr)
    {
        return;
    }

    g_wasmDebugBreakpointArmed = false;
    g_wasmDebugBreakpointHitCount++;

    char event[WasmDebugMessageBufferSize];
    snprintf(
        event,
        sizeof(event),
        "breakpoint-hit:name=%s;token=0x%08x;il=0x%x",
        methodName,
        methodToken,
        ilOffset);
    SetWasmDebugEvent(event);
}
