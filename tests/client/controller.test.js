import test from 'node:test';
import assert from 'node:assert/strict';
import { BtwController, btwSource, parseBtw, hostTabId, normalizeTab, newTabOperation } from '../../src/client/controller.js';
import { transcriptRows, liveText } from '../../src/client/transcript.js';
import { createApi } from '../../src/client/api.js';
import { markdownBlocks, inlineTokens, safeHref } from '../../src/client/markdown.js';

const record = (id = 'one', parent = 'parent') => ({ kind: 'btw', contentId: `sidebar://btw/${id}`, tabId: id, sessionId: parent });
function fixture(extra = {}) {
  const calls = [];
  let count = 0;
  const api = {
    async create(args) { calls.push(['create', args]); return { sideId: `side${++count}`, parentSessionId: args.parentSessionId, tabId: args.tabId }; },
    async state(args) { calls.push(['state', args]); return { sideId: args.sideId, status: 'idle', events: [], revision: 1 }; },
    async list(args) { calls.push(['list', args]); return []; },
    async send(args) { calls.push(['send', args]); },
    async close(args) { calls.push(['close', args]); },
    async stop(args) { calls.push(['stop', args]); },
    ...extra
  };
  const controller = new BtwController(api, { id: () => `req${++count}` });
  return { api, calls, controller };
}

test('native guide inventory and slash submit both create independent tabs immediately', async () => {
  const { controller, api, calls } = fixture();
  const inventory = [];
  let minted = 0;
  const sidebar = {
    mounted: { getSnapshot: () => 'parent' },
    openTabs: { getSnapshot: () => [...inventory] },
    openTab(kind) { assert.equal(kind, 'btw'); inventory.push(record(`tab${++minted}`)); controller.reconcile(inventory); }
  };
  // Native guide default EntryBox only invokes openTab; the inventory owns creation.
  sidebar.openTab('btw');
  assert.equal(calls.filter(call => call[0] === 'create').length, 1);
  const openNew = newTabOperation(controller, sidebar, api, { id: () => 'question-request' });
  const source = btwSource(openNew, key => key);
  for (const question of ['', 'why?']) {
    const outcome = await source.matchEnter({ sessionId: 'parent' }, `/btw ${question}`, null, {});
    await outcome.claim.submit(question, {});
  }
  assert.equal(inventory.length, 3);
  assert.equal(calls.filter(call => call[0] === 'create').length, 3);
  assert.equal(calls.filter(call => call[0] === 'send').length, 1);
  assert.equal(new Set(calls.filter(call => call[0] === 'create').map(call => call[1].tabId)).size, 3);
  await assert.rejects(openNew('another-parent'), /original/);
});

test('copied native records and identical addresses in another parent cannot alias a side', async () => {
  const { controller, calls } = fixture();
  const first = record();
  const duplicate = { ...first, tabId: 'duplicate' };
  const otherParent = { ...first, sessionId: 'other' };
  controller.reconcile([first, duplicate, otherParent]);
  await Promise.all([...controller.entries.values()].map(entry => entry.opening));
  assert.equal(controller.entries.size, 3);
  assert.notEqual(controller.get(first).meta.sideId, controller.get(duplicate).meta.sideId);
  assert.notEqual(controller.get(first).meta.sideId, controller.get(otherParent).meta.sideId);
  assert.deepEqual(normalizeTab(first.sessionId, { ...first, id: first.tabId, tabId: undefined }).tabId, first.tabId);
  controller.close(normalizeTab(first.sessionId, { ...first, id: first.tabId, tabId: undefined }));
  assert.equal(controller.get(first), undefined);
  assert.ok(controller.get(otherParent)); assert.ok(controller.get(duplicate));
  controller.setDraft(first, 'late input'); await controller.send(first);
  assert.equal(controller.entries.size, 2);
  await assert.rejects(controller.create(first), /closed/);
  assert.equal(calls.filter(call => call[0] === 'create').length, 3);
});

test('moving or docking a native record preserves identity and never recreates it', async () => {
  const { controller, calls } = fixture();
  await controller.create(record());
  controller.reconcile([{ ...record(), paneId: 'float3', visible: false }]);
  assert.equal(controller.entries.size, 1);
  assert.equal(calls.filter(call => call[0] === 'create').length, 1);
});

test('exact /btw parses empty and multiline questions without matching unrelated commands', () => {
  assert.deepEqual(parseBtw('/btw'), { question: '' });
  assert.deepEqual(parseBtw('/btw hello\nthere'), { question: 'hello\nthere' });
  assert.equal(parseBtw('/btwice nope'), undefined);
});

test('root inventory creates immediately, only once per native tab address', async () => {
  const { controller, calls } = fixture();
  controller.reconcile([record(), record('two')]);
  assert.equal(calls.filter(c => c[0] === 'create').length, 2);
  controller.reconcile([record(), record('two')]);
  await Promise.all([...controller.entries.values()].map(e => e.opening));
  assert.equal(calls.filter(c => c[0] === 'create').length, 2);
});

test('collapse, invisible membership, and component teardown do not close Host history', async () => {
  const { controller, calls } = fixture();
  await controller.create(record());
  controller.reconcile([]);
  assert.equal(controller.entries.size, 1);
  controller.dispose();
  assert.equal(calls.some(c => c[0] === 'close'), false);
});

test('explicit close clears all local history/draft and stale response cannot restore it', async () => {
  const { controller, calls } = fixture();
  await controller.create(record());
  const entry = controller.get(record());
  controller.setDraft(record(), 'private draft');
  controller.close(record());
  controller.patch(entry, { state: { events: ['late'] }, draft: 'late' });
  controller.reconcile([record()]);
  assert.equal(controller.entries.size, 0);
  assert.deepEqual(entry.store.getSnapshot(), { phase: 'closed', draft: '', busy: false });
  assert.equal(calls.filter(c => c[0] === 'close').length, 1);
  assert.equal(calls.filter(c => c[0] === 'create').length, 1);
});

test('close during create disposes the late Host side without recreating local state', async () => {
  let resolve;
  const { controller, calls } = fixture({ create: () => new Promise(r => { resolve = r; }) });
  const opening = controller.create(record());
  controller.close(record());
  resolve({ sideId: 'late' });
  await opening;
  assert.equal(controller.entries.size, 0);
  assert.deepEqual(calls.filter(c => c[0] === 'close').map(c => c[1]), [
    { tabId: hostTabId(record()), parentSessionId: 'parent', requestId: 'req2' },
    { sideId: 'late', parentSessionId: 'parent', requestId: 'req3' }
  ]);
});

test('plugin unload during pending create never closes an unclosed Host tab', async () => {
  let resolve;
  const { controller, calls } = fixture({ create: () => new Promise(r => { resolve = r; }) });
  const opening = controller.create(record());
  controller.dispose();
  resolve({ sideId: 'unclosed' }); await opening;
  assert.equal(calls.some(call => call[0] === 'close'), false);
});

test('restore reconnects only existing tab IDs and does not recreate expired saved layouts', async () => {
  const { controller, calls } = fixture({ list: async ({ parentSessionId }) => [{ sideId: 'old', tabId: hostTabId(record()), parentSessionId }] });
  await controller.restore([record(), record('expired')]);
  assert.equal(controller.get(record()).meta.sideId, 'old');
  assert.equal(controller.get(record('expired')).store.getSnapshot().phase, 'expired');
  assert.equal(calls.some(c => c[0] === 'create'), false);
});

test('separate drafts/continuations use exact side and parent identities', async () => {
  const { controller, calls } = fixture();
  await controller.create(record()); await controller.create(record('two', 'second'));
  controller.setDraft(record(), 'first'); controller.setDraft(record('two', 'second'), 'second');
  await controller.send(record());
  assert.equal(controller.get(record('two', 'second')).store.getSnapshot().draft, 'second');
  assert.equal(calls.find(c => c[0] === 'send')[1].parentSessionId, 'parent');
  await controller.stop(record());
  assert.equal(calls.find(c => c[0] === 'stop')[1].parentSessionId, 'parent');
});

test('send failure retains draft; SSE revisions cannot roll state backwards', async () => {
  const { controller } = fixture({ send: async () => { throw new Error('refused'); } });
  await controller.create(record()); controller.setDraft(record(), 'keep');
  await controller.send(record());
  const entry = controller.get(record());
  assert.equal(entry.store.getSnapshot().draft, 'keep');
  assert.equal(entry.store.getSnapshot().error, 'refused');
  controller.patch(entry, { state: { revision: 5 } });
  controller.patch(entry, { state: { revision: 2 } });
  assert.equal(entry.store.getSnapshot().state.revision, 5);
});

test('input trigger returns claim; only submit creates NEW tab, once for each invocation', async () => {
  const opened = [];
  const source = btwSource(async (...args) => opened.push(args), key => key);
  for (const line of ['/btw', '/btw question']) {
    const outcome = await source.matchEnter({ sessionId: 'parent' }, line, new AbortController().signal, { attachments: 0 });
    assert.equal(opened.length, line === '/btw' ? 0 : 1);
    await outcome.claim.submit(line === '/btw' ? '' : 'question', {});
  }
  assert.deepEqual(opened, [['parent', ''], ['parent', 'question']]);
  assert.equal(await source.matchEnter({}, '/other', null, {}), undefined);
  await assert.rejects(source.matchEnter({}, '/btw q', null, { attachments: 1 }), /attachmentsUnsupported/);
});

test('transcript renders own native message/tool payloads, compact failed attempts and nested stream chunks', () => {
  const state = { inheritedEventCount: 1, events: [
    { seq: 0, type: 'user/message', data: { content: [{ type: 'text', text: 'hidden inherited' }] } },
    { seq: 1, type: 'user/message', data: { content: [{ type: 'text', text: '<script>safe text</script>' }] } },
    { seq: 2, type: 'assistant/message', data: { message: { content: [{ type: 'reasoning', text: 'internal' }, { type: 'text', text: 'answer' }] } } },
    { seq: 3, type: 'tool/result', data: { message: { toolCallId: 'call', content: [{ type: 'text', text: 'result' }] } } },
    { seq: 4, type: 'assistant/attempt', data: { stream: [{ type: 'text-chunks', texts: ['par', 'tial'] }] } }
  ] };
  assert.deepEqual(transcriptRows(state).map(row => row.text), ['<script>safe text</script>', 'answer', 'result', 'partial']);
  assert.equal(liveText({ assistantFrames: [{ type: 'chunk', chunk: { type: 'text-delta', text: 'live' } }] }), 'live');
});

test('native start/chunk frames display text while generation is still running, not only after commit', () => {
  const frames = [
    { type: 'start', attemptId: 'a', revision: 1 },
    { type: 'chunk', index: 0, chunk: { type: 'block-start', index: 0, blockType: 'text' } },
    { type: 'chunk', index: 1, chunk: { type: 'text-delta', index: 0, text: 'BTW_' } },
    { type: 'chunk', index: 2, chunk: { type: 'reasoning-delta', index: 1, text: 'do not show reasoning' } }
  ];
  assert.equal(liveText({ status: 'running', events: [], assistantFrames: frames }), 'BTW_');
  frames.push({ type: 'chunk', index: 3, chunk: { type: 'text-delta', index: 0, text: 'OK' } });
  assert.equal(liveText({ status: 'running', events: [], assistantFrames: frames }), 'BTW_OK');
  frames.push({ type: 'chunk', index: 4, chunk: { type: 'block-end', index: 0, block: { type: 'text', text: 'BTW_OK' } } });
  assert.equal(liveText({ assistantFrames: frames }), 'BTW_OK');
});

test('compact records stream across updates and fallback attempts do not insert chunk-boundary newlines', () => {
  const records = [
    { type: 'text-chunks', index: 0, texts: ['hel', 'lo'] },
    { type: 'chunk', chunk: { type: 'usage', usage: {} } },
    { type: 'text-chunks', index: 0, texts: [' ', 'world'] },
    { type: 'reasoning-chunks', index: 1, texts: ['not shown'] }
  ];
  assert.equal(liveText({ status: 'running', assistantFrames: records }), 'hello world');
  assert.equal(liveText({ assistantFrames: [{ type: 'chunk', chunk: records[0] }] }), 'hello');
  const rows = transcriptRows({ events: [{ type: 'user/message', seq: 0, data: { content: 'question' } }, { type: 'assistant/attempt', seq: 1, data: { stream: records } }] });
  assert.equal(rows[1].text, 'hello world');
  assert.equal(liveText({ assistantFrames: [...records, { type: 'start' }, { type: 'chunk', chunk: { type: 'text-delta', index: 0, text: 'new attempt' } }] }), 'new attempt');
});

test('synthetic fork results never appear before the side thread first user message', () => {
  assert.deepEqual(transcriptRows({ events: [{ seq: 4, type: 'tool/result', data: { message: { content: 'inherited fork result' } } }, { seq: 5, type: 'user/message', data: { content: 'actual side question' } }] }).map(row => row.text), ['actual side question']);
});

test('safe Markdown preserves raw HTML as text and rejects unsafe link protocols', () => {
  assert.equal(safeHref('javascript:alert(1)'), undefined);
  assert.equal(safeHref('//evil.example'), undefined);
  for (const href of ['JaVaScRiPt:alert(1)', 'data:text/html,payload', 'vbscript:payload', '/\\\\evil.example', 'https://example.com\n/unsafe']) assert.equal(safeHref(href), undefined);
  assert.equal(safeHref('https://example.com'), 'https://example.com');
  assert.equal(inlineTokens('<img src=x onerror=alert(1)>')[0].type, 'text');
  assert.equal(inlineTokens('**bold** and [unsafe](data:payload)')[0].type, 'strong');
  assert.deepEqual(markdownBlocks('# Heading\n\n- one\n- two\n\n```js\n<script>\n```').map(block => block.type), ['h1', 'ul', 'pre']);
});

test('failed explicit cleanup remains visible and user retry finishes it', async () => {
  let fail = true;
  const { controller } = fixture({ close: async () => { if (fail) throw new Error('offline'); } });
  await controller.create(record());
  controller.close(record());
  await Promise.all([...controller.cleanups]);
  assert.deepEqual(controller.cleanupStore.getSnapshot(), ['offline']);
  fail = false;
  await controller.retryCleanup();
  assert.deepEqual(controller.cleanupStore.getSnapshot(), []);
  assert.equal(controller.entries.size, 0);
});

test('HTTP uses authenticated relative channel and preserves explicit errors', async () => {
  const requests = [];
  const api = createApi({ fetch: async (...args) => { requests.push(args); return { ok: true, json: async () => ({ ok: true, value: [] }) }; } });
  await api.list({ parentSessionId: 'p' });
  assert.equal(requests[0][0], '/plugins/dsh-btw/api');
  assert.equal(requests[0][1].credentials, 'same-origin');
  assert.deepEqual(JSON.parse(requests[0][1].body), { method: 'list', args: { parentSessionId: 'p' } });
  const broken = createApi({ fetch: async () => ({ ok: false, json: async () => ({ ok: false, error: { code: 'BTW_EXPIRED', message: 'expired' } }) }) });
  await assert.rejects(broken.state({}), error => error.code === 'BTW_EXPIRED');
});

test('SSE expiry probe closes expired or closed Host sides without ever creating replacements', async () => {
  for (const code of ['BTW_EXPIRED', 'BTW_CLOSED', undefined]) {
    let stream; const methods = [];
    class FakeEventSource { constructor() { stream = this; } close() { this.closed = true; } }
    const api = createApi({ EventSource: FakeEventSource, fetch: async (_url, options) => {
      methods.push(JSON.parse(options.body).method);
      return { ok: false, status: code ? 404 : 410, json: async () => ({ ok: false, error: { code, message: 'expired' } }) };
    } });
    const states = [];
    api.watch({ sideId: 's', parentSessionId: 'p' }, state => states.push(state), () => {});
    await stream.onerror(); await stream.onerror();
    stream.onmessage({ data: '{"revision":100}' });
    assert.equal(stream.closed, true);
    assert.deepEqual(methods, ['state']);
    assert.deepEqual(states, [{ sideId: 's', parentSessionId: 'p', closed: true, status: 'closed', expired: true }]);
  }
});

test('SSE probe is single-flight; transient network errors keep automatic reconnection', async () => {
  let stream; let reject; let calls = 0;
  class FakeEventSource { constructor() { stream = this; } close() { this.closed = true; } }
  const api = createApi({ EventSource: FakeEventSource, fetch: () => { calls++; return new Promise((_resolve, rej) => { reject = rej; }); } });
  const states = []; const errors = [];
  api.watch({ sideId: 's', parentSessionId: 'p' }, state => states.push(state), error => errors.push(error));
  const probe = stream.onerror(); await stream.onerror(); await stream.onerror();
  assert.equal(calls, 1); assert.equal(errors.length, 1);
  reject(new Error('network offline')); await probe;
  assert.equal(stream.closed, undefined);
  stream.onmessage({ data: '{"revision":2}' });
  assert.deepEqual(states, [{ revision: 2 }]);
});

test('SSE expiry result after explicit watcher disposal cannot publish a late state', async () => {
  let stream; let resolve;
  class FakeEventSource { constructor() { stream = this; } close() { this.closed = true; } }
  const api = createApi({ EventSource: FakeEventSource, fetch: () => new Promise(r => { resolve = r; }) });
  const states = [];
  const off = api.watch({ sideId: 's', parentSessionId: 'p' }, state => states.push(state), () => {});
  const probe = stream.onerror(); off();
  resolve({ ok: false, status: 410, json: async () => { throw new Error('gone without JSON'); } });
  await probe;
  assert.deepEqual(states, []); assert.equal(stream.closed, true);
});

test('SSE is retained until close/dispose and ignores late closed callbacks', () => {
  let stream;
  class FakeEventSource { constructor(url) { this.url = url; stream = this; } close() { this.closed = true; } }
  const api = createApi({ fetch: async () => {}, EventSource: FakeEventSource });
  const states = [];
  const off = api.watch({ sideId: 's', parentSessionId: 'p' }, state => states.push(state), assert.fail);
  stream.onmessage({ data: '{"revision":1}' });
  off(); stream.onmessage({ data: '{"revision":2}' });
  assert.equal(stream.url, '/plugins/dsh-btw/events?sideId=s&parentSessionId=p');
  assert.equal(stream.closed, true); assert.equal(states.length, 1);
});
