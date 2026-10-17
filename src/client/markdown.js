/** Small, text-only Markdown AST. Raw HTML stays text; no HTML renderer exists. */
export function safeHref(value) {
  if (typeof value !== 'string' || /[\u0000-\u0020\u007f\\]/u.test(value)) return undefined;
  return /^(https?:\/\/|mailto:|#|\/(?!\/))/iu.test(value) ? value : undefined;
}
export function inlineTokens(text, depth = 0) {
  if (depth > 4) return [{ type: 'text', text }];
  const result = [];
  const pattern = /(`+)([^`\n]+)\1|\*\*([^*\n]+)\*\*|\[([^\]\n]+)\]\(([^\s)]+)\)|\*([^*\n]+)\*/gu;
  let cursor = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index > cursor) result.push({ type: 'text', text: text.slice(cursor, match.index) });
    if (match[1]) result.push({ type: 'code', text: match[2] });
    else if (match[3]) result.push({ type: 'strong', children: inlineTokens(match[3], depth + 1) });
    else if (match[4]) {
      const href = safeHref(match[5]);
      result.push(href ? { type: 'a', href, children: inlineTokens(match[4], depth + 1) } : { type: 'text', text: match[0] });
    } else result.push({ type: 'em', children: inlineTokens(match[6], depth + 1) });
    cursor = match.index + match[0].length;
  }
  if (cursor < text.length) result.push({ type: 'text', text: text.slice(cursor) });
  return result;
}
export function markdownBlocks(text) {
  const lines = text.split('\n');
  const blocks = [];
  let paragraph = [];
  const flush = () => { if (paragraph.length) { blocks.push({ type: 'p', text: paragraph.join('\n') }); paragraph = []; } };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = /^\s*(```+|~~~+)([^ ]*)\s*$/u.exec(line);
    if (fence) {
      flush(); const body = [];
      while (++i < lines.length && !lines[i].trim().startsWith(fence[1])) body.push(lines[i]);
      blocks.push({ type: 'pre', text: body.join('\n'), language: fence[2] }); continue;
    }
    if (!line.trim()) { flush(); continue; }
    const heading = /^(#{1,6})\s+(.+)$/u.exec(line);
    if (heading) { flush(); blocks.push({ type: `h${heading[1].length}`, text: heading[2] }); continue; }
    const item = /^\s*(?:([-+*])|\d+\.)\s+(.+)$/u.exec(line);
    if (item) {
      flush(); const type = item[1] ? 'ul' : 'ol'; const previous = blocks.at(-1);
      if (previous?.type === type) previous.items.push(item[2]);
      else blocks.push({ type, items: [item[2]] });
      continue;
    }
    const quote = /^>\s?(.*)$/u.exec(line);
    if (quote) { flush(); blocks.push({ type: 'blockquote', text: quote[1] }); continue; }
    paragraph.push(line);
  }
  flush(); return blocks;
}
