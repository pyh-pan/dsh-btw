import { randomUUID, createHash } from 'node:crypto';
import { createNativeWorld } from './native-world.js';
import { sideToolNames } from './seed.js';

function assertText(value, name, { empty = false, max = 100000 } = {}) {
  if (typeof value !== 'string' || (!empty && !value.trim()) || value.length > max) {
    throw new TypeError(`${name} must be ${empty ? '' : 'nonempty '}text (at most ${max} characters)`);
  }
  return value;
}
function expired() { const e = new Error('Side conversation is closed or expired'); e.code = 'BTW_EXPIRED'; return e; }

/** Capture the admitted prefix via the public observation API, not deprecated
 * synchronous Session event readers. Read the boundary BEFORE the first await.
 */
export async function captureParent(ctx, parent, boundary = parent.session.seq) {
  const cwd = ctx.workingDirectory?.get(parent.session) ?? parent.session.header.cwd;
  const projections = ctx.get?.('sessionProjections');
  const loggedHeader = parent.session.requestHeader?.();
  const pendingSelection = projections?.stateOf(parent.session, 'modelSelection')?.pending;
  const deploymentDefault = loggedHeader ? {} : ctx.get?.('agentDefaultModel')?.currentSelection() ?? {};
  const initialModel = structuredClone({ ...deploymentDefault, ...parent.options, ...(loggedHeader?.config ?? {}) });
  for (const key of ['reasoningEffort', 'maxTokens']) if (loggedHeader?.adapterDefaults?.[key] === true) delete initialModel[key];
  if (pendingSelection && typeof pendingSelection.provider === 'string' && typeof pendingSelection.model === 'string') {
    initialModel.provider = pendingSelection.provider;
    initialModel.model = pendingSelection.model;
    delete initialModel.reasoningEffort;
    if (pendingSelection.reasoningEffort !== undefined) initialModel.reasoningEffort = pendingSelection.reasoningEffort;
  }
  const agentPreset = projections?.stateOf(parent.session, 'agentPreset') ?? parent.session.header.agentPreset;
  const schemas = parent.ctx?.tools?.schemas?.(parent);
  const toolNames = schemas ? sideToolNames(schemas) : undefined;
  const observation = await ctx.sessionQuery.observeSession(parent.id, { projectionMode: 'none' });
  try {
    if (observation.events.length < boundary) throw new Error('Parent snapshot prefix unavailable');
    const events = structuredClone(observation.events.slice(0, boundary));
    // Only an unconsumed modelSelection projection overrides the logged route;
    // replaying every old selection would resurrect an already-consumed choice.
    const agentOptions = {};
    for (const key of ['provider', 'model', 'reasoningEffort', 'maxTokens']) {
      if (initialModel[key] !== undefined) agentOptions[key] = initialModel[key];
    }
    return { events, cwd, model: agentOptions,
      agentPreset, ...(toolNames ? { toolNames } : {}),
      snapshotSeq: boundary ? boundary - 1 : null };
  } finally { observation[Symbol.dispose](); }
}

/** Host-owned ephemeral side runtime. native MUST contain canonical Host module
 * exports; no module import fallback may instantiate a duplicate scope registry.
 * createWorld/capture are narrow dependency seams for deterministic node tests.
 */
export async function createRuntime(ctx, options = {}) {
  const createWorld = options.createWorld ?? createNativeWorld;
  const capture = options.capture ?? captureParent;
  const mintId = options.mintId ?? (() => `btw-${randomUUID()}`);
  const now = options.now ?? Date.now;
  const entries = new Map();
  const creations = new Map();
  const closedIds = new Set();
  const closedTabs = new Set();
  let tabAdmissionClosed = false;
  let closing;
  let disposed = false;
  const lookup = sideId => {
    const entry = entries.get(sideId);
    if (!entry || entry.closed || entry.closing) throw expired();
    return entry;
  };
  const publish = entry => {
    if (entry.closed || entry.closing || entries.get(entry.meta.sideId) !== entry) return;
    entry.revision++;
    for (const listener of [...entry.listeners]) {
      try { listener({ sideId: entry.meta.sideId, revision: entry.revision }); } catch { /* isolate observers */ }
    }
  };
  const describe = entry => ({ ...entry.meta, revision: entry.revision });
  const authorize = (entry, parentSessionId) => {
    if (typeof parentSessionId !== 'string' || parentSessionId !== entry.meta.parentSessionId) {
      throw Object.assign(new Error('Side conversation does not belong to this main conversation'), { code: 'BTW_FORBIDDEN' });
    }
    return entry;
  };
  const state = ({ sideId, parentSessionId, display = false }) => {
    const entry = authorize(lookup(sideId), parentSessionId);
    if (!entry.world) throw new Error('Side conversation is still initializing');
    const raw = { ...describe(entry), ...entry.world.read(), closed: false };
    // The trusted synchronous wire projector can remove inherited/internal data
    // BEFORE cloning. SSE must not copy the entire main prefix on every token.
    const projected = display === true && options.projectState ? options.projectState(raw) : raw;
    if (projected && typeof projected.then === 'function') throw new TypeError('projectState must be synchronous');
    return structuredClone(projected);
  };
  const close = ({ sideId, parentSessionId, tabId }) => {
    assertText(parentSessionId, 'parentSessionId', { max: 256 });
    if (!sideId) assertText(tabId, 'tabId', { max: 256 });
    const entry = sideId ? entries.get(sideId) : [...entries.values()].find(value =>
      value.meta.parentSessionId === parentSessionId && value.meta.tabId === tabId);
    if (entry) authorize(entry, parentSessionId);
    const resolvedTab = entry?.meta.tabId ?? tabId;
    if (resolvedTab) {
      if (closedTabs.size < (options.maxCreationRequests ?? 10000)) closedTabs.add(`${parentSessionId}\0${resolvedTab}`);
      else tabAdmissionClosed = true;
    }
    if (!entry) return Promise.resolve({ ...(sideId ? { sideId } : {}), ...(resolvedTab ? { tabId: resolvedTab } : {}), closed: true });
    sideId = entry.meta.sideId;
    if (entry.closing) return entry.closing;
    // Synchronously reject admission, before waiting for any in-flight create.
    entry.closed = true;
    entry.closing = (async () => {
      try {
        await entry.ready?.catch(() => {});
        await entry.world?.dispose();
        entries.delete(sideId);
        closedIds.add(sideId);
        // Tombstones contain identifiers only; bound them to avoid a leak.
        if (closedIds.size > 2048) closedIds.delete(closedIds.values().next().value);
        entry.world = undefined;
        entry.cleanupError = undefined;
      } catch (error) {
        // Keep the CLOSED entry and native handle for explicit cleanup retry;
        // never expose its history or accidentally return successful deletion.
        entry.cleanupError = error;
        throw error;
      } finally {
        for (const listener of [...entry.listeners]) {
          try { listener({ sideId, revision: ++entry.revision, closed: true }); } catch {}
        }
        entry.listeners.clear();
        entry.sent.clear();
        entry.parent = undefined;
        entry.ready = undefined;
      }
      return { sideId, closed: true };
    })().catch(error => { entry.closing = undefined; throw error; });
    return entry.closing;
  };
  const runtime = {
    async create(request) {
      if (disposed) throw expired();
      const parentSessionId = assertText(request.parentSessionId, 'parentSessionId', { max: 256 });
      const requestId = assertText(request.requestId, 'requestId', { max: 256 });
      const tabId = assertText(request.tabId, 'tabId', { max: 256 });
      const question = request.question === undefined ? '' : assertText(request.question, 'question', { empty: true });
      if (closedTabs.has(`${parentSessionId}\0${tabId}`)) throw expired();
      if (tabAdmissionClosed) throw Object.assign(new Error('Temporary tab admission limit reached'), { code: 'BTW_LIMIT' });
      const key = `${parentSessionId}\0${requestId}`;
      const fingerprint = createHash('sha256').update(JSON.stringify({ tabId, question })).digest('hex');
      if (creations.has(key)) {
        const { sideId, fingerprint: previous } = creations.get(key);
        if (fingerprint !== previous) throw Object.assign(new Error('requestId was already used for a different creation'), { code: 'BTW_CONFLICT' });
        if (!entries.has(sideId)) throw expired();
        await entries.get(sideId).ready;
        return describe(lookup(sideId));
      }
      if (entries.size >= (options.maxConversations ?? 128) || creations.size >= (options.maxCreationRequests ?? 10000)) {
        throw Object.assign(new Error('Temporary conversation limit reached; close a tab or restart the Host'), { code: 'BTW_LIMIT' });
      }
      const parent = ctx.agents.get(parentSessionId);
      if (!parent) throw new Error('A live main conversation is required');
      const boundary = parent.session.seq;
      const sideId = mintId();
      if (entries.has(sideId) || closedIds.has(sideId)) throw new Error('Duplicate side identity');
      const entry = { meta: { sideId, parentSessionId, tabId,
        createdAt: now(), snapshotSeq: boundary ? boundary - 1 : null, inheritedEventCount: boundary },
        parent, revision: 0, listeners: new Set(), sent: new Map(), world: undefined, closed: false };
      entries.set(sideId, entry);
      creations.set(key, { sideId, fingerprint });
      entry.ready = (async () => {
        const snapshot = await capture(ctx, parent, boundary);
        if (entry.closed || disposed) throw expired();
        entry.world = await createWorld({ native: options.native, hostCtx: ctx, parent, capture: snapshot, sideId, onChange: () => publish(entry) });
        if (entry.closed || disposed) throw expired();
        if (question.trim()) entry.world.send(question);
        publish(entry);
      })();
      try { await entry.ready; }
      catch (error) {
        if (!entry.closing) {
          try { await close({ sideId, parentSessionId }); }
          catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Creation failed and cleanup requires retry'); }
        }
        throw error;
      }
      return describe(lookup(sideId));
    },
    send({ sideId, parentSessionId, requestId, text }) {
      const entry = authorize(lookup(sideId), parentSessionId);
      assertText(requestId, 'requestId', { max: 256 });
      assertText(text, 'text');
      if (!entry.world) throw new Error('Side conversation is still initializing');
      if (entry.sent.has(requestId)) {
        if (entry.sent.get(requestId) !== text) throw new Error('requestId was already used for different text');
        return { sideId, accepted: true, revision: entry.revision };
      }
      entry.sent.set(requestId, text);
      try { entry.world.send(text); } catch (error) { entry.sent.delete(requestId); throw error; }
      publish(entry);
      return { sideId, accepted: true, revision: entry.revision };
    },
    state,
    hasSide(sideId) { return entries.has(sideId) || closedIds.has(sideId); },
    stop({ sideId, parentSessionId }) { const entry = authorize(lookup(sideId), parentSessionId); entry.world?.stop(); publish(entry); return { sideId, stopped: true }; },
    close,
    list({ parentSessionId }) {
      assertText(parentSessionId, 'parentSessionId', { max: 256 });
      return [...entries.values()].filter(entry => !entry.closed && entry.meta.parentSessionId === parentSessionId).map(describe);
    },
    subscribe(sideId, listener) {
      if (typeof listener !== 'function') throw new TypeError('listener must be a function');
      const entry = lookup(sideId);
      entry.listeners.add(listener);
      return () => entry.listeners.delete(listener);
    },
    dispose() {
      if (closing) return closing;
      disposed = true;
      closing = (async () => {
        const results = await Promise.allSettled([...entries.values()].map(entry => close({ sideId: entry.meta.sideId, parentSessionId: entry.meta.parentSessionId })));
        creations.clear(); closedIds.clear(); closedTabs.clear();
        const failed = results.filter(result => result.status === 'rejected');
        if (failed.length) throw new AggregateError(failed.map(result => result.reason), 'Side runtime teardown failed');
      })().catch(error => { closing = undefined; throw error; });
      return closing;
    },
  };
  return runtime;
}
