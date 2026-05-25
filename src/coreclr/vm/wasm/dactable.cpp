// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

#include "common.h"
#include "threads.h"
#include "../../interpreter/intops.h"

#include <emscripten.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

DLLEXPORT DacGlobals g_dacTable;

extern "C" int32_t CoreClrWasmDebugOnBreakpointHit(uint32_t eventAddress, uint32_t eventLength);

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
constexpr uint32_t WasmDebugCommandRecordMagic = 0x434d4457;

enum class WasmDebugCommandKind : uint32_t
{
    None = 0,
    SetBreakpointByName = 1,
    SetBreakpointByToken = 2,
    Continue = 3,
};

enum class WasmDebugEventKind : uint32_t
{
    None = 0,
    Breakpoint = 1,
};

struct WasmDebugCommandRecord
{
    uint32_t Magic;
    uint32_t Kind;
    uint32_t MethodToken;
    uint32_t ILOffset;
    char MethodName[64];
};

struct WasmDebugEventRecord
{
    uint32_t Kind;
    uint32_t MethodToken;
    uint32_t ILOffset;
    uint32_t HitCount;
    uint32_t ContinueCount;
    char MethodName[64];
    char Message[256];
};

struct WasmDebugFrameRecord
{
    uint32_t MethodToken;
    uint32_t ILOffset;
    uint32_t InterpreterIP;
    uint32_t FrameAddress;
    uint32_t StackAddress;
    int32_t FirstStackSlotI32;
    char MethodName[64];
};

static_assert(sizeof(WasmDebugCommandRecord) == 80);
static_assert(sizeof(WasmDebugEventRecord) == 340);
static_assert(sizeof(WasmDebugFrameRecord) == 88);

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
WasmDebugEventRecord g_wasmDebugLastEventRecord;
WasmDebugFrameRecord g_wasmDebugLastFrameRecord;
char g_wasmDebugBreakpointMethodName[64];
uint32_t g_wasmDebugBreakpointMethodToken;
bool g_wasmDebugBreakpointArmed;
bool g_wasmDebugBreakpointStopped;
bool g_wasmDebugContinueRequested;
uint32_t g_wasmDebugBreakpointHitCount;
uint32_t g_wasmDebugContinueCount;
int32_t* g_wasmDebugBreakpointAddress;
int32_t g_wasmDebugBreakpointOriginalOpcode;
bool g_wasmDebugBreakpointPatchActive;

void SetWasmDebugEvent(const char* event)
{
    size_t eventLength = strlen(event);
    if (eventLength >= WasmDebugMessageBufferSize)
    {
        eventLength = WasmDebugMessageBufferSize - 1;
    }

    memcpy(g_wasmDebugLastEvent, event, eventLength);
    g_wasmDebugLastEvent[eventLength] = 0;
    g_wasmDebugLastEventLength = static_cast<uint32_t>(eventLength);
}

void CopyWasmDebugString(char* destination, size_t destinationLength, const char* source)
{
    size_t sourceLength = strlen(source);
    if (sourceLength >= destinationLength)
    {
        sourceLength = destinationLength - 1;
    }

    memcpy(destination, source, sourceLength);
    destination[sourceLength] = 0;
}

void SetWasmDebugBreakpointEventRecord(MethodDesc* methodDesc, uint32_t ilOffset)
{
    memset(&g_wasmDebugLastEventRecord, 0, sizeof(g_wasmDebugLastEventRecord));
    g_wasmDebugLastEventRecord.Kind = static_cast<uint32_t>(WasmDebugEventKind::Breakpoint);
    g_wasmDebugLastEventRecord.MethodToken = methodDesc->GetMemberDef();
    g_wasmDebugLastEventRecord.ILOffset = ilOffset;
    g_wasmDebugLastEventRecord.HitCount = g_wasmDebugBreakpointHitCount;
    g_wasmDebugLastEventRecord.ContinueCount = g_wasmDebugContinueCount;
    CopyWasmDebugString(g_wasmDebugLastEventRecord.MethodName, sizeof(g_wasmDebugLastEventRecord.MethodName), methodDesc->GetName());
    CopyWasmDebugString(g_wasmDebugLastEventRecord.Message, sizeof(g_wasmDebugLastEventRecord.Message), reinterpret_cast<const char*>(g_wasmDebugLastEvent));
}

void SetWasmDebugBreakpointFrameRecord(MethodDesc* methodDesc, uint32_t ilOffset, const int32_t* ip, uintptr_t frameAddress, uintptr_t stackAddress)
{
    memset(&g_wasmDebugLastFrameRecord, 0, sizeof(g_wasmDebugLastFrameRecord));
    g_wasmDebugLastFrameRecord.MethodToken = methodDesc->GetMemberDef();
    g_wasmDebugLastFrameRecord.ILOffset = ilOffset;
    g_wasmDebugLastFrameRecord.InterpreterIP = static_cast<uint32_t>(reinterpret_cast<uintptr_t>(ip));
    g_wasmDebugLastFrameRecord.FrameAddress = static_cast<uint32_t>(frameAddress);
    g_wasmDebugLastFrameRecord.StackAddress = static_cast<uint32_t>(stackAddress);
    if (stackAddress != 0)
    {
        g_wasmDebugLastFrameRecord.FirstStackSlotI32 = *reinterpret_cast<int32_t*>(stackAddress);
    }
    CopyWasmDebugString(g_wasmDebugLastFrameRecord.MethodName, sizeof(g_wasmDebugLastFrameRecord.MethodName), methodDesc->GetName());
}

void RestoreWasmDebugBreakpointPatch()
{
    if (g_wasmDebugBreakpointPatchActive && g_wasmDebugBreakpointAddress != nullptr)
    {
        *g_wasmDebugBreakpointAddress = g_wasmDebugBreakpointOriginalOpcode;
    }

    g_wasmDebugBreakpointAddress = nullptr;
    g_wasmDebugBreakpointOriginalOpcode = 0;
    g_wasmDebugBreakpointPatchActive = false;
}

void ArmWasmDebugBreakpoint(uint32_t methodToken, const char* methodName)
{
    RestoreWasmDebugBreakpointPatch();
    g_wasmDebugBreakpointMethodToken = methodToken;
    const char* name = methodName != nullptr ? methodName : "";

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
    memset(&g_wasmDebugLastEventRecord, 0, sizeof(g_wasmDebugLastEventRecord));
    memset(&g_wasmDebugLastFrameRecord, 0, sizeof(g_wasmDebugLastFrameRecord));
    g_wasmDebugBreakpointStopped = false;
    g_wasmDebugContinueRequested = false;
    g_wasmDebugContinueCount = 0;
    g_wasmDebugBreakpointArmed = true;
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
    uint32_t methodToken = 0;
    if (strncmp(name, NamePrefix, sizeof(NamePrefix) - 1) == 0)
    {
        name += sizeof(NamePrefix) - 1;
    }
    else if (strncmp(name, TokenPrefix, sizeof(TokenPrefix) - 1) == 0)
    {
        name += sizeof(TokenPrefix) - 1;
        methodToken = static_cast<uint32_t>(strtoul(name, nullptr, 16));
        name = "";
    }
    else
    {
        name = "";
    }

    ArmWasmDebugBreakpoint(methodToken, name);
}

bool WasmDebugBreakpointMatches(MethodDesc* methodDesc, uint32_t ilOffset)
{
    if (methodDesc == nullptr || ilOffset != 0)
    {
        return false;
    }

    LPCUTF8 methodName = methodDesc->GetName();
    mdMethodDef methodToken = methodDesc->GetMemberDef();
    if (g_wasmDebugBreakpointMethodToken != 0 &&
        g_wasmDebugBreakpointMethodToken != methodToken)
    {
        return false;
    }

    if (g_wasmDebugBreakpointMethodToken == 0 &&
        g_wasmDebugBreakpointMethodName[0] != 0 &&
        strstr(methodName, g_wasmDebugBreakpointMethodName) == nullptr)
    {
        return false;
    }

    return true;
}

void ContinueWasmDebugBreakpointFromCommand(const char* command)
{
    static constexpr char ContinueCommand[] = "dbi-command:continue";
    if (strcmp(command, ContinueCommand) != 0)
    {
        return;
    }

    if (g_wasmDebugBreakpointStopped)
    {
        g_wasmDebugContinueRequested = true;
        g_wasmDebugContinueCount++;
    }
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

    ContinueWasmDebugBreakpointFromCommand(reinterpret_cast<const char*>(g_wasmDebugLastCommand));
    ArmWasmDebugBreakpointFromCommand(reinterpret_cast<const char*>(g_wasmDebugLastCommand));

    return 0;
}

extern "C" EMSCRIPTEN_KEEPALIVE int32_t CoreClrWasmDebugReceiveCommandRecord(const uint8_t* commandRecord, uint32_t commandRecordLength)
{
    if (commandRecord == nullptr || commandRecordLength != sizeof(WasmDebugCommandRecord))
    {
        return -1;
    }

    WasmDebugCommandRecord record;
    memcpy(&record, commandRecord, sizeof(record));
    if (record.Magic != WasmDebugCommandRecordMagic)
    {
        return -1;
    }

    switch (static_cast<WasmDebugCommandKind>(record.Kind))
    {
        case WasmDebugCommandKind::SetBreakpointByName:
            record.MethodName[sizeof(record.MethodName) - 1] = 0;
            ArmWasmDebugBreakpoint(0, record.MethodName);
            return 0;

        case WasmDebugCommandKind::SetBreakpointByToken:
            if (record.ILOffset != 0)
            {
                return -1;
            }

            ArmWasmDebugBreakpoint(record.MethodToken, "");
            return 0;

        case WasmDebugCommandKind::Continue:
            if (g_wasmDebugBreakpointStopped)
            {
                g_wasmDebugContinueRequested = true;
                g_wasmDebugContinueCount++;
            }
            return 0;

        default:
            return -1;
    }
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

extern "C" EMSCRIPTEN_KEEPALIVE uint32_t CoreClrWasmDebugGetLastEventRecordSize()
{
    return sizeof(WasmDebugEventRecord);
}

extern "C" EMSCRIPTEN_KEEPALIVE int32_t CoreClrWasmDebugCopyLastEventRecord(uint8_t* buffer, uint32_t bufferLength)
{
    if (buffer == nullptr || bufferLength < sizeof(WasmDebugEventRecord))
    {
        return -1;
    }

    memcpy(buffer, &g_wasmDebugLastEventRecord, sizeof(g_wasmDebugLastEventRecord));
    return 0;
}

extern "C" EMSCRIPTEN_KEEPALIVE uint32_t CoreClrWasmDebugGetLastFrameRecordSize()
{
    return sizeof(WasmDebugFrameRecord);
}

extern "C" EMSCRIPTEN_KEEPALIVE int32_t CoreClrWasmDebugCopyLastFrameRecord(uint8_t* buffer, uint32_t bufferLength)
{
    if (buffer == nullptr || bufferLength < sizeof(WasmDebugFrameRecord))
    {
        return -1;
    }

    memcpy(buffer, &g_wasmDebugLastFrameRecord, sizeof(g_wasmDebugLastFrameRecord));
    return 0;
}

extern "C" EMSCRIPTEN_KEEPALIVE uint32_t CoreClrWasmDebugGetBreakpointHitCount()
{
    return g_wasmDebugBreakpointHitCount;
}

extern "C" EMSCRIPTEN_KEEPALIVE uint32_t CoreClrWasmDebugGetContinueCount()
{
    return g_wasmDebugContinueCount;
}

extern "C" void CoreClrWasmDebugMaybePatchInterpreterMethod(MethodDesc* methodDesc, uint32_t ilOffset, int32_t* ip)
{
    if (!g_wasmDebugBreakpointArmed || ip == nullptr || !WasmDebugBreakpointMatches(methodDesc, ilOffset))
    {
        return;
    }

    g_wasmDebugBreakpointAddress = ip;
    g_wasmDebugBreakpointOriginalOpcode = *ip;
    g_wasmDebugBreakpointPatchActive = true;
    g_wasmDebugBreakpointArmed = false;
    *ip = INTOP_BREAKPOINT;
}

extern "C" bool CoreClrWasmDebugHandleInterpreterBreakpoint(
    MethodDesc* methodDesc,
    uint32_t ilOffset,
    const int32_t* ip,
    uintptr_t frameAddress,
    uintptr_t stackAddress,
    int32_t* originalOpcode)
{
    if (!g_wasmDebugBreakpointPatchActive ||
        ip == nullptr ||
        originalOpcode == nullptr ||
        ip != g_wasmDebugBreakpointAddress ||
        !WasmDebugBreakpointMatches(methodDesc, ilOffset))
    {
        return false;
    }

    *originalOpcode = g_wasmDebugBreakpointOriginalOpcode;
    RestoreWasmDebugBreakpointPatch();

    g_wasmDebugBreakpointStopped = true;
    g_wasmDebugContinueRequested = false;
    g_wasmDebugBreakpointHitCount++;

    LPCUTF8 methodName = methodDesc->GetName();
    mdMethodDef methodToken = methodDesc->GetMemberDef();
    char event[WasmDebugMessageBufferSize];
    snprintf(
        event,
        sizeof(event),
        "breakpoint-hit:name=%s;token=0x%08x;il=0x%x",
        methodName,
        methodToken,
        ilOffset);
    SetWasmDebugEvent(event);
    SetWasmDebugBreakpointEventRecord(methodDesc, ilOffset);
    SetWasmDebugBreakpointFrameRecord(methodDesc, ilOffset, ip, frameAddress, stackAddress);

    CoreClrWasmDebugOnBreakpointHit(
        static_cast<uint32_t>(reinterpret_cast<uintptr_t>(g_wasmDebugLastEvent)),
        g_wasmDebugLastEventLength);

    g_wasmDebugBreakpointStopped = false;
    return true;
}
