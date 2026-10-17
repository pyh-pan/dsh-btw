import { randomUUID } from 'node:crypto';
import { invokeRuntime } from './transport.js';

export function summarizeSideState(state) {
  const messages = [];
  let own = false;
  for (const event of state.events ?? []) {
    if (event.type === 'user/message') own = true;
    if (!own || !['user/message', 'assistant/message', 'assistant/attempt', 'tool/result'].includes(event.type)) continue;
    const message = event.data?.message ?? event.data;
    const blocks = Array.isArray(message?.content) ? message.content : [];
    const text = blocks.filter(block => block.type === 'text').map(block => block.text).join('\n');
    const calls = blocks.filter(block => block.type === 'tool-call').map(block => block.name);
    if (text || calls.length) messages.push({ seq: event.seq, role: message.role ?? event.type.split('/')[0], text: text.slice(0, 1800), ...(calls.length ? { tools: calls } : {}), ...(text.length > 1800 ? { truncated: true } : {}) });
  }
  return { sideId: state.sideId, parentSessionId: state.parentSessionId, tabId: state.tabId,
    createdAt: state.createdAt, snapshotSeq: state.snapshotSeq, revision: state.revision,
    status: state.status, running: state.running, closed: state.closed,
    ...(state.error ? { error: state.error } : {}), messages: messages.slice(-16),
    ...(messages.length > 16 ? { omittedMessages: messages.length - 16 } : {}) };
}

export function registerBtwTool(ctx, runtime) {
  return ctx.tools.register({
    name: 'btw_manage',
    description: 'Create or inspect independent temporary side conversations for the current session, send a follow-up, stop an answer, or permanently close a side conversation. Closing clears its in-memory history. Sidebar navigation remains a UI action.',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['create', 'list', 'state', 'send', 'stop', 'close'], description: 'Operation. close irreversibly clears this side conversation.' },
        sideId: { type: 'string', description: 'Side conversation identifier returned by create or list; required for state, send, stop and close.' },
        text: { type: 'string', description: 'Initial question for create, or required follow-up for send. An empty create only captures context.' },
        requestId: { type: 'string', description: 'Reuse the same request identity when retrying a create or send; a new identity creates a distinct operation.' },
      }, required: ['action'],
    },
    output: {
      schema: { type: 'object', properties: { result: {} }, required: ['result'], additionalProperties: false },
      render(_args, value) { return [{ type: 'text', text: JSON.stringify(value.result) }]; },
    },
    async execute(args, exec) {
      if (!exec.agent) throw new Error('BTW operations require a receiving main session');
      if (runtime.hasSide?.(exec.agent.id)) throw new Error('A side conversation cannot manage another side conversation');
      const requestId = args.requestId ?? randomUUID();
      const input = { parentSessionId: exec.agent.id, sideId: args.sideId, requestId };
      if (args.action === 'create') {
        input.tabId = `tool:${requestId}`;
        input.question = args.text ?? '';
      } else if (args.action === 'send') input.text = args.text;
      const value = await invokeRuntime(runtime, args.action, input);
      return { result: args.action === 'state' ? summarizeSideState(value) : value };
    },
    timeoutMs: 60_000,
    isConcurrencySafe: args => args.action === 'list' || args.action === 'state',
  });
}
