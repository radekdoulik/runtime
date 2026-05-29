# WASM CordbProcess connect design

## Purpose and scope

This design describes Phase 3 of the WASM DBI/DAC sidecar work: replacing facade-only process state with a real
`CordbProcess` created through the V3 `OpenVirtualProcessImpl` attach path.

The design is anchored on the exported V3 entry point `OpenVirtualProcessImpl`, whose signature accepts
`clrInstanceId`, a data target, an optional DAC module handle, debugger-version bounds, the result interface
IID, and attach flags (`src/coreclr/debug/di/process.cpp:61-68`).

The V3 entry point rejects null data targets, zero `clrInstanceId`, missing version input, and a call that
requests neither flags nor a process instance (`src/coreclr/debug/di/process.cpp:76-81`).

The V3 path deliberately avoids the V2 shim process and Win32 event-thread model: the source comment says there
is no `ShimProcess`, no `w32et`, and that stop state is controlled externally
(`src/coreclr/debug/di/process.cpp:94-100`).

The Phase 3 attach call should therefore model:

```cpp
OpenVirtualProcessImpl(
    clrInstanceId,
    pDataTarget,
    hDacModule,
    &maxDebuggerSupportedVersion,
    riid,
    &process,
    &flags);
```

For the WASM sidecar, `clrInstanceId` is the target address that identifies the runtime instance. The
productization plan names that value `g_wasmDebugContractDescriptorAddress`. On this branch, the checked-in WASM
runtime source does not yet contain that symbol; the current runtime path exposes the generated cDAC contract
through `DotNetRuntimeContractDescriptor` and the smoke host resolves it with
`GetDotNetRuntimeContractDescriptor` (`src/coreclr/vm/datadescriptor/CMakeLists.txt:15-19`,
`src/coreclr/debug/wasm-dbi-dac/smoke-test.js:203-205`, `src/coreclr/debug/wasm-dbi-dac/smoke-test.js:276-280`).

This design covers:

- The exact desktop DBI call chain that Phase 3 must reuse.
- Static DAC binding in a single WASM sidecar module.
- Platform reporting and the `CorDebugPlatform` audit.
- The data-target `QueryInterface` sequence and what it means for WASM.
- PAL event creation during `CordbProcess::Init`.
- The event-pump replacement shape for a browser-WASM host.
- The helper-thread audit relevant to sidecar-side DBI code.
- A `TESTS_ONLY` probe ladder that validates each gap before product
exports change.

This design does not cover:

- Phase 4 transport productization beyond the minimum queue/callback shape
needed by `CordbProcess` lifecycle.
- Phase 5 target-side debug EE implementation.
- Phase 6 stop trigger mechanics, breakpoint lowering, stepping, or source
mapping.
- A public frontend protocol, CDP/DAP mapping, or IDE UX.
- API review mechanics for any public `CorDebugPlatform` addition.

Phase 3 must preserve the sidecar host-bridge invariants that already exist: sidecar and runtime memories are
distinct wasm32 linear memories (`src/coreclr/debug/wasm-dbi-dac/README.md:19-33`), all target memory reads
cross the host import instead of bulk-copying the runtime memory
(`src/coreclr/debug/wasm-dbi-dac/README.md:65-83`), and connect/disconnect invalidate the page cache
(`src/coreclr/debug/wasm-dbi-dac/dbi_dac_wasm.cpp:313-321`,
`src/coreclr/debug/wasm-dbi-dac/dbi_dac_wasm.cpp:1534-1559`,
`src/coreclr/debug/wasm-dbi-dac/dbi_dac_wasm.cpp:1562-1577`).

## Current state inventory

### Sidecar module shape

The sidecar build is included for wasm targets by the top-level CoreCLR CMake when `CLR_CMAKE_TARGET_ARCH_WASM`
is true (`src/coreclr/CMakeLists.txt:372-374`).

The sidecar target links `cordbdi`, `cee_dac`, `daccess`, metadata DBI/DAC libraries, `coreclrpal`, and
`coreclrpal_dac` into one executable module (`src/coreclr/debug/wasm-dbi-dac/CMakeLists.txt:7-28`,
`src/coreclr/debug/wasm-dbi-dac/CMakeLists.txt:49-59`).

The product and test variants share the same translation units; tests add `WASM_DBI_DAC_BUILD_TESTS=1` and
expose probe exports (`src/coreclr/debug/wasm-dbi-dac/CMakeLists.txt:62-67`).

The two existing smoke targets are `coreclr_dbi_dac_wasm_smoke` and
`coreclr_dbi_dac_wasm_hello_breakpoint_smoke` (`src/coreclr/debug/wasm-dbi-dac/CMakeLists.txt:69-82`).

The host import surface is currently four calls: `read_target_memory`, `get_symbol_address`,
`get_target_module_base`, and `send_ipc_to_runtime` (`src/coreclr/debug/wasm-dbi-dac/README.md:52-64`).

The product export surface already includes session creation, runtime connect/disconnect, breakpoint commands,
continue, event polling, runtime event receive calls, and page-cache invalidation
(`src/coreclr/debug/wasm-dbi-dac/README.md:165-187`).

### `WasmDacDataTarget` interface inventory

`WasmDacDataTarget` inherits exactly three COM interfaces today: `ICLRDataTarget`, `ICLRRuntimeLocator`, and
`ICorDebugDataTarget` (`src/coreclr/debug/wasm-dbi-dac/dbi_dac_wasm.cpp:449-453`).

Its `QueryInterface` succeeds for `IUnknown`/`ICLRDataTarget`, `ICLRRuntimeLocator`, and `ICorDebugDataTarget`
(`src/coreclr/debug/wasm-dbi-dac/dbi_dac_wasm.cpp:461-480`).

Its `QueryInterface` returns `E_NOINTERFACE` for every other IID
(`src/coreclr/debug/wasm-dbi-dac/dbi_dac_wasm.cpp:482-485`).

Therefore it does not currently implement `ICorDebugMutableDataTarget`. It also does not implement
`ICorDebugMetaDataLocator`. That matches the README inventory, which says Phase 3 owns filling out mutable
data-target support (`src/coreclr/debug/wasm-dbi-dac/README.md:256-270`).

The class has an `ICLRDataTarget::WriteVirtual` implementation, but that is not the `ICorDebugMutableDataTarget`
contract; the current implementation sets `bytesWritten` to zero and returns `E_NOTIMPL`
(`src/coreclr/debug/wasm-dbi-dac/dbi_dac_wasm.cpp:554-566`).

The data target reports `IMAGE_FILE_MACHINE_UNKNOWN` from `GetMachineType` and reports pointer size with
`sizeof(void*)` (`src/coreclr/debug/wasm-dbi-dac/dbi_dac_wasm.cpp:507-527`).

`ReadVirtual` delegates to the sidecar `ReadTargetMemory` helper
(`src/coreclr/debug/wasm-dbi-dac/dbi_dac_wasm.cpp:545-552`).

`ReadTargetMemory` validates wasm32 source and destination ranges, then uses a 4 KiB page cache or falls back to
`read_target_memory` (`src/coreclr/debug/wasm-dbi-dac/dbi_dac_wasm.cpp:787-887`).

`GetRuntimeBase` returns the runtime base captured by the sidecar and fails when that base is zero
(`src/coreclr/debug/wasm-dbi-dac/dbi_dac_wasm.cpp:619-627`).

`GetPlatform` returns the synthetic sentinel `0x77415331` rather than a published `CorDebugPlatform` value
(`src/coreclr/debug/wasm-dbi-dac/dbi_dac_wasm.cpp:72-87`,
`src/coreclr/debug/wasm-dbi-dac/dbi_dac_wasm.cpp:630-660`).

### Existing DAC/DBI probes

`coreclr_wasm_dbi_dac_create_dac_dbi_interface` is already a test-only probe. It validates a non-zero runtime
base, creates `WasmDacDataTarget`, instantiates allocator and metadata lookup facades, calls
`DacDbiInterfaceInstance`, releases the data target, and releases the DAC interface on success
(`src/coreclr/debug/wasm-dbi-dac/dbi_dac_wasm.cpp:1392-1418`).

`coreclr_wasm_dbi_dac_probe_dac_consistency_checks` is already a test-only Phase 3 onramp probe. It creates
`IDacDbiInterface`, invokes `DacSetTargetConsistencyChecks(FALSE)`, writes that HRESULT to the caller's
sidecar-memory address, and returns the create result
(`src/coreclr/debug/wasm-dbi-dac/dbi_dac_wasm.cpp:1420-1464`).

That probe guards the desktop attach call site where `CordbProcess::CreateDacDbiInterface` calls
`DacSetTargetConsistencyChecks` immediately after binding the DAC (`src/coreclr/debug/di/process.cpp:699-700`).
Commit `e0146aa64b4` is the traceability marker for that onramp landing.

The sidecar also exposes protocol and version probes. The version blob has fixed size 32 bytes and carries
magic, ABI version, protocol breaking counter, component mask, sidecar build version words, and reserved space
(`src/coreclr/debug/wasm-dbi-dac/dbi_dac_wasm.cpp:217-232`,
`src/coreclr/debug/wasm-dbi-dac/dbi_dac_wasm.cpp:1026-1066`).

### Runtime-side descriptor state

The generated runtime contract descriptor is named `DotNetRuntimeContractDescriptor` by the CoreCLR
data-descriptor CMake rule (`src/coreclr/vm/datadescriptor/CMakeLists.txt:15-19`).

The current WASM runtime debug file defines `g_dacTable` and the PoC debug state globals, but it does not define
a checked-in symbol named `g_wasmDebugContractDescriptorAddress` (`src/coreclr/vm/wasm/dactable.cpp:13-15`,
`src/coreclr/vm/wasm/dactable.cpp:80-104`).

The WASM debug file exposes `GetWasmDbiDacTestData` and command receive entry points, not a descriptor-address
export with the plan's name (`src/coreclr/vm/wasm/dactable.cpp:292-320`).

The smoke host already requires `GetDotNetRuntimeContractDescriptor`, maps the symbol name
`DotNetRuntimeContractDescriptor` to that function, and uses the resulting address for a direct target-memory
copy smoke (`src/coreclr/debug/wasm-dbi-dac/smoke-test.js:203-205`,
`src/coreclr/debug/wasm-dbi-dac/smoke-test.js:276-280`, `src/coreclr/debug/wasm-dbi-dac/smoke-test.js:473-474`).

Phase 3 should treat the address of `DotNetRuntimeContractDescriptor` as the semantic value intended by
`g_wasmDebugContractDescriptorAddress`, but implementation must either add the named runtime-side address export
or record why the existing `GetDotNetRuntimeContractDescriptor` export is the stable source of the V3
`clrInstanceId`.

## Target connect call chain

### Entry point

`OpenVirtualProcessImpl` is the real V3 entry surface used by dbgshim to obtain an `ICorDebugProcess4` instance
(`src/coreclr/debug/di/process.cpp:39-51`, `src/coreclr/debug/di/process.cpp:61-68`).

The entry point creates an uninitialized `ProcessDescriptor`, then calls `CordbProcess::OpenVirtualProcess` with
the supplied `clrInstanceId`, data target, DAC module handle, null `Cordb`, null shim, and the descriptor
(`src/coreclr/debug/di/process.cpp:94-108`).

After process creation, it optionally obtains attach-state flags, checks the maximum debugger-supported major
version, queries the requested process interface, neuters the process on failure/no returned instance, and
returns the HRESULT (`src/coreclr/debug/di/process.cpp:114-153`).

Deprecated V1/V2 wrappers still exist, but `OpenVirtualProcessImpl2` simply normalizes `NULL` version input and
delegates to `OpenVirtualProcessImpl` (`src/coreclr/debug/di/process.cpp:158-190`), while the old public
`OpenVirtualProcess` wrapper passes a null DAC module (`src/coreclr/debug/di/process.cpp:194-223`).

Phase 3 should call `OpenVirtualProcessImpl` directly, not `Cordb::CreateProcess` and not the deprecated
wrappers.

### Process creation and initial QI

`CordbProcess::OpenVirtualProcess` receives the same `clrInstanceId`, data target, DAC module handle, optional
`Cordb`, descriptor, shim, and process out parameter (`src/coreclr/debug/di/process.cpp:788-795`).

In debug builds it first queries the incoming `IUnknown` for `IID_ICorDebugDataTarget` and asserts that the QI
succeeds (`src/coreclr/debug/di/process.cpp:799-807`).

It asserts that V3 has both `pCordb == NULL` and `pShim == NULL`, and that a real V3 path has a non-zero
`clrInstanceId` (`src/coreclr/debug/di/process.cpp:810-817`).

It allocates `CordbProcess`, calls `Init`, externally addrefs the process on success, and performs half-baked
cleanup on failure (`src/coreclr/debug/di/process.cpp:820-864`).

The `CordbProcess` constructor stores `m_clrInstanceId` from the constructor argument and stores the DAC module
handle in `m_hDacModule` (`src/coreclr/debug/di/process.cpp:885-956`).

The constructor then queries the data target for `IID_ICorDebugDataTarget` and fails construction if that QI
fails (`src/coreclr/debug/di/process.cpp:963-967`).

### Init and data-target optional interfaces

`CordbProcess::Init` initializes process locks before data-target optional interface probing
(`src/coreclr/debug/di/process.cpp:1612-1625`).

It then queries `m_pDACDataTarget` for `IID_ICorDebugMutableDataTarget`
(`src/coreclr/debug/di/process.cpp:1635-1639`).

If that QI fails, `Init` does not fail attach. It installs a `ReadOnlyDataTargetFacade` and comments that
mutation-required requests will fail later (`src/coreclr/debug/di/process.cpp:1639-1643`).

`ReadOnlyDataTargetFacade` itself QIs for `ICorDebugMutableDataTarget`, but its mutation methods return
`CORDBG_E_TARGET_READONLY` (`src/coreclr/debug/inc/readonlydatatargetfacade.inl:28-55`,
`src/coreclr/debug/inc/readonlydatatargetfacade.inl:115-145`).

`Init` then queries for `IID_ICorDebugMetaDataLocator` (`src/coreclr/debug/di/process.cpp:1645-1647`).

The metadata-locator QI HRESULT is overwritten by the subsequent `CreateMetaDataDispenser` call, so
`E_NOINTERFACE` from the data target is tolerated (`src/coreclr/debug/di/process.cpp:1645-1654`).

`CreateMetaDataDispenser` is expected to succeed because the dispenser is statically linked
(`src/coreclr/debug/di/process.cpp:1648-1656`).

`Init` sets the metadata thread-safety option on the dispenser on a best-effort path
(`src/coreclr/debug/di/process.cpp:1658-1664`).

### PAL events created during Init

The plan mentions three PAL events. The current branch creates exactly three unconditional events in
`CordbProcess::Init`: `m_leftSideEventAvailable`, `m_leftSideEventRead`, and `m_stopWaitEvent`
(`src/coreclr/debug/di/process.cpp:1671-1695`).

A fourth event, `m_detachSetThreadContextNeededEvent`, is created only when `OUT_OF_PROCESS_SETTHREADCONTEXT` is
defined (`src/coreclr/debug/di/process.cpp:1697-1703`).

The PAL implementation of `CreateEventW` forwards to `InternalCreateEvent`
(`src/coreclr/pal/src/synchobj/event.cpp:74-100`).

`InternalCreateEvent` rejects named events and allocates either a manual or auto-reset event object through the
PAL object manager (`src/coreclr/pal/src/synchobj/event.cpp:162-203`).

`coreclrpal` includes `synchobj/event.cpp` in its source list (`src/coreclr/pal/src/CMakeLists.txt:150-210`).

The sidecar links `coreclrpal` and `coreclrpal_dac`, but `coreclrpal_dac` only adds remote-unwind objects on the
non-Apple path (`src/coreclr/debug/wasm-dbi-dac/CMakeLists.txt:7-28`,
`src/coreclr/pal/src/CMakeLists.txt:234-257`).

Therefore the event implementation available to browser-WASM sidecar code comes from `coreclrpal`, not from
`coreclrpal_dac` alone.

### DAC initialization and static binding point

After events and metadata setup, `Init` calls `TryInitializeDac` (`src/coreclr/debug/di/process.cpp:1737-1745`).

`TryInitializeDac` first calls `EnsureClrInstanceIdSet`; if that fails, the DAC is not initialized
(`src/coreclr/debug/di/process.cpp:1448-1465`).

With a non-zero instance ID, `TryInitializeDac` calls `InitializeDac` and returns `TRUE`
(`src/coreclr/debug/di/process.cpp:1467-1473`).

`InitializeDac` calls `CreateDacDbiInterface` only when `m_pDacPrimitives` is null, then flushes the DAC
(`src/coreclr/debug/di/process.cpp:1494-1517`).

`CreateDacDbiInterface` asserts that `m_pDACDataTarget` is present, that `m_pDacPrimitives` is not
double-initialized, and that `m_clrInstanceId` is non-zero (`src/coreclr/debug/di/process.cpp:650-658`).

If `m_hDacModule` is null, desktop DBI calls `ShimProcess::GetDacModule` using the owning `Cordb` DAC module
path (`src/coreclr/debug/di/process.cpp:662-669`).

That null-handle fallback is not valid for the V3 WASM sidecar because the V3 call passes `pCordb == NULL`;
Phase 3 must ensure the static binding path is selected before dereferencing `m_cordb`.

The desktop binding point declares a function-pointer type matching
`DacDbiInterfaceInstance(ICorDebugDataTarget*, CORDB_ADDRESS, IDacDbiInterface::IAllocator*,
IDacDbiInterface::IMetaDataLookup*, IDacDbiInterface**)` (`src/coreclr/debug/di/process.cpp:675-684`).

Desktop DBI resolves that entry with `GetProcAddress(m_hDacModule, "DacDbiInterfaceInstance")`
(`src/coreclr/debug/di/process.cpp:686-691`).

It calls the resolved entry with the DBI data target, `m_clrInstanceId`, allocator, metadata lookup, and out
interface pointer (`src/coreclr/debug/di/process.cpp:693-697`).

It then immediately calls `DacSetTargetConsistencyChecks` on the created interface
(`src/coreclr/debug/di/process.cpp:699-700`).

`DacDbiInterfaceInstance` is exported by the DAC implementation and has the same signature in the DAC header and
implementation (`src/coreclr/debug/daccess/dacdbiimpl.h:22-29`,
`src/coreclr/debug/daccess/dacdbiimpl.cpp:286-315`).

The sidecar facade already declares the same symbol and calls it directly from the existing test probes
(`src/coreclr/debug/wasm-dbi-dac/dbi_dac_wasm.cpp:774-780`,
`src/coreclr/debug/wasm-dbi-dac/dbi_dac_wasm.cpp:1406-1410`,
`src/coreclr/debug/wasm-dbi-dac/dbi_dac_wasm.cpp:1448-1458`).

### `clrInstanceId` value

`EnsureClrInstanceIdSet` succeeds immediately if `m_clrInstanceId` is already non-zero
(`src/coreclr/debug/di/process.cpp:9292-9316`).

If `m_clrInstanceId` is zero, V3 is considered invalid: the code comments say V3 clients must pass a non-zero
value, and the failure path returns `E_UNEXPECTED` after asserting a shim path
(`src/coreclr/debug/di/process.cpp:9294-9312`).

Therefore the WASM sidecar must pass the contract-descriptor address as `clrInstanceId` up front. That is the
only value already used to identify the cDAC runtime instance in the current sidecar symbol contract
(`src/coreclr/debug/wasm-dbi-dac/dbi_dac_wasm.cpp:917-952`,
`src/coreclr/debug/wasm-dbi-dac/smoke-test.js:276-280`).

## Sidecar gaps to close

### Static DAC binding

There are two implementation choices.

Option 1 is a `WASM_SIDECAR_INLINE_DAC` guard in `process.cpp`. Under that guard,
`CordbProcess::CreateDacDbiInterface` would skip the null-handle `ShimProcess::GetDacModule` fallback and call
`DacDbiInterfaceInstance` directly.

Option 2 is an in-sidecar shim that gives `GetProcAddress` something to return while still routing to the same
in-module `DacDbiInterfaceInstance`.

The sidecar already links DBI and DAC into one module (`src/coreclr/debug/wasm-dbi-dac/CMakeLists.txt:7-28`).

The sidecar already declares and directly calls `DacDbiInterfaceInstance` from probes
(`src/coreclr/debug/wasm-dbi-dac/dbi_dac_wasm.cpp:774-780`,
`src/coreclr/debug/wasm-dbi-dac/dbi_dac_wasm.cpp:1392-1418`).

A grep of `src/coreclr/debug/di` shows the only `GetProcAddress` use there is the `DacDbiInterfaceInstance`
lookup in `process.cpp` (`src/coreclr/debug/di/process.cpp:687`).

Recommendation: use the inline guard. A shim adds an artificial loader indirection without improving fidelity on
WASM, where there is no separate DAC module to load. The inline guard also avoids the invalid V3 null-handle
fallback through `m_cordb` (`src/coreclr/debug/di/process.cpp:662-669`).

The guard must be narrow: it should only replace the module-load and `GetProcAddress` mechanics. It must
preserve allocator, metadata lookup, `m_clrInstanceId`, version checks reachable through `CheckDbiVersion`, DAC
flush, and `DacSetTargetConsistencyChecks` behavior (`src/coreclr/debug/inc/dacdbiinterface.h:181-230`,
`src/coreclr/debug/di/process.cpp:693-700`).

### Platform reporting

The public `CorDebugPlatform` enum currently ends with `CORDB_PLATFORM_POSIX_RISCV64` in the IDL
(`src/coreclr/inc/cordebug.idl:274-291`).

The generated PAL header assigns explicit arithmetic values and confirms `CORDB_PLATFORM_POSIX_X86` is the value
after POSIX_AMD64, POSIX_ARM64 is after POSIX_ARM, and POSIX_RISCV64 is the current last value
(`src/coreclr/pal/prebuilt/inc/cordebug.h:1479-1495`).

The sidecar must not impersonate `CORDB_PLATFORM_POSIX_X86` or `CORDB_PLATFORM_POSIX_ARM64`. The current
sentinel is intentionally outside the public enum range and spells `wAS1`
(`src/coreclr/debug/wasm-dbi-dac/dbi_dac_wasm.cpp:72-87`).

The product fix should add a real `CORDB_PLATFORM_WASM32` at the next free public slot after
`CORDB_PLATFORM_POSIX_RISCV64`, not at the stale plan-suggested value 12. On the generated header observed here,
the next slot is 14 (`src/coreclr/pal/prebuilt/inc/cordebug.h:1479-1495`).

The platform audit sites under `src/coreclr/debug/` are:

- `DataTargetAdapter::GetPlatform`, which maps PE machine type to
`CorDebugPlatform` and returns `E_NOTIMPL` for unknown machines
(`src/coreclr/debug/daccess/datatargetadapter.cpp:91-164`).
- `ClrDataAccess` platform compatibility, which currently skips its
host-vs-target check under `TARGET_WASM` (`src/coreclr/debug/daccess/daccess.cpp:5114-5158`).
- `ShimLocalDataTarget::GetPlatform`, which is Windows-only and assigns
Windows platform values (`src/coreclr/debug/di/shimlocaldatatarget.cpp:276-294`).
- `ShimRemoteDataTarget::GetPlatform`, which currently returns zero under
`TARGET_WASM` and otherwise maps target architecture macros
(`src/coreclr/debug/di/shimremotedatatarget.cpp:244-280`).
- `ReadOnlyDataTargetFacade::GetPlatform`, which asserts unexpected use
and returns `E_UNEXPECTED` (`src/coreclr/debug/inc/readonlydatatargetfacade.inl:79-87`).
- `WasmDacDataTarget::GetPlatform`, which returns the sidecar sentinel
(`src/coreclr/debug/wasm-dbi-dac/dbi_dac_wasm.cpp:630-660`).

The audit result is that Phase 3 can keep the sentinel internally while probes advance, but product attach
should either add the public enum value or translate the sentinel to a real value before any desktop DBI branch
can compare it.

### `ICorDebugMutableDataTarget` QI

The desktop attach path QIs `IID_ICorDebugMutableDataTarget` during `CordbProcess::Init`
(`src/coreclr/debug/di/process.cpp:1635-1639`).

That QI is optional for attach. If it fails, `Init` creates a `ReadOnlyDataTargetFacade` and continues
(`src/coreclr/debug/di/process.cpp:1639-1643`).

Recommendation for Phase 3: leave `WasmDacDataTarget`'s mutable QI failing until a real memory-write contract is
designed.

That recommendation preserves the true sidecar contract: the sidecar can read runtime memory but must not write
target memory in Phase 3. Calls that require mutation will fail through `ReadOnlyDataTargetFacade` with
`CORDBG_E_TARGET_READONLY` (`src/coreclr/debug/inc/readonlydatatargetfacade.inl:115-145`).

Adding a minimal `ICorDebugMutableDataTarget` that returns `E_NOTIMPL` from write APIs would make QI success
imply a mutability contract the sidecar does not have. If later phases need debugger writes, they should add the
interface with host-mediated write semantics and cache-epoch invalidation.

### `ICorDebugMetaDataLocator` QI

The desktop attach path QIs `IID_ICorDebugMetaDataLocator` (`src/coreclr/debug/di/process.cpp:1645-1647`).

The result is not checked before the metadata dispenser is created; the next statement overwrites `hr` with
`CreateMetaDataDispenser` (`src/coreclr/debug/di/process.cpp:1645-1654`).

Phase 3 may keep returning `E_NOINTERFACE` for `ICorDebugMetaDataLocator`. The design requirement is to verify
that all module metadata paths reached by WASM attach either use the in-memory image or fail with an explicit
metadata-locator gap.

A known adjacent risk is `CordbModule::InitPublicMetaDataFromFile`, which returns `E_FAIL` on `HOST_UNIX` for
file-mapped metadata loading (`src/coreclr/debug/di/module.cpp:751-775`). That is not part of the first
`OpenVirtualProcessImpl` acceptance probe, but it is a follow-up inspection gap.

### PAL event creation

The three unconditional `CreateEvent` calls in `Init` should be allowed to run in the sidecar. They are local
DBI synchronization objects, not target OS handles (`src/coreclr/debug/di/process.cpp:1671-1695`).

Browser-WASM sidecar builds use wasm PAL architecture sources (`src/coreclr/pal/src/CMakeLists.txt:62-64`,
`src/coreclr/pal/src/CMakeLists.txt:127-131`).

`coreclrpal` includes the generic event implementation (`src/coreclr/pal/src/CMakeLists.txt:150-210`).

Phase 3 must validate event creation with a probe because the code path has not historically run inside the
`coreclr-dbi-dac.wasm` product attach path. The probe should create and close the same three events, then
surface the first failing `GetLastError` or `HRESULT`.

The optional `OUT_OF_PROCESS_SETTHREADCONTEXT` event should remain outside Phase 3 unless that macro is enabled
in the sidecar compile.

### Helper-thread audit

An exact grep for `ThisIsHelperThreadWorker` under `src/coreclr/debug/di` and `src/coreclr/debug/shared` finds
no call sites on this branch. The actual `ThisIsHelperThreadWorker` predicate lives under the target-side EE
files, not the sidecar DBI files (`src/coreclr/debug/ee/debugger.h:346`,
`src/coreclr/debug/ee/debugger.cpp:14988-15035`).

The sidecar-relevant DBI helper-thread predicates and fields are instead:

- `CordbThread::IsCantStop`, which treats helper, temporary-helper, and
canary IDs as can't-stop threads. Classification: OK on single-threaded WASM if the synchronous-stop reroute
presents the stopped managed thread without fabricating helper IDs
(`src/coreclr/debug/di/rsthread.cpp:3330-3354`).
- `CordbProcess::ContinueInternal`, which uses `m_helperThreadDead` to skip
unmanaged-thread suspension in interop paths. Classification: already outside MVP if interop debugging stays
disabled for WASM (`src/coreclr/debug/di/process.cpp:4064-4096`).
- `CordbProcess::GetRuntimeOffsets`, which asserts that the runtime should
not ask the right side to create a helper thread and best-effort opens the helper thread handle. Classification:
needs rework if this path is ever reached without a shim; the first V3 attach probe should not require it
(`src/coreclr/debug/di/process.cpp:7315-7352`).
- `CordbProcess::Stop`, which rejects calls from the Win32 event thread,
sends an async-break IPC event, and waits on `m_stopWaitEvent` unless the helper thread is dead. Classification:
needs rework for Phase 6 stop; not a Phase 3 attach acceptance dependency
(`src/coreclr/debug/di/process.cpp:8036-8134`).
- `CordbRCEventThread::SendIPCEvent`, which models a deadlock involving
RCET, left side, helper thread, and `SendIPCEvent`, then optionally waits on the helper-thread handle.
Classification: needs rework as part of the event-pump replacement
(`src/coreclr/debug/di/process.cpp:9434-9665`).
- `CordbProcess::IsHelperThreadWorked`, which checks `m_helperThreadId`,
`m_realHelperThreadId`, and `m_temporaryHelperThreadId`. Classification: OK if no helper-thread IDs are
populated for WASM; needs defensive tests once event records synthesize thread state
(`src/coreclr/debug/di/process.cpp:13675-13700`).
- First- and second-chance unmanaged exception paths special-case helper
thread exceptions. Classification: not in Phase 3 unless native debug events are routed into DBI
(`src/coreclr/debug/di/process.cpp:12261-12303`, `src/coreclr/debug/di/process.cpp:12472-12476`).
- Exit-process/thread handling marks `m_helperThreadDead` when a helper
thread exits. Classification: not in Phase 3 unless native debug events are routed into DBI
(`src/coreclr/debug/di/process.cpp:13103-13110`, `src/coreclr/debug/di/process.cpp:13256-13258`).
- DCB transport marshaling copies helper-thread IDs and the
`m_rightSideShouldCreateHelperThread` flag. Classification: already wasm-stubbed for current sidecar transport
because Phase 3 does not use the desktop DCB transport, but this field set is the shape to replace
(`src/coreclr/debug/shared/dbgtransportsession.cpp:414-440`,
`src/coreclr/debug/shared/dbgtransportsession.cpp:444-481`).

### Event-pump shape

The current sidecar event facade is single-slot state, not a DBI-owned queue. `dbi_poll_event` delegates to
`transport_get_last_event` (`src/coreclr/debug/wasm-dbi-dac/dbi_dac_wasm.cpp:1665-1680`).

`dbi_poll_event_record` copies `g_lastRuntimeEventRecord` into the caller's buffer
(`src/coreclr/debug/wasm-dbi-dac/dbi_dac_wasm.cpp:1682-1710`).

`receive_runtime_event` and `receive_runtime_event_record` overwrite the last text/event-record state
(`src/coreclr/debug/wasm-dbi-dac/dbi_dac_wasm.cpp:1819-1868`).

For Phase 3, replace the helper-thread/event-thread assumption with:

1. A DBI-owned FIFO of runtime events inside the sidecar session.
2. A host callback that pushes one event into that FIFO while the runtime is
stopped in the JS `debugger;` callback, or a host polling call that DBI can invoke synchronously from stopped
state.
3. Event records that carry enough process/module/thread identity for DBI
to update real `CordbProcess` state without consulting a desktop DCB.
4. A deterministic detach path that drains or drops queued events, releases
the real `ICorDebugProcess`, clears `g_cordb`, resets runtime-base state, and invalidates the page cache.
5. No helper-thread wait in browser-WASM; waits must be represented as
host-driven polling or immediate stopped-state callbacks.

This shape preserves the host-bridge rule that `send_ipc_to_runtime` is synchronous today
(`src/coreclr/debug/wasm-dbi-dac/README.md:117-133`) while leaving Phase 4 room to replace the transport record
format.

## Probe ladder

All probes in this section are `WASM_DBI_DAC_EXPORT_TESTS_ONLY`. They are not product ABI.

Existing probes:

| Probe | Signature | Validates |
|---|---|---|
| `coreclr_wasm_dbi_dac_create_dac_dbi_interface` | `int32_t (uint32_t runtimeBase)` | Direct static DAC creation path reaches `DacDbiInterfaceInstance` (`src/coreclr/debug/wasm-dbi-dac/dbi_dac_wasm.cpp:1392-1418`). |
| `coreclr_wasm_dbi_dac_probe_dac_consistency_checks` | `int32_t (uint32_t runtimeBase, uint32_t consistencyHrAddress)` | DAC binding reaches `DacSetTargetConsistencyChecks(FALSE)` and surfaces its HRESULT (`src/coreclr/debug/wasm-dbi-dac/dbi_dac_wasm.cpp:1420-1464`). |

Proposed probes:

| Probe | Signature | Output contract | Gap validated |
|---|---|---|---|
| `coreclr_wasm_dbi_dac_probe_data_target_qi` | `int32_t (uint32_t outFlagsAddress)` | Writes bit flags for `ICLRDataTarget`, `ICLRRuntimeLocator`, `ICorDebugDataTarget`, `ICorDebugMutableDataTarget`, and `ICorDebugMetaDataLocator`; returns `S_OK` if the write succeeds. | Documents the exact QI behavior that `CordbProcess::Init` will see. |
| `coreclr_wasm_dbi_dac_probe_platform_result` | `int32_t (uint32_t outPlatformAddress, uint32_t outHrAddress)` | Writes the raw 32-bit platform value and the HRESULT from `GetPlatform`. | Proves whether attach sees the sentinel or a real `CORDB_PLATFORM_WASM32`. |
| `coreclr_wasm_dbi_dac_probe_clr_instance_id` | `int32_t (uint32_t runtimeBase, uint32_t outClrInstanceIdAddress, uint32_t outHrAddress)` | Resolves the runtime contract descriptor address, writes the value intended for V3 `clrInstanceId`, and writes symbol-resolution HRESULT. | Proves the `EnsureClrInstanceIdSet` input is non-zero and stable. |
| `coreclr_wasm_dbi_dac_probe_static_dac_binding` | `int32_t (uint32_t runtimeBase, uint32_t outCreateHrAddress, uint32_t outConsistencyHrAddress)` | Calls the same inline-DAC helper that `process.cpp` will use, writes create and consistency-check HRESULTs. | Proves the Phase 3 code path no longer depends on `GetProcAddress`. |
| `coreclr_wasm_dbi_dac_probe_create_events` | `int32_t (uint32_t outFlagsAddress, uint32_t outHrAddress)` | Creates the three unconditional `CordbProcess::Init` event shapes, closes them, writes success bits and first failure HRESULT. | Proves the browser-WASM PAL supports the Init event set. |
| `coreclr_wasm_dbi_dac_probe_open_virtual_process` | `int32_t (uint32_t runtimeBase, uint32_t outHrAddress, uint32_t outHasRealCordbProcessAddress)` | Calls `OpenVirtualProcessImpl` against `WasmDacDataTarget`, writes HRESULT and `hasRealCordbProcess` boolean, releases/detaches on success. | Final Phase 3 acceptance probe. |

Probe sequencing:

1. Keep both existing probes green.
2. Add `probe_data_target_qi` before changing `WasmDacDataTarget`.
3. Add `probe_platform_result` before replacing the sentinel.
4. Add `probe_clr_instance_id` before calling `OpenVirtualProcessImpl`.
5. Add `probe_create_events` before enabling real `CordbProcess::Init` in
the sidecar path.
6. Add `probe_static_dac_binding` with the process.cpp inline guard.
7. Add `probe_open_virtual_process` only after the prior probes pass.

## Acceptance gates

Phase 3 is complete only when all gates below pass on the test sidecar:

- `coreclr_wasm_dbi_dac_probe_open_virtual_process` returns success,
writes the `OpenVirtualProcessImpl` HRESULT as `S_OK`, and writes `hasRealCordbProcess=1`.
- `DacSetTargetConsistencyChecks(FALSE)` returns `S_OK`; the onramp probe
added in commit `e0146aa64b4` continues to cover this call
(`src/coreclr/debug/wasm-dbi-dac/dbi_dac_wasm.cpp:1420-1464`, `src/coreclr/debug/di/process.cpp:699-700`).
- `coreclr_dbi_dac_wasm_smoke` still passes
(`src/coreclr/debug/wasm-dbi-dac/CMakeLists.txt:69-76`).
- `coreclr_dbi_dac_wasm_hello_breakpoint_smoke` still passes
(`src/coreclr/debug/wasm-dbi-dac/CMakeLists.txt:77-82`).
- The sidecar process-state record no longer reports
`HasRealCordbProcess = 0` after attach; today that field is hard-coded to zero
(`src/coreclr/debug/wasm-dbi-dac/dbi_dac_wasm.cpp:1742-1777`).
- The DBI process object owns real process/module/thread state rather than
facade-only `g_connectedToRuntime` and `g_syntheticProcessId` fields
(`src/coreclr/debug/wasm-dbi-dac/dbi_dac_wasm.cpp:411-419`,
`src/coreclr/debug/wasm-dbi-dac/dbi_dac_wasm.cpp:1534-1559`).
- `IDacDbiInterface` is attached to the DBI process through
`CordbProcess::CreateDacDbiInterface`, not only through the facade probe
(`src/coreclr/debug/di/process.cpp:650-701`).
- Attach/detach can run repeatedly in one sidecar instance: each cycle
releases the process, calls `ICorDebug::Terminate` or the equivalent real detach path, clears runtime state,
clears queued events, and invalidates the page cache
(`src/coreclr/debug/wasm-dbi-dac/dbi_dac_wasm.cpp:1779-1805`).
- No Phase 3 probe or product path performs a whole runtime linear-memory
copy; all target reads continue through `read_target_memory` (`src/coreclr/debug/wasm-dbi-dac/README.md:65-83`).

## Open questions

- Should product code add a true public `CORDB_PLATFORM_WASM32` enum value
after `CORDB_PLATFORM_POSIX_RISCV64`, or keep the current sentinel behind a sidecar-local mapping until API
review? The IDL currently has no WASM member (`src/coreclr/inc/cordebug.idl:274-291`).
- Should `WasmDacDataTarget` continue returning `E_NOINTERFACE` for
`ICorDebugMutableDataTarget` during Phase 3, or should it implement the interface with write methods returning
`CORDBG_E_TARGET_READONLY`? The desktop connect path tolerates QI failure
(`src/coreclr/debug/di/process.cpp:1635-1643`).
- Does runtime-side `dactable.cpp` need to add an explicit
`g_wasmDebugContractDescriptorAddress` export, or is the existing `GetDotNetRuntimeContractDescriptor` export
the stable source of the descriptor address? The current WASM debug file does not define the named
`g_wasmDebugContractDescriptorAddress` symbol in the ranges read (`src/coreclr/vm/wasm/dactable.cpp:13-15`,
`src/coreclr/vm/wasm/dactable.cpp:292-320`).
- Should Phase 3 expose `OpenVirtualProcessImpl` directly from the sidecar
product ABI, or wrap it in a sidecar-specific probe/product function that owns `CLR_DEBUGGING_VERSION`, `riid`,
process release, and flags? The deprecated wrappers still exist (`src/coreclr/debug/di/process.cpp:158-223`).
- What is the first event payload that should populate real DBI module and
thread state after attach: loader/startup event, synthetic stopped-state snapshot, or target-side debug EE
callback? Current event records only carry method token, IL offset, hit count, continue count, method name, and
message (`src/coreclr/debug/wasm-dbi-dac/dbi_dac_wasm.cpp:251-260`).
- How should metadata lookup work once module inspection runs on WASM? The
metadata-locator QI may fail during attach, but file-backed metadata load returns `E_FAIL` on `HOST_UNIX`
(`src/coreclr/debug/di/process.cpp:1645-1654`, `src/coreclr/debug/di/module.cpp:751-775`).
- Which detach path should own repeated attach/detach lifecycle: direct
`ICorDebugProcess::Detach`, `ICorDebug::Terminate`, or a sidecar session destroy wrapper? Current session
destroy terminates the `ICorDebug` object and clears facade state
(`src/coreclr/debug/wasm-dbi-dac/dbi_dac_wasm.cpp:1779-1805`).

## References

| Area | Citation | Evidence |
|---|---|---|
| V3 entry | `src/coreclr/debug/di/process.cpp:39-51` | `OpenVirtualProcessImpl` purpose and return contract comments. |
| V3 signature | `src/coreclr/debug/di/process.cpp:61-68` | Function signature. |
| V3 argument validation | `src/coreclr/debug/di/process.cpp:76-81` | Rejects null data target, zero instance ID, missing version, missing outputs. |
| V3 model | `src/coreclr/debug/di/process.cpp:94-108` | No shim, no w32et, external stop state, call into `CordbProcess::OpenVirtualProcess`. |
| V3 result handling | `src/coreclr/debug/di/process.cpp:114-153` | Flags, version compatibility, QI, cleanup, return HRESULT. |
| Deprecated wrappers | `src/coreclr/debug/di/process.cpp:158-223` | V2/V1 wrapper surfaces delegate to V3 path. |
| Safe wait context | `src/coreclr/debug/di/process.cpp:244-252` | Waits include helper-thread signaled events. |
| DAC binding | `src/coreclr/debug/di/process.cpp:650-701` | `CreateDacDbiInterface`, `GetProcAddress`, direct call, consistency checks. |
| Process open | `src/coreclr/debug/di/process.cpp:788-864` | Debug QI, V3 asserts, allocation, `Init`, success/failure handling. |
| Constructor QI | `src/coreclr/debug/di/process.cpp:885-996` | Stores instance/DAC handle and QIs `ICorDebugDataTarget`. |
| DAC initialization | `src/coreclr/debug/di/process.cpp:1448-1517` | `TryInitializeDac`, `InitializeDac`, DAC flush. |
| Init optional QIs | `src/coreclr/debug/di/process.cpp:1612-1656` | Mutable QI, metadata locator QI, metadata dispenser creation. |
| Init events | `src/coreclr/debug/di/process.cpp:1671-1703` | Three unconditional events and optional set-thread-context event. |
| Attach DAC call | `src/coreclr/debug/di/process.cpp:1737-1745` | `TryInitializeDac` from `Init`. |
| Metadata file load | `src/coreclr/debug/di/module.cpp:751-775` | File-backed metadata load returns `E_FAIL` on `HOST_UNIX`. |
| Helper thread can't-stop | `src/coreclr/debug/di/rsthread.cpp:3330-3354` | Helper and canary IDs are can't-stop. |
| Continue helper state | `src/coreclr/debug/di/process.cpp:4064-4096` | Interop continue gates on `m_helperThreadDead`. |
| Runtime offsets helper handle | `src/coreclr/debug/di/process.cpp:7315-7352` | Helper-thread handle and DCB helper creation flag. |
| Stop helper wait | `src/coreclr/debug/di/process.cpp:8036-8134` | Async stop path and `m_stopWaitEvent` wait. |
| SendIPCEvent helper model | `src/coreclr/debug/di/process.cpp:9434-9665` | Deadlock model and helper-thread wait set. |
| Helper exception path | `src/coreclr/debug/di/process.cpp:12261-12303` | First-chance helper-thread exception handling. |
| Helper second chance | `src/coreclr/debug/di/process.cpp:12472-12476` | Second-chance helper-thread exception handling. |
| Helper exit | `src/coreclr/debug/di/process.cpp:13103-13110` | Marks helper thread dead on exit events. |
| Process dead helper flag | `src/coreclr/debug/di/process.cpp:13256-13258` | Marks helper thread dead when process is dead. |
| Helper predicate | `src/coreclr/debug/di/process.cpp:13675-13700` | `IsHelperThreadWorked` implementation. |
| DCB transport | `src/coreclr/debug/shared/dbgtransportsession.cpp:414-440` | DCB-to-transport helper fields. |
| DCB reverse transport | `src/coreclr/debug/shared/dbgtransportsession.cpp:444-481` | Transport-to-DCB helper fields. |
| EE helper predicate | `src/coreclr/debug/ee/debugger.h:346` | `ThisIsHelperThreadWorker` declaration. |
| EE helper implementation | `src/coreclr/debug/ee/debugger.cpp:14988-15035` | Worker and debugger helper-thread predicates. |
| DAC interface contract | `src/coreclr/debug/inc/dacdbiinterface.h:169-230` | `IDacDbiInterface`, first methods, consistency checks. |
| Read-only facade | `src/coreclr/debug/inc/readonlydatatargetfacade.inl:28-55` | QI exposes mutable facade. |
| Read-only writes | `src/coreclr/debug/inc/readonlydatatargetfacade.inl:115-145` | Mutation methods return `CORDBG_E_TARGET_READONLY`. |
| Source platform enum | `src/coreclr/inc/cordebug.idl:274-291` | `CorDebugPlatform` source enum has no WASM member. |
| Generated platform enum | `src/coreclr/pal/prebuilt/inc/cordebug.h:1479-1495` | Generated enum values through POSIX_RISCV64. |
| PAL event create | `src/coreclr/pal/src/synchobj/event.cpp:74-100` | `CreateEventW` forwards to `InternalCreateEvent`. |
| PAL event internals | `src/coreclr/pal/src/synchobj/event.cpp:162-203` | Unnamed event allocation. |
| PAL wasm architecture | `src/coreclr/pal/src/CMakeLists.txt:62-64` | wasm PAL architecture directory selection. |
| PAL wasm platform sources | `src/coreclr/pal/src/CMakeLists.txt:127-131` | wasm stubs platform source. |
| PAL event source list | `src/coreclr/pal/src/CMakeLists.txt:150-210` | `synchobj/event.cpp` included in `coreclrpal`. |
| PAL DAC library | `src/coreclr/pal/src/CMakeLists.txt:234-257` | `coreclrpal_dac` remote-unwind-only path. |
| Sidecar top-level include | `src/coreclr/CMakeLists.txt:372-374` | Adds sidecar on wasm target architecture. |
| Sidecar link graph | `src/coreclr/debug/wasm-dbi-dac/CMakeLists.txt:7-28` | Linked DBI, DAC, PAL, metadata libraries. |
| Sidecar target shape | `src/coreclr/debug/wasm-dbi-dac/CMakeLists.txt:49-67` | Product/test targets and test define. |
| Smoke targets | `src/coreclr/debug/wasm-dbi-dac/CMakeLists.txt:69-82` | Existing smoke target names. |
| Host bridge addresses | `src/coreclr/debug/wasm-dbi-dac/README.md:19-33` | Separate runtime and sidecar memories. |
| Host imports | `src/coreclr/debug/wasm-dbi-dac/README.md:52-64` | Four host imports. |
| Read semantics | `src/coreclr/debug/wasm-dbi-dac/README.md:65-83` | Target reads through host bridge. |
| IPC semantics | `src/coreclr/debug/wasm-dbi-dac/README.md:117-133` | Synchronous `send_ipc_to_runtime`. |
| Product exports | `src/coreclr/debug/wasm-dbi-dac/README.md:165-187` | Product ABI export families. |
| README probes | `src/coreclr/debug/wasm-dbi-dac/README.md:213-231` | Existing test-only probes. |
| README QI sequence | `src/coreclr/debug/wasm-dbi-dac/README.md:256-270` | Documented attach QI order. |
| Sidecar constants | `src/coreclr/debug/wasm-dbi-dac/dbi_dac_wasm.cpp:40-87` | ABI version, protocol counter, platform sentinel. |
| Version blob layout | `src/coreclr/debug/wasm-dbi-dac/dbi_dac_wasm.cpp:217-232` | `WasmDbiDacVersionBlob` fields. |
| Event record layout | `src/coreclr/debug/wasm-dbi-dac/dbi_dac_wasm.cpp:251-260` | Current runtime event record fields. |
| Page cache rules | `src/coreclr/debug/wasm-dbi-dac/dbi_dac_wasm.cpp:313-321` | Invalidation triggers and single-thread assumption. |
| Sidecar facade state | `src/coreclr/debug/wasm-dbi-dac/dbi_dac_wasm.cpp:411-419` | Current global Cordb/runtime/event state. |
| Data target interfaces | `src/coreclr/debug/wasm-dbi-dac/dbi_dac_wasm.cpp:449-489` | Implemented QI inventory. |
| Data target basics | `src/coreclr/debug/wasm-dbi-dac/dbi_dac_wasm.cpp:507-566` | Machine type, pointer size, read/write virtual. |
| Runtime base/platform | `src/coreclr/debug/wasm-dbi-dac/dbi_dac_wasm.cpp:619-660` | Runtime base and sentinel platform. |
| DAC entry declaration | `src/coreclr/debug/wasm-dbi-dac/dbi_dac_wasm.cpp:774-780` | Sidecar declaration of `DacDbiInterfaceInstance`. |
| Target reads | `src/coreclr/debug/wasm-dbi-dac/dbi_dac_wasm.cpp:787-887` | Read validation, cache, host callback. |
| Descriptor probe | `src/coreclr/debug/wasm-dbi-dac/dbi_dac_wasm.cpp:917-952` | Resolves and reads `DotNetRuntimeContractDescriptor`. |
| Version export | `src/coreclr/debug/wasm-dbi-dac/dbi_dac_wasm.cpp:1026-1066` | Writes version blob. |
| DAC create probe | `src/coreclr/debug/wasm-dbi-dac/dbi_dac_wasm.cpp:1392-1418` | Existing create probe. |
| Consistency probe | `src/coreclr/debug/wasm-dbi-dac/dbi_dac_wasm.cpp:1420-1464` | Existing consistency-check probe. |
| Session create process | `src/coreclr/debug/wasm-dbi-dac/dbi_dac_wasm.cpp:1498-1531` | Current facade uses `ICorDebug::CreateProcess`. |
| Runtime connect | `src/coreclr/debug/wasm-dbi-dac/dbi_dac_wasm.cpp:1534-1559` | Facade connect state and cache invalidation. |
| Runtime disconnect | `src/coreclr/debug/wasm-dbi-dac/dbi_dac_wasm.cpp:1562-1577` | Facade disconnect state and cache invalidation. |
| Poll text event | `src/coreclr/debug/wasm-dbi-dac/dbi_dac_wasm.cpp:1665-1680` | Current `dbi_poll_event` facade. |
| Poll event record | `src/coreclr/debug/wasm-dbi-dac/dbi_dac_wasm.cpp:1682-1710` | Current event-record poll. |
| Process state | `src/coreclr/debug/wasm-dbi-dac/dbi_dac_wasm.cpp:1742-1777` | `HasRealCordbProcess` currently zero. |
| Session destroy | `src/coreclr/debug/wasm-dbi-dac/dbi_dac_wasm.cpp:1779-1805` | Current teardown. |
| Receive events | `src/coreclr/debug/wasm-dbi-dac/dbi_dac_wasm.cpp:1819-1868` | Current event receive overwrite path. |
| Runtime descriptor rule | `src/coreclr/vm/datadescriptor/CMakeLists.txt:15-19` | Generates `DotNetRuntimeContractDescriptor`. |
| WASM debug globals | `src/coreclr/vm/wasm/dactable.cpp:13-15` | `g_dacTable` and breakpoint callback declaration. |
| WASM debug state | `src/coreclr/vm/wasm/dactable.cpp:80-104` | Current debug globals. |
| WASM debug exports | `src/coreclr/vm/wasm/dactable.cpp:292-320` | Test-data and command receive exports. |
| Smoke descriptor requirement | `src/coreclr/debug/wasm-dbi-dac/smoke-test.js:203-205` | Requires `GetDotNetRuntimeContractDescriptor`. |
| Smoke symbol mapping | `src/coreclr/debug/wasm-dbi-dac/smoke-test.js:276-280` | Maps descriptor and DAC symbols. |
| Smoke descriptor copy | `src/coreclr/debug/wasm-dbi-dac/smoke-test.js:473-474` | Uses descriptor address for target-memory copy. |
| Hello smoke mapping | `src/coreclr/debug/wasm-dbi-dac/hello-breakpoint-smoke.js:470-478` | Maps descriptor and DAC symbols in the breakpoint smoke. |
| DAC export header | `src/coreclr/debug/daccess/dacdbiimpl.h:22-29` | DAC entry-point signature. |
| DAC export implementation | `src/coreclr/debug/daccess/dacdbiimpl.cpp:286-315` | DAC entry implementation and initialization. |
| cDAC guarded lookup | `src/coreclr/debug/daccess/dacdbiimpl.cpp:323-336` | `DotNetRuntimeContractDescriptor` lookup guarded off for WASM. |
| DAC platform adapter | `src/coreclr/debug/daccess/datatargetadapter.cpp:91-164` | Machine type to platform mapping. |
| DAC platform check | `src/coreclr/debug/daccess/daccess.cpp:5114-5158` | Platform compatibility check skipped under `TARGET_WASM`. |
| Shim local platform | `src/coreclr/debug/di/shimlocaldatatarget.cpp:276-294` | Windows platform mapping. |
| Shim remote platform | `src/coreclr/debug/di/shimremotedatatarget.cpp:244-280` | `TARGET_WASM` zero and other platform mapping. |
