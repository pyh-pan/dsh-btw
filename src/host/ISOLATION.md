# Host isolation contract (DSH 0.2.1-rc.2)

The original read-only findings were obtained on rc.1 and the constructor,
factory-persistence and public service contracts were rechecked on rc.2.

## Why the ordinary factory is not used

Read-only inspection established that the installed `AgentLoop` retains its own
`runtime.ctx` in a plain holder. Its `createStoredSession()` resolves
`sessionPersistence` from that retained context, **before** the setup callback.
Changing the caller context or shadowing persistence during setup therefore
cannot turn an ordinary global Agent into a memory-only Agent.

The shipped session-log request contributor also looks up an outgoing request's
Session ID in its own global SessionStore before adding `dsh_session_log`.
A side Session must not enter that global store, even temporarily.

## Composition

Each tab owns a fresh public Cordis `Context`, with its own event dispatcher,
Agent registry, SessionStore, projection registry and standard AgentLoop. No
persistence backend, query index, projection cache, goal driver, team runtime,
subagent manager, or session logger is mounted in that root.

Only LLM, tools and system-prompt capabilities are borrowed. Existing Cordis
caller proxies are unwrapped through the exported `symbols.original` before the
private root traces them. A private loop scope prevents the loop's provider/model
prompt-variable registrations from touching the shared global layer. The loop
is constructed inside an injected child fiber declaring agents, sessions, LLM,
tools, systemPrompt and sessionProjections: a plain scope fiber does not satisfy
Cordis's service-injection checks.

All constructors and scope functions must come from the **canonical Host module
URLs**. A second npm/bundled copy of the scope package has different WeakMaps and
would silently lose ancestry, restrictions and guards. The runtime accepts the
canonical native exports by injection and has no fallback to ordinary creation.

`bindScopeParent(sideAgent, parentAgent)` is a public lookup-ancestry link; it is
not runtime child ownership and does not publish to the parent's event registry.

### Version-locked tool dispatch

An unchanged global ToolRuntime's scheduler contains constructor-owned arrows;
ordinary caller tracing does not rebind their context. Its global semantic
checkpoint calls the global SessionStore's `flush(sideSession)` before a tool
body and correctly rejects an unregistered private Session. Registering the side
in that store would fix the symptom by violating the privacy requirement.

The rc.2 adapter creates a private facade inheriting the original ToolRuntime,
overriding **only** the publicly exported `TOOL_RUNTIME_SCHEDULER` protocol.
Dispatch calls the original public `execute(exec)` through canonical Cordis
`getTraceable(privateCtx, facade)`. That public method does not call the captured
scheduler arrows. The original registry, restrictions and monotonic guards stay
on the original instance; no internal registry field is inspected or reassigned,
and no fake nested execution token is supplied. The Host registry's public
`withInitiator(sideAgent, operation)` also carries the exact side identity through
the borrowed tool's async chain, without inserting it into the global registry.

Host pre-execute, post-execute and result policies are bridged with the original
service's scoped carrier. Host around-dispatch events are not bridged because
their durable checkpoint cannot own a private Session. The shipped native timeout
wrapper is mounted privately. Custom third-party around-dispatch wrappers are not
supported by this **explicitly rc.2-locked** adapter; they must not be assumed to
execute. The original public pipeline receives `exec.agent === sideAgent`,
retaining native guards and writing conversation records to the side Session. Tools
are an explicit intersection with the parent's available read/read_image,
write/edit, glob/grep, web_search/web_fetch, working_directory, skill, todo_write,
Cordis inspection and dependency-location capabilities. Unknown/custom tools,
shell/terminal/PTY, background jobs, delegation, interactive user questions,
goals, schedules, installation and team manipulation are unavailable. This is a
native multi-step, tool-using Agent, not a no-tools LLM fallback.

An application-side scope owned by the exact private Agent claims any native
`approval/request` with `rejected`, before interactive answerers. Its disposer is
also owned by the private Agent scope. Existing policy can deny more, never
less; no approval request is redirected to the parent UI. Workspace file edits,
web requests, and native tool output artifacts are not claimed to be temporary
merely because the conversation is temporary.

## Snapshot and admission

Creation reads the current committed event boundary, route and cwd before its
first await, then obtains that exact prefix through `sessionQuery.observeSession`.
Only an unconsumed `modelSelection.pending` overrides the logged route; a blank
main conversation captures the deployment default. Tool names are frozen before
the observation await and intersected with the still-available parent surface.
It does not use deprecated synchronous Session event readers. The native
`buildForkSeed(events, inclusiveBoundary)` closes only an open inherited tail.
A pure replay then appends cancellation splices for every inherited pending inbox
entry. Neither a parent's pending tool call nor its pending prompt is resumed.
A distinct new followup is the only operation that wakes the side driver.

Create request IDs are idempotent and fingerprint their tab/question payload;
conflicting reuse fails. Send IDs likewise reject conflicting content. Every
addressed operation validates the parent Session ID. Snapshot events and state
responses are detached so callers cannot mutate the live private log. A trusted
synchronous `options.projectState` may project a `display: true` read before
cloning, excluding the inherited prefix, internal system records and provider
replay payloads. Default state reads retain their full detached semantics.

## Closing

Explicit close synchronously closes admission. It awaits initialization, drains
the native Agent handle, disposes the private root, clears local event/stream and
request caches, and removes the tab-owned runtime entry. Late notifications are
ignored. Closing by tab ID before the creation reply also blocks admission; a
tab tombstone rejects reordered create requests. Collapse, tab switching and
main-session switching do not call close.

Cleanup failures are not converted to successful deletion. The closed entry is
hidden from continuation/listing but retains the cleanup capability for an
explicit retry; the error reaches the caller. Host restart is the final expiry
boundary. Request tombstones contain identifiers/fingerprints, not conversation
text. Admission limits bound active roots and total create requests.

## Verification and remaining live checks

The zero-dependency node tests cover snapshot timing, independent continuation,
idempotency/conflict detection, authority, close/drain races, cleanup retry,
unload during creation, late events, owned subscriptions, inbox cancellation,
private-root composition and required canonical exports. Composition doubles are
explicitly **not** proof that a particular installed Host has executed the real
native loop. An additional opt-in integration test uses the real canonical
Cordis/AgentLoop/Session/projection implementations to check dependency injection,
empty creation, global-event/persistence isolation, and disposal without making a
model request. It is explicitly skipped in plain Node without an unpacked runtime.

Live acceptance must still exercise streaming, a normal read tool, cancellation,
concurrent tabs, global-history/index absence and shutdown cleanup. In particular:

- A prefix requiring a plugin-owned message interpreter (such as `image/offload`)
  must fail closed if that interpreter is unavailable in the private SessionStore;
  it must never silently drop records or fall back to global storage.
- Native approval/question interfaces assume global Agent lookup. Interactive
  question tools are not inherited, and exact-side approval requests are rejected
  before any application UI answerer.
- Detached jobs/PTY tools are excluded. Enabling them in the future requires an
  independently verified owner-disposal path; standard foreground Agent drain
  alone does not prove removal of a global background registry's output caches.
- Allowed native tools can still create their normal workspace/output artifacts
  (for example a large-output spill). The plugin's memory-only guarantee covers
  the side's session history and its own transcript/stream/request caches, not
  arbitrary tool side effects or an external model provider's retention policy.
- The committed history, model and cwd are creation snapshots. Borrowed preset
  layers remain scope-based; changing the parent preset after creation requires
  separate live testing and must not widen the side's policy.

No Client, profile, root manifest or installation is changed by this Host module.
