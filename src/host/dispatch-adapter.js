/** DSH 0.2.1-rc.2 tool dispatch adapter.
 *
 * The native loop consumes the exported ToolRuntimeScheduler protocol. The
 * original service's scheduler contains constructor-owned arrows, which retain
 * its global event context even after Cordis caller tracing. A private facade
 * therefore supplies ONLY that protocol; dispatch delegates to the unchanged
 * original public execute() through canonical getTraceable(privateCtx, ...).
 * The original registry, restrictions and monotonic guards are not copied,
 * inspected, rewritten or bypassed. No nested execution token is fabricated.
 */
export function createPrivateToolFacade({ native, privateCtx, hostCtx, parentTools }) {
  if (native.version !== '0.2.1-rc.2') throw new Error('Private tool scheduler adapter requires DSH 0.2.1-rc.2');
  const { getTraceable, scopeTarget, TOOL_RUNTIME_SCHEDULER: schedulerKey } = native;
  if (typeof getTraceable !== 'function' || typeof scopeTarget !== 'function' || typeof schedulerKey !== 'symbol') {
    throw new Error('Canonical tool scheduler exports are unavailable');
  }
  if (!hostCtx || typeof hostCtx.waterfall !== 'function' || !hostCtx.events?.dispatch) {
    throw new Error('Host tool policy dispatch capability is unavailable');
  }
  const hostAgents = hostCtx.get?.('agents');
  if (typeof hostAgents?.withInitiator !== 'function') throw new Error('Host Agent initiator bridge is unavailable');
  const raw = parentTools[native.symbols.original] ?? parentTools;
  if (typeof raw.execute !== 'function' || typeof raw.executionMode !== 'function' || !raw[schedulerKey]) {
    throw new Error('Unsupported native tool runtime surface');
  }
  // Object.create does not modify the shared service. Public methods and its
  // native guard/restriction state remain inherited from the exact original.
  const facade = Object.create(raw);
  const executor = getTraceable(privateCtx, facade);
  Object.defineProperty(facade, schedulerKey, { value: Object.freeze({
    prepare: async exec => ({ kind: 'dispatch', exec }),
    dispatch: async exec => ({ kind: 'final-result', result: await hostAgents.withInitiator(exec.agent, () => executor.execute(exec)) }),
    finalize: async (_exec, result) => result,
    finish: (_exec, result) => result,
  }) });

  const carrier = exec => scopeTarget(raw, exec.agent);
  privateCtx.on('tools/pre-execute', (exec, next) =>
    hostCtx.waterfall(carrier(exec), 'tools/pre-execute', exec, next));
  privateCtx.on('tools/post-execute', (exec, result, next) =>
    hostCtx.waterfall(carrier(exec), 'tools/post-execute', exec, result, next));
  privateCtx.on('tools/result', (exec, result) => {
    // Result observers cannot fail the authoritative, already-settled outcome.
    const args = [carrier(exec), 'tools/result', exec, result];
    for (const callback of hostCtx.events.dispatch('emit', args)) {
      try { Promise.resolve(callback(...args)).catch(() => {}); } catch {}
    }
  });
  // Deliberately do NOT relay host tools/execute. Its ordinary Session durability
  // checkpoint cannot own an ephemeral Session. The shipped timeout wrapper is
  // mounted privately by createNativeWorld. Custom around-dispatch wrappers are
  // not supported by this version-locked adapter; pre/post/guards remain native.
  return facade;
}
