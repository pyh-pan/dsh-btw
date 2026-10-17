/** Safe, text-only presentation of standard Session payloads; never inject model HTML. */
export function contentText(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(contentText).filter(Boolean).join('\n');
  if (!value || typeof value !== 'object') return '';
  if (value.type === 'reasoning' || value.type === 'reasoning-chunks') return '';
  if (value.type === 'text-chunks') return value.texts.join('');
  if (value.type === 'chunk') return contentText(value.chunk);
  if (value.type === 'block-end') return ''; // deltas already contain this block
  if (typeof value.text === 'string') return value.text;
  if (typeof value.content === 'string' || Array.isArray(value.content)) return contentText(value.content);
  return '';
}

export function transcriptRows(state = {}) {
  const rows = [];
  let ownUserSeen = false;
  for (const event of (state.events ?? []).slice(state.inheritedEventCount ?? 0)) {
    if (event.type === 'user/message') ownUserSeen = true;
    if (!ownUserSeen) continue; // synthetic fork closures are context, not this side thread
    const data = event.data ?? event;
    if (event.type === 'user/message') {
      const text = contentText(data.content ?? data.message?.content ?? data.message ?? data);
      if (text) rows.push({ id: `user:${event.seq}`, kind: 'user', text });
    } else if (event.type === 'assistant/message' || event.type === 'assistant/attempt') {
      const content = data.message?.content ?? data.content;
      let text = contentText(content);
      // Compact stream payloads use ordered typed blocks. Retain textual output only.
      if (!text) text = Array.isArray(data.stream) ? liveText({ assistantFrames: data.stream }) : contentText(data.stream?.blocks ?? data.blocks);
      if (text) rows.push({ id: `assistant:${event.seq}`, kind: 'assistant', text });
      for (const block of Array.isArray(content) ? content : []) {
        if (block.type === 'tool-call' || block.type === 'tool_use') rows.push({ id: `call:${event.seq}:${block.id ?? block.toolCallId}`, kind: 'tool', title: block.name ?? block.toolName ?? 'Tool', text: typeof block.arguments === 'string' ? block.arguments : JSON.stringify(block.arguments ?? block.input ?? {}, null, 2) });
      }
    } else if (event.type === 'tool/result') {
      const result = data.message ?? data.result ?? data;
      rows.push({ id: `tool:${event.seq}`, kind: 'tool', title: data.toolName ?? data.name ?? result.toolCallId ?? 'Tool', text: contentText(result.content ?? result.output ?? result.error ?? result) || JSON.stringify(result, null, 2) });
    }
  }
  return rows;
}

/** Fold native AssistantStreamFrames as well as compact AssistantStreamRecords.
 * Block-end is authoritative, so a final block never duplicates prior deltas.
 * Reasoning/tool/usage frames never become visible assistant answer text.
 */
export function liveText(state = {}) {
  const blocks = new Map();
  for (const frame of state.assistantFrames ?? []) {
    if (frame.type === 'start') { blocks.clear(); continue; }
    const data = frame.chunk ?? frame.data?.chunk ?? frame.data ?? frame;
    const index = data.index ?? 0;
    if (data.type === 'block-start') { blocks.set(index, ''); continue; }
    if (data.type === 'block-end') {
      if (data.block?.type === 'text') blocks.set(index, data.block.text);
      continue;
    }
    let delta = '';
    if (data.type === 'text-chunks') delta = (data.texts ?? []).filter(value => typeof value === 'string').join('');
    else if (data.type === 'text-delta' || data.type === 'text' || data.type === 'assistant/text') delta = data.text ?? data.delta ?? '';
    else if (typeof data.delta?.text === 'string') delta = data.delta.text;
    if (typeof delta === 'string' && delta) blocks.set(index, (blocks.get(index) ?? '') + delta);
  }
  return [...blocks.entries()].sort(([a], [b]) => a - b).map(([, text]) => text).join('\n');
}
