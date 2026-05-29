# CoreCLR WASM debugger stop and resume behavior

## Purpose & audience

This document is for tooling owners, the Blazor and .NET MAUI WASM teams, and debugger users who need to know what CoreCLR WASM debugging stops can do in the MVP, what they cannot do yet, and which async-pause capabilities are candidates for Phase 13 follow-up work.

## TL;DR table

| Scenario | MVP result | Roadmap owner | User-facing contract |
|---|---|---|---|
| Managed breakpoints: set, hit, continue | ✅ Supported | Phase 7 | A source breakpoint can bind, stop at managed code, show managed frames, and continue. |
| Managed single-step: into, over, out | ✅ Supported | Target Phase 7 | Step commands stop at managed sequence points reached by interpreter execution. |
| Managed exceptions: first-chance and unhandled stop | ✅ Supported | Target Phase 7 + Phase 8 | Exception stops are managed stops; richer exception-frame and value inspection completes with Phase 8. |
| Loader events: `LOAD_MODULE`, `UNLOAD_MODULE`, `CREATE_THREAD` | ✅ Supported | Target Phase 5 | The IDE can receive runtime load/thread lifecycle events through the managed-debug event path. |
| IDE-initiated async pause while running | ❌ Not supported | Phase 13 | Pressing Pause while the runtime is already running is not a managed stop in MVP. |
| Engine-level pause via browser DevTools | ⚠️ Engine halt only | Phase 13 if promoted | DevTools may halt JavaScript/WASM, but the stop is at a WASM/JS frame, not a managed sequence point. |
| Hot reload / edit-and-continue | ❌ Not supported | Out of plan scope | No MVP stop/resume behavior depends on hot reload or edit-and-continue. |
| Multi-runtime-instance debugging | ❌ Not supported | Phase 13 | MVP debugs one CoreCLR WASM runtime instance per page or harness. |

## MVP supported behavior

MVP stop/resume follows the same trigger shape as Mono WebAssembly debugging:
a runtime-initiated managed event synchronously calls a JavaScript import,
the import executes `debugger;`, the browser engine pauses at that import
frame, and the debugger sidecar provides managed frames and data while the
engine is stopped. Mono's JavaScript import is visible at
`src/mono/browser/runtime/debug.ts:36-43`; the Mono WASM runtime calls the
import from `receive_debugger_agent_message` at
`src/mono/mono/component/mini-wasm-debugger.c:452-456`.

### Managed breakpoints

When a user sets a source breakpoint, the IDE should show the breakpoint as
bound once the runtime and PDB/source mapping are ready. When execution reaches
that line, the IDE stops on the managed source line, shows managed stack frames,
locals, and arguments to the extent implemented by the current inspection
phase, and Continue resumes execution after the stopped sequence point.

- Implementation primitive: the runtime-initiated breakpoint event uses the
  Mono-pattern JavaScript import that executes `debugger;`
  (`debug.ts:36-43`; `mini-wasm-debugger.c:455`).
- Runtime hand-off: CoreCLR records the breakpoint event and calls the pause
  import only while the debugger-attached gate is set.
- Sidecar hand-off: the debugger sidecar polls the queued event/frame state and
  reads target memory through its host bridge.
- IDE hand-off: the proxy translates the engine pause into a managed
  `Debugger.paused` / DAP stop notification and sends Continue back through the
  sidecar/runtime command path.

### Managed single-step

When a user chooses Step Into, Step Over, or Step Out, the IDE should resume the
runtime and then stop again at the next managed sequence point selected by the
step request. The stop is a managed debugger stop, not a native WASM breakpoint
or browser line-table stop.

- Implementation primitive: the step-complete event uses the same
  `debugger;`-from-import pause path as breakpoints (`debug.ts:36-43`;
  `mini-wasm-debugger.c:455`).
- Runtime hand-off: CoreCLR records the active step request and emits a managed
  stop when interpreter execution reaches the selected sequence point.
- Sidecar hand-off: the debugger sidecar turns the stop event into DBI-shaped
  thread/frame data and invalidates stale cache state across resume.
- IDE hand-off: the IDE sees a normal step-complete stop and may issue further
  step, inspect, or continue commands while the engine remains paused.

### Managed exceptions

When the IDE is configured to break on first-chance or unhandled exceptions,
MVP treats the exception as a managed event. The user should see the exception
stop at a managed frame with managed stack information. Exception-object and
complex frame inspection complete with the Phase 8 inspection work.

- Implementation primitive: exception events use the same runtime-initiated
  pause import (`debug.ts:36-43`; `mini-wasm-debugger.c:455`).
- Runtime hand-off: CoreCLR's WASM debug event path classifies the exception
  according to the configured stop policy and emits a managed stop event.
- Sidecar hand-off: the debugger sidecar exposes the exception stop and frame
  records through its event/frame polling surface.
- IDE hand-off: the IDE reports a managed exception stop; user-code filters and
  richer exception display are later policy/UI layers, not a different stop
  primitive.

### Loader and thread lifecycle events

Loader events let an IDE bind breakpoints when modules and symbols become
available. In MVP, `LOAD_MODULE`, `UNLOAD_MODULE`, and `CREATE_THREAD` are
part of the supported managed-debug event surface. Some loader chatter may be
reported without stopping; events that must stop use the same pause primitive.

- Implementation primitive: stop-worthy loader/thread events use the
  `debugger;`-from-import path (`debug.ts:36-43`; `mini-wasm-debugger.c:455`).
- Runtime hand-off: CoreCLR emits module/thread lifecycle events from the
  target-side WASM debug event path.
- Sidecar hand-off: the debugger sidecar drains runtime events and updates the
  module/thread view exposed to the IDE proxy.
- IDE hand-off: the IDE receives lifecycle notifications, binds pending
  breakpoints, and only presents a user-visible stop when the event policy says
  to stop.

### Continue and resume

Continue is engine-native after a managed stop. The IDE sends a resume command,
the browser engine returns from the `debugger;` statement, the JavaScript import
returns to the runtime, and interpreter execution continues. The productization
plan describes this sequence at `product-ready-mscordbi-dac-sidecar-plan.md:819-825`.

## MVP unsupported behavior

### IDE-initiated async pause while running

Users may expect the IDE Pause button to interrupt a busy Blazor or MAUI WASM
app immediately and show managed frames wherever the runtime happened to be.
That is not the MVP contract. MVP only produces managed stops when managed
execution reaches a runtime-initiated stop point: breakpoint, step, exception,
or loader/thread event.

Mono parity is explicit here. Mono's WASM debugger engine declines out-of-band
suspend: `try_process_suspend` returns `FALSE` at
`src/mono/mono/component/mini-wasm-debugger.c:88-91`, and
`ensure_runtime_is_suspended` is a no-op success at
`src/mono/mono/component/mini-wasm-debugger.c:124-127`. The CoreCLR MVP matches
that user-visible behavior. Phase 13 catalogs candidate mechanisms for true
async pause while running.

### Hot reload and edit-and-continue

Users may expect a paused CoreCLR WASM app to accept edits, apply deltas, and
continue with the edited code. MVP does not support hot reload or
edit-and-continue, and this stop/resume design does not reserve UI behavior for
it. If hot reload becomes a separate product feature, it needs its own design
for delta application, breakpoint rebinding, and inspection consistency.

This is not a Mono stop/resume parity claim. It is simply outside the MVP and
Phase 13 stop-behavior scope described by the productization plan.

### Multi-runtime-instance debugging

Users may expect one IDE session to debug multiple CoreCLR WASM runtime
instances in the same page, such as a main-thread runtime plus worker-hosted
runtimes. MVP does not support that. A debug session selects one runtime
instance and one debugger sidecar connection.

Phase 13 records multi-instance support as a deferred protocol expansion: the
proxy and sidecar wire vocabulary need a runtime-instance index before multiple
CoreCLR WASM runtimes can be debugged in one page
(`product-ready-mscordbi-dac-sidecar-plan.md:1499-1507`). This is adjacent to,
but separate from, Mono's `RuntimeId` model.

## Engine-level pause clarification

Browser DevTools has its own Pause button. Pressing it can stop the JavaScript
engine or the WASM engine, but MVP does not convert that arbitrary engine halt
into a managed debugger stop.

A DevTools pause can land at a JavaScript frame, an import/export boundary, or
a WASM frame that has no managed sequence-point event attached. At that point
the runtime has not necessarily recorded a managed stop event, the sidecar has
no authoritative stopped-state epoch for inspection, and the IDE cannot assume
that a managed stack walk is safe or meaningful.

The debugger sidecar needs a managed stop at a known sequence point. That stop
provides the event record, frame identity, cache epoch, and runtime state needed
to enumerate managed frames. Without that hand-off, the sidecar may still read
raw target memory for low-level diagnostics, but it cannot promise user-facing
managed frames, locals, or exception state.

MVP workaround: set a managed breakpoint at the line of interest and let
managed execution reach it naturally. The resulting stop is the supported
managed-debugger stop and can be continued normally.

## Phase 13 roadmap for IDE-initiated async pause while running

Phase 13 is the follow-up bucket for true IDE-initiated async pause while the
runtime is executing. The plan explicitly says the mechanism choice is still a
candidate decision, not a shipping commitment
(`product-ready-mscordbi-dac-sidecar-plan.md:1329-1335`). The trigger primitive
for runtime-initiated stops remains `debugger;`-from-JS-import; Phase 13 only
chooses how an out-of-band Pause request reaches a future safepoint poll.

| Candidate | Description | Trade-off |
|---|---|---|
| F-1: CDP `Debugger.pause` then evaluate | The IDE asks the engine to pause, uses `Runtime.evaluate` to set a normal runtime flag, resumes, and lets the runtime stop at the next safepoint. | V8/CDP-oriented and useful for Blazor-like dev flows; no SharedArrayBuffer, COOP/COEP, Worker, JSPI, or Asyncify requirement. |
| F-2: SharedArrayBuffer + worker-hosted trigger | A Worker owns a `SharedArrayBuffer`; the IDE signals through `Atomics`, and the runtime polls the shared flag at safepoints. | Cross-engine where SAB is available, but browser deployment requires COOP/COEP and `crossOriginIsolated = true`. |
| F-3: JSPI | A JSPI-enabled import boundary suspends and resumes at safepoint poll boundaries. | Clean browser primitive with no whole-program instrumentation, but blocked on an emsdk upgrade to a JSPI-enabled release. |
| F-4: Asyncify | Asyncify only the interpreter dispatch or safepoint-poll paths. | Available on the current emsdk, but adds Asyncify size/performance overhead to those paths. |

The shared runtime-side shape for any candidate is also Phase 13 work:
a safepoint poll, a host-callable async-break request flag, a small JavaScript
poll import, and a FIFO event drain for repeated pause requests
(`product-ready-mscordbi-dac-sidecar-plan.md:1364-1392`).

## Frequently asked questions

### Why can't I pause my Blazor app from the IDE?

Because MVP only stops at managed stop points reached by the runtime. Set a
managed breakpoint at the code you care about and let it fire. True Pause while
running is a Phase 13 candidate area, not an MVP promise.

### I set a breakpoint but it never fires. What should I check?

Check that the debugger is attached before the line runs, the breakpoint is on
reachable managed code, symbols/PDBs are available, the app is running under the
supported CoreCLR WASM debugging configuration, and you are debugging the one
runtime instance selected by the session.

### Will exceptions thrown deep in framework code stop the debugger?

They can, if the IDE has enabled the relevant first-chance or unhandled
exception stop policy and the exception reaches the managed exception event
path. User-code filtering and richer exception-object display are policy and
inspection layers, not separate stop primitives.

### Does this work in browsers other than Chrome?

The `debugger;` trigger itself is standard JavaScript and is expected to halt in
Chromium/V8, Firefox/SpiderMonkey, Safari/JavaScriptCore, and Node. The initial
IDE command channel follows the CDP `Runtime.evaluate` shape used by Blazor
today, so non-Chromium product support needs per-engine proxy adapters.

### Does this work in Node?

Node is a secondary development and CI harness target, not the primary product
host. The same V8 `debugger;` primitive can halt Node under the inspector, and
Phase 13 keeps Node inspector patterns as dev/CI accelerators.

### Why does the IDE say "paused on debugger statement" instead of "paused on breakpoint"?

The engine really did pause on a JavaScript `debugger;` statement in the runtime
pause import. The proxy should recognize that frame, read the managed event
payload, and present the managed breakpoint, step, exception, or loader stop to
the user.

### Will hot reload work?

No. Hot reload and edit-and-continue are outside this MVP stop/resume contract
and outside the Phase 13 async-pause candidate list.

### Can I debug a worker-hosted runtime?

Not as a separate runtime instance in MVP. Worker-hosted mechanisms are Phase 13
candidates for async pause and multi-instance debugging, but the plan does not
commit to shipping any one mechanism yet.

## References

| Claim or surface | Verified reference |
|---|---|
| MVP runtime-initiated stops use Mono-pattern `debugger;` from a JS import | `product-ready-mscordbi-dac-sidecar-plan.md:224-243`; `product-ready-mscordbi-dac-sidecar-plan.md:776-809` |
| Mono JS import executes `debugger;` for a debugger-agent message | `src/mono/browser/runtime/debug.ts:36-43` |
| Mono WASM runtime calls the JS debugger-agent message import | `src/mono/mono/component/mini-wasm-debugger.c:452-456` |
| Mono exposes an attach-state gate for JS to mark the debugger attached | Declaration: `src/mono/mono/component/mini-wasm-debugger.c:38`; definition: `src/mono/mono/component/mini-wasm-debugger.c:357-373` |
| Mono declines out-of-band suspend requests | `src/mono/mono/component/mini-wasm-debugger.c:87-91` |
| Mono `ensure_runtime_is_suspended` is a no-op success | `src/mono/mono/component/mini-wasm-debugger.c:123-127` |
| Phase 5 owns loader/thread lifecycle events and continue/detach handling | `product-ready-mscordbi-dac-sidecar-plan.md:693-750` |
| Phase 7 owns breakpoint, step, and exception event implementation | `product-ready-mscordbi-dac-sidecar-plan.md:894-931` |
| Phase 8 owns stack/frame/context/value inspection, including exception frames | `product-ready-mscordbi-dac-sidecar-plan.md:933-969` |
| Continue resumes by returning from the `debugger;` import frame | `product-ready-mscordbi-dac-sidecar-plan.md:819-825` |
| Async pause while running is Phase 13 follow-up scope | `product-ready-mscordbi-dac-sidecar-plan.md:1318-1335` |
| Phase 13 candidate mechanisms F-1 through F-4 | `product-ready-mscordbi-dac-sidecar-plan.md:1335-1362` |
| Phase 13 shared runtime-side machinery | `product-ready-mscordbi-dac-sidecar-plan.md:1364-1392` |
| Multi-runtime-instance debugging is deferred | `product-ready-mscordbi-dac-sidecar-plan.md:1499-1507` |
| Sidecar host imports, including `send_ipc_to_runtime` | `src/coreclr/debug/wasm-dbi-dac/README.md:52-64`; `src/coreclr/debug/wasm-dbi-dac/README.md:117-133` |
| Sidecar protocol-gated exports for breakpoint, continue, event, frame, and process-state polling | `src/coreclr/debug/wasm-dbi-dac/README.md:165-187` |
