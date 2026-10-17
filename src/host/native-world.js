import { cancelInheritedInbox, sideToolNames, SIDE_CONTEXT_INSTRUCTION } from './seed.js';
import { createPrivateToolFacade } from './dispatch-adapter.js';

/** Create a tab-owned, independent Cordis root using canonical Host modules.
 * The caller supplies the actual Host module exports, NOT bundled duplicates.
 * Nothing publishes this root's session/agent events into the application root.
 */
export async function createNativeWorld({ native, hostCtx, parent, capture, sideId, onChange }) {
  const { Context, AgentRegistry, SessionStore, SessionProjectionRegistry, AgentLoop,
    bindScopeParent, createScope, buildForkSeed, createUserMessage } = native;
  for (const [name, value] of Object.entries({ Context, AgentRegistry, SessionStore,
    SessionProjectionRegistry, AgentLoop, bindScopeParent, createScope, buildForkSeed, createUserMessage })) {
    if (typeof value !== 'function') throw new Error(`Missing canonical native export: ${name}`);
  }
  if (typeof native.symbols?.original !== 'symbol') throw new Error('Missing canonical Cordis symbols export');
  const root = new Context();
  let handle;
  let disposing;
  let events;
  let assistantFrames = [];
  let error;
  const disposeRoot = async () => {
    await Promise.resolve(root.fiber.dispose());
    while (root.fiber.inertia !== undefined) await root.fiber.inertia;
  };
  try {
    // Only capabilities are borrowed. In particular, do NOT bridge persistence,
    // sessions, agents, projections, goals, subagents, teams, storage or events.
    for (const key of ['llm', 'systemPrompt']) {
      const service = parent.ctx.get(key);
      if (!service) throw new Error(`Parent lacks required ${key} capability`);
      // Strip an existing Cordis caller proxy before tracing against this root.
      root.reflect.provide(key, service[native.symbols.original] ?? service);
    }
    const parentTools = parent.ctx.get('tools');
    if (!parentTools) throw new Error('Parent lacks required tools capability');
    root.reflect.provide('tools', createPrivateToolFacade({ native, privateCtx: root,
      hostCtx: hostCtx ?? parent.ctx, parentTools }));
    if (typeof native.TimeoutPolicy?.apply !== 'function' || !Array.isArray(native.TimeoutPolicy.inject)) {
      throw new Error('Canonical native TimeoutPolicy module is unavailable');
    }
    await root.plugin(native.TimeoutPolicy);
    // Root-native events are private: default history/index/telemetry listeners
    // cannot see these sessions. There is intentionally no persistence backend.
    await root.plugin(AgentRegistry);
    await root.plugin(SessionStore);
    await root.plugin(SessionProjectionRegistry);
    const fork = capture.events.length ? buildForkSeed(capture.events, capture.events.length - 1) : [
      { type: 'session/end-seed', seq: 0, time: Date.now(), data: { inherited: true } },
    ];
    events = cancelInheritedInbox(fork);
    root.on('session/event', (session, event) => {
      if (session.id !== sideId) return;
      if (event.seq !== events.length) throw new Error('Private side-event cursor diverged');
      events.push(event);
      onChange();
    });
    root.on('agent/status', ({ agent }) => { if (agent.id === sideId) onChange(); });
    root.on('agent/error', ({ agent, error: cause }) => {
      if (agent.id !== sideId) return;
      error = cause instanceof Error ? cause.message : String(cause);
      onChange();
    });
    root.on('agent/assistant-stream', ({ agent, frame }) => {
      if (agent.id !== sideId) return;
      if (frame.type === 'start') assistantFrames = [];
      assistantFrames.push(frame);
      if (frame.type === 'end') assistantFrames = [];
      onChange();
    });
    // Direct constructors are supported public service exports. The Config
    // volatile getter is supplied explicitly because no Loader exists here.
    const loopScope = createScope(root, {});
    // A scope fiber does not implicitly declare dependencies. The standard
    // constructor reads projections immediately, so activate it under an
    // injected child fiber rather than constructing directly on loopScope.ctx.
    await loopScope.ctx.inject(['agents', 'sessions', 'llm', 'tools', 'systemPrompt', 'sessionProjections'], loopCtx => {
      new AgentLoop(loopCtx, { agents: [], maxParallelToolCalls: { get: () => 10 } });
    });
    const privateAgents = root.get('agents');
    const privateSessions = root.get('sessions');
    const privateProjections = root.get('sessionProjections');
    if (!privateAgents || !privateSessions || !privateProjections) throw new Error('Private native services did not activate');
    const model = capture.model;
    handle = await privateAgents.create({
      sessionId: sideId,
      seed: events,
      inheritedEventCount: capture.events.length,
      meta: {
        cwd: capture.cwd,
        parentSession: parent.id,
        isSeeded: true,
        ...(capture.agentPreset ? { agentPreset: capture.agentPreset } : {}),
      },
      agentOptions: model,
      setup(agentCtx, agent) {
        // This public link shares lookup ancestry, not event registries or
        // runtime ownership. exec.agent remains the NEW agent throughout.
        bindScopeParent(agent, parent);
        const currentTools = sideToolNames(parent.ctx.tools.schemas(parent));
        const capturedTools = capture.toolNames ? new Set(capture.toolNames) : undefined;
        const allow = capturedTools ? currentTools.filter(name => capturedTools.has(name)) : currentTools;
        agentCtx.tools.restrict({ allow });
        // Same bounded end-capabilities, directly in native mode. No PTC worker
        // process or fabricated nested execution token is admitted.
        agentCtx.tools.presentAs('native');
        // The borrowed native tool pipeline retains the application approval
        // service. Claim requests for this exact private Agent before any UI
        // answerer: without a private approval-addressing bridge, deny rather
        // than widening policy or asking in the main conversation.
        const approvalScope = createScope(hostCtx ?? parent.ctx, agent);
        approvalScope.ctx.on('approval/request', async (request, next) =>
          request.agent === agent ? 'rejected' : next(), { prepend: true });
        agentCtx.effect(() => () => approvalScope.dispose());
        agentCtx.systemPrompt.section({ name: 'btw:independent-side-conversation', order: 100000,
          text: SIDE_CONTEXT_INSTRUCTION, interpolate: false });
        if (agent.inbox.nextTurn.length || agent.inbox.nextStep.length) {
          throw new Error('Inherited executable inbox survived side fork');
        }
      },
    });
    // Validate before accepting any user input. No fallback to the global pool.
    if (root.get('sessionPersistence') || privateSessions.get(sideId) !== handle.agent.session) {
      throw new Error('Private side root is not memory-only');
    }
    return {
      agent: handle.agent,
      read() {
        return {
          header: handle.agent.session.header,
          inheritedEventCount: handle.agent.session.inheritedEventCount,
          events,
          projections: privateProjections.snapshot(handle.agent.session),
          running: handle.agent.status === 'running',
          status: handle.agent.status,
          assistantFrames,
          ...(error ? { error } : {}),
        };
      },
      send(text) {
        error = undefined;
        handle.agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }));
      },
      stop() { handle.agent.cancel({ kind: 'user' }, { keepInbox: true }); },
      dispose() {
        return disposing ??= (async () => {
          const failures = [];
          try { await handle.dispose(); } catch (error) { failures.push(error); }
          try { await disposeRoot(); } catch (error) { failures.push(error); }
          finally {
            // Release local snapshots even if a native cleanup reports failure.
            events.length = 0;
            assistantFrames.length = 0;
            error = undefined;
          }
          if (failures.length) throw new AggregateError(failures, 'Private side root cleanup failed');
          handle = undefined;
        })().catch(error => { disposing = undefined; throw error; });
      },
    };
  } catch (error) {
    try { await handle?.dispose(); } finally { await disposeRoot(); }
    throw error;
  }
}
