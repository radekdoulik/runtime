# WASM debug transport design

## Purpose and scope

This document is the Phase 4 transport design for the CoreCLR browser-WASM
DBI/DAC sidecar. It narrows the productization plan's Phase 4 item: replace
the prototype command/event records with real CoreCLR debug IPC semantics and
publish a Cordb-shaped JSON-RPC vocabulary for the IDE/debug-adapter plane
(`product-ready-mscordbi-dac-sidecar-plan.md:602-690`).

It covers four transport boundaries:

- The DBI-to-runtime command and runtime-to-DBI event wire inside the browser
  host, including the choice to carry serialized `DebuggerIPCEvent` payloads
  rather than long-term `WasmDebugCommandRecord` / `WasmDebugEventRecord`
  envelopes.
- The IDE-facing JSON method vocabulary: `lifecycle.*`, `target.*`, `dac.*`,
  `dbi.*`, and `cdp.*`, with HRESULTs in results rather than JSON-RPC
  plumbing errors, matching the plan's cross-cutting criteria
  (`product-ready-mscordbi-dac-sidecar-plan.md:265-274`).
- The two-channel split: a high-rate binary channel for `ReadVirtual` / bulk
  memory and a low-rate JSON text channel for control and Cordb-shaped calls,
  matching the Phase 4 plan (`product-ready-mscordbi-dac-sidecar-plan.md:641-647`).
- The lifecycle gate that prevents target-side breakpoint arming and `to_pause`
  events until the IDE/proxy has completed attach, mirroring Mono's attach
  gate (`product-ready-mscordbi-dac-sidecar-plan.md:838-846`).

The design intentionally stays at the transport and wire-contract level. It
assumes the Phase 0 architecture decision remains: final architecture is real
DBI + real DAC + WASM transport + runtime debug EE, not a parallel debugger
protocol (`product-ready-mscordbi-dac-sidecar-plan.md:276-278`).

This document does not design or re-open:

- Phase 3 V3 process attach / `OpenVirtualProcessImpl`; Phase 4 consumes the
  process object when it exists but does not define it.
- Phase 5 target-side debug EE enablement; today `debug/ee/wks` is excluded
  for WASM by `if (NOT CLR_CMAKE_TARGET_ARCH_WASM)`
  (`src/coreclr/debug/ee/CMakeLists.txt:72-75`).
- Phase 6 stop-trigger mechanics; this design assumes the Mono-pattern
  `debugger;` import remains the MVP trigger and async-pause-while-running is
  deferred to Phase 13 (`product-ready-mscordbi-dac-sidecar-plan.md:752-774`).
- Phase 13 features such as SAB/Worker async break, JSPI, Asyncify, or a
  cooperative safepoint FIFO; the plan explicitly excludes those from MVP
  (`product-ready-mscordbi-dac-sidecar-plan.md:848-863`).

The MVP transport surface is therefore: breakpoint set, breakpoint hit,
continue, loader/thread/process event shapes as they become available, and
read-only inspection while stopped. IDE-initiated async pause while the runtime
is mid-execution is not an MVP transport requirement
(`product-ready-mscordbi-dac-sidecar-plan.md:1189-1195`).

## Current state inventory

The current sidecar is a two-module proof of concept: the debugger WASM module
links real DAC and DBI code, but live debugging still uses prototype command
and event payloads rather than full desktop IPC events
(`debug-dac-wasm-coreclr.md:43-66`).

### Prototype records

| Record | Fixed size | Layout evidence |
|---|---:|---|
| `WasmDebugCommandRecord` | 80 bytes | `Magic`, `Kind`, `MethodToken`, `ILOffset`, and `MethodName[64]` are defined in `src/coreclr/debug/wasm-dbi-dac/dbi_dac_wasm.cpp:242-249`; the size assertion is `src/coreclr/debug/wasm-dbi-dac/dbi_dac_wasm.cpp:292`; the runtime mirror is `src/coreclr/vm/wasm/dactable.cpp:45-52` and `src/coreclr/vm/wasm/dactable.cpp:76`. |
| `WasmDebugEventRecord` | 340 bytes | `Kind`, `MethodToken`, `ILOffset`, `HitCount`, `ContinueCount`, `MethodName[64]`, and `Message[256]` are defined in `src/coreclr/debug/wasm-dbi-dac/dbi_dac_wasm.cpp:251-260`; the size assertion is `src/coreclr/debug/wasm-dbi-dac/dbi_dac_wasm.cpp:293`; the runtime mirror is `src/coreclr/vm/wasm/dactable.cpp:54-63` and `src/coreclr/vm/wasm/dactable.cpp:77`. |
| `WasmDebugFrameRecord` | 88 bytes | `MethodToken`, `ILOffset`, `InterpreterIP`, `FrameAddress`, `StackAddress`, `FirstStackSlotI32`, and `MethodName[64]` are defined in `src/coreclr/debug/wasm-dbi-dac/dbi_dac_wasm.cpp:262-271`; the size assertion is `src/coreclr/debug/wasm-dbi-dac/dbi_dac_wasm.cpp:294`; the runtime mirror is `src/coreclr/vm/wasm/dactable.cpp:65-74` and `src/coreclr/vm/wasm/dactable.cpp:78`. |
| `WasmDbiProcessState` | 40 bytes | Session/runtime/process/event counters are defined in `src/coreclr/debug/wasm-dbi-dac/dbi_dac_wasm.cpp:273-285`; the size assertion is `src/coreclr/debug/wasm-dbi-dac/dbi_dac_wasm.cpp:295`. |

### Host imports and protocol gate

All JS-to-sidecar imports live under module `"coreclr_dbi_dac"` and are
listed in the host-bridge README (`src/coreclr/debug/wasm-dbi-dac/README.md:52-64`):

- `read_target_memory` copies bytes from runtime memory to sidecar memory.
- `get_symbol_address` resolves target runtime symbols.
- `get_target_module_base` resolves the runtime module base.
- `send_ipc_to_runtime` delivers a binary DBI command to the runtime.

The C declarations use the same import module and names
(`src/coreclr/debug/wasm-dbi-dac/dbi_dac_wasm.cpp:758-768`). The README
states that `send_ipc_to_runtime` pulls bytes from sidecar memory and routes
those bytes to `CoreClrWasmDebugReceiveCommand` or
`CoreClrWasmDebugReceiveCommandRecord` in the runtime, then copies any reply
back through sidecar receive exports (`src/coreclr/debug/wasm-dbi-dac/README.md:117-125`).

Product exports are gated by an acknowledged version protocol. The sidecar
version blob contains a `ProtocolBreakingChangeCounter` field
(`src/coreclr/debug/wasm-dbi-dac/dbi_dac_wasm.cpp:222-231`), and the blob writer
copies the current counter into that field
(`src/coreclr/debug/wasm-dbi-dac/dbi_dac_wasm.cpp:1054-1062`).
`check_protocol` returns `HrIncompatibleProtocol` (`0x8013134B`) when magic,
ABI version, or breaking-change counter do not match
(`src/coreclr/debug/wasm-dbi-dac/dbi_dac_wasm.cpp:1068-1092`).
`acknowledge_protocol` latches `g_protocolAcknowledged` on success and clears
it on failure (`src/coreclr/debug/wasm-dbi-dac/dbi_dac_wasm.cpp:1095-1117`).
Every gated export calls `EnsureProtocolAcknowledged`, which returns success
or `HrIncompatibleProtocol` (`src/coreclr/debug/wasm-dbi-dac/dbi_dac_wasm.cpp:1120-1126`).

The wire-change rule is already documented: any host-bridge signature, struct
layout, error sentinel, or sequencing change must bump
`WasmDbiDacProtocolBreakingChangeCounter`
(`src/coreclr/debug/wasm-dbi-dac/README.md:12-18`). The counter is currently
`1`, with a bumping log in the source
(`src/coreclr/debug/wasm-dbi-dac/dbi_dac_wasm.cpp:50-58`).

### Page cache from Phase 2

The current data-target cache is a stopped-state cache for `ReadTargetMemory`:
4 KiB pages, 32 slots, fully associative lookup, LRU eviction by tick, epoch
invalidation, and cross-page bypass (`src/coreclr/debug/wasm-dbi-dac/dbi_dac_wasm.cpp:298-324`).
`PageCacheEntry` and `PageCacheStatsBlob` define the entry and 24-byte stats
layout (`src/coreclr/debug/wasm-dbi-dac/dbi_dac_wasm.cpp:328-346`); globals
start at epoch `1` and count hits, misses, bypasses, and invalidations
(`src/coreclr/debug/wasm-dbi-dac/dbi_dac_wasm.cpp:348-354`).
Invalidation increments the epoch and clears entries only on wrap
(`src/coreclr/debug/wasm-dbi-dac/dbi_dac_wasm.cpp:356-374`). The public
invalidation and stats exports are `src/coreclr/debug/wasm-dbi-dac/dbi_dac_wasm.cpp:1154-1194`.
The Phase 2 plan required page-level caching, host-owned stopped-state epochs,
invalidation on resume-like transitions, and `target.memoryInvalidated { epoch }`
or equivalent (`product-ready-mscordbi-dac-sidecar-plan.md:467-479`). The
sibling PoC reported 91-94% hits and 9-15x wire reduction
(`product-ready-mscordbi-dac-sidecar-plan.md:93-98`).

## Real CoreCLR debug IPC contract

The desktop contract is private but structured. `dbgipcevents.h` states that
its data structures may cross process and network boundaries, so each shared
structure must have identical field offsets and field sizes; `MSLAYOUT` is the
mechanism used to avoid compiler packing drift
(`src/coreclr/debug/inc/dbgipcevents.h:109-113`). The file also states that the
left-side and right-side protocol are a conceptual pair that can change, but
not by debug/retail layout differences (`src/coreclr/debug/inc/dbgipcevents.h:67-77`).

### `DebuggerIPCEvent` envelope

`DebuggerIPCEvent` is the event envelope passed between the runtime controller
and debugger interface. The header comments say some event types are fixed
size, while others carry specialized data attached through the union at the
end of the structure (`src/coreclr/debug/inc/dbgipcevents.h:1697-1704`). The
fixed prefix fields are:

- `type` (`DebuggerIPCEventType`).
- `processId`.
- `threadId`.
- `vmAppDomain`.
- `vmThread`.
- `hr`.
- `replyRequired`.
- `asyncSend`.

Evidence: fixed prefix at `src/coreclr/debug/inc/dbgipcevents.h:1704-1716`.
The payload union starts immediately after that prefix
(`src/coreclr/debug/inc/dbgipcevents.h:1716-1717`). Relevant union branches
include `LoadModuleData` (`src/coreclr/debug/inc/dbgipcevents.h:1737-1742`),
`UnloadModuleData` (`src/coreclr/debug/inc/dbgipcevents.h:1745-1749`),
`BreakpointData` (`src/coreclr/debug/inc/dbgipcevents.h:1759-1769`),
`DataBreakpointData` (`src/coreclr/debug/inc/dbgipcevents.h:1795-1799`),
`StepData` (`src/coreclr/debug/inc/dbgipcevents.h:1801-1815`), and `Exception`
(`src/coreclr/debug/inc/dbgipcevents.h:1878-1883`).

The transport buffer size is required to hold a `DebuggerIPCEvent`; the
transport-size macro rounds `sizeof(DebuggerIPCEvent)` up to an 8-byte
multiple and asserts it still fits `CorDBIPC_BUFFER_SIZE`
(`src/coreclr/debug/inc/dbgipcevents.h:2092-2100`).

### Event types relevant to MVP

`DebuggerIPCEventType` is generated by including `dbgipceventtypes.h` under
macros (`src/coreclr/debug/inc/dbgipcevents.h:865-880`). The names relevant to
Phase 4 MVP are the actual enum names below.

| Direction | MVP concept | Actual enum name | Value | Citation |
|---|---|---:|---:|---|
| Runtime to DBI | Breakpoint hit | `DB_IPCE_BREAKPOINT` | `0x0100` | `src/coreclr/debug/inc/dbgipceventtypes.h:22-25` |
| Runtime to DBI | Attach/sync complete | `DB_IPCE_SYNC_COMPLETE` | `0x0102` | `src/coreclr/debug/inc/dbgipceventtypes.h:24-25` |
| Runtime to DBI | Create thread | `DB_IPCE_THREAD_ATTACH` | `0x0103` | `src/coreclr/debug/inc/dbgipceventtypes.h:26` |
| Runtime to DBI | Exit thread | `DB_IPCE_THREAD_DETACH` | `0x0104` | `src/coreclr/debug/inc/dbgipceventtypes.h:27` |
| Runtime to DBI | Load module | `DB_IPCE_LOAD_MODULE` | `0x0105` | `src/coreclr/debug/inc/dbgipceventtypes.h:28` |
| Runtime to DBI | Unload module | `DB_IPCE_UNLOAD_MODULE` | `0x0106` | `src/coreclr/debug/inc/dbgipceventtypes.h:29` |
| Runtime to DBI | Exception | `DB_IPCE_EXCEPTION` | `0x0109` | `src/coreclr/debug/inc/dbgipceventtypes.h:32` |
| Runtime to DBI | Breakpoint add reply | `DB_IPCE_BREAKPOINT_ADD_RESULT` | `0x010D` | `src/coreclr/debug/inc/dbgipceventtypes.h:34` |
| Runtime to DBI | Step reply | `DB_IPCE_STEP_RESULT` | `0x010E` | `src/coreclr/debug/inc/dbgipceventtypes.h:35` |
| Runtime to DBI | Step complete | `DB_IPCE_STEP_COMPLETE` | `0x010F` | `src/coreclr/debug/inc/dbgipceventtypes.h:36` |
| Runtime to DBI | Breakpoint remove reply | `DB_IPCE_BREAKPOINT_REMOVE_RESULT` | `0x0111` | `src/coreclr/debug/inc/dbgipceventtypes.h:37` |
| Runtime to DBI | User breakpoint / async stop | `DB_IPCE_USER_BREAKPOINT` | `0x011C` | `src/coreclr/debug/inc/dbgipceventtypes.h:43` |
| DBI to runtime | Async break request | `DB_IPCE_ASYNC_BREAK` | `0x0200` | `src/coreclr/debug/inc/dbgipceventtypes.h:90-93` |
| DBI to runtime | Continue | `DB_IPCE_CONTINUE` | `0x0201` | `src/coreclr/debug/inc/dbgipceventtypes.h:93` |
| DBI to runtime | Breakpoint add | `DB_IPCE_BREAKPOINT_ADD` | `0x0209` | `src/coreclr/debug/inc/dbgipceventtypes.h:98` |
| DBI to runtime | Breakpoint remove | `DB_IPCE_BREAKPOINT_REMOVE` | `0x020A` | `src/coreclr/debug/inc/dbgipceventtypes.h:99` |
| DBI to runtime | Step cancel | `DB_IPCE_STEP_CANCEL` | `0x020B` | `src/coreclr/debug/inc/dbgipceventtypes.h:100` |
| DBI to runtime | Step into / over | `DB_IPCE_STEP` | `0x020C` | `src/coreclr/debug/inc/dbgipceventtypes.h:101` |
| DBI to runtime | Step out | `DB_IPCE_STEP_OUT` | `0x020D` | `src/coreclr/debug/inc/dbgipceventtypes.h:102` |
| DBI to runtime | Attaching | `DB_IPCE_ATTACHING` | `0x021A` | `src/coreclr/debug/inc/dbgipceventtypes.h:107` |
| DBI to runtime | Continue exception | `DB_IPCE_CONTINUE_EXCEPTION` | `0x0219` | `src/coreclr/debug/inc/dbgipceventtypes.h:106` |

There is no enum named `DB_IPCE_CREATE_THREAD`, `DB_IPCE_EXIT_THREAD`, or
`DB_IPCE_ATTACH_COMPLETE` in the current event-type list. The desktop thread
callbacks are driven by `DB_IPCE_THREAD_ATTACH` and `DB_IPCE_THREAD_DETACH`;
DBI maps them to `CreateThread` / `ExitThread` callbacks in
`src/coreclr/debug/di/process.cpp:4935-4955`. The runtime emits those same
events from `Debugger::AttachThread` and `Debugger::DetachThread`
(`src/coreclr/debug/ee/debugger.cpp:8869-8875`,
`src/coreclr/debug/ee/debugger.cpp:8937-8947`).

### Desktop transport session

`DbgTransportSession` frames messages as a fixed `MessageHeader` plus optional
data block; debugger events are the header plus a `DebuggerIPCEvent` data block
(`src/coreclr/debug/inc/dbgtransportsession.h:32-39`). The underlying channel is
`IDebugChannel::Read` / `Write` (`src/coreclr/debug/inc/dbgtransportsession.h:323-340`).
`MessageHeader` carries type, data length, sender/reply IDs, last-seen ID, and
`MT_Event` diagnostics (`src/coreclr/debug/inc/dbgtransportsession.h:493-547`).
`SendEvent` / `SendDebugEvent` call `SendEventWorker`, which computes
`GetEventSize`, stamps `MT_Event`, and sends the header plus data
(`src/coreclr/debug/shared/dbgtransportsession.cpp:326-341`,
`src/coreclr/debug/shared/dbgtransportsession.cpp:556-569`). `SendMessage`
immediately writes or queues messages depending on session state
(`src/coreclr/debug/shared/dbgtransportsession.cpp:645-690`). Receiving
`MT_Event` validates length, reads event bytes, records event type, and signals
readiness (`src/coreclr/debug/shared/dbgtransportsession.cpp:1782-1872`);
`GetNextEvent` copies one queued event to the caller
(`src/coreclr/debug/shared/dbgtransportsession.cpp:358-387`). `GetEventSize` is
the desktop byte-count reference for fixed-prefix plus selected union branch
(`src/coreclr/debug/shared/dbgtransportsession.cpp:2112-2411`).

### DBI-side manager

`DbgTransportTarget` is the DBI-side manager for transport sessions. It
initializes its lock in `Init` and tears down process entries in `Shutdown`
(`src/coreclr/debug/di/dbgtransportmanager.cpp:74-99`). `GetTransportForProcess`
finds or creates a `DbgTransportSession` for a process descriptor and returns a
handle for process termination (`src/coreclr/debug/di/dbgtransportmanager.cpp:102-107`).
When creating a new entry, it allocates the session, validates the process,
creates the process-exit handle, starts the Unix poller when needed, and calls
`transport->Init` (`src/coreclr/debug/di/dbgtransportmanager.cpp:118-177`).
`ReleaseTransport` decrements references and shuts the transport down when the
entry is removed (`src/coreclr/debug/di/dbgtransportmanager.cpp:211-250`).

### Wire-payload decision

Phase 4 should carry serialized `DebuggerIPCEvent` payloads, not a second
semantic debugger protocol. The bytes are the fixed prefix in source order
(`type`, `processId`, `threadId`, `vmAppDomain`, `vmThread`, `hr`,
`replyRequired`, `asyncSend`) followed by the union branch selected by `type`
(`src/coreclr/debug/inc/dbgipcevents.h:1704-1717`). The breakpoint MVP branch is
`BreakpointData` (`src/coreclr/debug/inc/dbgipcevents.h:1759-1769`). The byte
count must match the branch-sizing logic equivalent to `GetEventSize`
(`src/coreclr/debug/shared/dbgtransportsession.cpp:2112-2411`). Integers are
little-endian for Phase 4 because the current version blob is defined as
little-endian (`src/coreclr/debug/wasm-dbi-dac/dbi_dac_wasm.cpp:46-48`) and the
cDAC descriptor sets little-endian platform flags
(`src/coreclr/debug/datadescriptor-shared/datadescriptor.cpp:345`).
Pointer-like fields remain target handles, not JS pointers; the README already
distinguishes runtime-memory and sidecar-memory addresses
(`src/coreclr/debug/wasm-dbi-dac/README.md:19-32`). Any schema change must be
covered by the Phase 4 `WasmDbiDacProtocolBreakingChangeCounter` bump.

## DBI-to-runtime transport design

### Recommendation

Carry serialized `DebuggerIPCEvent` payloads through the existing
`send_ipc_to_runtime` host import, one host import call per outbound DBI
command. The import already accepts sidecar address and length
(`src/coreclr/debug/wasm-dbi-dac/dbi_dac_wasm.cpp:767-768`) and is already the
DBI session/breakpoint import in the README
(`src/coreclr/debug/wasm-dbi-dac/README.md:58-64`). This avoids productizing
`WasmDebugCommandRecord`, which only models set-breakpoint and continue kinds
(`src/coreclr/debug/wasm-dbi-dac/dbi_dac_wasm.cpp:97-103`) while desktop IPC
already models the MVP module, thread, breakpoint, step, exception, continue,
attach, and user-breakpoint events (`src/coreclr/debug/inc/dbgipceventtypes.h:22-107`).

The host import return value is the non-blocking back-pressure surface. The
current send path validates buffer arguments and forwards non-zero host-import
results unchanged (`src/coreclr/debug/wasm-dbi-dac/dbi_dac_wasm.cpp:955-965`).
Phase 4 should standardize `0`/success, `BufferTooSmall` (`-7`), and a new
negative `QueueFull` added with the protocol bump. `send_ipc_to_runtime` must
never block JS. The current byte limit is 256 bytes
(`src/coreclr/debug/wasm-dbi-dac/dbi_dac_wasm.cpp:43`), mirrored on the runtime
side (`src/coreclr/vm/wasm/dactable.cpp:28`); raising it is a wire change.

### Migration from prototype records

The migration order should be:

1. Add serializer/deserializer helpers for one event type: `DB_IPCE_BREAKPOINT`
   first, because the current HelloWorld smoke already proves the breakpoint
   callback path end to end (`src/coreclr/vm/wasm/dactable.cpp:480-496`,
   `src/coreclr/debug/wasm-dbi-dac/hello-breakpoint-smoke.js:600-638`).
2. Send a serialized `DebuggerIPCEvent` for the breakpoint-hit round trip while
   leaving the existing text event and prototype record path available in the
   tests build only.
3. Keep `WasmDebugCommandRecord`, `WasmDebugEventRecord`, and
   `WasmDebugFrameRecord` behind `WASM_DBI_DAC_BUILD_TESTS` / TESTS_ONLY
   exports so existing smokes remain useful until their replacements land. The
   test sidecar is already a separate target with that compile definition
   (`src/coreclr/debug/wasm-dbi-dac/CMakeLists.txt:62-67`).
4. Remove prototype records from product exports after all MVP event types have
   serialized `DebuggerIPCEvent` coverage.

Existing smoke tests should continue to pass during the ladder. The CMake
smoke targets are `coreclr_dbi_dac_wasm_smoke` and
`coreclr_dbi_dac_wasm_hello_breakpoint_smoke`
(`src/coreclr/debug/wasm-dbi-dac/CMakeLists.txt:71-80`). The HelloWorld smoke
currently exercises `dbi_session_create`, `dbi_connect_runtime`,
`dbi_set_breakpoint_by_name`, event polling, frame polling, process-state
polling, continue, disconnect, and destroy
(`src/coreclr/debug/wasm-dbi-dac/hello-breakpoint-smoke.js:556-586`,
`src/coreclr/debug/wasm-dbi-dac/hello-breakpoint-smoke.js:600-638`).

### Endianness and layout

Browser-wasm Phase 4 is wasm32 and little-endian. The current sidecar asserts
that `sizeof(void*) == sizeof(uint32_t)`
(`src/coreclr/debug/wasm-dbi-dac/dbi_dac_wasm.cpp:291-296`). The version blob
stores bytes little-endian by design
(`src/coreclr/debug/wasm-dbi-dac/dbi_dac_wasm.cpp:46-48`). The cDAC platform
flags set the little-endian bit and the 32-bit bit when appropriate
(`src/coreclr/debug/datadescriptor-shared/datadescriptor.cpp:345`).

Therefore, Phase 4 serialization is little-endian. A big-endian host is not a
supported wasm32 ABI today; if a future wasm target changes that assumption,
it must become a protocol-breaking follow-up rather than silent byte swapping.

### Reentrancy and cadence

The current breakpoint smoke re-enters sidecar exports and calls `dbi_continue`
inside the same JS breakpoint callback (`src/coreclr/debug/wasm-dbi-dac/hello-breakpoint-smoke.js:495-553`).
Product transport must forbid arbitrary synchronous JS callback reentrancy: the
runtime endpoint queues inbound DBI commands, and the runtime pulls from that
queue at breakpoint/step/exception/loader stop cadence. Async pause remains a
Phase 13 item (`product-ready-mscordbi-dac-sidecar-plan.md:848-863`).

### Lifecycle errors

Send-before-sidecar-handshake returns `HrIncompatibleProtocol`. The helper is
explicit and every gated export uses it
(`src/coreclr/debug/wasm-dbi-dac/dbi_dac_wasm.cpp:1120-1126`).

Send-while-disconnected currently uses `E_FAIL`, not a named
`NotConnected` sentinel. Examples: `dbi_set_breakpoint_by_name` returns
`E_FAIL` if `g_cordb` is null or `g_connectedToRuntime` is false
(`src/coreclr/debug/wasm-dbi-dac/dbi_dac_wasm.cpp:1591-1603`),
`dbi_continue` does the same (`src/coreclr/debug/wasm-dbi-dac/dbi_dac_wasm.cpp:1644-1662`),
and `dbi_poll_event` does the same
(`src/coreclr/debug/wasm-dbi-dac/dbi_dac_wasm.cpp:1665-1679`).
The external JSON-RPC surface should expose this as a documented not-connected
condition in `result.hr` and `outs.state`, without using JSON-RPC `error`.

## IDE-facing JSON-RPC vocabulary

This section defines method names and JSON shapes. It does not choose a final
JSON-RPC dialect; that trade-off remains open in Section 10. The method names
follow the Cordb-shaped naming rule from the plan
(`product-ready-mscordbi-dac-sidecar-plan.md:627-640`).

### Uniform response and error shape

Every `dac.*` and `dbi.*` response is:

```json
{
  "hr": 0,
  "outs": {}
}
```

`hr` is a signed 32-bit integer containing `S_OK`, a sidecar negative `Result`,
or an HRESULT. JSON-RPC `error` is reserved for transport/plumbing failures:
parse error, invalid method envelope, incompatible JSON protocol version,
channel teardown, or a missing mandatory feature. This follows the plan's rule
that cDAC/DBI status lives in `result.hr`, not `error.code`
(`product-ready-mscordbi-dac-sidecar-plan.md:265-268`,
`product-ready-mscordbi-dac-sidecar-plan.md:648-651`).

Control methods under `lifecycle.*` and `target.*` SHOULD use the same
`{ hr, outs }` shape when they touch the sidecar or target. Server-pushed
notifications, such as `target.memoryInvalidated`, have no response.

### Lifecycle methods

| Method | Params | Result outs | HRESULT location | Semantics |
|---|---|---|---|---|
| `lifecycle.ping` | `{}` | `{ "serverTime": <string>, "protocol": <string> }` | `result.hr` | Idempotent liveness probe. |
| `lifecycle.info` | `{}` | `{ "abiVersion": <u32>, "protocolBreakingChangeCounter": <u32>, "componentMask": <u32>, "capabilities": [<string>] }` | `result.hr` | Reads the version blob fields defined by the sidecar. |
| `lifecycle.stats` | `{ "includeCache": <bool>, "includeTransport": <bool> }` | `{ "pageCache": { "epoch": <u32>, "hits": <u32>, "misses": <u32>, "bypasses": <u32>, "invalidations": <u32> }, "queues": { ... } }` | `result.hr` | Idempotent diagnostics; cache fields mirror `PageCacheStatsBlob`. |
| `lifecycle.attach` | `{ "ideSessionId": <string>, "cdpSessionId": <string|null>, "capabilities": [<string>] }` | `{ "attached": true, "epoch": <u32> }` | `result.hr` | Idempotently opens the IDE attach gate and drives the runtime attached export. |
| `lifecycle.shutdown` | `{ "reason": <string> }` | `{ "detached": true }` | `result.hr` | Idempotent teardown; closes queues and clears the runtime attached flag. |

### Target methods

| Method | Params | Result outs | HRESULT location | Semantics |
|---|---|---|---|---|
| `target.tryGetSymbol` | `{ "baseAddress": <u64>, "symbolName": <string> }` | `{ "found": <bool>, "address": <u64|null> }` | `result.hr` | Idempotent symbol lookup; maps to the host symbol import. |
| `target.copyFrom` | `{ "address": <u64>, "byteCount": <u32>, "encoding": "base64"|"binaryHandle" }` | `{ "bytes": <string>|null, "binaryHandle": <string|null>, "bytesRead": <u32> }` | `result.hr` | Idempotent small read; large reads should use the binary channel. |
| `target.memoryInvalidated` | `{ "epoch": <u32>, "reason": "continue"|"step"|"write"|"resume"|"host" }` | none | none | Server-pushed notification; increments the stopped-state epoch. |

### DAC methods

| Method | Params | Result outs | HRESULT location | Semantics |
|---|---|---|---|---|
| `dac.runSweep` | `{ "name": <string>, "arguments": { ... } }` | `{ "summary": { ... } }` | `result.hr` | Idempotent probe/sweep while stopped. |
| `dac.thread.enumerate` | `{ "processId": <u32|null> }` | `{ "threads": [ { "id": <u32>, "managedId": <u64|null> } ] }` | `result.hr` | Idempotent enumeration. |
| `dac.thread.getInfo` | `{ "threadId": <u32> }` | `{ "thread": { ... } }` | `result.hr` | Idempotent thread inspection. |
| `dac.stackwalk.create` | `{ "threadId": <u32> }` | `{ "walkId": <string> }` | `result.hr` | Allocates a one-shot stackwalk cursor. |
| `dac.stackwalk.next` | `{ "walkId": <string>, "count": <u32> }` | `{ "frames": [ { ... } ], "complete": <bool> }` | `result.hr` | Advances a cursor; not idempotent. |
| `dac.stackwalk.getFrame` | `{ "walkId": <string>, "frameIndex": <u32> }` | `{ "frame": { ... } }` | `result.hr` | Idempotent for an existing cursor. |
| `dac.stackwalk.close` | `{ "walkId": <string> }` | `{ "closed": true }` | `result.hr` | Idempotent cursor cleanup. |
| `dac.cache.flush` | `{ "reason": <string> }` | `{ "epoch": <u32> }` | `result.hr` | Idempotent invalidation for the current epoch transition. |
| `dac.page.reset` | `{ "address": <u64|null> }` | `{ "epoch": <u32> }` | `result.hr` | Debug/test cache reset; idempotent. |
| `dac.interpreter.walkFrames` | `{ "threadId": <u32>, "maxFrames": <u32> }` | `{ "frames": [ { "methodToken": <u32>, "ilOffset": <u32> } ] }` | `result.hr` | Idempotent interpreter-frame snapshot. |

### DBI methods

| Method | Params | Result outs | HRESULT location | Semantics |
|---|---|---|---|---|
| `dbi.session.create` | `{ "runtimeBase": <u32>, "ideSessionId": <string> }` | `{ "sessionId": <string>, "processId": <u32> }` | `result.hr` | Idempotent for the same live session; creates/attaches sidecar DBI state. |
| `dbi.session.list` | `{}` | `{ "sessions": [ { "sessionId": <string>, "state": <string> } ] }` | `result.hr` | Idempotent. |
| `dbi.session.close` | `{ "sessionId": <string> }` | `{ "closed": true }` | `result.hr` | Idempotent teardown. |
| `dbi.process.enumerateThreads` | `{ "sessionId": <string> }` | `{ "threads": [ { "threadId": <u32> } ] }` | `result.hr` | Idempotent. |
| `dbi.process.continue` | `{ "sessionId": <string>, "threadId": <u32|null> }` | `{ "continued": true, "epoch": <u32> }` | `result.hr` | One-shot per stopped state; also invalidates memory epoch. |
| `dbi.process.stop` | `{ "sessionId": <string> }` | `{ "requested": true }` | `result.hr` | MVP may return `E_NOTIMPL`; async pause is Phase 13. |
| `dbi.process.asyncBreak` | `{ "sessionId": <string> }` | `{ "requested": true }` | `result.hr` | MVP may return `E_NOTIMPL`; maps to `DB_IPCE_ASYNC_BREAK` later. |
| `dbi.process.enumerateAppDomains` | `{ "sessionId": <string> }` | `{ "appDomains": [ { ... } ] }` | `result.hr` | Idempotent. |
| `dbi.callbacks.poll` | `{ "sessionId": <string>, "maxEvents": <u32> }` | `{ "events": [ { "eventType": <string>, "payload": { ... } } ] }` | `result.hr` | Drains queued callbacks; not idempotent. |
| `dbi.breakpoint.set` | `{ "sessionId": <string>, "methodToken": <u32>|null, "methodName": <string|null>, "ilOffset": <u32> }` | `{ "breakpointId": <string> }` | `result.hr` | Idempotent for identical key; sends `DB_IPCE_BREAKPOINT_ADD`. |
| `dbi.breakpoint.clear` | `{ "sessionId": <string>, "breakpointId": <string> }` | `{ "cleared": true }` | `result.hr` | Idempotent; sends `DB_IPCE_BREAKPOINT_REMOVE`. |
| `dbi.breakpoint.list` | `{ "sessionId": <string> }` | `{ "breakpoints": [ { ... } ] }` | `result.hr` | Idempotent. |
| `dbi.step.into` | `{ "sessionId": <string>, "threadId": <u32> }` | `{ "requested": true }` | `result.hr` | One-shot per stopped state; sends `DB_IPCE_STEP`. |
| `dbi.step.over` | `{ "sessionId": <string>, "threadId": <u32> }` | `{ "requested": true }` | `result.hr` | One-shot per stopped state; sends `DB_IPCE_STEP`. |
| `dbi.step.out` | `{ "sessionId": <string>, "threadId": <u32> }` | `{ "requested": true }` | `result.hr` | One-shot per stopped state; sends `DB_IPCE_STEP_OUT`. |
| `dbi.ipc.poll` | `{ "sessionId": <string>, "maxMessages": <u32> }` | `{ "messages": [ { "type": <u32>, "bytes": <string> } ] }` | `result.hr` | Drains raw serialized IPC for diagnostics; not idempotent. |
| `dbi.receiveRuntimeEvent` | `{ "sessionId": <string>, "eventBytes": <base64> }` | `{ "queued": true }` | `result.hr` | Host-to-sidecar ingestion for serialized runtime events; not idempotent. |
| `dbi.setAllDebugState` | `{ "sessionId": <string>, "state": <string> }` | `{ "applied": true }` | `result.hr` | Idempotent for the same requested state; maps to `DB_IPCE_SET_ALL_DEBUG_STATE` later. |

### CDP pass-through

`cdp.*` is a namespaced pass-through for IDE/proxy commands that must reach the
engine. Shape:

```json
{
  "method": "cdp.Debugger.resume",
  "params": {
    "cdpMethod": "Debugger.resume",
    "cdpParams": {}
  }
}
```

The response is `{ "hr": 0, "outs": { "cdpResult": { ... } } }` when the
sidecar host successfully forwards to CDP. A CDP protocol failure is data in
`outs.cdpError`; JSON-RPC `error` is still reserved for the sidecar transport
itself. The dialect and exact pass-through envelope remain open questions.

### HRESULT discipline

| Name | Value | Use |
|---|---:|---|
| `S_OK` / `Success` | `0` | Operation succeeded (`src/coreclr/debug/wasm-dbi-dac/dbi_dac_wasm.cpp:105-108`). |
| `InvalidArgument` | `-1` | Parameter violation (`src/coreclr/debug/wasm-dbi-dac/README.md:241-245`). |
| `HostReadFailed` | `-2` | `read_target_memory` returned non-zero (`src/coreclr/debug/wasm-dbi-dac/README.md:245`). |
| `HostSymbolLookupFailed` | `-3` | Symbol import failed (`src/coreclr/debug/wasm-dbi-dac/README.md:246`). |
| `InvalidContractDescriptor` | `-4` | Descriptor bytes did not parse (`src/coreclr/debug/wasm-dbi-dac/README.md:247`). |
| `InvalidPointerDataIndex` | `-5` | cDAC pointer-data index out of range (`src/coreclr/debug/wasm-dbi-dac/README.md:248`). |
| `InvalidTestData` | `-6` | Test-data magic mismatch (`src/coreclr/debug/wasm-dbi-dac/README.md:249`). |
| `BufferTooSmall` | `-7` | Output buffer too small (`src/coreclr/debug/wasm-dbi-dac/README.md:250`). |
| `InvalidReadRange` | `-8` | Read range overflow or too large (`src/coreclr/debug/wasm-dbi-dac/README.md:251`). |
| `InvalidSymbolName` | `-9` | Empty/too-long/out-of-range symbol name (`src/coreclr/debug/wasm-dbi-dac/README.md:252`). |
| `HrIncompatibleProtocol` | `0x8013134B` | ABI/protocol gate failure (`src/coreclr/debug/wasm-dbi-dac/README.md:253`). |
| `E_NOTIMPL` | `0x80004001` | Stubbed cDAC/DBI path (`src/coreclr/debug/wasm-dbi-dac/README.md:254`). |

### Idempotency summary

Idempotent: `lifecycle.ping`, `lifecycle.info`, `lifecycle.stats`,
`lifecycle.shutdown`, `target.tryGetSymbol`, `target.copyFrom`,
`dac.runSweep`, `dac.thread.*`, `dac.stackwalk.getFrame`,
`dac.stackwalk.close`, `dac.cache.flush`, `dac.page.reset`,
`dac.interpreter.walkFrames`, `dbi.session.list`, `dbi.session.close`,
`dbi.process.enumerateThreads`, `dbi.process.enumerateAppDomains`,
`dbi.breakpoint.list`, and repeated `dbi.breakpoint.set` for the same logical
breakpoint key.

One-shot or draining: `dbi.process.continue`, `dbi.step.*`,
`dbi.callbacks.poll`, `dbi.ipc.poll`, `dbi.receiveRuntimeEvent`, and raw CDP
methods whose underlying CDP method is one-shot. `dbi.process.continue` is
one-shot per stopped state because it resumes execution and increments the
memory epoch; the sidecar already invalidates the page cache on continue
(`src/coreclr/debug/wasm-dbi-dac/dbi_dac_wasm.cpp:1658-1662`).

## Two-channel transport split

Phase 4 should use two host-to-debug-adapter channels.

### High-rate binary channel

The high-rate channel carries `ReadVirtual` / `read_target_memory` and future
bulk memory operations. It uses one binary frame per call:

- request: `{ requestId, targetAddress, byteCount }` in a fixed binary header;
- response: `{ requestId, hr, bytesRead }` followed by raw bytes;
- notification: `{ epoch }` can be represented as a short binary control frame
  or mirrored on the JSON channel as `target.memoryInvalidated`.

Justification: current DAC reads are small and clustered, and the source says
without a cache every read crosses the JS bridge, which dominates wall-clock
cost (`src/coreclr/debug/wasm-dbi-dac/dbi_dac_wasm.cpp:298-302`). The plan says
the sibling PoC measured about 100 reads per probe sweep and 9-15x wire
reduction from the LRU cache (`product-ready-mscordbi-dac-sidecar-plan.md:641-647`).
The sibling lessons also report 91-94% cache hit rate with zero steady-state
evictions (`product-ready-mscordbi-dac-sidecar-plan.md:93-98`).

### Low-rate JSON text channel

The JSON text channel carries `lifecycle.*`, `target.*` control calls,
`dac.*`, `dbi.*`, and `cdp.*`. It is optimized for debuggability, explicit
HRESULTs, and Cordb-shaped method names rather than bulk throughput. The
Phase 4 plan names the same method families
(`product-ready-mscordbi-dac-sidecar-plan.md:627-640`).

### Channel multiplexing

Use separate WebSocket connections: one binary, one text. The Phase 4 plan
already calls for separate WebSocket connections and one frame per protocol
message (`product-ready-mscordbi-dac-sidecar-plan.md:641-647`). A single
multiplexed connection would risk head-of-line blocking: one large memory read
or a slow binary response could delay `continue`, `shutdown`, or
`target.memoryInvalidated` control traffic.

### Host-import mapping

The sidecar runtime endpoint does not speak JSON-RPC. The JSON-RPC server is a
host/debug-adapter surface. Internally, sidecar `read_target_memory` is the
mirror of the high-rate binary channel: the sidecar import asks the host for
runtime memory (`src/coreclr/debug/wasm-dbi-dac/dbi_dac_wasm.cpp:758-759`), and
the host satisfies that request from the binary channel when it is remote. The
runtime-side endpoint continues to receive serialized IPC bytes through
`CoreClrWasmDebugReceiveCommand*`, not JSON (`src/coreclr/vm/wasm/dactable.cpp:297-358`).

## Connection-state gate

The runtime must not arm breakpoints or fire `to_pause` events before the IDE
has completed its attach handshake. The plan calls this out directly because
`debugger;` is a no-op when no debugger is attached
(`product-ready-mscordbi-dac-sidecar-plan.md:838-846`). It also lists this as a
near-term action: expose a runtime export that the host calls after the CDP
handshake and gate breakpoint arming / `to_pause` events on that flag
(`product-ready-mscordbi-dac-sidecar-plan.md:1288-1293`).

Mono parity is `mono_wasm_set_is_debugger_attached`. The export declaration is
at `src/mono/mono/component/mini-wasm-debugger.c:35-41`, and the implementation
calls `mono_set_is_debugger_attached(is_attached)`
(`src/mono/mono/component/mini-wasm-debugger.c:357-373`).

Recommendation:

- Runtime export: `CoreClrWasmDebugSetDebuggerAttached(int32_t isAttached)`.
- JSON-RPC driver: `lifecycle.attach`, not `dbi.session.create`.
- Sidecar gate: reject `dbi.breakpoint.*`, `dbi.step.*`, `dbi.process.continue`,
  `dbi.process.stop`, `dbi.process.asyncBreak`, and runtime-event delivery until
  `lifecycle.attach` succeeds.
- Teardown: `lifecycle.shutdown` and `dbi.session.close` call the runtime export
  with `0` before tearing down local session state.

Rationale: `dbi.session.create` is DBI object/session construction, while the
attach gate is IDE/proxy lifecycle state. Keeping the gate in `lifecycle.attach`
lets the host complete CDP first, then arm runtime-side debug behavior, then
create or reuse DBI state. This also allows a future non-CDP front end to drive
the same runtime export without pretending to create a new DBI process.

Pre-gate `dbi.*` calls should be successful JSON-RPC responses with a documented
`result.hr`, not JSON-RPC `error`. Until a named HRESULT is added, use the
current disconnected sentinel (`E_FAIL`) plus `outs.state = "notAttached"`.
Sidecar ABI protocol mismatch remains `HrIncompatibleProtocol`.

## Migration ladder

1. Gate Phase 3 by adding the serialized `DebuggerIPCEvent` helper for
   `DB_IPCE_BREAKPOINT`. Route the existing breakpoint smoke through it while
   keeping the old record path in TESTS_ONLY exports.
2. Add the IDE-facing JSON-RPC server skeleton in the host process only. Do not
   modify the sidecar for this step. Implement `lifecycle.ping`,
   `lifecycle.info`, `lifecycle.stats`, `lifecycle.shutdown`,
   `target.tryGetSymbol`, and `target.copyFrom`.
3. Add `dbi.session.create` and `dbi.callbacks.poll`. Prove the HelloWorld
   breakpoint smoke through JSON-RPC while the internal side still uses the
   serialized breakpoint event.
4. Add the connection-state gate. Add a negative test proving no breakpoint or
   `to_pause` event arrives before `lifecycle.attach` completes.
5. Migrate remaining MVP event types one at a time: `DB_IPCE_LOAD_MODULE`,
   `DB_IPCE_UNLOAD_MODULE`, `DB_IPCE_THREAD_ATTACH`, `DB_IPCE_THREAD_DETACH`,
   `DB_IPCE_EXCEPTION`, `DB_IPCE_STEP_RESULT`, `DB_IPCE_STEP_COMPLETE`,
   `DB_IPCE_BREAKPOINT_ADD_RESULT`, `DB_IPCE_BREAKPOINT_REMOVE_RESULT`,
   `DB_IPCE_USER_BREAKPOINT`, and `DB_IPCE_CONTINUE`.
6. Deprecate prototype records from the product ABI. Keep them only in the
   tests sidecar. The product ABI change must be represented by exactly one
   Phase 4 bump to `WasmDbiDacProtocolBreakingChangeCounter`.

## Acceptance gates

Phase 4 closes only when all gates pass:

- A real serialized `DebuggerIPCEvent` envelope carries the breakpoint
  round-trip end to end.
- The JSON-RPC vocabulary above is published, and all `dac.*` / `dbi.*`
  methods enforce `{ "hr": <int32>, "outs": { ... } }`.
- The connection-state gate is enforced: pre-`lifecycle.attach` `dbi.*` calls
  return documented `result.hr` / `outs.state` failures, not plumbing errors.
- The two-channel split is implemented: binary channel carries `ReadVirtual`,
  JSON channel carries lifecycle/target/control/DAC/DBI/CDP calls.
- Existing smokes `coreclr_dbi_dac_wasm_smoke` and
  `coreclr_dbi_dac_wasm_hello_breakpoint_smoke` continue to pass
  (`src/coreclr/debug/wasm-dbi-dac/CMakeLists.txt:71-80`).
- `WasmDbiDacProtocolBreakingChangeCounter` is bumped exactly once across the
  Phase 4 work, covering the serialized IPC surface and prototype-record
  product deprecation.

## Open questions

- Which JSON-RPC dialect is final: vanilla JSON-RPC 2.0, a CDP-shaped envelope,
  or a DAP-shaped envelope? This document defines method names and payloads, not
  the dialect choice.
- Should the high-rate binary channel use WebSocket binary frames or browser
  `postMessage` with `Transferable` buffers when the proxy is co-located with
  the page?
- How should server-pushed events work on the text channel: JSON-RPC
  notifications, long-poll (`dbi.callbacks.poll`), SSE, or a dedicated event
  WebSocket?
- Should breakpoint-hit events travel only as serialized `DebuggerIPCEvent` on
  the internal/binary path, or should the IDE also receive a JSON notification
  for low-latency UI updates?
- What named HRESULT or sidecar `Result` should replace today's `E_FAIL` for
  the external "not attached" / "not connected" state?
- When `MaxTransportMessageBytes` grows beyond 256, what is the target upper
  bound for a single serialized IPC event on browser-wasm?
- How much of desktop `DbgTransportSession` resend/ack semantics should be
  preserved once the browser host owns reliable WebSocket delivery?

## References

| Topic | Citation |
|---|---|
| Phase 4 work and JSON vocabulary | `product-ready-mscordbi-dac-sidecar-plan.md:602-690` |
| Cross-cutting JSON/HRESULT rule | `product-ready-mscordbi-dac-sidecar-plan.md:265-274` |
| Sibling PoC cache results | `product-ready-mscordbi-dac-sidecar-plan.md:93-98` |
| Phase 2 page-cache plan | `product-ready-mscordbi-dac-sidecar-plan.md:467-479` |
| Phase 6 / Phase 13 trigger scope | `product-ready-mscordbi-dac-sidecar-plan.md:752-774` |
| Attach-state gate plan | `product-ready-mscordbi-dac-sidecar-plan.md:838-846`, `product-ready-mscordbi-dac-sidecar-plan.md:1288-1293` |
| MVP async-pause exclusion | `product-ready-mscordbi-dac-sidecar-plan.md:1189-1195` |
| Style baseline and current prototype summary | `debug-dac-wasm-coreclr.md:43-66` |
| Sidecar host imports and error table | `src/coreclr/debug/wasm-dbi-dac/README.md:52-64`, `src/coreclr/debug/wasm-dbi-dac/README.md:232-254` |
| Host-bridge wire-change rule | `src/coreclr/debug/wasm-dbi-dac/README.md:12-18` |
| Protocol sequencing and smokes | `src/coreclr/debug/wasm-dbi-dac/README.md:272-296` |
| Sidecar constants and protocol counter | `src/coreclr/debug/wasm-dbi-dac/dbi_dac_wasm.cpp:40-70` |
| Sidecar result enum | `src/coreclr/debug/wasm-dbi-dac/dbi_dac_wasm.cpp:105-117` |
| Prototype record layouts | `src/coreclr/debug/wasm-dbi-dac/dbi_dac_wasm.cpp:242-295` |
| Page cache implementation | `src/coreclr/debug/wasm-dbi-dac/dbi_dac_wasm.cpp:298-389`, `src/coreclr/debug/wasm-dbi-dac/dbi_dac_wasm.cpp:823-887` |
| Page cache invalidation and stats exports | `src/coreclr/debug/wasm-dbi-dac/dbi_dac_wasm.cpp:1154-1194` |
| Sidecar host import declarations | `src/coreclr/debug/wasm-dbi-dac/dbi_dac_wasm.cpp:758-768` |
| Sidecar send path and handshake | `src/coreclr/debug/wasm-dbi-dac/dbi_dac_wasm.cpp:955-974`, `src/coreclr/debug/wasm-dbi-dac/dbi_dac_wasm.cpp:1048-1126` |
| Sidecar session/breakpoint/continue/poll exports | `src/coreclr/debug/wasm-dbi-dac/dbi_dac_wasm.cpp:1466-1770`, `src/coreclr/debug/wasm-dbi-dac/dbi_dac_wasm.cpp:1795-1891` |
| Sidecar smoke targets | `src/coreclr/debug/wasm-dbi-dac/CMakeLists.txt:62-80` |
| Smoke host command routing | `src/coreclr/debug/wasm-dbi-dac/smoke-test.js:296-326`, `src/coreclr/debug/wasm-dbi-dac/hello-breakpoint-smoke.js:430-455` |
| HelloWorld event forwarding and validation | `src/coreclr/debug/wasm-dbi-dac/hello-breakpoint-smoke.js:495-553`, `src/coreclr/debug/wasm-dbi-dac/hello-breakpoint-smoke.js:600-638` |
| Runtime prototype record mirrors and exports | `src/coreclr/vm/wasm/dactable.cpp:28-78`, `src/coreclr/vm/wasm/dactable.cpp:297-358` |
| Runtime breakpoint callback path | `src/coreclr/vm/wasm/dactable.cpp:456-500` |
| Corerun breakpoint JS import | `src/coreclr/hosts/corerun/wasm/libCorerun.js:37-43` |
| cDAC descriptor export generation | `src/coreclr/vm/datadescriptor/CMakeLists.txt:15-19` |
| cDAC little-endian/32-bit flags | `src/coreclr/debug/datadescriptor-shared/datadescriptor.cpp:312-345` |
| Debug EE WASM guard | `src/coreclr/debug/ee/CMakeLists.txt:72-75` |
| `DebuggerIPCEvent` layout | `src/coreclr/debug/inc/dbgipcevents.h:109-113`, `src/coreclr/debug/inc/dbgipcevents.h:1697-1716`, `src/coreclr/debug/inc/dbgipcevents.h:1716-1815`, `src/coreclr/debug/inc/dbgipcevents.h:1878-1883`, `src/coreclr/debug/inc/dbgipcevents.h:2092-2100` |
| IPC event enum generation and values | `src/coreclr/debug/inc/dbgipcevents.h:865-880`, `src/coreclr/debug/inc/dbgipceventtypes.h:22-107` |
| Thread attach/detach desktop mapping | `src/coreclr/debug/di/process.cpp:4935-4955`, `src/coreclr/debug/ee/debugger.cpp:8869-8875`, `src/coreclr/debug/ee/debugger.cpp:8937-8947` |
| Transport message header and channel | `src/coreclr/debug/inc/dbgtransportsession.h:32-39`, `src/coreclr/debug/inc/dbgtransportsession.h:323-340`, `src/coreclr/debug/inc/dbgtransportsession.h:493-547` |
| Transport send/receive event flow | `src/coreclr/debug/shared/dbgtransportsession.cpp:326-387`, `src/coreclr/debug/shared/dbgtransportsession.cpp:556-690`, `src/coreclr/debug/shared/dbgtransportsession.cpp:1782-1872`, `src/coreclr/debug/shared/dbgtransportsession.cpp:2112-2411` |
| DBI transport manager | `src/coreclr/debug/di/dbgtransportmanager.cpp:74-99`, `src/coreclr/debug/di/dbgtransportmanager.cpp:102-177`, `src/coreclr/debug/di/dbgtransportmanager.cpp:211-250` |
| Mono attach-state export | `src/mono/mono/component/mini-wasm-debugger.c:35-41`, `src/mono/mono/component/mini-wasm-debugger.c:357-373` |
