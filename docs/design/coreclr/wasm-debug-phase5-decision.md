# Phase 5 / Phase 4 implementation decision (2026-06-01)

Status: **Decision recorded. Phase 5 = Option 5b (expand the wasm runtime adapter). Phase 4 = staged migration deferred to follow-up slices.**

## Context

The Phase 5 design (`product-ready-mscordbi-dac-sidecar-plan.md:714-732`) records two open options for target-side debug EE on wasm:

- **Option 5a** — enable parts of `src/coreclr/debug/ee/wks/` for wasm. Reuses the desktop debug-EE semantics (Debugger / DebuggerController / DebuggerPatchTable). Heavy port — wks is ~37K lines and depends on Win32 sync primitives, helper-thread (`DebuggerRCThread`), thread suspension / register-context APIs, and the `OUT_OF_PROCESS_SETTHREADCONTEXT` machinery. All wasm-hostile.
- **Option 5b** — expand the wasm runtime adapter (`src/coreclr/vm/wasm/dbi-control-plane.cpp`) to cover the same behavior without `debug/ee/wks`. Lower porting surface; reimplements semantics the EE already encodes; risks divergence from desktop.

The plan deliberately deferred this decision until "Phase 5 implementation begins."

## Decision

**Pick Option 5b — expand the wasm runtime adapter.**

## Rationale

The Phase 3 implementation slices that just landed (commits `1c240e9f1f3` + `b830ca1d453`) prove the model works for the DBI side: small surgical wasm-specialized branches in shared code, with all the heavy lifting delegated to a wasm-only adapter TU. The same pattern should work for the EE side.

The arguments in favor:

1. **Single-threaded constraint is fatal to wks.** `DebuggerRCThread` (1,792 lines) assumes a dedicated helper thread. `Debugger::HandleIPCEvent` and `DebuggerController::DispatchPatchOrSingleStep` route through `ThisIsHelperThreadWorker()`. Single-threaded wasm has nowhere to put a helper thread; routing every assumption to the managed thread inside a stop callback would touch ~13 occurrences in `rcthread.cpp`, ~27 in `debugger.cpp`, ~4 in `controller.cpp` — each one a behavioral change that needs validation. The adapter approach lets us implement the semantics we need without inheriting assumptions we don't.

2. **Win32 sync primitives are not enough.** `debugger.cpp` has ~22 references to `SuspendThread`/`ResumeThread`/`GetThreadContext`/`SetThreadContext`. Wasm has no thread suspension primitive and no register file in the desktop sense (the wasm engine owns it). Every codepath that goes through these would need a wasm-specific reroute — same blast radius as Option 5b but with the additional burden of preserving every desktop semantic intact for non-wasm.

3. **The dbi-control-plane.cpp adapter is already in place.** Today it implements single-breakpoint MVP. Stepping (into/over/out), exception events, multi-breakpoint, and func-eval can be added incrementally with smoke coverage at each slice. Each slice that lands keeps both the wasm path AND the desktop path healthy — divergence is a real risk but is observable and bounded.

4. **Option 5a's "reuse" claim is weaker than it sounds.** Even if wks compiled and linked on wasm, every codepath that touches threads/registers/Win32 events would need an `#ifdef TARGET_WASM` reroute. The "reuse" is mostly the class hierarchy and the `DebuggerIPCEvent` dispatch — both of which Option 5b can reuse (or wrap) selectively.

5. **The Phase 3 model worked.** When we needed real `CordbProcess`, we added a 5-line wasm-specialized branch in `process.cpp:650-701`. That's an Option 5b shape for the DBI side. The result: `hasRealCordbProcess=1` end-to-end with zero changes to desktop behavior. The EE side will be larger but follows the same template.

## Acceptance gates for Option 5b

For each capability we add to the wasm adapter, the slice MUST:

1. Land a probe that exercises the new capability via the adapter.
2. Add a smoke assertion locking the new behavior down.
3. Document the equivalent desktop codepath in `controller.cpp` / `debugger.cpp` so a future maintainer can see what the adapter is mirroring.
4. Keep both `coreclr_dbi_dac_wasm_smoke` and `coreclr_dbi_dac_wasm_hello_breakpoint_smoke` green.

The capabilities that the adapter must cover for MVP (in order of priority):

- ✅ Single breakpoint set/hit/continue — done today.
- 🔜 Stepping (into / over / out) — Phase 7.
- 🔜 Exception events (first chance / user-unhandled) — Phase 7.
- 🔜 Multiple concurrent breakpoints — Phase 7.
- 🔜 Module load/unload events — Phase 8.
- 🔜 Thread create/exit events — Phase 8.
- 🔜 Stack walking / locals inspection — Phase 8.

The capabilities that stay deliberately out of MVP (matching Mono Blazor's shipping scope):

- ✗ Function evaluation (`funceval.cpp`) — Phase 13.
- ✗ Edit-and-continue — Phase 13.
- ✗ Async-pause-while-running — Phase 13.
- ✗ Mixed-mode (managed+native) debugging — Phase 13.

## Phase 4 status and next slices

Phase 4 (real WASM debug transport, replace `WasmDebugCommandRecord` with `DebuggerIPCEvent`-shaped wire) is **design-complete and implementation-deferred**. The design (`docs/design/coreclr/wasm-debug-transport.md`) defines:

- Two-channel split (binary `target.*` channel + JSON-RPC `lifecycle.*` / `dbi.*` / `dac.*` / `cdp.*` channel).
- Uniform `{ hr, outs }` response shape on RPC plane.
- Server-pushed `target.memoryInvalidated` event with epoch counter.
- Connection-state gate mirroring Mono's `mono_wasm_set_is_debugger_attached`.

The first migration step is: serialize one `DB_IPCE_BREAKPOINT` round trip. This requires:

1. A wasm-side simplified `DebuggerIPCBreakpointEvent` wire structure (uint32_t fields mirroring `DebuggerIPCEvent::BreakpointData`).
2. Serializer/deserializer helpers in the sidecar.
3. A test-only round-trip probe (`coreclr_wasm_dbi_dac_probe_dbg_ipc_event_breakpoint_roundtrip`) that constructs a synthetic event, serializes, deserializes, and asserts field equality.
4. Once the round-trip probe is green, layer in the runtime-side emit path (which is where Option 5b adapter expansion comes in).

This is concrete bounded work for the next session and intentionally **does not** belong in the same commit as the Phase 5 decision.

## Out of scope for this decision

- **Cross-engine command channel beyond CDP** (Firefox inspector, WebKit RemoteInspector) — Phase 13.
- **Header changes that propagate into shared code** (e.g. `DebuggerIPCEvent` becoming wasm-aware) — only if the adapter approach proves insufficient.
- **Re-evaluating the decision** — should only happen if Option 5b runs into a wall that Option 5a wouldn't (unlikely given the threading constraints above).

## Tracking

- The 5 `_REQUIRES_DEBUG_EE` macros in `inc/dacvars.h` and `inc/vptr_list.h` tag the symbols that Option 5b sidesteps. If a future slice needs any of them (e.g., DAC inspection of debugger state), it must either provide a wasm stub or implement the underlying behavior in the adapter — not enable wks.
- The 6 Phase 3 onramp probes (`probe_data_target_qi`, `probe_clr_instance_id`, `probe_create_events`, `probe_static_dac_binding`, `probe_dac_consistency_checks`, `probe_open_virtual_process`) all stay green; they constrain the Phase 3 acceptance gates so Option 5b's adapter work doesn't accidentally regress the V3 attach path.
- Phase 5 design doc (`product-ready-mscordbi-dac-sidecar-plan.md:752-892`) should be updated separately to lock in this decision and remove the "5a vs 5b" open question.
