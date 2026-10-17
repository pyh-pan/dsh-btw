// src/native-loader.js
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { isAbsolute, join } from "node:path";
var SUPPORTED_DSH = "0.2.1-rc.2";
var PACKAGES = {
  "@deepseek-ai/cordis": ["Context", "symbols", "getTraceable"],
  "@deepseek-ai/dsh-agent": ["AgentRegistry"],
  "@deepseek-ai/dsh-session": ["SessionStore", "buildForkSeed"],
  "@deepseek-ai/dsh-session-projection": ["SessionProjectionRegistry"],
  "@deepseek-ai/dsh-agent-loop": ["AgentLoop"],
  "@deepseek-ai/dsh-scope": ["bindScopeParent", "createScope", "scopeTarget"],
  "@deepseek-ai/dsh-tools": ["TOOL_RUNTIME_SCHEDULER", "ToolRuntime"],
  "@deepseek-ai/dsh-llm": ["createUserMessage"]
};
async function loadNativeModules(options = {}) {
  const anchors = [];
  if (options.runtimePath) anchors.push(pathToFileURL(join(options.runtimePath, "package.json")).href);
  if (process.resourcesPath) anchors.push(pathToFileURL(join(process.resourcesPath, "app.asar", "dsh", "package.json")).href);
  if (process.argv[1] && isAbsolute(process.argv[1])) anchors.push(pathToFileURL(process.argv[1]).href);
  anchors.push(import.meta.url);
  const attempts = [];
  for (const anchor of [...new Set(anchors)]) {
    try {
      const probe = createRequire(anchor);
      const manifestPath = probe.resolve("@deepseek-ai/dsh/package.json");
      const resolve = createRequire(manifestPath);
      const manifest = resolve(manifestPath);
      if (manifest.version !== SUPPORTED_DSH) {
        throw new Error(`dsh-btw requires DSH ${SUPPORTED_DSH}; found ${manifest.version}`);
      }
      const native = { version: manifest.version };
      for (const [name, symbols] of Object.entries(PACKAGES)) {
        const entry = resolve.resolve(name);
        const module = await import(pathToFileURL(entry).href);
        for (const symbol of symbols) {
          const expected = symbol === "symbols" ? "object" : symbol === "TOOL_RUNTIME_SCHEDULER" ? "symbol" : "function";
          if (typeof module[symbol] !== expected || module[symbol] === null) throw new Error(`Missing public export ${name}#${symbol}`);
          native[symbol] = module[symbol];
        }
      }
      native.TimeoutPolicy = await import(pathToFileURL(resolve.resolve("@deepseek-ai/dsh-tool-call-timeout-policy")).href);
      if (typeof native.TimeoutPolicy.apply !== "function" || !Array.isArray(native.TimeoutPolicy.inject)) {
        throw new Error("Missing public timeout policy module");
      }
      return native;
    } catch (error) {
      attempts.push(error.message);
    }
  }
  throw new Error(`Cannot resolve the supported serving DSH runtime: ${[...new Set(attempts)].join("; ")}`);
}

// src/host/runtime.js
import { randomUUID, createHash } from "node:crypto";

// src/host/seed.js
function cancelInheritedInbox(events, now = Date.now) {
  const pending = { "next-step": [], "next-turn": [] };
  for (const event of events) {
    if (event.type !== "agent/inbox/spliced") continue;
    const { target, start, removedCount = 0, inserted } = event.data;
    const list = pending[target];
    if (!list || !Number.isSafeInteger(start) || start < 0 || start > list.length || !Number.isSafeInteger(removedCount) || removedCount < 0 || start + removedCount > list.length || !Array.isArray(inserted)) {
      throw new Error("Invalid inherited inbox splice");
    }
    list.splice(start, removedCount, ...inserted);
  }
  const seed = structuredClone(events);
  for (const target of ["next-step", "next-turn"]) {
    if (!pending[target].length) continue;
    seed.push({ type: "agent/inbox/spliced", seq: seed.length, time: now(), data: {
      target,
      start: 0,
      removedCount: pending[target].length,
      inserted: [],
      outcome: "canceled"
    } });
  }
  return seed;
}
var SIDE_TOOL_ALLOWLIST = Object.freeze([
  "read",
  "read_image",
  "write",
  "edit",
  "glob",
  "grep",
  "web_search",
  "web_fetch",
  "working_directory",
  "skill",
  "todo_write",
  "cordis_inspect_list",
  "cordis_inspect_query",
  "load_workspace_dependencies"
]);
var allowedTools = new Set(SIDE_TOOL_ALLOWLIST);
function sideToolNames(schemas) {
  return schemas.map(({ name }) => name).filter((name) => allowedTools.has(name));
}
var SIDE_CONTEXT_INSTRUCTION = `This is a temporary, independent side conversation. The inherited main conversation is reference material only: do not resume its tasks, pending inputs, goals, team work, or approvals. Answer only the new messages in this side conversation. Never send messages, completion reports, questions, or results to the main conversation or a team. Conversation history exists only in this Host process and is discarded on explicit close. Normal workspace tools retain their existing authorization; temporary conversation history does not make external tool side effects temporary.`;

// src/host/dispatch-adapter.js
function createPrivateToolFacade({ native, privateCtx, hostCtx, parentTools }) {
  if (native.version !== "0.2.1-rc.2") throw new Error("Private tool scheduler adapter requires DSH 0.2.1-rc.2");
  const { getTraceable, scopeTarget, TOOL_RUNTIME_SCHEDULER: schedulerKey } = native;
  if (typeof getTraceable !== "function" || typeof scopeTarget !== "function" || typeof schedulerKey !== "symbol") {
    throw new Error("Canonical tool scheduler exports are unavailable");
  }
  if (!hostCtx || typeof hostCtx.waterfall !== "function" || !hostCtx.events?.dispatch) {
    throw new Error("Host tool policy dispatch capability is unavailable");
  }
  const hostAgents = hostCtx.get?.("agents");
  if (typeof hostAgents?.withInitiator !== "function") throw new Error("Host Agent initiator bridge is unavailable");
  const raw = parentTools[native.symbols.original] ?? parentTools;
  if (typeof raw.execute !== "function" || typeof raw.executionMode !== "function" || !raw[schedulerKey]) {
    throw new Error("Unsupported native tool runtime surface");
  }
  const facade = Object.create(raw);
  const executor = getTraceable(privateCtx, facade);
  Object.defineProperty(facade, schedulerKey, { value: Object.freeze({
    prepare: async (exec) => ({ kind: "dispatch", exec }),
    dispatch: async (exec) => ({ kind: "final-result", result: await hostAgents.withInitiator(exec.agent, () => executor.execute(exec)) }),
    finalize: async (_exec, result) => result,
    finish: (_exec, result) => result
  }) });
  const carrier = (exec) => scopeTarget(raw, exec.agent);
  privateCtx.on("tools/pre-execute", (exec, next) => hostCtx.waterfall(carrier(exec), "tools/pre-execute", exec, next));
  privateCtx.on("tools/post-execute", (exec, result, next) => hostCtx.waterfall(carrier(exec), "tools/post-execute", exec, result, next));
  privateCtx.on("tools/result", (exec, result) => {
    const args = [carrier(exec), "tools/result", exec, result];
    for (const callback of hostCtx.events.dispatch("emit", args)) {
      try {
        Promise.resolve(callback(...args)).catch(() => {
        });
      } catch {
      }
    }
  });
  return facade;
}

// src/host/native-world.js
async function createNativeWorld({ native, hostCtx, parent, capture, sideId, onChange }) {
  const {
    Context,
    AgentRegistry,
    SessionStore,
    SessionProjectionRegistry,
    AgentLoop,
    bindScopeParent,
    createScope,
    buildForkSeed,
    createUserMessage
  } = native;
  for (const [name, value] of Object.entries({
    Context,
    AgentRegistry,
    SessionStore,
    SessionProjectionRegistry,
    AgentLoop,
    bindScopeParent,
    createScope,
    buildForkSeed,
    createUserMessage
  })) {
    if (typeof value !== "function") throw new Error(`Missing canonical native export: ${name}`);
  }
  if (typeof native.symbols?.original !== "symbol") throw new Error("Missing canonical Cordis symbols export");
  const root = new Context();
  let handle;
  let disposing;
  let events;
  let assistantFrames = [];
  let error;
  const disposeRoot = async () => {
    await Promise.resolve(root.fiber.dispose());
    while (root.fiber.inertia !== void 0) await root.fiber.inertia;
  };
  try {
    for (const key of ["llm", "systemPrompt"]) {
      const service = parent.ctx.get(key);
      if (!service) throw new Error(`Parent lacks required ${key} capability`);
      root.reflect.provide(key, service[native.symbols.original] ?? service);
    }
    const parentTools = parent.ctx.get("tools");
    if (!parentTools) throw new Error("Parent lacks required tools capability");
    root.reflect.provide("tools", createPrivateToolFacade({
      native,
      privateCtx: root,
      hostCtx: hostCtx ?? parent.ctx,
      parentTools
    }));
    if (typeof native.TimeoutPolicy?.apply !== "function" || !Array.isArray(native.TimeoutPolicy.inject)) {
      throw new Error("Canonical native TimeoutPolicy module is unavailable");
    }
    await root.plugin(native.TimeoutPolicy);
    await root.plugin(AgentRegistry);
    await root.plugin(SessionStore);
    await root.plugin(SessionProjectionRegistry);
    const fork = capture.events.length ? buildForkSeed(capture.events, capture.events.length - 1) : [
      { type: "session/end-seed", seq: 0, time: Date.now(), data: { inherited: true } }
    ];
    events = cancelInheritedInbox(fork);
    root.on("session/event", (session, event) => {
      if (session.id !== sideId) return;
      if (event.seq !== events.length) throw new Error("Private side-event cursor diverged");
      events.push(event);
      onChange();
    });
    root.on("agent/status", ({ agent }) => {
      if (agent.id === sideId) onChange();
    });
    root.on("agent/error", ({ agent, error: cause }) => {
      if (agent.id !== sideId) return;
      error = cause instanceof Error ? cause.message : String(cause);
      onChange();
    });
    root.on("agent/assistant-stream", ({ agent, frame }) => {
      if (agent.id !== sideId) return;
      if (frame.type === "start") assistantFrames = [];
      assistantFrames.push(frame);
      if (frame.type === "end") assistantFrames = [];
      onChange();
    });
    const loopScope = createScope(root, {});
    await loopScope.ctx.inject(["agents", "sessions", "llm", "tools", "systemPrompt", "sessionProjections"], (loopCtx) => {
      new AgentLoop(loopCtx, { agents: [], maxParallelToolCalls: { get: () => 10 } });
    });
    const privateAgents = root.get("agents");
    const privateSessions = root.get("sessions");
    const privateProjections = root.get("sessionProjections");
    if (!privateAgents || !privateSessions || !privateProjections) throw new Error("Private native services did not activate");
    const model = capture.model;
    handle = await privateAgents.create({
      sessionId: sideId,
      seed: events,
      inheritedEventCount: capture.events.length,
      meta: {
        cwd: capture.cwd,
        parentSession: parent.id,
        isSeeded: true,
        ...capture.agentPreset ? { agentPreset: capture.agentPreset } : {}
      },
      agentOptions: model,
      setup(agentCtx, agent) {
        bindScopeParent(agent, parent);
        const currentTools = sideToolNames(parent.ctx.tools.schemas(parent));
        const capturedTools = capture.toolNames ? new Set(capture.toolNames) : void 0;
        const allow = capturedTools ? currentTools.filter((name) => capturedTools.has(name)) : currentTools;
        agentCtx.tools.restrict({ allow });
        agentCtx.tools.presentAs("native");
        const approvalScope = createScope(hostCtx ?? parent.ctx, agent);
        approvalScope.ctx.on("approval/request", async (request, next) => request.agent === agent ? "rejected" : next(), { prepend: true });
        agentCtx.effect(() => () => approvalScope.dispose());
        agentCtx.systemPrompt.section({
          name: "btw:independent-side-conversation",
          order: 1e5,
          text: SIDE_CONTEXT_INSTRUCTION,
          interpolate: false
        });
        if (agent.inbox.nextTurn.length || agent.inbox.nextStep.length) {
          throw new Error("Inherited executable inbox survived side fork");
        }
      }
    });
    if (root.get("sessionPersistence") || privateSessions.get(sideId) !== handle.agent.session) {
      throw new Error("Private side root is not memory-only");
    }
    return {
      agent: handle.agent,
      read() {
        return {
          header: handle.agent.session.header,
          inheritedEventCount: handle.agent.session.inheritedEventCount,
          events,
          projections: privateProjections.snapshot(handle.agent.session),
          running: handle.agent.status === "running",
          status: handle.agent.status,
          assistantFrames,
          ...error ? { error } : {}
        };
      },
      send(text) {
        error = void 0;
        handle.agent.followup(createUserMessage({ content: [{ type: "text", text }], source: { kind: "user" } }));
      },
      stop() {
        handle.agent.cancel({ kind: "user" }, { keepInbox: true });
      },
      dispose() {
        return disposing ??= (async () => {
          const failures = [];
          try {
            await handle.dispose();
          } catch (error2) {
            failures.push(error2);
          }
          try {
            await disposeRoot();
          } catch (error2) {
            failures.push(error2);
          } finally {
            events.length = 0;
            assistantFrames.length = 0;
            error = void 0;
          }
          if (failures.length) throw new AggregateError(failures, "Private side root cleanup failed");
          handle = void 0;
        })().catch((error2) => {
          disposing = void 0;
          throw error2;
        });
      }
    };
  } catch (error2) {
    try {
      await handle?.dispose();
    } finally {
      await disposeRoot();
    }
    throw error2;
  }
}

// src/host/runtime.js
function assertText(value, name, { empty = false, max = 1e5 } = {}) {
  if (typeof value !== "string" || !empty && !value.trim() || value.length > max) {
    throw new TypeError(`${name} must be ${empty ? "" : "nonempty "}text (at most ${max} characters)`);
  }
  return value;
}
function expired() {
  const e = new Error("Side conversation is closed or expired");
  e.code = "BTW_EXPIRED";
  return e;
}
async function captureParent(ctx, parent, boundary = parent.session.seq) {
  const cwd = ctx.workingDirectory?.get(parent.session) ?? parent.session.header.cwd;
  const projections = ctx.get?.("sessionProjections");
  const loggedHeader = parent.session.requestHeader?.();
  const pendingSelection = projections?.stateOf(parent.session, "modelSelection")?.pending;
  const deploymentDefault = loggedHeader ? {} : ctx.get?.("agentDefaultModel")?.currentSelection() ?? {};
  const initialModel = structuredClone({ ...deploymentDefault, ...parent.options, ...loggedHeader?.config ?? {} });
  for (const key of ["reasoningEffort", "maxTokens"]) if (loggedHeader?.adapterDefaults?.[key] === true) delete initialModel[key];
  if (pendingSelection && typeof pendingSelection.provider === "string" && typeof pendingSelection.model === "string") {
    initialModel.provider = pendingSelection.provider;
    initialModel.model = pendingSelection.model;
    delete initialModel.reasoningEffort;
    if (pendingSelection.reasoningEffort !== void 0) initialModel.reasoningEffort = pendingSelection.reasoningEffort;
  }
  const agentPreset = projections?.stateOf(parent.session, "agentPreset") ?? parent.session.header.agentPreset;
  const schemas = parent.ctx?.tools?.schemas?.(parent);
  const toolNames = schemas ? sideToolNames(schemas) : void 0;
  const observation = await ctx.sessionQuery.observeSession(parent.id, { projectionMode: "none" });
  try {
    if (observation.events.length < boundary) throw new Error("Parent snapshot prefix unavailable");
    const events = structuredClone(observation.events.slice(0, boundary));
    const agentOptions = {};
    for (const key of ["provider", "model", "reasoningEffort", "maxTokens"]) {
      if (initialModel[key] !== void 0) agentOptions[key] = initialModel[key];
    }
    return {
      events,
      cwd,
      model: agentOptions,
      agentPreset,
      ...toolNames ? { toolNames } : {},
      snapshotSeq: boundary ? boundary - 1 : null
    };
  } finally {
    observation[Symbol.dispose]();
  }
}
async function createRuntime(ctx, options = {}) {
  const createWorld = options.createWorld ?? createNativeWorld;
  const capture = options.capture ?? captureParent;
  const mintId = options.mintId ?? (() => `btw-${randomUUID()}`);
  const now = options.now ?? Date.now;
  const entries = /* @__PURE__ */ new Map();
  const creations = /* @__PURE__ */ new Map();
  const closedIds = /* @__PURE__ */ new Set();
  const closedTabs = /* @__PURE__ */ new Set();
  let tabAdmissionClosed = false;
  let closing;
  let disposed = false;
  const lookup = (sideId) => {
    const entry = entries.get(sideId);
    if (!entry || entry.closed || entry.closing) throw expired();
    return entry;
  };
  const publish = (entry) => {
    if (entry.closed || entry.closing || entries.get(entry.meta.sideId) !== entry) return;
    entry.revision++;
    for (const listener of [...entry.listeners]) {
      try {
        listener({ sideId: entry.meta.sideId, revision: entry.revision });
      } catch {
      }
    }
  };
  const describe = (entry) => ({ ...entry.meta, revision: entry.revision });
  const authorize = (entry, parentSessionId) => {
    if (typeof parentSessionId !== "string" || parentSessionId !== entry.meta.parentSessionId) {
      throw Object.assign(new Error("Side conversation does not belong to this main conversation"), { code: "BTW_FORBIDDEN" });
    }
    return entry;
  };
  const state = ({ sideId, parentSessionId, display = false }) => {
    const entry = authorize(lookup(sideId), parentSessionId);
    if (!entry.world) throw new Error("Side conversation is still initializing");
    const raw = { ...describe(entry), ...entry.world.read(), closed: false };
    const projected = display === true && options.projectState ? options.projectState(raw) : raw;
    if (projected && typeof projected.then === "function") throw new TypeError("projectState must be synchronous");
    return structuredClone(projected);
  };
  const close = ({ sideId, parentSessionId, tabId }) => {
    assertText(parentSessionId, "parentSessionId", { max: 256 });
    if (!sideId) assertText(tabId, "tabId", { max: 256 });
    const entry = sideId ? entries.get(sideId) : [...entries.values()].find((value) => value.meta.parentSessionId === parentSessionId && value.meta.tabId === tabId);
    if (entry) authorize(entry, parentSessionId);
    const resolvedTab = entry?.meta.tabId ?? tabId;
    if (resolvedTab) {
      if (closedTabs.size < (options.maxCreationRequests ?? 1e4)) closedTabs.add(`${parentSessionId}\0${resolvedTab}`);
      else tabAdmissionClosed = true;
    }
    if (!entry) return Promise.resolve({ ...sideId ? { sideId } : {}, ...resolvedTab ? { tabId: resolvedTab } : {}, closed: true });
    sideId = entry.meta.sideId;
    if (entry.closing) return entry.closing;
    entry.closed = true;
    entry.closing = (async () => {
      try {
        await entry.ready?.catch(() => {
        });
        await entry.world?.dispose();
        entries.delete(sideId);
        closedIds.add(sideId);
        if (closedIds.size > 2048) closedIds.delete(closedIds.values().next().value);
        entry.world = void 0;
        entry.cleanupError = void 0;
      } catch (error) {
        entry.cleanupError = error;
        throw error;
      } finally {
        for (const listener of [...entry.listeners]) {
          try {
            listener({ sideId, revision: ++entry.revision, closed: true });
          } catch {
          }
        }
        entry.listeners.clear();
        entry.sent.clear();
        entry.parent = void 0;
        entry.ready = void 0;
      }
      return { sideId, closed: true };
    })().catch((error) => {
      entry.closing = void 0;
      throw error;
    });
    return entry.closing;
  };
  const runtime = {
    async create(request) {
      if (disposed) throw expired();
      const parentSessionId = assertText(request.parentSessionId, "parentSessionId", { max: 256 });
      const requestId = assertText(request.requestId, "requestId", { max: 256 });
      const tabId = assertText(request.tabId, "tabId", { max: 256 });
      const question = request.question === void 0 ? "" : assertText(request.question, "question", { empty: true });
      if (closedTabs.has(`${parentSessionId}\0${tabId}`)) throw expired();
      if (tabAdmissionClosed) throw Object.assign(new Error("Temporary tab admission limit reached"), { code: "BTW_LIMIT" });
      const key = `${parentSessionId}\0${requestId}`;
      const fingerprint = createHash("sha256").update(JSON.stringify({ tabId, question })).digest("hex");
      if (creations.has(key)) {
        const { sideId: sideId2, fingerprint: previous } = creations.get(key);
        if (fingerprint !== previous) throw Object.assign(new Error("requestId was already used for a different creation"), { code: "BTW_CONFLICT" });
        if (!entries.has(sideId2)) throw expired();
        await entries.get(sideId2).ready;
        return describe(lookup(sideId2));
      }
      if (entries.size >= (options.maxConversations ?? 128) || creations.size >= (options.maxCreationRequests ?? 1e4)) {
        throw Object.assign(new Error("Temporary conversation limit reached; close a tab or restart the Host"), { code: "BTW_LIMIT" });
      }
      const parent = ctx.agents.get(parentSessionId);
      if (!parent) throw new Error("A live main conversation is required");
      const boundary = parent.session.seq;
      const sideId = mintId();
      if (entries.has(sideId) || closedIds.has(sideId)) throw new Error("Duplicate side identity");
      const entry = {
        meta: {
          sideId,
          parentSessionId,
          tabId,
          createdAt: now(),
          snapshotSeq: boundary ? boundary - 1 : null,
          inheritedEventCount: boundary
        },
        parent,
        revision: 0,
        listeners: /* @__PURE__ */ new Set(),
        sent: /* @__PURE__ */ new Map(),
        world: void 0,
        closed: false
      };
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
      try {
        await entry.ready;
      } catch (error) {
        if (!entry.closing) {
          try {
            await close({ sideId, parentSessionId });
          } catch (cleanupError) {
            throw new AggregateError([error, cleanupError], "Creation failed and cleanup requires retry");
          }
        }
        throw error;
      }
      return describe(lookup(sideId));
    },
    send({ sideId, parentSessionId, requestId, text }) {
      const entry = authorize(lookup(sideId), parentSessionId);
      assertText(requestId, "requestId", { max: 256 });
      assertText(text, "text");
      if (!entry.world) throw new Error("Side conversation is still initializing");
      if (entry.sent.has(requestId)) {
        if (entry.sent.get(requestId) !== text) throw new Error("requestId was already used for different text");
        return { sideId, accepted: true, revision: entry.revision };
      }
      entry.sent.set(requestId, text);
      try {
        entry.world.send(text);
      } catch (error) {
        entry.sent.delete(requestId);
        throw error;
      }
      publish(entry);
      return { sideId, accepted: true, revision: entry.revision };
    },
    state,
    hasSide(sideId) {
      return entries.has(sideId) || closedIds.has(sideId);
    },
    stop({ sideId, parentSessionId }) {
      const entry = authorize(lookup(sideId), parentSessionId);
      entry.world?.stop();
      publish(entry);
      return { sideId, stopped: true };
    },
    close,
    list({ parentSessionId }) {
      assertText(parentSessionId, "parentSessionId", { max: 256 });
      return [...entries.values()].filter((entry) => !entry.closed && entry.meta.parentSessionId === parentSessionId).map(describe);
    },
    subscribe(sideId, listener) {
      if (typeof listener !== "function") throw new TypeError("listener must be a function");
      const entry = lookup(sideId);
      entry.listeners.add(listener);
      return () => entry.listeners.delete(listener);
    },
    dispose() {
      if (closing) return closing;
      disposed = true;
      closing = (async () => {
        const results = await Promise.allSettled([...entries.values()].map((entry) => close({ sideId: entry.meta.sideId, parentSessionId: entry.meta.parentSessionId })));
        creations.clear();
        closedIds.clear();
        closedTabs.clear();
        const failed = results.filter((result) => result.status === "rejected");
        if (failed.length) throw new AggregateError(failed.map((result) => result.reason), "Side runtime teardown failed");
      })().catch((error) => {
        closing = void 0;
        throw error;
      });
      return closing;
    }
  };
  return runtime;
}

// src/shared/protocol.js
var API_PATH = "/plugins/dsh-btw/api";
var EVENTS_PATH = "/plugins/dsh-btw/events";
var MAX_BODY_BYTES = 128 * 1024;
var MAX_TEXT_LENGTH = 64 * 1024;
var METHODS = Object.freeze(["create", "send", "state", "stop", "close", "list"]);
function errorRecord(error) {
  return {
    code: typeof error?.code === "string" ? error.code : "BTW_ERROR",
    message: error instanceof Error ? error.message : String(error)
  };
}
function assertObject(value, name = "arguments") {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw Object.assign(new Error(`${name} must be an object`), { code: "BAD_REQUEST" });
  }
  return value;
}
function validateCall(method, rawArgs = {}) {
  if (!METHODS.includes(method)) throw Object.assign(new Error("Unknown BTW operation"), { code: "BAD_REQUEST" });
  const args = assertObject(rawArgs);
  const required = method === "create" ? ["parentSessionId", "requestId", "tabId"] : method === "list" ? ["parentSessionId"] : method === "close" && !args.sideId ? ["parentSessionId", "tabId"] : ["parentSessionId", "sideId"];
  if (method === "send") required.push("requestId", "text");
  for (const key of required) {
    if (typeof args[key] !== "string" || !args[key].trim()) {
      throw Object.assign(new Error(`${key} is required`), { code: "BAD_REQUEST" });
    }
    if (key !== "text" && args[key].length > 2048) {
      throw Object.assign(new Error(`${key} is too long`), { code: "BAD_REQUEST" });
    }
  }
  for (const key of ["text", "question"]) {
    if (args[key] !== void 0 && (typeof args[key] !== "string" || args[key].length > MAX_TEXT_LENGTH)) {
      throw Object.assign(new Error(`${key} must be at most ${MAX_TEXT_LENGTH} characters`), { code: "BAD_REQUEST" });
    }
  }
  return { ...args };
}

// src/transport.js
function writeJson(response, status, value) {
  if (response.writableEnded || response.destroyed) return;
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });
  response.end(JSON.stringify(value));
}
async function readJson(request, limit = MAX_BODY_BYTES) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += bytes.byteLength;
    if (length > limit) throw Object.assign(new Error("Request body is too large"), { code: "BODY_TOO_LARGE" });
    chunks.push(bytes);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw Object.assign(new Error("Invalid JSON body"), { code: "BAD_REQUEST" });
  }
}
function withoutReplay(value) {
  if (Array.isArray(value)) return value.map(withoutReplay);
  if (!value || typeof value !== "object") return value;
  const clean = {};
  for (const [key, item] of Object.entries(value)) {
    if (key !== "replayState") clean[key] = withoutReplay(item);
  }
  return clean;
}
function publicState(state) {
  if (!state || !Array.isArray(state.events)) return state;
  const inherited = state.inheritedEventCount ?? 0;
  const contextEventCount = state.contextEventCount ?? inherited;
  const visible = /* @__PURE__ */ new Set(["user/message", "assistant/message", "assistant/attempt", "tool/result", "turn/end", "step/end"]);
  const events = state.events.slice(inherited).filter((event) => !event || typeof event !== "object" || visible.has(event.type)).map(withoutReplay);
  return { ...state, events, inheritedEventCount: 0, contextEventCount, assistantFrames: withoutReplay(state.assistantFrames ?? []) };
}
async function invokeRuntime(runtime, method, rawArgs) {
  const args = validateCall(method, rawArgs);
  const value = await runtime[method](method === "state" ? { ...args, display: true } : args);
  return method === "state" ? publicState(value) : value;
}
function registerTransport(ctx, runtime) {
  const responses = /* @__PURE__ */ new Set();
  const authorize = (request, response) => {
    const admission = ctx.connection.admit({ headers: request.headers });
    if (admission.rejection || admission.peer?.principal?.kind !== "owner") {
      writeJson(response, admission.rejection ?? 403, { ok: false, error: { code: "FORBIDDEN", message: "An authenticated DSH owner connection is required" } });
      return false;
    }
    return true;
  };
  const api = ctx.webServer.register({
    kind: "exact",
    path: API_PATH,
    async handler(request, response) {
      if (!authorize(request, response)) return;
      if (request.method !== "POST") {
        writeJson(response, 405, { ok: false, error: { code: "METHOD_NOT_ALLOWED", message: "Use POST" } });
        return;
      }
      if (!(request.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
        writeJson(response, 415, { ok: false, error: { code: "CONTENT_TYPE", message: "Use application/json" } });
        return;
      }
      try {
        const { method, args } = await readJson(request);
        const value = await invokeRuntime(runtime, method, args);
        writeJson(response, 200, { ok: true, value: value ?? null });
      } catch (error) {
        const status = error.code === "BODY_TOO_LARGE" ? 413 : error.code === "BAD_REQUEST" ? 400 : error.code === "FORBIDDEN" ? 403 : 409;
        writeJson(response, status, { ok: false, error: errorRecord(error) });
      }
    }
  });
  const events = ctx.webServer.register({
    kind: "exact",
    path: EVENTS_PATH,
    async handler(request, response) {
      if (!authorize(request, response)) return;
      if (request.method !== "GET") {
        writeJson(response, 405, { ok: false, error: { code: "METHOD_NOT_ALLOWED", message: "Use GET" } });
        return;
      }
      const url = new URL(request.url, "http://localhost");
      const args = { sideId: url.searchParams.get("sideId"), parentSessionId: url.searchParams.get("parentSessionId") };
      let initial;
      try {
        initial = await invokeRuntime(runtime, "state", args);
      } catch (error) {
        writeJson(response, 410, { ok: false, error: errorRecord(error) });
        return;
      }
      response.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-store",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
        "X-Content-Type-Options": "nosniff"
      });
      response.flushHeaders?.();
      responses.add(response);
      let unsubscribe = () => {
      };
      let heartbeat;
      let updateTimer;
      let ended = false;
      const finish = () => {
        if (ended) return;
        ended = true;
        clearInterval(heartbeat);
        clearTimeout(updateTimer);
        unsubscribe();
        responses.delete(response);
        if (!response.writableEnded && !response.destroyed) response.end();
      };
      const publish = (value) => {
        if (ended || response.destroyed || response.writableEnded) return;
        response.write(`data: ${JSON.stringify(value)}

`);
        if (value?.closed === true || value?.status === "closed") finish();
      };
      response.on("close", finish);
      try {
        unsubscribe = runtime.subscribe(args.sideId, (value) => {
          if (value?.closed === true || value?.status === "closed") {
            publish(value);
            return;
          }
          if (ended || updateTimer) return;
          updateTimer = setTimeout(() => {
            updateTimer = void 0;
            if (ended) return;
            Promise.resolve().then(() => runtime.state({ ...args, display: true })).then(
              (state) => publish(publicState(state)),
              (error) => publish({ ...args, closed: true, status: "closed", error: errorRecord(error) })
            );
          }, 100);
          updateTimer.unref?.();
        });
        publish(initial);
        heartbeat = setInterval(() => {
          if (!ended && !response.destroyed) response.write(": keepalive\n\n");
        }, 2e4);
        heartbeat.unref?.();
        if (ended) {
          clearInterval(heartbeat);
          unsubscribe();
        }
      } catch (error) {
        publish({ ...args, closed: true, status: "closed", error: errorRecord(error) });
        finish();
      }
    }
  });
  return () => {
    api();
    events();
    for (const response of responses) response.destroy();
    responses.clear();
  };
}

// src/tool.js
import { randomUUID as randomUUID2 } from "node:crypto";
function summarizeSideState(state) {
  const messages = [];
  let own = false;
  for (const event of state.events ?? []) {
    if (event.type === "user/message") own = true;
    if (!own || !["user/message", "assistant/message", "assistant/attempt", "tool/result"].includes(event.type)) continue;
    const message = event.data?.message ?? event.data;
    const blocks = Array.isArray(message?.content) ? message.content : [];
    const text = blocks.filter((block) => block.type === "text").map((block) => block.text).join("\n");
    const calls = blocks.filter((block) => block.type === "tool-call").map((block) => block.name);
    if (text || calls.length) messages.push({ seq: event.seq, role: message.role ?? event.type.split("/")[0], text: text.slice(0, 1800), ...calls.length ? { tools: calls } : {}, ...text.length > 1800 ? { truncated: true } : {} });
  }
  return {
    sideId: state.sideId,
    parentSessionId: state.parentSessionId,
    tabId: state.tabId,
    createdAt: state.createdAt,
    snapshotSeq: state.snapshotSeq,
    revision: state.revision,
    status: state.status,
    running: state.running,
    closed: state.closed,
    ...state.error ? { error: state.error } : {},
    messages: messages.slice(-16),
    ...messages.length > 16 ? { omittedMessages: messages.length - 16 } : {}
  };
}
function registerBtwTool(ctx, runtime) {
  return ctx.tools.register({
    name: "btw_manage",
    description: "Create or inspect independent temporary side conversations for the current session, send a follow-up, stop an answer, or permanently close a side conversation. Closing clears its in-memory history. Sidebar navigation remains a UI action.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        action: { type: "string", enum: ["create", "list", "state", "send", "stop", "close"], description: "Operation. close irreversibly clears this side conversation." },
        sideId: { type: "string", description: "Side conversation identifier returned by create or list; required for state, send, stop and close." },
        text: { type: "string", description: "Initial question for create, or required follow-up for send. An empty create only captures context." },
        requestId: { type: "string", description: "Reuse the same request identity when retrying a create or send; a new identity creates a distinct operation." }
      },
      required: ["action"]
    },
    output: {
      schema: { type: "object", properties: { result: {} }, required: ["result"], additionalProperties: false },
      render(_args, value) {
        return [{ type: "text", text: JSON.stringify(value.result) }];
      }
    },
    async execute(args, exec) {
      if (!exec.agent) throw new Error("BTW operations require a receiving main session");
      if (runtime.hasSide?.(exec.agent.id)) throw new Error("A side conversation cannot manage another side conversation");
      const requestId = args.requestId ?? randomUUID2();
      const input = { parentSessionId: exec.agent.id, sideId: args.sideId, requestId };
      if (args.action === "create") {
        input.tabId = `tool:${requestId}`;
        input.question = args.text ?? "";
      } else if (args.action === "send") input.text = args.text;
      const value = await invokeRuntime(runtime, args.action, input);
      return { result: args.action === "state" ? summarizeSideState(value) : value };
    },
    timeoutMs: 6e4,
    isConcurrencySafe: (args) => args.action === "list" || args.action === "state"
  });
}

// src/index.js
var inject = ["agents", "sessions", "sessionQuery", "workingDirectory", "tools", "connection", "webServer"];
async function apply(ctx, config = {}) {
  const native = await loadNativeModules({ runtimePath: config.runtimePath });
  const runtime = await createRuntime(ctx, { native, projectState: publicState });
  ctx.effect(() => () => runtime.dispose(), "dsh-btw: temporary worlds");
  ctx.effect(() => registerTransport(ctx, runtime), "dsh-btw: authenticated transport");
  ctx.effect(() => registerBtwTool(ctx, runtime), "dsh-btw: service tooling");
  ctx.effect(() => ctx.reflect.provide("btwConversations", runtime), "dsh-btw: application service");
}
export {
  apply,
  inject
};
