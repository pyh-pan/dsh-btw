import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { invokeRuntime, publicState, readJson, registerTransport } from '../../src/transport.js';
import { validateCall } from '../../src/shared/protocol.js';
import { summarizeSideState } from '../../src/tool.js';

const args = { parentSessionId: 'main', sideId: 'side-1' };

test('wire validation rejects unknown operations, missing identities and oversized text', () => {
  assert.throws(() => validateCall('__proto__', args));
  assert.throws(() => validateCall('create', { parentSessionId: 'main' }));
  assert.throws(() => validateCall('send', { ...args, requestId: 'r', text: 'x'.repeat(65537) }));
  assert.throws(() => validateCall('state', { sideId: 's' }));
  assert.deepEqual(validateCall('state', args), args);
});

test('HTTP parser bounds memory and rejects malformed JSON', async () => {
  assert.deepEqual(await readJson(Readable.from(['{"method":', '"list"}'])), { method: 'list' });
  await assert.rejects(readJson(Readable.from(['{'])), /Invalid JSON/);
  await assert.rejects(readJson(Readable.from(['abcdef']), 4), /too large/);
});

test('public snapshots expose no inherited main history and never mutate private log', () => {
  const privateState = { inheritedEventCount: 2, events: ['secret-1', 'secret-2', 'own'], snapshotSeq: 1 };
  const wire = publicState(privateState);
  assert.deepEqual(wire.events, ['own']);
  assert.equal(wire.inheritedEventCount, 0);
  assert.equal(wire.contextEventCount, 2);
  assert.equal(privateState.events.length, 3);
});

test('wire projection is idempotent and preserves the original snapshot boundary', () => {
  const once = publicState({ inheritedEventCount: 1, events: ['main', 'side'], snapshotSeq: 8 });
  assert.deepEqual(publicState(once), once);
  assert.equal(once.contextEventCount, 1);
});

test('browser snapshots omit internal prompts, tool catalogs and provider replay state', () => {
  const wire = publicState({ inheritedEventCount: 0, events: [
    { type: 'system/message', data: { text: 'internal-prompt' } },
    { type: 'request/header', data: { tools: ['private-catalog'] } },
    { type: 'assistant/message', data: { message: { role: 'assistant', content: [{ type: 'text', text: 'answer' }], source: { replayState: { secret: 'encrypted-replay' }, model: 'example' } } } },
  ], assistantFrames: [{ replayState: { secret: 'live-replay' }, text: 'visible' }] });
  assert.equal(wire.events.length, 1);
  assert.equal(wire.events[0].data.message.source.replayState, undefined);
  assert.equal(wire.assistantFrames[0].replayState, undefined);
  assert.equal(wire.events[0].data.message.content[0].text, 'answer');
});

test('agent state inspection is bounded and skips synthetic fork messages', () => {
  const events = [{ type: 'tool/result', data: { message: { role: 'tool', content: [{ type: 'text', text: 'inherited-closer' }] } } }];
  for (let index = 0; index < 24; index++) events.push({ type: index ? 'assistant/message' : 'user/message', seq: index, data: { message: { role: index ? 'assistant' : 'user', content: [{ type: 'text', text: 'x'.repeat(4000) }], source: { replayState: { hidden: true } } } } });
  const result = summarizeSideState({ sideId: 's', running: false, events });
  assert.equal(result.messages.length, 16);
  assert.equal(result.omittedMessages, 8);
  assert.ok(result.messages.every(message => message.text.length <= 1800 && message.truncated));
  assert.ok(!JSON.stringify(result).includes('inherited-closer'));
});

test('UI operations dispatch to the same runtime methods with validated arguments', async () => {
  const called = [];
  const runtime = { state(input) { called.push(input); return { ...input, inheritedEventCount: 1, events: ['inherited', 'own'] }; } };
  const state = await invokeRuntime(runtime, 'state', args);
  assert.deepEqual(called, [{ ...args, display: true }]);
  assert.deepEqual(state.events, ['own']);
});

function response() {
  return { status: undefined, headers: undefined, body: undefined, writeHead(status, headers) { this.status = status; this.headers = headers; }, end(body) { this.body = body; this.writableEnded = true; } };
}

test('transport refuses anonymous and nonowner callers before runtime access', async () => {
  const routes = [];
  const ctx = { connection: { admit: () => ({ rejection: 401 }) }, webServer: { register(route) { routes.push(route); return () => {}; } } };
  const off = registerTransport(ctx, {});
  const res = response();
  await routes[0].handler({ headers: {}, method: 'POST' }, res);
  assert.equal(res.status, 401);
  ctx.connection.admit = () => ({ peer: { principal: { kind: 'guest' } } });
  const guest = response();
  await routes[0].handler({ headers: {}, method: 'POST' }, guest);
  assert.equal(guest.status, 403);
  off();
});

test('authenticated JSON API returns explicit success and rejects non-JSON mutation', async () => {
  const routes = [];
  const ctx = { connection: { admit: () => ({ peer: { principal: { kind: 'owner' } } }) }, webServer: { register(route) { routes.push(route); return () => {}; } } };
  const off = registerTransport(ctx, { list: input => [{ parentSessionId: input.parentSessionId }] });
  const req = Readable.from([JSON.stringify({ method: 'list', args: { parentSessionId: 'main' } })]);
  req.headers = { 'content-type': 'application/json' }; req.method = 'POST';
  const res = response();
  await routes[0].handler(req, res);
  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(res.body), { ok: true, value: [{ parentSessionId: 'main' }] });
  const rejected = response();
  await routes[0].handler({ headers: { 'content-type': 'text/plain' }, method: 'POST' }, rejected);
  assert.equal(rejected.status, 415);
  off();
});
