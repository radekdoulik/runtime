# `TARGET_WASM` cuts in `src/coreclr/debug/`

## Purpose

This file is the single source-of-truth catalogue of every `TARGET_WASM`
preprocessor cut under `src/coreclr/debug/`. It exists to support the
WebAssembly DAC/`mscordbi` productization effort: each existing cut is
either a permanent platform difference (kept), a stop-gap that hides
work owed to a later phase (tracked stub), or a wrong shortcut that
must be unwound through a principled fix (needs replacement).

Use this catalogue when:

- Auditing the wasm sidecar (`src/coreclr/debug/wasm-dbi-dac/`) build
  surface before changing `TARGET_WASM`-gated code in the debug tree.
- Triaging which phase of the productization plan retires a cut.
- Filing or updating the tracking issues for "Needs replacement" and
  "Tracked stub" rows.

### How to keep this file up to date

1. Re-run `grep -rn 'TARGET_WASM' src/coreclr/debug/` and reconcile the
   line list with the per-file sections below.
2. For each new cut, add a row that includes a file:line citation, a
   short summary of what the cut does, a classification, the owner
   phase, and a one-line rationale. Update the summary table.
3. When a cut is retired, delete the row (do not leave stale entries).
4. The classification taxonomy is:
   - **OK as-is** — genuinely wasm-only behavior. Will not be removed.
   - **Needs replacement** — must be removed and the call routed
     through `minipal` / `coreclrpal_dac` / a wasm-specific helper.
     Every entry of this kind must reference a tracking GitHub issue
     before the audit is considered complete; the audit will not sign
     off with `TBD` placeholders in this column.
   - **Tracked stub** — `E_NOTIMPL` / no-op / placeholder kept until a
     later phase implements it. The owner phase listed on the row
     *is* the tracking commitment; an explicit per-cut issue is
     optional and is filed only when the owner-phase work item does
     not already cover the cut. Inline `TBD` placeholders are
     acceptable here and resolve when the owner-phase work lands.

### Inventory snapshot

The audit was taken on branch `wasm-clr-debug-wip` against the working
tree dated 2025. `grep -nE 'TARGET_WASM' src/coreclr/debug/` returns
**45 raw token occurrences** which collapse into **26 distinct `#if`
regions ("cuts")** across **12 files**. The "cuts" number (26) is the
canonical figure used everywhere in this catalogue and in the summary
below; the productization plan should be updated to match. Earlier
plan text quoting "~44 cuts" was counting raw occurrences rather than
regions and predates this audit.

The corresponding build wiring lives in
`src/coreclr/CMakeLists.txt:363-375` (the `CLR_CMAKE_ENABLE_WASM_DBI_DAC`
opt-in gate) and `src/coreclr/debug/wasm-dbi-dac/CMakeLists.txt` (the
sidecar's link list: `corguids`, `cordbdi`, `cordbee_dac`, `cee_dac`,
`daccess`, `debug-pal`, `dbgutil`, the metadata libs, `minipal`,
`utilcode_dac`, `mscorrc`, `coreclrpal`, `coreclrminipal`,
`coreclrpal_dac`). Because both `cordbdi` and `daccess` are linked
into one wasm module, several cuts exist to collapse the
"DBI lives in `mscordbi.dll`, DAC lives in `mscordaccore.dll`" symbol
topology into a single binary.

## Summary table

| File | Cuts | OK as-is | Needs replacement | Tracked stub |
|------|-----:|---------:|------------------:|-------------:|
| `src/coreclr/debug/daccess/dacdbiimpl.cpp` | 10 | 9 | 0 | 1 |
| `src/coreclr/debug/daccess/daccess.cpp` | 4 | 0 | 0 | 4 |
| `src/coreclr/debug/di/rsmain.cpp` | 3 | 1 | 0 | 2 |
| `src/coreclr/debug/daccess/request.cpp` | 1 | 1 | 0 | 0 |
| `src/coreclr/debug/di/rsthread.cpp` | 1 | 0 | 0 | 1 |
| `src/coreclr/debug/di/rspriv.h` | 1 | 1 | 0 | 0 |
| `src/coreclr/debug/di/shimremotedatatarget.cpp` | 1 | 0 | 0 | 1 |
| `src/coreclr/debug/di/module.cpp` | 1 | 0 | 0 | 1 |
| `src/coreclr/debug/di/platformspecific.cpp` | 1 | 0 | 0 | 1 |
| `src/coreclr/debug/inc/dbgtargetcontext.h` | 1 | 1 | 0 | 0 |
| `src/coreclr/debug/inc/dbgipcevents.h` | 1 | 0 | 0 | 1 |
| `src/coreclr/debug/inc/readonlydatatargetfacade.inl` | 1 | 1 | 0 | 0 |
| **Total** | **26** | **14** | **0** | **12** |

## `src/coreclr/debug/daccess/dacdbiimpl.cpp` (10 cuts)

The first nine cuts in this file all exist for the same reason: in
the wasm sidecar topology, `cordbdi` and `daccess` are linked into
one wasm module. The cross-DLL allocator handoff that `g_pAllocator`
(an `IDacDbiInterface::IAllocator` supplied by DBI to DAC) implements
is unnecessary because there is no DLL boundary: a plain in-process
`::operator new`/`::operator delete` works. The same allocator
overload symbols (`operator new(size_t, const forDbiWorker&)`) are
also defined on the DBI side in `src/coreclr/debug/di/rspriv.h`, so
the `forDbi` global and the operator overloads are made `inline` on
wasm (vague linkage) to avoid multiple-definition errors.

### Cut 1 — line 102-104: `inline` for `forDbi` tag global

- Citation: `src/coreclr/debug/daccess/dacdbiimpl.cpp:102-104`
  — `#if defined(TARGET_WASM) inline #endif forDbiWorker forDbi;`
- What: Makes the `forDbi` tag global have vague linkage so the
  identical definition can also appear in `rsmain.cpp` without a
  duplicate-symbol link error inside the unified sidecar binary.
- Classification: **OK as-is**.
- Owner phase: Phase 1 (final on graduation).
- Rationale: Direct, mechanical consequence of linking both `cordbdi`
  and `daccess` into one wasm executable. Both `rsmain.cpp:40-42` and
  this cut must change together if the sidecar ever moves back to a
  multi-module topology.

### Cut 2 — line 109-114: `operator new(size_t, const forDbiWorker&)` body

- Citation: `src/coreclr/debug/daccess/dacdbiimpl.cpp:109-114`
  — wasm path uses `::operator new(lenBytes, std::nothrow)`, otherwise
  `g_pAllocator->Alloc(lenBytes)`.
- What: Allocates DBI-owned memory using the in-process CRT allocator
  on wasm; routes through the DBI-supplied cross-DLL allocator on
  every other host.
- Classification: **OK as-is**.
- Owner phase: Phase 1 (final on graduation).
- Rationale: No DBI/DAC DLL boundary exists in the sidecar. The
  `g_pAllocator` indirection is meaningful only when DBI and DAC are
  in separate images and the allocator carries process-affinity info
  across that boundary; here the same heap services both.

### Cut 3 — line 124-129: `operator new[](size_t, const forDbiWorker&)` body

- Citation: `src/coreclr/debug/daccess/dacdbiimpl.cpp:124-129`
  — array-new variant of Cut 2.
- What: Same as Cut 2 for array-new.
- Classification: **OK as-is**.
- Owner phase: Phase 1.
- Rationale: Same as Cut 2.

### Cut 4 — line 146-151: `operator delete(void*, const forDbiWorker&)` body

- Citation: `src/coreclr/debug/daccess/dacdbiimpl.cpp:146-151`
  — wasm uses `::operator delete`, otherwise `g_pAllocator->Free`.
- What: Frees DBI-owned memory through the in-process CRT on wasm;
  otherwise through the cross-DLL allocator.
- Classification: **OK as-is**.
- Owner phase: Phase 1.
- Rationale: Mirror of Cuts 2/3. Required to keep alloc/free
  symmetric within the sidecar's single heap.

### Cut 5 — line 164-169: `operator delete[](void*, const forDbiWorker&)` body

- Citation: `src/coreclr/debug/daccess/dacdbiimpl.cpp:164-169`
  — array-delete variant of Cut 4.
- What: Same as Cut 4 for array-delete.
- Classification: **OK as-is**.
- Owner phase: Phase 1.
- Rationale: Same as Cut 4.

### Cut 6 — line 181-187: `DeleteDbiMemory<T>` template

- Citation: `src/coreclr/debug/daccess/dacdbiimpl.cpp:181-187`
  — wasm uses `delete p`, otherwise manual dtor + `g_pAllocator->Free`.
- What: Destroys and frees a DBI object. On wasm, `delete` already
  invokes both the destructor and the matched `::operator delete`; on
  other hosts the cross-DLL split forces an explicit
  destructor-then-free sequence.
- Classification: **OK as-is**.
- Owner phase: Phase 1.
- Rationale: Single-binary topology means the language-level `delete`
  already does the right thing.

### Cut 7 — line 192-204: `AllocDbiMemory(size_t)`

- Citation: `src/coreclr/debug/daccess/dacdbiimpl.cpp:192-204`
  — wasm uses `::operator new(size, std::nothrow)`; non-wasm path
  prefers `g_pAllocator` and falls back to `new (nothrow) BYTE[size]`.
- What: Raw byte allocation for DBI use. On non-wasm hosts the
  fallback exists because `AllocDbiMemory` can be called before the
  cross-DLL allocator is wired; on wasm there is no allocator
  bootstrap so the fallback is unconditional.
- Classification: **OK as-is**.
- Owner phase: Phase 1.
- Rationale: Same family as Cuts 2-6.

### Cut 8 — line 218-229: `DeleteDbiMemory(void*)`

- Citation: `src/coreclr/debug/daccess/dacdbiimpl.cpp:218-229`
  — wasm uses `::operator delete(p)`, otherwise `g_pAllocator` or
  `::delete[] (BYTE*)p`.
- What: Untyped free counterpart to `AllocDbiMemory`.
- Classification: **OK as-is**.
- Owner phase: Phase 1.
- Rationale: Same as Cut 7.

### Cut 9 — line 243-253: `DeleteDbiArrayMemory<T>` template

- Citation: `src/coreclr/debug/daccess/dacdbiimpl.cpp:243-253`
  — wasm uses `delete[] p`, otherwise per-element destructor loop +
  `g_pAllocator->Free`.
- What: Destroys and frees an array of DBI objects. Same single-heap
  argument as Cut 6 applied to arrays.
- Classification: **OK as-is**.
- Owner phase: Phase 1.
- Rationale: Same as Cut 6.

### Cut 10 — line 323-368: cDAC bootstrap in `DacDbiInterfaceInstance`

- Citation: `src/coreclr/debug/daccess/dacdbiimpl.cpp:323-368`
  — `#if defined(CAN_USE_CDAC) && !defined(TARGET_WASM)` around the
  `ENABLE_CDAC` env-var lookup and `CDAC::Create` /
  `CreateDacDbiInterface` call path.
- What: Skips the contract-descriptor-driven cDAC bootstrap entirely
  on wasm; the legacy in-process DAC path is always taken.
- Classification: **Tracked stub**. Owner-phase tracking item is the
  Phase 2 cDAC bootstrap workstream; no separate per-cut issue
  required.
- Owner phase: Phase 2 ("product-grade target-memory and symbol
  layer"; the Phase 2 work list explicitly includes cDAC descriptor /
  data-contract build infrastructure and the contract version /
  symbol resolution that this cut depends on). Pair with the matching
  cut in `daccess.cpp:6550-6589`.
- Rationale: `TryGetSymbol` (the route the cDAC uses to find
  `DotNetRuntimeContractDescriptor` in the target image) is only
  implemented for Linux/macOS/Windows today; enabling cDAC on wasm
  requires a wasm-aware symbol resolver and an end-to-end cDAC
  contract review. Both are explicitly enumerated in Phase 2.

## `src/coreclr/debug/daccess/daccess.cpp` (4 cuts)

### Cut 1 — line 5116-5157: host/target platform mismatch check

- Citation: `src/coreclr/debug/daccess/daccess.cpp:5116-5157`
  — `#ifndef TARGET_WASM` around the chain that computes
  `hostPlatform`, calls `m_pTarget->GetPlatform`, and returns
  `CORDBG_E_INCOMPATIBLE_PLATFORMS` on mismatch.
- What: Skips the entire `CorDebugPlatform` host/target compatibility
  check at `ClrDataAccess::Initialize` time. The preceding comment
  ("The legacy CorDebugPlatform enum does not have a wasm value yet.")
  is the literal reason.
- Classification: **Tracked stub**. Needs issue filed (TBD).
- Owner phase: Phase 1 (foundational; CorDebugPlatform enum addition
  is a public DBI/DAC ABI surface change that must land in lockstep
  with the sidecar version blob).
- Rationale: The check is correct in spirit; the only reason it is
  cut is the missing enum value. Once `CORDB_PLATFORM_WASM` (or
  similar) is added to `ICorDebug.idl`, this block should come back
  to life with a wasm arm. Pairs with `shimremotedatatarget.cpp:249-250`.

### Cut 2 — line 5189-5191: `DacGetHostVtPtrs()`

- Citation: `src/coreclr/debug/daccess/daccess.cpp:5189-5191`
  — `#ifndef TARGET_WASM IfFailRet(DacGetHostVtPtrs()); #endif`.
- What: Skips the initialization that populates the table of host
  vtable pointers DAC uses to round-trip `DAC_VPTR_TABLE` entries
  back to host-side C++ object identities.
- Classification: **Tracked stub**.
- Owner phase: Phase 5 (target-side debug EE in CoreCLR WASM —
  the first phase whose work plausibly forces DBI to instantiate
  VPTR-marshaled DAC objects through the real debugger surface).
  Retire earlier if a Phase 1–3 code path needs it.
- Rationale: Host vtable identity is fundamental to how DAC marshals
  a target object back to a host-side `PTR_*` smart pointer; bypassing
  the table works only as long as no DAC code path exercises
  `DacGetVtForHostVtable` / `DAC_VPTR`. Today the sidecar
  (`src/coreclr/debug/wasm-dbi-dac/dbi_dac_wasm.cpp`) only obtains
  `IXCLRDataProcess` and a `DacDbiInterfaceInstance` handle and
  exercises no DAC API that marshals a typed object back through a
  VPTR smart pointer, so the skipped initialization is invisible at
  runtime. The wasm host has the same vtables as any other DAC host
  (it is a C++ build of the same daccess sources), so the table is
  generatable; what is missing is the symbol-resolution glue. Any
  future code path on wasm that hits `DacInstantiateTypeByAddress`
  with `VPTR` usage will silently materialize a host object with a
  NULL vtable pointer and crash on the first virtual call. The cut
  must be retired as soon as such a path is introduced; flag the
  build to fail rather than ship that breakage by accident.

### Cut 3 — line 6544-6546: `InitializeLogging()`

- Citation: `src/coreclr/debug/daccess/daccess.cpp:6544-6546`
  — `#if defined(LOGGING) && !defined(TARGET_WASM)`.
- What: Skips the CLR diagnostic logging subsystem initialization
  (the `LF_*`/`LL_*` macros) in checked DAC builds on wasm.
- Classification: **Tracked stub**.
- Owner phase: Phase 11 ("validation and CI"). `LOGGING` is only
  defined in checked builds, so this cut affects dev/CI surface
  rather than the product. If a bring-up phase needs DAC logs, retire
  this cut at that point.
- Rationale: `LOGGING` is the primary diagnostic instrument for DAC
  bring-up, but the gate is `#if defined(LOGGING) && !defined(TARGET_WASM)`,
  so the cut is a no-op in release / shipping builds and only
  suppresses logs in checked builds used by developers and CI. The
  right fix is to wire the logging sink through the wasm sidecar's
  host bridge; doing so before there is a CI scenario that actually
  consumes DAC logs is premature optimization. Treat the gap as a
  validation-phase task.

### Cut 4 — line 6550-6589: cDAC bootstrap in `CLRDataCreateInstance`

- Citation: `src/coreclr/debug/daccess/daccess.cpp:6550-6589`
  — `#if defined(CAN_USE_CDAC) && !defined(TARGET_WASM)` around the
  `ENABLE_CDAC` env-var lookup, `CDAC::Create`, and
  `CreateSosInterface` call path used by SOS clients.
- What: Skips the cDAC bootstrap for SOS clients on wasm. Twin of
  Cut 10 in `dacdbiimpl.cpp`.
- Classification: **Tracked stub**. Owner-phase tracking item is
  the Phase 2 cDAC bootstrap workstream; no separate per-cut issue
  required.
- Owner phase: Phase 2 (paired with the `dacdbiimpl.cpp:323-368`
  retirement; both must land in the same PR).
- Rationale: Same reasoning as the `dacdbiimpl.cpp` twin: cDAC
  symbol resolution is not implemented for wasm. Retire both cuts in
  the same PR to keep the two code paths in sync.

## `src/coreclr/debug/di/rsmain.cpp` (3 cuts)

### Cut 1 — line 40-42: `inline` for `forDbi` tag global

- Citation: `src/coreclr/debug/di/rsmain.cpp:40-42`
  — `#if defined(TARGET_WASM) inline #endif forDbiWorker forDbi;`
- What: Mirror of `dacdbiimpl.cpp:102-104`. Makes the DBI-side
  definition of `forDbi` vague-linkage so the single sidecar binary
  resolves it cleanly when both translation units are linked in.
- Classification: **OK as-is**.
- Owner phase: Phase 1.
- Rationale: Single-binary topology consequence; must change in
  lockstep with the `dacdbiimpl.cpp` mirror.

### Cut 2 — line 1231-1265: skip `CordbRCEventThread` creation/start

- Citation: `src/coreclr/debug/di/rsmain.cpp:1231-1265`
  — wasm path just sets `m_initialized = TRUE`; the in-tree comment
  says the runtime-controller event thread has not been wired to a
  host transport yet.
- What: Bypasses construction, `Init()`, and `Start()` of the
  runtime-controller event thread (the dispatcher that pumps DBI
  events from the left side to the right side) on wasm.
- Classification: **Tracked stub**. Needs issue filed (TBD).
- Owner phase: Phase 3 (real `CordbProcess` attach + transport).
- Rationale: Until the wasm sidecar has an actual host-supplied
  transport for runtime-controller events, this thread has nothing
  to pump. Phase 3 retires the cut and replaces the thread with the
  real wasm transport.

### Cut 3 — line 1268-1270: omit `exit:` label

- Citation: `src/coreclr/debug/di/rsmain.cpp:1268-1270`
  — `#if !defined(TARGET_WASM) exit: #endif`.
- What: Drops the `exit:` label whose only `goto exit;` users live
  inside the body cut by Cut 2.
- Classification: **Tracked stub** (mechanically coupled to Cut 2).
- Owner phase: Phase 3 (retired with Cut 2).
- Rationale: Compiler error "label is not used" if Cut 2 elides the
  block. Once Cut 2 is retired the label is needed again.

## `src/coreclr/debug/daccess/request.cpp` (1 cut)

### Cut 1 — line 695: wasm register-name table

- Citation: `src/coreclr/debug/daccess/request.cpp:695`
  — `#elif defined(TARGET_WASM)` arm of the static `regs[]` table
  used by the register-name accessor; supplies `IP`, `SP`, `FP`.
- What: Provides display strings for the three interpreter registers
  the wasm-targeted register set exposes.
- Classification: **OK as-is**.
- Owner phase: Phase 1.
- Rationale: Matches the wasm `CordbRegisterSet` implementation in
  `src/coreclr/debug/di/wasm/cordbregisterset.cpp` which exposes
  exactly those three registers. The table will grow only if/when
  the wasm register model grows (Phase 8).

## `src/coreclr/debug/di/rsthread.cpp` (1 cut)

### Cut 1 — line 8853-8904: `CordbJITILFrame::GetReturnValueForType`

- Citation: `src/coreclr/debug/di/rsthread.cpp:8853-8904`
  — wasm arm just `return E_NOTIMPL;`, everything else picks an
  ABI-specific float register and integer register and dispatches to
  `GetLocalRegisterValue` / `GetLocalFloatingPointValue` /
  `GetLocalDoubleRegisterValue`.
- What: Returns `E_NOTIMPL` for the return-value-after-step API on
  wasm; on other targets the implementation reads the ABI-defined
  return register.
- Classification: **Tracked stub**. Needs issue filed (TBD).
- Owner phase: Phase 8 (stack/frame work).
- Rationale: The wasm interpreter does not have ABI return registers
  in the AMD64/ARM64 sense; return-value retrieval has to go through
  the interpreter's value stack via the wasm-specific stackwalker.
  That mechanism does not yet exist.

## `src/coreclr/debug/di/rspriv.h` (1 cut)

### Cut 1 — line 212-232: omit DBI-side `operator new`/`operator new[]`

- Citation: `src/coreclr/debug/di/rspriv.h:212-232`
  — `#if !defined(TARGET_WASM)` around the inline `operator
  new(size_t, const forDbiWorker&)` and `operator new[]` definitions.
- What: On non-wasm hosts, `rspriv.h` provides simple `new (nothrow)
  BYTE[lenBytes]`-backed overloads for DBI compile units, because
  DBI has no cross-DLL allocator (it owns the allocator). On wasm,
  the `dacdbiimpl.cpp` definitions are visible to the same link
  image and would collide.
- Classification: **OK as-is**.
- Owner phase: Phase 1.
- Rationale: Avoids duplicate-definition errors in the sidecar.
  Logically coupled to Cuts 1-9 in `dacdbiimpl.cpp`.

## `src/coreclr/debug/di/shimremotedatatarget.cpp` (1 cut)

### Cut 1 — line 249-250: `GetPlatform` returns `static_cast<CorDebugPlatform>(0)`

- Citation: `src/coreclr/debug/di/shimremotedatatarget.cpp:249-250`
  — the `TARGET_WASM` arm itself is just the `#if defined(TARGET_WASM)`
  guard on line 249 and the `*pPlatform = static_cast<CorDebugPlatform>(0);`
  assignment on line 250. The surrounding `#elif defined(TARGET_UNIX)`
  (lines 251-266) and `#else` Windows (lines 267-281) arms are the
  pre-existing per-architecture mapping and are *not* part of the
  wasm cut; they are shown here only to make the contrast obvious.
- What: Reports a synthetic zero-valued `CorDebugPlatform` for wasm
  because the public enum has no wasm member.
- Classification: **Tracked stub**. Needs issue filed (TBD).
- Owner phase: Phase 1 (foundational; pairs with the
  `daccess.cpp:5116-5157` retirement).
- Rationale: Adding `CORDB_PLATFORM_WASM` (or equivalent) to
  `CorDebugPlatform` in the public `ICorDebug.idl` lets both this
  cut and the `daccess.cpp` host/target check go away together.

## `src/coreclr/debug/di/module.cpp` (1 cut)

### Cut 1 — line 4364-4366: `CordbNativeCode::GetCallInstructionLength`

- Citation: `src/coreclr/debug/di/module.cpp:4364-4366`
  — `#elif defined(TARGET_WASM) PORTABILITY_ASSERT("WASM call
  instruction length is not implemented"); return -1;`.
- What: Triggers a portability assert and returns -1 for the
  "how many bytes is this native call instruction" query on wasm.
- Classification: **Tracked stub**. Needs issue filed (TBD).
- Owner phase: Phase 8 (stack/frame, native-code paths).
- Rationale: The interpreter MVP exposes no native call instructions
  to the debugger, so the assert is currently unreachable, but any
  consumer that begins to call this on wasm will abort. The right
  fix is either an honest interpreter-aware answer or a documented
  `S_FALSE`/`E_NOTIMPL` return.

## `src/coreclr/debug/di/platformspecific.cpp` (1 cut)

### Cut 1 — line 42-43: wasm arm of platform-specific source inclusion

- Citation: `src/coreclr/debug/di/platformspecific.cpp:42-43`
  — `#elif TARGET_WASM` includes `wasm/cordbregisterset.cpp` only;
  every other arch arm also pulls in a sibling `primitives.cpp`.
- What: Brings in the wasm-specific `CordbRegisterSet` implementation
  for the DBI build but skips `di/wasm/primitives.cpp` (which does
  not currently exist).
- Classification: **Tracked stub**. Needs issue filed (TBD).
- Borderline: defaulted to "Tracked stub" because there is no
  `src/coreclr/debug/di/wasm/primitives.cpp` to include and current
  builds link successfully, which suggests the DBI-side
  `primitives.cpp` symbols are unreferenced from the wasm DBI
  surface. Could be reclassified OK-as-is once we confirm
  unreferenced-by-design (and ideally drop the symbols from the
  wasm DBI compile unit explicitly). If a future DBI code path
  references a `primitives.cpp` symbol, the build will fail and
  this cut will become a real gap.
- Owner phase: Phase 1 (audit) / Phase 8 (if/when wasm DBI grows
  primitives needs).
- Rationale: Asymmetric with `src/coreclr/debug/daccess/wasm/primitives.cpp`,
  which exists for the daccess side. The DBI side either needs a
  matching file with the right wasm stubs or an explicit comment
  documenting why it does not.

## `src/coreclr/debug/inc/dbgtargetcontext.h` (1 cut)

### Cut 1 — line 61-62: `DTCONTEXT_IS_WASM` selector

- Citation: `src/coreclr/debug/inc/dbgtargetcontext.h:61-62`
  — `#elif defined (TARGET_WASM) #define DTCONTEXT_IS_WASM`.
- What: Picks the wasm arm of the `DTCONTEXT_IS_*` family, which
  later (line 619-635) selects the minimal interpreter `DT_CONTEXT`
  layout (`InterpreterWalkFramePointer`, `InterpreterSP`,
  `InterpreterFP`, `InterpreterIP`).
- Classification: **OK as-is**.
- Owner phase: Phase 1.
- Rationale: Every supported target architecture has one of these.
  The wasm arm is the legitimate way to bind `DT_CONTEXT` to the
  wasm interpreter's context shape. Verify in lockstep with any
  Phase 8 context-layout changes.

## `src/coreclr/debug/inc/dbgipcevents.h` (1 cut)

### Cut 1 — line 1689-1691: `DBG_TARGET_REGNUM_SP` for wasm

- Citation: `src/coreclr/debug/inc/dbgipcevents.h:1689-1691`
  — `#elif defined(TARGET_WASM) #define DBG_TARGET_REGNUM_SP 0
  #define DBG_TARGET_REGNUM_AMBIENT_SP 0`.
- What: Defines the wasm values for the SP and ambient-SP register
  numbers used by the IPC-event regnum mapping that the JIT/EE-side
  debugger emits.
- Classification: **Tracked stub**. Needs issue filed (TBD).
- Owner phase: Phase 8 (stack/frame).
- Rationale: Every other architecture's arm pairs its values with a
  `static_assert(DBG_TARGET_REGNUM_SP == ICorDebugInfo::REGNUM_SP)`
  cross-check; the wasm arm sets both to placeholder `0` without
  such a check, which means there is no honest mapping into
  `ICorDebugInfo::RegNum`. The values are correct only insofar as
  no debugger path on wasm currently exercises them.

## `src/coreclr/debug/inc/readonlydatatargetfacade.inl` (1 cut)

### Cut 1 — line 12-16: `READONLYDATATARGETFACADE_INLINE` macro

- Citation: `src/coreclr/debug/inc/readonlydatatargetfacade.inl:12-16`
  — `#if defined(TARGET_WASM) #define READONLYDATATARGETFACADE_INLINE
  inline #else #define READONLYDATATARGETFACADE_INLINE #endif`.
- What: Makes each method definition in the `.inl` `inline` on wasm,
  so the file can be `#include`d into more than one translation unit
  in the unified sidecar binary without ODR/multiple-definition
  failures.
- Classification: **OK as-is**.
- Owner phase: Phase 1.
- Rationale: Same single-binary topology as the `forDbi` family of
  cuts; this is the right shape for the sidecar's link model.

## Follow-up: tracking commitments

Per the taxonomy at the top of this file, only **Needs replacement**
entries require an explicit, separate tracking issue before the audit
is closed. **Tracked stub** entries are tracked by the owner-phase
column on each row; the per-cut `TBD` placeholders below are kept
inline and resolve when the listed phase's work item lands.

### Needs replacement (0)

After the borderline-classification review, the audit currently
contains zero "Needs replacement" entries. Any cut promoted to this
class in a future audit pass MUST gain a tracking GitHub issue before
the audit is re-signed-off.

### Tracked stub inventory (12)

Listed by owner phase for convenience. Each row is already documented
in the per-file section above; the owner phase is the tracking
commitment.

**Phase 1 (foundational, ABI/version surface):**

1. `src/coreclr/debug/daccess/daccess.cpp:5116-5157` —
   host/target `CorDebugPlatform` mismatch check skipped because the
   public enum has no wasm member. Pairs with #2.
2. `src/coreclr/debug/di/shimremotedatatarget.cpp:249-250` —
   `GetPlatform` returns synthetic 0. Pairs with #1.
3. `src/coreclr/debug/di/platformspecific.cpp:42-43` — wasm
   arm omits `primitives.cpp` include; either supply
   `di/wasm/primitives.cpp` or document the deliberate gap. May
   move to Phase 8 if a future wasm DBI path needs primitives.

**Phase 2 (target-memory and symbol layer, including cDAC):**

4. `src/coreclr/debug/daccess/dacdbiimpl.cpp:323-368` — cDAC
   bootstrap skipped in `DacDbiInterfaceInstance`. Pairs with #5.
5. `src/coreclr/debug/daccess/daccess.cpp:6550-6589` — cDAC
   bootstrap skipped in `CLRDataCreateInstance`. Pairs with #4.

**Phase 3 (real `CordbProcess` attach + transport):**

6. `src/coreclr/debug/di/rsmain.cpp:1231-1265` —
   `CordbRCEventThread` not created/started. Pairs with #7.
7. `src/coreclr/debug/di/rsmain.cpp:1268-1270` — `exit:` label
   omitted (mechanically coupled to #6).

**Phase 5 (target-side debug EE / DAC vtable identity):**

8. `src/coreclr/debug/daccess/daccess.cpp:5189-5191` —
   `DacGetHostVtPtrs()` skipped. Retire earlier if any Phase 1-3
   path begins to instantiate VPTR-marshaled DAC objects.

**Phase 8 (stack/frame, native-code, register-set work):**

9. `src/coreclr/debug/di/rsthread.cpp:8853-8904` —
   `CordbJITILFrame::GetReturnValueForType` returns `E_NOTIMPL`.
10. `src/coreclr/debug/di/module.cpp:4364-4366` —
    `CordbNativeCode::GetCallInstructionLength` asserts/returns -1.
11. `src/coreclr/debug/inc/dbgipcevents.h:1689-1691` —
    `DBG_TARGET_REGNUM_SP`/`AMBIENT_SP` are placeholder zeros, no
    `static_assert` cross-check.

**Phase 11 (validation and CI):**

12. `src/coreclr/debug/daccess/daccess.cpp:6544-6546` —
    `InitializeLogging()` skipped under
    `defined(LOGGING) && !defined(TARGET_WASM)`. Only matters in
    checked builds; retire when a CI scenario actually consumes
    DAC logs.

## Notes and surprises from the audit

- **Occurrences vs cuts.** Plain `grep -n TARGET_WASM` returns **45**
  hits; those collapse into **26** `#if`/`#endif` regions. The
  catalogue uses regions everywhere; the plan should be updated to
  match.
- **`dbgtargetcontext.h` has a second wasm site.** Line **619** uses
  `#elif defined(DTCONTEXT_IS_WASM)` (not `TARGET_WASM`) to select the
  wasm `DT_CONTEXT` layout. It is *not* in this catalogue because it
  is not a `TARGET_WASM` cut, but it is the direct downstream
  consumer of Cut 1 at line 61, and both must move together if the
  context layout changes.
- **No stray `HOST_WASM` cuts.** A `grep -n 'HOST_WASM\|HOST_BROWSER'
  src/coreclr/debug/` returns nothing, so the sidecar build is
  driven entirely by `TARGET_WASM`. Phase 1 work to confirm host
  vs. target defines for the DAC/DBI compile units (plan §1, audit
  `HOST_*` defines) needs to add the `HOST_*` story; today it does
  not exist in the debug tree.
- **Asymmetric `wasm/primitives.cpp`.** `daccess/wasm/primitives.cpp`
  exists and is included via `daccess/CMakeLists.txt`'s
  `${ARCH_SOURCES_DIR}/primitives.cpp`; the DBI side has no
  `di/wasm/primitives.cpp` and `platformspecific.cpp`'s wasm arm
  only `#include`s `wasm/cordbregisterset.cpp`. This is the
  rationale for Cut 1 in `platformspecific.cpp` being a tracked
  stub rather than OK-as-is.
- **Two distinct cDAC cut sites are textually almost identical.**
  `dacdbiimpl.cpp:323-368` and `daccess.cpp:6550-6589` share the
  same `CDAC::Create`/`TryGetSymbol` shape. Retire them in a single
  PR to keep them in sync.
- **The allocator cuts (`dacdbiimpl.cpp:102-253` plus
  `rspriv.h:212-232` plus `readonlydatatargetfacade.inl:12-16`)
  form one logical group of seven cuts** that exist for exactly one
  reason: `cordbdi` and `daccess` link into a single sidecar
  binary. They should be reasoned about together. If the productization
  ever moves back to a multi-module topology, all seven would need
  re-evaluation simultaneously.
- **`CorDebugPlatform` is the highest-leverage missing public API.**
  Adding a wasm value to `CorDebugPlatform` retires
  `shimremotedatatarget.cpp:249-250` *and*
  `daccess.cpp:5116-5157` (the platform-mismatch check) in one
  stroke. That is two of the twelve tracked stubs gone for the price
  of one enum value, and it is the precondition for honest
  attach-time platform verification.
