export const TAB_KIND = 'btw';
export const PLUGIN_ID = 'dsh-btw';

export function parseBtw(line) {
  const match = /^\/btw(?:\s+([\s\S]*))?$/u.exec(line.trim());
  return match ? { question: (match[1] ?? '').trim() } : undefined;
}

export function createStore(value) {
  const listeners = new Set();
  return {
    getSnapshot: () => value,
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    set(next) { value = next; for (const fn of listeners) fn(); }
  };
}

export const normalizeTab = (sessionId, tab) => ({ ...tab, sessionId, tabId: tab.tabId ?? tab.id });
export const hostTabId = record => JSON.stringify([record.tabId, record.contentId]);
const keyOf = record => JSON.stringify([record.sessionId, record.tabId, record.contentId]);

/** Root-owned lifetime: React unmounts and presentation changes never close a tab. */
export class BtwController {
  constructor(api, { id = () => globalThis.crypto.randomUUID() } = {}) {
    this.api = api;
    this.id = id;
    this.entries = new Map();
    this.sequence = 0;
    this.closed = new Set();
    this.cleanups = new Set();
    this.cleanupFailures = new Map();
    this.cleanupStore = createStore([]);
    this.stopped = false;
  }

  get(record) { return this.entries.get(keyOf(record)); }

  entry(record) {
    const key = keyOf(record);
    let entry = this.entries.get(key);
    if (!entry) {
      entry = { record, ordinal: ++this.sequence, restored: false, store: createStore({ phase: 'opening', draft: '', busy: false }), requestId: this.id(), closed: false };
      this.entries.set(key, entry);
    }
    return entry;
  }

  /** Restore saved addresses only; expired Host generations must never be recreated. */
  async restore(records) {
    const saved = records.filter(r => r.kind === TAB_KIND);
    for (const record of saved) this.entry(record).restored = true;
    try {
      const parents = [...new Set(saved.map(record => record.sessionId))];
      const results = await Promise.all(parents.map(parentSessionId => this.api.list({ parentSessionId })));
      const items = results.flatMap(result => Array.isArray(result) ? result : result.items ?? []);
      for (const record of saved) {
        const entry = this.entries.get(keyOf(record));
        if (!entry || entry.closed) continue;
        const item = items.find(item => item.tabId === hostTabId(record) && item.parentSessionId === record.sessionId);
        if (item) {
          entry.meta = item;
          await this.refresh(entry);
        } else this.patch(entry, { phase: 'expired' });
      }
    } catch (error) {
      for (const record of saved) this.patch(this.entries.get(keyOf(record)), { phase: 'error', error: String(error.message ?? error) });
    }
  }

  /** Called synchronously by native openTabs membership publication, not first render. */
  reconcile(records) {
    for (const record of records) {
      if (record.kind !== TAB_KIND || this.entries.has(keyOf(record)) || this.closed.has(keyOf(record))) continue;
      this.create(record);
    }
  }

  create(record, question = '') {
    if (this.closed.has(keyOf(record)) || this.stopped) return Promise.reject(new Error('Side conversation is closed'));
    const entry = this.entry(record);
    if (entry.opening) return entry.opening;
    if (entry.closed || this.stopped) return Promise.reject(new Error('Side conversation is closed'));
    entry.opening = this.api.create({ parentSessionId: record.sessionId, tabId: hostTabId(record), requestId: entry.requestId, ...(question ? { question } : {}) }).then(async meta => {
      if (entry.closed) {
        entry.meta = meta;
        await this.api.close({ sideId: meta.sideId, parentSessionId: record.sessionId, requestId: this.id() });
        return;
      }
      // Unload/HMR is not explicit close; a refreshed Client may restore this tab.
      if (this.stopped) return meta;
      entry.meta = meta;
      await this.refresh(entry);
      return meta;
    }).catch(error => {
      this.patch(entry, { phase: 'error', error: String(error.message ?? error) });
      throw error;
    });
    entry.opening.catch(() => {});
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
      entry.unwatch = this.api.watch({ sideId: entry.meta.sideId, parentSessionId: entry.record.sessionId }, state => {
        this.patch(entry, state.closed ? { phase: 'expired', state: undefined } : { phase: 'ready', state, error: undefined });
      }, error => this.patch(entry, { error: String(error.message ?? error) }));
    }
    if (state.closed) this.patch(entry, { phase: 'expired', state: undefined });
    else this.patch(entry, { phase: 'ready', state, error: undefined });
    return state;
  }

  setDraft(record, draft) { this.patch(this.get(record), { draft }); }

  async send(record) {
    const entry = this.get(record);
    if (!entry) return;
    const draft = entry.store.getSnapshot().draft;
    if (entry.closed || !entry.meta || !draft.trim() || entry.store.getSnapshot().busy) return;
    this.patch(entry, { busy: true, error: undefined });
    try {
      await this.api.send({ sideId: entry.meta.sideId, parentSessionId: entry.record.sessionId, requestId: this.id(), text: draft });
      this.patch(entry, { draft: '' });
      await this.refresh(entry);
    } catch (error) { this.patch(entry, { error: String(error.message ?? error) }); }
    finally { this.patch(entry, { busy: false }); }
  }

  async stop(record) {
    const entry = this.get(record);
    if (!entry || !entry.meta || entry.closed) return;
    try {
      await this.api.stop({ sideId: entry.meta.sideId, parentSessionId: entry.record.sessionId, requestId: this.id() });
      await this.refresh(entry);
    } catch (error) { this.patch(entry, { error: String(error.message ?? error) }); }
  }

  /** Synchronous admission barrier; cleanup is retained before native close is allowed. */
  close(record) {
    const key = keyOf(record);
    this.closed.add(key);
    const entry = this.entries.get(key);
    if (!entry || entry.closed) return;
    entry.closed = true;
    entry.unwatch?.();
    entry.store.set({ phase: 'closed', draft: '', busy: false });
    this.entries.delete(key);
    const cleanup = (entry.meta
      ? this.api.close({ sideId: entry.meta.sideId, parentSessionId: entry.record.sessionId, requestId: this.id() })
      : (async () => {
        // tabId exists before create RPC resolves. Close Host admission now;
        // create's late-resolution path additionally closes the exact sideId.
        const results = await Promise.allSettled([
          this.api.close({ tabId: hostTabId(record), parentSessionId: entry.record.sessionId, requestId: this.id() }),
          entry.opening ?? Promise.resolve()
        ]);
        if (results.every(result => result.status === 'rejected')) throw results[0].reason;
      })()).catch(error => {
        // Retain failure explicitly: unload/visibility changes are never used as close.
        this.cleanupFailures.set(key, { entry, error: String(error.message ?? error) });
        this.cleanupStore.set([...this.cleanupFailures.values()].map(value => value.error));
      });
    this.cleanups.add(cleanup);
    cleanup.finally(() => this.cleanups.delete(cleanup));
  }

  async retryCleanup() {
    for (const [key, failure] of this.cleanupFailures) {
      try {
        await this.api.close({ ...(failure.entry.meta ? { sideId: failure.entry.meta.sideId } : { tabId: hostTabId(failure.entry.record) }), parentSessionId: failure.entry.record.sessionId, requestId: this.id() });
        this.cleanupFailures.delete(key);
      } catch (error) { failure.error = String(error.message ?? error); }
    }
    this.cleanupStore.set([...this.cleanupFailures.values()].map(value => value.error));
  }

  dispose() {
    this.stopped = true;
    for (const entry of this.entries.values()) {
      entry.unwatch?.();
      entry.store.set({ phase: 'closed', draft: '', busy: false });
    }
    this.entries.clear();
  }
}

export function newTabOperation(controller, sidebar, api, { id = () => globalThis.crypto.randomUUID(), wrongSession = 'Return to the original conversation first' } = {}) {
  return async (parentSessionId, question = '') => {
    if (sidebar.mounted.getSnapshot() !== parentSessionId) throw new Error(wrongSession);
    const previous = new Set(sidebar.openTabs.getSnapshot().map(record => keyOf(record)));
    sidebar.openTab(TAB_KIND, { revealIfOpened: false });
    const record = sidebar.openTabs.getSnapshot().find(record => record.kind === TAB_KIND && record.sessionId === parentSessionId && !previous.has(keyOf(record)));
    if (!record) throw new Error('Native sidebar did not create a side conversation tab');
    const meta = await controller.create(record);
    if (question && meta) {
      const entry = controller.get(record);
      if (!entry || entry.closed) throw new Error('Side conversation is closed');
      await api.send({ sideId: meta.sideId, parentSessionId, requestId: id(), text: question });
      await controller.refresh(entry);
    }
  };
}

export function btwSource(openNew, t) {
  const claim = session => ({ name: 'btw', token: '/btw ', hint: t('placeholder'), submit: async (args, _actx, attachments = []) => {
    if (attachments.length) throw new Error(t('attachmentsUnsupported'));
    await openNew(session.sessionId, args.trim());
    return { kind: 'success' };
  } });
  return {
    trigger: '/', name: 'btw', order: -100,
    candidates: async (_session, request) => request.position === 'leading' && 'btw'.startsWith(request.query.toLowerCase()) ? [{ name: 'btw', label: t('title'), description: t('description') }] : [],
    onPick: pick => ({ claim: claim(pick.session) }),
    matchSpace: (session, token) => token === '/btw' ? { claim: claim(session) } : undefined,
    matchClaim: async (session, token) => token === '/btw' ? claim(session) : undefined,
    matchEnter: async (session, line, _signal, envelope) => {
      if (!parseBtw(line)) return undefined;
      if (envelope?.attachments > 0) throw new Error(t('attachmentsUnsupported'));
      return { claim: claim(session) };
    }
  };
}
