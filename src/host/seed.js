/** Pure fork preparation. No inherited inbox entry is executable in a side chat. */
export function cancelInheritedInbox(events, now = Date.now) {
  const pending = { 'next-step': [], 'next-turn': [] };
  for (const event of events) {
    if (event.type !== 'agent/inbox/spliced') continue;
    const { target, start, removedCount = 0, inserted } = event.data;
    const list = pending[target];
    if (!list || !Number.isSafeInteger(start) || start < 0 || start > list.length ||
        !Number.isSafeInteger(removedCount) || removedCount < 0 || start + removedCount > list.length || !Array.isArray(inserted)) {
      throw new Error('Invalid inherited inbox splice');
    }
    list.splice(start, removedCount, ...inserted);
  }
  const seed = structuredClone(events);
  for (const target of ['next-step', 'next-turn']) {
    if (!pending[target].length) continue;
    seed.push({ type: 'agent/inbox/spliced', seq: seed.length, time: now(), data: {
      target, start: 0, removedCount: pending[target].length, inserted: [], outcome: 'canceled',
    } });
  }
  return seed;
}

// Fail closed for unknown/custom tools: their detached work and cache lifetime
// have not been established. This remains a real tool-using native Agent; only
// capabilities whose foreground lifecycle is known are inherited from parent.
export const SIDE_TOOL_ALLOWLIST = Object.freeze([
  'read', 'read_image', 'write', 'edit', 'glob', 'grep',
  'web_search', 'web_fetch', 'working_directory', 'skill', 'todo_write',
  'cordis_inspect_list', 'cordis_inspect_query', 'load_workspace_dependencies',
]);
const allowedTools = new Set(SIDE_TOOL_ALLOWLIST);
export function sideToolNames(schemas) {
  return schemas.map(({ name }) => name).filter(name => allowedTools.has(name));
}

export const SIDE_CONTEXT_INSTRUCTION = `This is a temporary, independent side conversation. The inherited main conversation is reference material only: do not resume its tasks, pending inputs, goals, team work, or approvals. Answer only the new messages in this side conversation. Never send messages, completion reports, questions, or results to the main conversation or a team. Conversation history exists only in this Host process and is discarded on explicit close. Normal workspace tools retain their existing authorization; temporary conversation history does not make external tool side effects temporary.`;
