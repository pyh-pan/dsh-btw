import { API_PATH, EVENTS_PATH, MAX_BODY_BYTES, errorRecord, validateCall } from './shared/protocol.js';

function writeJson(response, status, value) {
  if (response.writableEnded || response.destroyed) return;
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(JSON.stringify(value));
}

export async function readJson(request, limit = MAX_BODY_BYTES) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += bytes.byteLength;
    if (length > limit) throw Object.assign(new Error('Request body is too large'), { code: 'BODY_TOO_LARGE' });
    chunks.push(bytes);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw Object.assign(new Error('Invalid JSON body'), { code: 'BAD_REQUEST' }); }
}

/** Same service operations serve both native-tab UI and agent tooling. */
function withoutReplay(value) {
  if (Array.isArray(value)) return value.map(withoutReplay);
  if (!value || typeof value !== 'object') return value;
  const clean = {};
  for (const [key, item] of Object.entries(value)) {
    if (key !== 'replayState') clean[key] = withoutReplay(item);
  }
  return clean;
}

export function publicState(state) {
  if (!state || !Array.isArray(state.events)) return state;
  const inherited = state.inheritedEventCount ?? 0;
  const contextEventCount = state.contextEventCount ?? inherited;
  const visible = new Set(['user/message', 'assistant/message', 'assistant/attempt', 'tool/result', 'turn/end', 'step/end']);
  const events = state.events.slice(inherited).filter(event =>
    !event || typeof event !== 'object' || visible.has(event.type)).map(withoutReplay);
  return { ...state, events, inheritedEventCount: 0, contextEventCount, assistantFrames: withoutReplay(state.assistantFrames ?? []) };
}

export async function invokeRuntime(runtime, method, rawArgs) {
  const args = validateCall(method, rawArgs);
  const value = await runtime[method](method === 'state' ? { ...args, display: true } : args);
  return method === 'state' ? publicState(value) : value;
}

export function registerTransport(ctx, runtime) {
  const responses = new Set();
  const authorize = (request, response) => {
    const admission = ctx.connection.admit({ headers: request.headers });
    if (admission.rejection || admission.peer?.principal?.kind !== 'owner') {
      writeJson(response, admission.rejection ?? 403, { ok: false, error: { code: 'FORBIDDEN', message: 'An authenticated DSH owner connection is required' } });
      return false;
    }
    return true;
  };
  const api = ctx.webServer.register({
    kind: 'exact', path: API_PATH,
    async handler(request, response) {
      if (!authorize(request, response)) return;
      if (request.method !== 'POST') { writeJson(response, 405, { ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'Use POST' } }); return; }
      if (!(request.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) {
        writeJson(response, 415, { ok: false, error: { code: 'CONTENT_TYPE', message: 'Use application/json' } }); return;
      }
      try {
        const { method, args } = await readJson(request);
        const value = await invokeRuntime(runtime, method, args);
        writeJson(response, 200, { ok: true, value: value ?? null });
      } catch (error) {
        const status = error.code === 'BODY_TOO_LARGE' ? 413 : error.code === 'BAD_REQUEST' ? 400 : error.code === 'FORBIDDEN' ? 403 : 409;
        writeJson(response, status, { ok: false, error: errorRecord(error) });
      }
    },
  });
  const events = ctx.webServer.register({
    kind: 'exact', path: EVENTS_PATH,
    async handler(request, response) {
      if (!authorize(request, response)) return;
      if (request.method !== 'GET') { writeJson(response, 405, { ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'Use GET' } }); return; }
      const url = new URL(request.url, 'http://localhost');
      const args = { sideId: url.searchParams.get('sideId'), parentSessionId: url.searchParams.get('parentSessionId') };
      let initial;
      try { initial = await invokeRuntime(runtime, 'state', args); }
      catch (error) { writeJson(response, 410, { ok: false, error: errorRecord(error) }); return; }
      response.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-store',
        Connection: 'keep-alive', 'X-Accel-Buffering': 'no', 'X-Content-Type-Options': 'nosniff',
      });
      response.flushHeaders?.();
      responses.add(response);
      let unsubscribe = () => {};
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
        response.write(`data: ${JSON.stringify(value)}\n\n`);
        if (value?.closed === true || value?.status === 'closed') finish();
      };
      response.on('close', finish);
      try {
        unsubscribe = runtime.subscribe(args.sideId, (value) => {
          if (value?.closed === true || value?.status === 'closed') { publish(value); return; }
          if (ended || updateTimer) return;
          updateTimer = setTimeout(() => {
            updateTimer = undefined;
            if (ended) return;
            Promise.resolve().then(() => runtime.state({ ...args, display: true })).then(
              state => publish(publicState(state)),
              error => publish({ ...args, closed: true, status: 'closed', error: errorRecord(error) }),
            );
          }, 100);
          updateTimer.unref?.();
        });
        publish(initial);
        heartbeat = setInterval(() => { if (!ended && !response.destroyed) response.write(': keepalive\n\n'); }, 20_000);
        heartbeat.unref?.();
        if (ended) { clearInterval(heartbeat); unsubscribe(); }
      } catch (error) {
        publish({ ...args, closed: true, status: 'closed', error: errorRecord(error) });
        finish();
      }
    },
  });
  return () => {
    api(); events();
    for (const response of responses) response.destroy();
    responses.clear();
  };
}
