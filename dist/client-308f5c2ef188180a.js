window.__ModuleLoader__.load({ id: "dsh-btw", factory(require) { const module = {exports:{}}; const exports = module.exports;
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/client/index.js
var index_exports = {};
__export(index_exports, {
  apply: () => apply,
  inject: () => inject
});
module.exports = __toCommonJS(index_exports);
var import_react = __toESM(require("react"), 1);

// src/client/controller.js
var TAB_KIND = "btw";
var PLUGIN_ID = "dsh-btw";
function parseBtw(line) {
  const match = /^\/btw(?:\s+([\s\S]*))?$/u.exec(line.trim());
  return match ? { question: (match[1] ?? "").trim() } : void 0;
}
function createStore(value) {
  const listeners = /* @__PURE__ */ new Set();
  return {
    getSnapshot: () => value,
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    set(next) {
      value = next;
      for (const fn of listeners) fn();
    }
  };
}
var normalizeTab = (sessionId, tab) => ({ ...tab, sessionId, tabId: tab.tabId ?? tab.id });
var hostTabId = (record) => JSON.stringify([record.tabId, record.contentId]);
var keyOf = (record) => JSON.stringify([record.sessionId, record.tabId, record.contentId]);
var BtwController = class {
  constructor(api, { id = () => globalThis.crypto.randomUUID() } = {}) {
    this.api = api;
    this.id = id;
    this.entries = /* @__PURE__ */ new Map();
    this.sequence = 0;
    this.closed = /* @__PURE__ */ new Set();
    this.cleanups = /* @__PURE__ */ new Set();
    this.cleanupFailures = /* @__PURE__ */ new Map();
    this.cleanupStore = createStore([]);
    this.stopped = false;
  }
  get(record) {
    return this.entries.get(keyOf(record));
  }
  entry(record) {
    const key = keyOf(record);
    let entry = this.entries.get(key);
    if (!entry) {
      entry = { record, ordinal: ++this.sequence, restored: false, store: createStore({ phase: "opening", draft: "", busy: false }), requestId: this.id(), closed: false };
      this.entries.set(key, entry);
    }
    return entry;
  }
  /** Restore saved addresses only; expired Host generations must never be recreated. */
  async restore(records) {
    const saved = records.filter((r) => r.kind === TAB_KIND);
    for (const record of saved) this.entry(record).restored = true;
    try {
      const parents = [...new Set(saved.map((record) => record.sessionId))];
      const results = await Promise.all(parents.map((parentSessionId) => this.api.list({ parentSessionId })));
      const items = results.flatMap((result) => Array.isArray(result) ? result : result.items ?? []);
      for (const record of saved) {
        const entry = this.entries.get(keyOf(record));
        if (!entry || entry.closed) continue;
        const item = items.find((item2) => item2.tabId === hostTabId(record) && item2.parentSessionId === record.sessionId);
        if (item) {
          entry.meta = item;
          await this.refresh(entry);
        } else this.patch(entry, { phase: "expired" });
      }
    } catch (error) {
      for (const record of saved) this.patch(this.entries.get(keyOf(record)), { phase: "error", error: String(error.message ?? error) });
    }
  }
  /** Called synchronously by native openTabs membership publication, not first render. */
  reconcile(records) {
    for (const record of records) {
      if (record.kind !== TAB_KIND || this.entries.has(keyOf(record)) || this.closed.has(keyOf(record))) continue;
      this.create(record);
    }
  }
  create(record, question = "") {
    if (this.closed.has(keyOf(record)) || this.stopped) return Promise.reject(new Error("Side conversation is closed"));
    const entry = this.entry(record);
    if (entry.opening) return entry.opening;
    if (entry.closed || this.stopped) return Promise.reject(new Error("Side conversation is closed"));
    entry.opening = this.api.create({ parentSessionId: record.sessionId, tabId: hostTabId(record), requestId: entry.requestId, ...question ? { question } : {} }).then(async (meta) => {
      if (entry.closed) {
        entry.meta = meta;
        await this.api.close({ sideId: meta.sideId, parentSessionId: record.sessionId, requestId: this.id() });
        return;
      }
      if (this.stopped) return meta;
      entry.meta = meta;
      await this.refresh(entry);
      return meta;
    }).catch((error) => {
      this.patch(entry, { phase: "error", error: String(error.message ?? error) });
      throw error;
    });
    entry.opening.catch(() => {
    });
    return entry.opening;
  }
  patch(entry, patch) {
    if (!entry || entry.closed || this.stopped) return;
    const previous = entry.store.getSnapshot();
    if (patch.state && previous.state && patch.state.revision < previous.state.revision) return;
    entry.store.set({ ...previous, ...patch });
  }
  async refresh(entry) {
    if (!entry.meta || entry.closed || this.stopped) return;
    const state = await this.api.state({ sideId: entry.meta.sideId, parentSessionId: entry.record.sessionId });
    if (!entry.closed && !this.stopped && !entry.unwatch && this.api.watch) {
      entry.unwatch = this.api.watch({ sideId: entry.meta.sideId, parentSessionId: entry.record.sessionId }, (state2) => {
        this.patch(entry, state2.closed ? { phase: "expired", state: void 0 } : { phase: "ready", state: state2, error: void 0 });
      }, (error) => this.patch(entry, { error: String(error.message ?? error) }));
    }
    if (state.closed) this.patch(entry, { phase: "expired", state: void 0 });
    else this.patch(entry, { phase: "ready", state, error: void 0 });
    return state;
  }
  setDraft(record, draft) {
    this.patch(this.get(record), { draft });
  }
  async send(record) {
    const entry = this.get(record);
    if (!entry) return;
    const draft = entry.store.getSnapshot().draft;
    if (entry.closed || !entry.meta || !draft.trim() || entry.store.getSnapshot().busy) return;
    this.patch(entry, { busy: true, error: void 0 });
    try {
      await this.api.send({ sideId: entry.meta.sideId, parentSessionId: entry.record.sessionId, requestId: this.id(), text: draft });
      this.patch(entry, { draft: "" });
      await this.refresh(entry);
    } catch (error) {
      this.patch(entry, { error: String(error.message ?? error) });
    } finally {
      this.patch(entry, { busy: false });
    }
  }
  async stop(record) {
    const entry = this.get(record);
    if (!entry || !entry.meta || entry.closed) return;
    try {
      await this.api.stop({ sideId: entry.meta.sideId, parentSessionId: entry.record.sessionId, requestId: this.id() });
      await this.refresh(entry);
    } catch (error) {
      this.patch(entry, { error: String(error.message ?? error) });
    }
  }
  /** Synchronous admission barrier; cleanup is retained before native close is allowed. */
  close(record) {
    const key = keyOf(record);
    this.closed.add(key);
    const entry = this.entries.get(key);
    if (!entry || entry.closed) return;
    entry.closed = true;
    entry.unwatch?.();
    entry.store.set({ phase: "closed", draft: "", busy: false });
    this.entries.delete(key);
    const cleanup = (entry.meta ? this.api.close({ sideId: entry.meta.sideId, parentSessionId: entry.record.sessionId, requestId: this.id() }) : (async () => {
      const results = await Promise.allSettled([
        this.api.close({ tabId: hostTabId(record), parentSessionId: entry.record.sessionId, requestId: this.id() }),
        entry.opening ?? Promise.resolve()
      ]);
      if (results.every((result) => result.status === "rejected")) throw results[0].reason;
    })()).catch((error) => {
      this.cleanupFailures.set(key, { entry, error: String(error.message ?? error) });
      this.cleanupStore.set([...this.cleanupFailures.values()].map((value) => value.error));
    });
    this.cleanups.add(cleanup);
    cleanup.finally(() => this.cleanups.delete(cleanup));
  }
  async retryCleanup() {
    for (const [key, failure] of this.cleanupFailures) {
      try {
        await this.api.close({ ...failure.entry.meta ? { sideId: failure.entry.meta.sideId } : { tabId: hostTabId(failure.entry.record) }, parentSessionId: failure.entry.record.sessionId, requestId: this.id() });
        this.cleanupFailures.delete(key);
      } catch (error) {
        failure.error = String(error.message ?? error);
      }
    }
    this.cleanupStore.set([...this.cleanupFailures.values()].map((value) => value.error));
  }
  dispose() {
    this.stopped = true;
    for (const entry of this.entries.values()) {
      entry.unwatch?.();
      entry.store.set({ phase: "closed", draft: "", busy: false });
    }
    this.entries.clear();
  }
};
function newTabOperation(controller, sidebar, api, { id = () => globalThis.crypto.randomUUID(), wrongSession = "Return to the original conversation first" } = {}) {
  return async (parentSessionId, question = "") => {
    if (sidebar.mounted.getSnapshot() !== parentSessionId) throw new Error(wrongSession);
    const previous = new Set(sidebar.openTabs.getSnapshot().map((record2) => keyOf(record2)));
    sidebar.openTab(TAB_KIND, { revealIfOpened: false });
    const record = sidebar.openTabs.getSnapshot().find((record2) => record2.kind === TAB_KIND && record2.sessionId === parentSessionId && !previous.has(keyOf(record2)));
    if (!record) throw new Error("Native sidebar did not create a side conversation tab");
    const meta = await controller.create(record);
    if (question && meta) {
      const entry = controller.get(record);
      if (!entry || entry.closed) throw new Error("Side conversation is closed");
      await api.send({ sideId: meta.sideId, parentSessionId, requestId: id(), text: question });
      await controller.refresh(entry);
    }
  };
}
function btwSource(openNew, t) {
  const claim = (session) => ({ name: "btw", token: "/btw ", hint: t("placeholder"), submit: async (args, _actx, attachments = []) => {
    if (attachments.length) throw new Error(t("attachmentsUnsupported"));
    await openNew(session.sessionId, args.trim());
    return { kind: "success" };
  } });
  return {
    trigger: "/",
    name: "btw",
    order: -100,
    candidates: async (_session, request) => request.position === "leading" && "btw".startsWith(request.query.toLowerCase()) ? [{ name: "btw", label: t("title"), description: t("description") }] : [],
    onPick: (pick) => ({ claim: claim(pick.session) }),
    matchSpace: (session, token) => token === "/btw" ? { claim: claim(session) } : void 0,
    matchClaim: async (session, token) => token === "/btw" ? claim(session) : void 0,
    matchEnter: async (session, line, _signal, envelope) => {
      if (!parseBtw(line)) return void 0;
      if (envelope?.attachments > 0) throw new Error(t("attachmentsUnsupported"));
      return { claim: claim(session) };
    }
  };
}

// src/client/api.js
function createApi({ fetch = globalThis.fetch.bind(globalThis), EventSource = globalThis.EventSource, connectionMessage = "Side conversation connection interrupted; reconnecting\u2026" } = {}) {
  async function call(method, args = {}) {
    const response = await fetch("/plugins/dsh-btw/api", {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ method, args })
    });
    let result;
    try {
      result = await response.json();
    } catch (cause) {
      const error = new Error(`BTW request failed (${response.status})`, { cause });
      error.code = response.status === 410 ? "BTW_EXPIRED" : "btw/transport";
      error.status = response.status;
      throw error;
    }
    if (!response.ok || !result.ok) {
      const error = new Error(result.error?.message ?? `BTW request failed (${response.status})`);
      error.code = result.error?.code ?? (response.status === 410 ? "BTW_EXPIRED" : "btw/transport");
      error.status = response.status;
      throw error;
    }
    return result.value;
  }
  return {
    create: (args) => call("create", args),
    send: (args) => call("send", args),
    state: (args) => call("state", args),
    stop: (args) => call("stop", args),
    close: (args) => call("close", args),
    list: (args) => call("list", args),
    watch(args, onState, onError) {
      const query = new URLSearchParams(args);
      const stream = new EventSource(`/plugins/dsh-btw/events?${query}`);
      let active = true;
      let checking = false;
      stream.onmessage = (event) => {
        if (!active) return;
        try {
          const state = JSON.parse(event.data);
          onState(state);
          if (state.closed) {
            active = false;
            stream.close();
          }
        } catch (error) {
          onError(error);
        }
      };
      stream.onerror = async () => {
        if (!active || checking) return;
        checking = true;
        onError(new Error(connectionMessage));
        try {
          const state = await call("state", args);
          if (!active) return;
          if (state.closed) {
            active = false;
            stream.close();
          }
          onState(state);
        } catch (error) {
          if (!active) return;
          if (error.code === "BTW_EXPIRED" || error.code === "BTW_CLOSED" || error.status === 410) {
            active = false;
            stream.close();
            onState({ ...args, closed: true, status: "closed", expired: true });
          }
        } finally {
          checking = false;
        }
      };
      return () => {
        active = false;
        stream.close();
      };
    }
  };
}

// src/client/transcript.js
function contentText(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(contentText).filter(Boolean).join("\n");
  if (!value || typeof value !== "object") return "";
  if (value.type === "reasoning" || value.type === "reasoning-chunks") return "";
  if (value.type === "text-chunks") return value.texts.join("");
  if (value.type === "chunk") return contentText(value.chunk);
  if (value.type === "block-end") return "";
  if (typeof value.text === "string") return value.text;
  if (typeof value.content === "string" || Array.isArray(value.content)) return contentText(value.content);
  return "";
}
function transcriptRows(state = {}) {
  const rows = [];
  let ownUserSeen = false;
  for (const event of (state.events ?? []).slice(state.inheritedEventCount ?? 0)) {
    if (event.type === "user/message") ownUserSeen = true;
    if (!ownUserSeen) continue;
    const data = event.data ?? event;
    if (event.type === "user/message") {
      const text = contentText(data.content ?? data.message?.content ?? data.message ?? data);
      if (text) rows.push({ id: `user:${event.seq}`, kind: "user", text });
    } else if (event.type === "assistant/message" || event.type === "assistant/attempt") {
      const content = data.message?.content ?? data.content;
      let text = contentText(content);
      if (!text) text = Array.isArray(data.stream) ? liveText({ assistantFrames: data.stream }) : contentText(data.stream?.blocks ?? data.blocks);
      if (text) rows.push({ id: `assistant:${event.seq}`, kind: "assistant", text });
      for (const block of Array.isArray(content) ? content : []) {
        if (block.type === "tool-call" || block.type === "tool_use") rows.push({ id: `call:${event.seq}:${block.id ?? block.toolCallId}`, kind: "tool", title: block.name ?? block.toolName ?? "Tool", text: typeof block.arguments === "string" ? block.arguments : JSON.stringify(block.arguments ?? block.input ?? {}, null, 2) });
      }
    } else if (event.type === "tool/result") {
      const result = data.message ?? data.result ?? data;
      rows.push({ id: `tool:${event.seq}`, kind: "tool", title: data.toolName ?? data.name ?? result.toolCallId ?? "Tool", text: contentText(result.content ?? result.output ?? result.error ?? result) || JSON.stringify(result, null, 2) });
    }
  }
  return rows;
}
function liveText(state = {}) {
  const blocks = /* @__PURE__ */ new Map();
  for (const frame of state.assistantFrames ?? []) {
    if (frame.type === "start") {
      blocks.clear();
      continue;
    }
    const data = frame.chunk ?? frame.data?.chunk ?? frame.data ?? frame;
    const index = data.index ?? 0;
    if (data.type === "block-start") {
      blocks.set(index, "");
      continue;
    }
    if (data.type === "block-end") {
      if (data.block?.type === "text") blocks.set(index, data.block.text);
      continue;
    }
    let delta = "";
    if (data.type === "text-chunks") delta = (data.texts ?? []).filter((value) => typeof value === "string").join("");
    else if (data.type === "text-delta" || data.type === "text" || data.type === "assistant/text") delta = data.text ?? data.delta ?? "";
    else if (typeof data.delta?.text === "string") delta = data.delta.text;
    if (typeof delta === "string" && delta) blocks.set(index, (blocks.get(index) ?? "") + delta);
  }
  return [...blocks.entries()].sort(([a], [b]) => a - b).map(([, text]) => text).join("\n");
}

// src/client/markdown.js
function safeHref(value) {
  if (typeof value !== "string" || /[\u0000-\u0020\u007f\\]/u.test(value)) return void 0;
  return /^(https?:\/\/|mailto:|#|\/(?!\/))/iu.test(value) ? value : void 0;
}
function inlineTokens(text, depth = 0) {
  if (depth > 4) return [{ type: "text", text }];
  const result = [];
  const pattern = /(`+)([^`\n]+)\1|\*\*([^*\n]+)\*\*|\[([^\]\n]+)\]\(([^\s)]+)\)|\*([^*\n]+)\*/gu;
  let cursor = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index > cursor) result.push({ type: "text", text: text.slice(cursor, match.index) });
    if (match[1]) result.push({ type: "code", text: match[2] });
    else if (match[3]) result.push({ type: "strong", children: inlineTokens(match[3], depth + 1) });
    else if (match[4]) {
      const href = safeHref(match[5]);
      result.push(href ? { type: "a", href, children: inlineTokens(match[4], depth + 1) } : { type: "text", text: match[0] });
    } else result.push({ type: "em", children: inlineTokens(match[6], depth + 1) });
    cursor = match.index + match[0].length;
  }
  if (cursor < text.length) result.push({ type: "text", text: text.slice(cursor) });
  return result;
}
function markdownBlocks(text) {
  const lines = text.split("\n");
  const blocks = [];
  let paragraph = [];
  const flush = () => {
    if (paragraph.length) {
      blocks.push({ type: "p", text: paragraph.join("\n") });
      paragraph = [];
    }
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = /^\s*(```+|~~~+)([^ ]*)\s*$/u.exec(line);
    if (fence) {
      flush();
      const body = [];
      while (++i < lines.length && !lines[i].trim().startsWith(fence[1])) body.push(lines[i]);
      blocks.push({ type: "pre", text: body.join("\n"), language: fence[2] });
      continue;
    }
    if (!line.trim()) {
      flush();
      continue;
    }
    const heading = /^(#{1,6})\s+(.+)$/u.exec(line);
    if (heading) {
      flush();
      blocks.push({ type: `h${heading[1].length}`, text: heading[2] });
      continue;
    }
    const item = /^\s*(?:([-+*])|\d+\.)\s+(.+)$/u.exec(line);
    if (item) {
      flush();
      const type = item[1] ? "ul" : "ol";
      const previous = blocks.at(-1);
      if (previous?.type === type) previous.items.push(item[2]);
      else blocks.push({ type, items: [item[2]] });
      continue;
    }
    const quote = /^>\s?(.*)$/u.exec(line);
    if (quote) {
      flush();
      blocks.push({ type: "blockquote", text: quote[1] });
      continue;
    }
    paragraph.push(line);
  }
  flush();
  return blocks;
}

// src/client/index.js
var h = import_react.default.createElement;
var NS = "btw";
var dictionaries = {
  en: {
    title: "Side conversation",
    description: "Ask aside, without interrupting this conversation",
    placeholder: "Ask a side question\u2026",
    opening: "Freezing conversation context\u2026",
    empty: "A separate thread, the same context.",
    hint: "Context is frozen; closing the tab clears its memory. File and web tools supported; terminal, background tasks and attachments unavailable.",
    expired: "This side conversation has expired. Open a new one from /btw or the sidebar guide.",
    send: "Send",
    stop: "Stop",
    running: "Working\u2026",
    user: "You",
    assistant: "Assistant",
    attachmentsUnsupported: "/btw does not accept attachments. Remove them before submitting.",
    wrongSession: "Return to the original conversation before opening a side conversation.",
    connectionError: "Side conversation connection interrupted; reconnecting\u2026",
    snapshot: "Snapshot",
    created: "Created",
    retry: "Retry cleanup",
    cleanupError: "A closed side conversation could not be cleared on the Host. Retry to finish clearing its in-memory history."
  },
  zh: {
    title: "\u4FA7\u8FB9\u5BF9\u8BDD",
    description: "\u65C1\u95EE\u4E00\u53E5\uFF0C\u4E0D\u6253\u65AD\u5F53\u524D\u5BF9\u8BDD",
    placeholder: "\u5728\u8FD9\u91CC\u65C1\u95EE\u4E00\u53E5\u2026",
    opening: "\u6B63\u5728\u51BB\u7ED3\u5F53\u524D\u5BF9\u8BDD\u4E0A\u4E0B\u6587\u2026",
    empty: "\u53E6\u8D77\u4E00\u7EBF\uFF0C\u627F\u63A5\u6B64\u523B\u4E0A\u4E0B\u6587\u3002",
    hint: "\u4E0A\u4E0B\u6587\u5DF2\u51BB\u7ED3\uFF0C\u4EC5\u5B58\u5185\u5B58\uFF0C\u5173\u95ED\u6807\u7B7E\u540E\u6E05\u9664\u3002\u652F\u6301\u6587\u4EF6\u4E0E\u7F51\u9875\u5DE5\u5177\uFF1B\u7EC8\u7AEF\u3001\u540E\u53F0\u4EFB\u52A1\u548C\u9644\u4EF6\u4E0D\u53EF\u7528\u3002",
    expired: "\u6B64\u4FA7\u804A\u5DF2\u5931\u6548\u3002\u8BF7\u901A\u8FC7 /btw \u6216\u4FA7\u680F\u5165\u53E3\u65B0\u5EFA\u3002",
    send: "\u53D1\u9001",
    stop: "\u505C\u6B62",
    running: "\u6B63\u5728\u5904\u7406\u2026",
    user: "\u4F60",
    assistant: "\u52A9\u624B",
    attachmentsUnsupported: "/btw \u4E0D\u63A5\u53D7\u9644\u4EF6\uFF0C\u8BF7\u5148\u79FB\u9664\u9644\u4EF6\u518D\u53D1\u9001\u3002",
    wrongSession: "\u8BF7\u5148\u56DE\u5230\u539F\u5BF9\u8BDD\uFF0C\u518D\u65B0\u5EFA\u4FA7\u804A\u3002",
    connectionError: "\u4FA7\u804A\u8FDE\u63A5\u4E2D\u65AD\uFF0C\u6B63\u5728\u91CD\u65B0\u8FDE\u63A5\u2026",
    snapshot: "\u5FEB\u7167",
    created: "\u521B\u5EFA\u4E8E",
    retry: "\u91CD\u8BD5\u6E05\u9664",
    cleanupError: "\u5173\u95ED\u4FA7\u8FB9\u5BF9\u8BDD\u540E\u7684 Host \u6E05\u9664\u64CD\u4F5C\u672A\u5B8C\u6210\uFF0C\u8BF7\u91CD\u8BD5\u4EE5\u6E05\u9664\u5176\u5185\u5B58\u5386\u53F2\u3002"
  }
};
var css = `
[data-btw-chat]{display:flex;flex-direction:column;height:100%;min-height:0;color:var(--dsw-alias-label-primary);font:inherit;background:var(--dsw-alias-bg-base)}
[data-btw-chat] *{box-sizing:border-box}
.btw-context{margin:0;padding:10px 18px;font-size:11px;line-height:17px;color:var(--dsw-alias-label-tertiary);border-bottom:1px solid var(--dsw-alias-border-l1)}
.btw-transcript{flex:1;min-height:0;overflow:auto;overscroll-behavior:contain;padding:20px 18px;scrollbar-width:thin}
.btw-empty{height:100%;min-height:120px;display:grid;place-content:center;text-align:center;color:var(--dsw-alias-label-tertiary);font-size:14px;line-height:22px}
.btw-message{font-size:14px;line-height:1.65;white-space:pre-wrap;overflow-wrap:anywhere;margin:0 0 22px}
.btw-message[data-role=user]{padding:10px 14px;margin-left:24px;border-radius:18px;background:var(--dsw-alias-bg-layer-1)}
.btw-message[data-role=assistant]{padding:0 2px;white-space:normal}.btw-message p{white-space:pre-wrap;margin:0 0 12px}.btw-message p:last-child{margin-bottom:0}.btw-message pre{padding:12px;background:var(--dsw-alias-bg-layer-1);border-radius:10px;overflow:auto;font-size:12px;white-space:pre}.btw-message code{font-size:.9em}.btw-message blockquote{margin:12px 0;padding-left:12px;border-left:2px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary)}.btw-message a{color:inherit;text-decoration:underline}.btw-message h1,.btw-message h2,.btw-message h3{font-size:1.1em;margin:14px 0 8px}.btw-message ul,.btw-message ol{padding-left:22px;margin:8px 0}
.btw-tool{margin:0 0 12px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;font-size:12px;color:var(--dsw-alias-label-secondary)}
.btw-tool summary{padding:8px 10px;cursor:pointer;overflow-wrap:anywhere}.btw-tool pre{padding:0 10px 10px;margin:0;white-space:pre-wrap;overflow-wrap:anywhere;max-height:260px;overflow:auto;font-size:11px}
.btw-status,.btw-error{font-size:12px;line-height:18px;padding:8px 2px;color:var(--dsw-alias-label-tertiary)}
.btw-error{color:var(--dsw-alias-label-primary);border-left:2px solid var(--dsw-alias-border-l1);padding-left:10px}
.btw-composer{margin:0 12px 12px;border:1px solid var(--dsw-alias-border-l1);border-radius:20px;padding:12px;background:var(--dsw-alias-bg-layer-1)}
.btw-composer:focus-within{border-color:var(--dsw-alias-label-tertiary)}
.btw-composer textarea{display:block;resize:none;min-height:56px;max-height:160px;width:100%;border:0;outline:0;background:transparent;color:inherit;font:inherit;font-size:14px;line-height:22px}
.btw-composer textarea::placeholder{color:var(--dsw-alias-label-tertiary)}
.btw-composer footer{display:flex;justify-content:flex-end;align-items:center;gap:8px;padding-top:6px}
.btw-composer button{border:1px solid var(--dsw-alias-border-l1);border-radius:14px;padding:5px 13px;background:transparent;color:inherit;cursor:pointer;font:inherit;font-size:12px;line-height:18px}
.btw-composer button:hover{background:var(--dsw-alias-bg-layer-1)}.btw-composer button:disabled{opacity:.4;cursor:default}
.btw-composer button:focus-visible,.btw-tool summary:focus-visible{outline:2px solid var(--dsw-alias-label-secondary);outline-offset:2px}
`;
function SideGlyph({ size = 16, className } = {}) {
  return h(
    "svg",
    { width: size, height: size, className, viewBox: "0 0 16 16", fill: "none", "aria-hidden": true },
    h("path", { d: "M2.5 2.5h8v6h-4l-2.5 2v-2H2.5zM8.5 10.5h3l2 2v-6h-1", stroke: "currentColor", strokeWidth: 1.25, strokeLinejoin: "round" })
  );
}
function inline(nodes) {
  return nodes.map((node, key) => node.type === "text" ? node.text : h(node.type, { key, ...node.href ? { href: node.href, target: "_blank", rel: "noreferrer noopener" } : {} }, node.children ? inline(node.children) : node.text));
}
function Markdown({ text }) {
  return markdownBlocks(text).map((block, key) => block.type === "pre" ? h("pre", { key }, h("code", null, block.text)) : block.items ? h(block.type, { key }, block.items.map((item, i) => h("li", { key: i }, inline(inlineTokens(item))))) : h(block.type, { key }, inline(inlineTokens(block.text))));
}
var missing = createStore({ phase: "opening", draft: "", busy: false });
function SideTitle({ sessionId, useTabInfo, controller, t }) {
  const { tab } = useTabInfo();
  const entry = controller.get(normalizeTab(sessionId, tab));
  const store = entry?.store ?? missing;
  (0, import_react.useSyncExternalStore)(store.subscribe, store.getSnapshot);
  return `${t("title")} ${entry?.ordinal ?? tab.id.replace("tab", "#")}`;
}
function CleanupNotice({ controller, t }) {
  const errors = (0, import_react.useSyncExternalStore)(controller.cleanupStore.subscribe, controller.cleanupStore.getSnapshot);
  return errors.length ? h("div", { role: "alert", className: "btw-error" }, t("cleanupError"), " ", h("button", { type: "button", onClick: () => {
    void controller.retryCleanup();
  } }, t("retry"))) : null;
}
function SideChat({ sessionId, useTabInfo, controller, t }) {
  const { tab } = useTabInfo();
  const record = normalizeTab(sessionId, tab);
  const entry = controller.get(record);
  const store = entry?.store ?? missing;
  const view = (0, import_react.useSyncExternalStore)(store.subscribe, store.getSnapshot);
  const scroll = (0, import_react.useRef)(null);
  const editor = (0, import_react.useRef)(null);
  const previouslyVisible = (0, import_react.useRef)(tab.visible);
  const focusedNew = (0, import_react.useRef)(false);
  (0, import_react.useEffect)(() => {
    const becameVisible = tab.visible && !previouslyVisible.current;
    const newReady = tab.visible && view.phase === "ready" && !entry?.restored && !focusedNew.current;
    if ((becameVisible || newReady) && view.phase === "ready") {
      editor.current?.focus({ preventScroll: true });
      focusedNew.current = true;
    }
    previouslyVisible.current = tab.visible;
  }, [tab.visible, view.phase, entry]);
  const state = view.state ?? {};
  const rows = transcriptRows(state);
  const live = liveText(state);
  const running = state.status === "running";
  (0, import_react.useEffect)(() => {
    const element = scroll.current;
    if (element && element.scrollHeight - element.scrollTop - element.clientHeight < 200) element.scrollTop = element.scrollHeight;
  }, [state]);
  const submit = (event) => {
    event.preventDefault();
    void controller.send(record);
  };
  return h(
    "section",
    { "data-btw-chat": "", "aria-label": t("title") },
    h("style", null, css),
    h("p", { className: "btw-context" }, t("hint"), entry?.meta && h("span", { style: { display: "block" } }, `${t("created")} ${new Date(entry.meta.createdAt).toLocaleString()} \xB7 ${t("snapshot")} ${entry.meta.snapshotSeq ?? "\u2014"}`)),
    h(
      "div",
      { className: "btw-transcript", ref: scroll, role: "log", "aria-live": "polite", "aria-relevant": "additions text" },
      view.phase === "opening" && h("div", { className: "btw-empty", role: "status" }, t("opening")),
      (view.phase === "expired" || view.phase === "closed") && h("p", { className: "btw-empty" }, t("expired")),
      view.phase === "ready" && rows.length === 0 && !running && h("p", { className: "btw-empty" }, t("empty")),
      ...rows.map((row) => row.kind === "tool" ? h("details", { className: "btw-tool", key: row.id }, h("summary", null, row.title), h("pre", null, row.text)) : h("article", { className: "btw-message", "data-role": row.kind, "aria-label": t(row.kind), key: row.id }, row.kind === "assistant" ? h(Markdown, { text: row.text }) : row.text)),
      live && h("article", { className: "btw-message", "data-role": "assistant" }, live),
      running && h("div", { className: "btw-status", role: "status" }, t("running")),
      (view.error || state.error) && h("p", { className: "btw-error", role: "alert" }, view.error || state.error)
    ),
    h(
      "form",
      { className: "btw-composer", onSubmit: submit },
      h("textarea", {
        ref: editor,
        value: view.draft,
        placeholder: t("placeholder"),
        "aria-label": t("placeholder"),
        rows: 2,
        disabled: view.phase !== "ready" || view.busy,
        onChange: (event) => controller.setDraft(record, event.target.value),
        onKeyDown: (event) => {
          if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && !event.isComposing) {
            event.preventDefault();
            void controller.send(record);
          }
        }
      }),
      h(
        "footer",
        null,
        running && h("button", { type: "button", onClick: () => {
          void controller.stop(record);
        } }, t("stop")),
        h("button", { type: "submit", disabled: view.phase !== "ready" || view.busy || !view.draft.trim() }, t("send"))
      )
    )
  );
}
var inject = ["slots", "sidebarRight", "sidebarRightTabs", "inputTriggers", "locale"];
function apply(ctx) {
  ctx.effect(() => ctx.locale.register(NS, dictionaries), "btw: locale");
  const t = ctx.locale.bind(NS);
  const api = createApi({ connectionMessage: t("connectionError") });
  const controller = new BtwController(api);
  ctx.effect(() => () => controller.dispose(), "btw: memory-only UI lifetime");
  ctx.effect(() => ctx.sidebarRightTabs.register({
    id: PLUGIN_ID,
    kind: TAB_KIND,
    multiple: true,
    keepMounted: true,
    title: () => t("title"),
    guide: [{ id: "new", order: 40, icon: SideGlyph, title: () => t("title"), description: () => t("description") }]
  }), "btw: native multiple tab and default guide entry");
  ctx.effect(() => {
    const inventory = ctx.sidebarRight.openTabs;
    const initial = inventory.getSnapshot();
    const restoration = controller.restore(initial);
    const off = inventory.subscribe(() => controller.reconcile(inventory.getSnapshot()));
    restoration.catch(() => {
    });
    return off;
  }, "btw: snapshot at native tab creation");
  ctx.effect(() => ctx.sidebarRight.registerCloseHandler(TAB_KIND, (sessionId, tab) => {
    controller.close(normalizeTab(sessionId, tab));
  }), "btw: explicit close destroys; collapse retains");
  ctx.effect(() => ctx.slots.inject("sidebar.right.pane.tab.title", () => ctx.slots.register({ name: "sidebar.right.pane.tab.title", key: PLUGIN_ID, locale: NS }, (props) => h(SideTitle, { ...props, controller, t }))), "btw: distinct native tab titles");
  ctx.effect(() => ctx.slots.inject("conversation.composer.dock", () => ctx.slots.register({ name: "conversation.composer.dock", id: "btw-cleanup-notice", locale: NS }, () => h(CleanupNotice, { controller, t }))), "btw: visible cleanup failure and retry");
  const openNew = newTabOperation(controller, ctx.sidebarRight, api, { wrongSession: t("wrongSession") });
  ctx.effect(() => ctx.inputTriggers.registerSource(btwSource(openNew, t)), "btw: transactional input-trigger submit");
  ctx.effect(() => ctx.slots.inject("sidebar.right.pane.tab", () => ctx.slots.register({
    name: "sidebar.right.pane.tab",
    key: PLUGIN_ID,
    locale: NS
  }, (props) => h(SideChat, { ...props, controller, t }))), "btw: native tab body");
}
return module.exports; } });
