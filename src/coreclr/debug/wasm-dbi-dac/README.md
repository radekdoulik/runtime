# WASM DBI/DAC sidecar host-bridge contract

This directory contains the browser-wasm DBI/DAC sidecar
(`coreclr-dbi-dac.wasm`) and its test variant
(`coreclr-dbi-dac-tests.wasm`). The sidecar is a standalone WebAssembly
module that owns its own linear memory and inspects the CoreCLR runtime
module (`corerun.wasm` today, `dotnet.native.wasm` in production) via a
small set of host-mediated callbacks. See
[`debug-dac-wasm-coreclr.md`](../../../../debug-dac-wasm-coreclr.md) for
the higher-level architecture.

This document is the source of truth for the host-bridge contract: the
exact JS-to-sidecar and sidecar-to-JS surface that a cooperating host
must implement to drive the DBI/DAC sidecar correctly. Any change to a
signature, struct layout, error sentinel, or sequencing rule listed here
is a wire-format change and **must** bump
`WasmDbiDacProtocolBreakingChangeCounter` in `dbi_dac_wasm.cpp`.

## Address discipline

The sidecar runs on `wasm32`: all addresses passed across the host
bridge are 32-bit unsigned integers naming offsets into one of two
distinct WebAssembly linear memories:

| Address parameter pattern               | Linear memory it points into                                  |
|-----------------------------------------|---------------------------------------------------------------|
| `targetAddress`, `baseAddress`, `runtimeBase`, `imageNameAddress` | runtime module memory (`corerun.wasm` / `dotnet.native.wasm`) |
| `debuggerAddress`, `*OutAddress`, `bufferAddress`, `messageAddress`, `symbolNameAddress` | sidecar module memory (`coreclr-dbi-dac*.wasm`)               |

The host **must not** assume a value read out of one memory can be
dereferenced as a pointer into the other. Every cross-memory transfer
goes through the bridge primitives below.

`WebAssembly.Memory.grow()` detaches the prior `ArrayBuffer`. The host
**must** re-fetch `new Uint8Array(memory.buffer)` on every host-import
callback rather than caching a typed-array view across calls. The
existing smoke harnesses do this defensively (see the buffer-refetch
logic in `smoke-test.js` and `hello-breakpoint-smoke.js`).

## Sidecar variants

| Module                          | Exports                                                                                         |
|---------------------------------|-------------------------------------------------------------------------------------------------|
| `coreclr-dbi-dac.wasm`          | Product ABI only (`WASM_DBI_DAC_EXPORT(...)`-tagged functions in `dbi_dac_wasm.cpp`).           |
| `coreclr-dbi-dac-tests.wasm`    | Product ABI plus probe / smoke helpers (`WASM_DBI_DAC_EXPORT_TESTS_ONLY(...)` also visible).    |

Export tagging lives in [`dbi_dac_wasm_exports.h`](dbi_dac_wasm_exports.h);
`wasm-ld` honours `export_name` directly so the linker preserves and
exposes each tagged function without a parallel `EXPORTED_FUNCTIONS`
list in CMake.

## Host imports (JS → sidecar)

All host imports live under the import module `"coreclr_dbi_dac"`. The
sidecar declares them in `dbi_dac_wasm.cpp` near line 740 with
`__attribute__((import_module("coreclr_dbi_dac"), import_name(...)))`.

| Import name (`coreclr_dbi_dac.*`) | C signature                                                                          | Required by      |
|-----------------------------------|--------------------------------------------------------------------------------------|------------------|
| `read_target_memory`              | `int32_t (uint32_t targetAddress, uint32_t debuggerAddress, uint32_t byteCount)`     | All product flow |
| `get_symbol_address`              | `int32_t (uint32_t baseAddress, uint32_t symbolNameAddress, uint32_t symbolNameLength, uint32_t outAddress)` | DAC bootstrap    |
| `get_target_module_base`          | `int32_t (uint32_t imageNameAddress, uint32_t imageNameCharCount, uint32_t outAddress)` | DAC bootstrap    |
| `send_ipc_to_runtime`             | `int32_t (uint32_t messageAddress, uint32_t messageLength)`                          | DBI session/breakpoint flow |

### `read_target_memory(targetAddress, debuggerAddress, byteCount)`

Copy `byteCount` bytes starting at `targetAddress` in the **runtime**
linear memory into the sidecar's linear memory at `debuggerAddress`.

**Returns**: `0` on success, negative on failure. The sidecar treats any
non-zero return as a fatal host-read failure and propagates `E_FAIL` /
`CORDBG_E_*` from the calling DAC API.

**Required semantics**:

- The implementation **must** re-fetch `runtimeMemory.buffer` and
  `debuggerMemory.buffer` on every call (memory.grow detaches buffers).
- `byteCount == 0` **must** be a no-op success (caller invariant; the
  cache layer relies on this).
- Reads that would walk past the end of runtime linear memory **must**
  fail (return non-zero). The sidecar wraps callers with a range check
  but still relies on host-side rejection for the page-cache fallback
  path to behave correctly.
- A single call should not be expected to exceed `MaxReadVirtualBytes`
  (= 256 MiB); the sidecar rejects larger requests before reaching the
  host.

### `get_symbol_address(baseAddress, symbolNameAddress, symbolNameLength, outAddress)`

Look up `symbolName` (NUL-not-required ASCII bytes at
`symbolNameAddress` in sidecar memory, `symbolNameLength` bytes long)
relative to `baseAddress` in the runtime module. On success, write a
64-bit little-endian target address into the 8 sidecar-memory bytes at
`outAddress` and return `0`. On failure, return a non-zero sentinel and
**must not** write to `outAddress`.

**Required semantics**:

- The host is expected to satisfy lookups for at least:
  - `DotNetRuntimeContractDescriptor` (cDAC entrypoint)
  - `g_dacTable` (legacy DAC global table)
  - Any name the host runtime exports (e.g.
    `GetDotNetRuntimeContractDescriptor`, `Getg_dacTable`).
- A name length of `0` or > 256 bytes (`MaxSymbolNameBytes`) is invalid;
  the sidecar wraps callers with a length check, but hosts should
  reject the underlying call defensively too.

### `get_target_module_base(imageNameAddress, imageNameCharCount, outAddress)`

Resolve a runtime module name (e.g. `"corerun"`) to its load base in the
runtime linear memory and write the 32-bit address to `outAddress`.

For the current single-runtime-module PoC, the host can implement this
as a fixed value (e.g. `0`) since DAC computes RVAs relative to the
descriptor address it gets from `get_symbol_address`.

### `send_ipc_to_runtime(messageAddress, messageLength)`

Deliver a binary IPC message from the sidecar to the runtime module's
debug receiver. The host pulls `messageLength` bytes (capped at 256 by
`MaxTransportMessageBytes`) starting at `messageAddress` in the
**sidecar** memory and routes them to the runtime's
`CoreClrWasmDebugReceiveCommand` / `CoreClrWasmDebugReceiveCommandRecord`
export, then synchronously copies any reply back via
`coreclr_wasm_dbi_dac_receive_runtime_event` / `_record`.

**Required semantics**:

- Synchronous. The PoC assumes the runtime has already returned to JS
  (single-threaded wasm); see Phase 13 of the productization plan for
  async-pause-while-running candidates.
- `messageLength` of `0` or > 256 is invalid.
- Returns `0` on success, non-zero on transport failure.

## Sidecar exports (sidecar → JS)

Exports group into seven families. All are visible in the `tests`
variant; only those tagged "product" below are visible in the product
variant.

### Version and protocol handshake (product)

| Export                                            | Signature                                                                                          | Notes |
|---------------------------------------------------|----------------------------------------------------------------------------------------------------|-------|
| `coreclr_wasm_dbi_dac_get_abi_version`            | `int32_t ()`                                                                                       | Returns `WasmDbiDacAbiVersion` (currently `1`). |
| `coreclr_wasm_dbi_dac_get_component_mask`         | `int32_t ()`                                                                                       | OR of `ComponentScaffold (0x1) \| ComponentCeeDac (0x2) \| ComponentDaccess (0x4) \| ComponentCordbdi (0x8)`. |
| `coreclr_wasm_dbi_dac_get_version_blob`           | `int32_t (uint32_t blobOutAddress, uint32_t blobOutLength, uint32_t bytesWrittenAddress)`          | Writes `WasmDbiDacVersionBlob` (32 bytes) at `blobOutAddress`, always writes the required size at `bytesWrittenAddress`. Returns `BufferTooSmall` if `blobOutLength` < 32. |
| `coreclr_wasm_dbi_dac_check_protocol`             | `int32_t (uint32_t hostMagic, uint32_t hostAbiVersion, uint32_t hostProtocolBreakingChangeCounter)` | Pure check; returns `0` or `HrIncompatibleProtocol` (`0x8013134B` = `CORDBG_E_INCOMPATIBLE_PROTOCOL`). |
| `coreclr_wasm_dbi_dac_acknowledge_protocol`       | Same as `check_protocol`                                                                           | On success, latches an internal flag so gated product exports may proceed. On failure, clears the latch. |

#### `WasmDbiDacVersionBlob` (32 bytes, little-endian)

```text
offset  size  field
   0     4    Magic                          // 'WDVB' = 0x42564457 LE
   4     4    BlobSize                       // sizeof(blob) = 32
   8     4    AbiVersion                     // WasmDbiDacAbiVersion
  12     4    ProtocolBreakingChangeCounter  // bumped on any wire change
  16     4    ComponentMask                  // mirror of get_component_mask()
  20     4    SidecarBuildVersionMS          // reserved, 0 today
  24     4    SidecarBuildVersionLS          // reserved, 0 today
  28     4    Reserved                       // 0
```

### Protocol-gated entry points (product)

The following exports require `acknowledge_protocol` to have returned
`0` since module instantiation. Calling any of them without a prior
acknowledged handshake returns `HrIncompatibleProtocol`.

| Export                                              | Purpose                                                |
|-----------------------------------------------------|--------------------------------------------------------|
| `coreclr_wasm_dbi_dac_dbi_session_create`           | Create the persistent DBI session object.              |
| `coreclr_wasm_dbi_dac_dbi_session_create_process`   | Attempt to create a `CordbProcess` (currently `E_NOTIMPL`). |
| `coreclr_wasm_dbi_dac_dbi_connect_runtime`          | Bind the session to a runtime base address; invalidates the page cache. |
| `coreclr_wasm_dbi_dac_dbi_disconnect_runtime`       | Unbind; invalidates the page cache.                    |
| `coreclr_wasm_dbi_dac_dbi_set_breakpoint_by_name`   | Send `SetBreakpointByName` command record to runtime.  |
| `coreclr_wasm_dbi_dac_dbi_set_breakpoint_by_token`  | Send `SetBreakpointByToken` command record to runtime. |
| `coreclr_wasm_dbi_dac_dbi_continue`                 | Send `Continue` command record; invalidates the page cache. |
| `coreclr_wasm_dbi_dac_dbi_poll_event`               | Drain queued runtime event text into the supplied buffer. |
| `coreclr_wasm_dbi_dac_dbi_poll_event_record`        | Drain queued runtime event record (`WasmDebugEventRecord`, 340 bytes). |
| `coreclr_wasm_dbi_dac_dbi_poll_frame_record`        | Drain frame record (`WasmDebugFrameRecord`, 88 bytes). |
| `coreclr_wasm_dbi_dac_dbi_poll_process_state`       | Drain process state snapshot (`WasmDbiProcessState`, 40 bytes). |
| `coreclr_wasm_dbi_dac_receive_runtime_event`        | Push a text event from the runtime side (called by the host bridge). |
| `coreclr_wasm_dbi_dac_receive_runtime_event_record` | Push a `WasmDebugEventRecord`.                         |
| `coreclr_wasm_dbi_dac_receive_runtime_frame_record` | Push a `WasmDebugFrameRecord`.                         |
| `coreclr_wasm_dbi_dac_invalidate_page_cache`        | Force-invalidate the in-sidecar page cache (epoch bump). |

### Session teardown (product, ungated)

| Export                                              | Purpose                                                |
|-----------------------------------------------------|--------------------------------------------------------|
| `coreclr_wasm_dbi_dac_dbi_session_destroy`          | Tear down the session; idempotent. **Intentionally ungated** so a host that lost handshake state can still tear down cleanly. The acknowledged-protocol latch is cleared at the end, so any subsequent session must re-handshake. |

### Page-cache stats (tests only)

| Export                                            | Signature                                  | Notes |
|---------------------------------------------------|--------------------------------------------|-------|
| `coreclr_wasm_dbi_dac_get_page_cache_stats`       | `int32_t (uint32_t statsOutAddress)`       | Writes 24-byte `PageCacheStatsBlob`. |

#### `PageCacheStatsBlob` (24 bytes, little-endian)

```text
offset  size  field
   0     4    Epoch          // bumped by every InvalidatePageCache
   4     4    Hits           // cumulative hits since module load
   8     4    Misses         // cumulative misses since module load
  12     4    Bypasses       // cumulative multi-page reads that skipped the cache
  16     4    Invalidations  // cumulative InvalidatePageCache calls
  20     4    Reserved       // 0
```

### Test-side memory / symbol probes (tests only)

| Export                                                 | Purpose |
|--------------------------------------------------------|---------|
| `coreclr_wasm_dbi_dac_copy_from_target`                | Direct `read_target_memory` host-import wrapper; bypasses the page cache by design (used by smoke harnesses to compare cached vs. uncached paths). |
| `coreclr_wasm_dbi_dac_try_get_symbol`                  | Direct `TryGetSymbol` wrapper exposing the wasm DAC symbol shim. |
| `coreclr_wasm_dbi_dac_probe_runtime_contract_descriptor` | Read and validate the cDAC `DotNetRuntimeContractDescriptor` from the connected runtime. |
| `coreclr_wasm_dbi_dac_probe_contract_pointer_data`     | Read one entry of the cDAC pointer-data array by index. |
| `coreclr_wasm_dbi_dac_probe_test_data`                 | Read the `WasmDbiDacTestData` block exposed by the runtime under `CLR_CMAKE_ENABLE_WASM_DBI_DAC`. |
| `coreclr_wasm_dbi_dac_probe_get_platform`              | Probe `ICorDebugDataTarget::GetPlatform()`; today returns the synthetic `WasmSidecarSyntheticPlatform` sentinel. |
| `coreclr_wasm_dbi_dac_create_clr_data_instance`        | Direct `CLRDataCreateInstance` smoke (legacy DAC). |
| `coreclr_wasm_dbi_dac_create_dac_dbi_interface`        | Direct `DacDbiInterfaceInstance` smoke (DBI-facing DAC). |
| `coreclr_wasm_dbi_dac_probe_dac_consistency_checks`    | Phase 3 onramp: creates `IDacDbiInterface` then calls `DacSetTargetConsistencyChecks(FALSE)` and writes the HRESULT to the supplied address. Guards the desktop V3-attach call site (`CordbProcess::CreateDacDbiInterface`) against silent regressions. |
| `coreclr_wasm_dbi_dac_create_cordb_object`             | Smoke wrapper around `CreateCordbObject`. |
| `coreclr_wasm_dbi_dac_probe_breakpoint_control`        | End-to-end probe for the breakpoint facade. |
| `coreclr_wasm_dbi_dac_transport_send_test_message`     | Smoke-only: round-trip a transport message without going through DBI. |
| `coreclr_wasm_dbi_dac_transport_get_last_event`        | Smoke-only: drain text event without going through DBI. |
| `coreclr_wasm_dbi_dac_dbi_read_test_data`              | Smoke-only DBI-facing facade that uses the data target to read `WasmDbiDacTestData`. |

## Error sentinels

All exports return one of:

- `0` (`Success`) on success.
- A negative `Result` enum value for a parameter / range / state error.
- A positive HRESULT (high bit set, so it presents as negative when
  re-interpreted as signed) for protocol or DBI errors.

| Sentinel                       | Decimal | Meaning |
|--------------------------------|---------|---------|
| `Success`                      | `0`     | Operation succeeded. |
| `InvalidArgument`              | `-1`    | Null pointer, zero length, or other simple parameter violation. |
| `HostReadFailed`               | `-2`    | The host `read_target_memory` import returned non-zero. |
| `HostSymbolLookupFailed`       | `-3`    | The host `get_symbol_address` import returned non-zero. |
| `InvalidContractDescriptor`    | `-4`    | The bytes at the host-resolved descriptor address do not parse as a `DotNetRuntimeContractDescriptor`. |
| `InvalidPointerDataIndex`      | `-5`    | Index out of range for the cDAC pointer-data table. |
| `InvalidTestData`              | `-6`    | Test data magic mismatch. |
| `BufferTooSmall`               | `-7`    | Caller-supplied output buffer is smaller than the required size; the export still writes the required size to its `bytesWrittenAddress` out parameter when one is defined. |
| `InvalidReadRange`             | `-8`    | Read range fails address-overflow / max-size validation (`MaxReadVirtualBytes = 256 MiB`). |
| `InvalidSymbolName`            | `-9`    | Symbol name is empty, longer than `MaxSymbolNameBytes` (256), or its bytes lie outside the sidecar's accessible memory. |
| `HrIncompatibleProtocol`       | `0x8013134B` (signed `-0x7FECECB5`) | Mirrors `CORDBG_E_INCOMPATIBLE_PROTOCOL`; returned by `check_protocol`, `acknowledge_protocol`, and every gated export when the handshake has not been completed. |
| `E_NOTIMPL`                    | `0x80004001` | Returned by `dbi_session_create_process` and other paths that are stubbed until later phases land. |

## QI sequence at attach

When a real `mscordbi` attaches to the sidecar's data target, it issues
the following `QueryInterface` calls in order (mirroring the desktop
DBI):

1. `ICorDebugDataTarget` (twice in DEBUG builds for sanity-check
   reasons).
2. `ICorDebugMutableDataTarget`.
3. `ICorDebugMetaDataLocator` (the data target may return
   `E_NOINTERFACE`; DBI tolerates that).

The current sidecar data target answers `ICorDebugDataTarget` and the
legacy `ICLRDataTarget` / `ICLRRuntimeLocator` interfaces. Filling out
`ICorDebugMutableDataTarget` is gated on Phase 3.

## Sequencing rules

A well-behaved host follows this sequence at session start:

1. Instantiate `coreclr-dbi-dac.wasm` (or `-tests.wasm`) and wire all
   four host imports.
2. Call `get_abi_version` and `get_component_mask` to detect a
   completely unknown sidecar build before doing anything else.
3. Call `get_version_blob(out, sizeof(out), &written)` and validate
   `Magic`, `BlobSize`, and `AbiVersion` field-by-field.
4. Call `acknowledge_protocol(magic, abiVersion, breakingChangeCounter)`
   with the values just read. Receive `0` to unlock gated exports.
5. Call `dbi_session_create()`.
6. Call `dbi_connect_runtime(runtimeBase)`; this invalidates the page
   cache so the next reads come from runtime memory.
7. Issue breakpoints, polls, and continues as needed; each `continue`
   call invalidates the page cache.
8. At shutdown: `dbi_disconnect_runtime` (invalidates cache) then
   `dbi_session_destroy`. The session is single-use today.

The page cache is also invalidated on every host-callable
`invalidate_page_cache` call (a defensive "the runtime was poked
out of band" hook). The two existing smoke harnesses
(`smoke-test.js`, `hello-breakpoint-smoke.js`) follow this sequence and
serve as reference implementations of the host side of the contract.

## See also

- [`debug-dac-wasm-coreclr.md`](../../../../debug-dac-wasm-coreclr.md) -
  architecture overview.
- [`debug-dac.md`](../../../../debug-dac.md) - desktop DAC architecture
  (the contract we approximate).
- [`debug-mono-wasm.md`](../../../../debug-mono-wasm.md) - Mono WASM
  debugger architecture (the closest shipping comparison).
- [`dbi_dac_wasm_exports.h`](dbi_dac_wasm_exports.h) - export tagging.
- [`smoke-test.js`](smoke-test.js),
  [`hello-breakpoint-smoke.js`](hello-breakpoint-smoke.js) - reference
  host implementations that fully exercise the contract above.
