import React, { useEffect, useRef, useSyncExternalStore } from 'react';
import { BtwController, btwSource, createStore, newTabOperation, normalizeTab, PLUGIN_ID, TAB_KIND } from './controller.js';
import { createApi } from './api.js';
import { transcriptRows, liveText } from './transcript.js';
import { markdownBlocks, inlineTokens } from './markdown.js';

const h = React.createElement;
const NS = 'btw';
const dictionaries = {
  en: {
    title: 'Side conversation', description: 'Ask aside, without interrupting this conversation',
    placeholder: 'Ask a side question…', opening: 'Freezing conversation context…',
    empty: 'A separate thread, the same context.', hint: 'Context is frozen; closing the tab clears its memory. File and web tools supported; terminal, background tasks and attachments unavailable.',
    expired: 'This side conversation has expired. Open a new one from /btw or the sidebar guide.',
    send: 'Send', stop: 'Stop', running: 'Working…', user: 'You', assistant: 'Assistant',
    attachmentsUnsupported: '/btw does not accept attachments. Remove them before submitting.',
    wrongSession: 'Return to the original conversation before opening a side conversation.',
    connectionError: 'Side conversation connection interrupted; reconnecting…', snapshot: 'Snapshot', created: 'Created', retry: 'Retry cleanup', cleanupError: 'A closed side conversation could not be cleared on the Host. Retry to finish clearing its in-memory history.'
  },
  zh: {
    title: '侧边对话', description: '旁问一句，不打断当前对话', placeholder: '在这里旁问一句…',
    opening: '正在冻结当前对话上下文…', empty: '另起一线，承接此刻上下文。',
    hint: '上下文已冻结，仅存内存，关闭标签后清除。支持文件与网页工具；终端、后台任务和附件不可用。',
    expired: '此侧聊已失效。请通过 /btw 或侧栏入口新建。',
    send: '发送', stop: '停止', running: '正在处理…', user: '你', assistant: '助手',
    attachmentsUnsupported: '/btw 不接受附件，请先移除附件再发送。',
    wrongSession: '请先回到原对话，再新建侧聊。', connectionError: '侧聊连接中断，正在重新连接…', snapshot: '快照', created: '创建于', retry: '重试清除', cleanupError: '关闭侧边对话后的 Host 清除操作未完成，请重试以清除其内存历史。'
  }
};

const css = `
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
  return h('svg', { width: size, height: size, className, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true },
    h('path', { d: 'M2.5 2.5h8v6h-4l-2.5 2v-2H2.5zM8.5 10.5h3l2 2v-6h-1', stroke: 'currentColor', strokeWidth: 1.25, strokeLinejoin: 'round' }));
}
function inline(nodes) {
  return nodes.map((node, key) => node.type === 'text' ? node.text : h(node.type, { key, ...(node.href ? { href: node.href, target: '_blank', rel: 'noreferrer noopener' } : {}) }, node.children ? inline(node.children) : node.text));
}
function Markdown({ text }) {
  return markdownBlocks(text).map((block, key) => block.type === 'pre'
    ? h('pre', { key }, h('code', null, block.text))
    : block.items ? h(block.type, { key }, block.items.map((item, i) => h('li', { key: i }, inline(inlineTokens(item)))))
    : h(block.type, { key }, inline(inlineTokens(block.text))));
}
const missing = createStore({ phase: 'opening', draft: '', busy: false });
function SideTitle({ sessionId, useTabInfo, controller, t }) {
  const { tab } = useTabInfo();
  const entry = controller.get(normalizeTab(sessionId, tab));
  const store = entry?.store ?? missing;
  useSyncExternalStore(store.subscribe, store.getSnapshot);
  return `${t('title')} ${entry?.ordinal ?? tab.id.replace('tab', '#')}`;
}
function CleanupNotice({ controller, t }) {
  const errors = useSyncExternalStore(controller.cleanupStore.subscribe, controller.cleanupStore.getSnapshot);
  return errors.length ? h('div', { role: 'alert', className: 'btw-error' }, t('cleanupError'), ' ', h('button', { type: 'button', onClick: () => { void controller.retryCleanup(); } }, t('retry'))) : null;
}

/** Runs within the native Sidebar tab seat. It never changes main Session scope. */
function SideChat({ sessionId, useTabInfo, controller, t }) {
  const { tab } = useTabInfo();
  const record = normalizeTab(sessionId, tab);
  const entry = controller.get(record);
  const store = entry?.store ?? missing;
  const view = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const scroll = useRef(null);
  const editor = useRef(null);
  const previouslyVisible = useRef(tab.visible);
  const focusedNew = useRef(false);
  useEffect(() => {
    const becameVisible = tab.visible && !previouslyVisible.current;
    const newReady = tab.visible && view.phase === 'ready' && !entry?.restored && !focusedNew.current;
    if ((becameVisible || newReady) && view.phase === 'ready') {
      editor.current?.focus({ preventScroll: true });
      focusedNew.current = true;
    }
    previouslyVisible.current = tab.visible;
  }, [tab.visible, view.phase, entry]);
  const state = view.state ?? {};
  const rows = transcriptRows(state);
  const live = liveText(state);
  const running = state.status === 'running';
  useEffect(() => {
    const element = scroll.current;
    if (element && element.scrollHeight - element.scrollTop - element.clientHeight < 200) element.scrollTop = element.scrollHeight;
  }, [state]);
  const submit = event => { event.preventDefault(); void controller.send(record); };
  return h('section', { 'data-btw-chat': '', 'aria-label': t('title') },
    h('style', null, css),
    h('p', { className: 'btw-context' }, t('hint'), entry?.meta && h('span', { style: { display: 'block' } }, `${t('created')} ${new Date(entry.meta.createdAt).toLocaleString()} · ${t('snapshot')} ${entry.meta.snapshotSeq ?? '—'}`)),
    h('div', { className: 'btw-transcript', ref: scroll, role: 'log', 'aria-live': 'polite', 'aria-relevant': 'additions text' },
      view.phase === 'opening' && h('div', { className: 'btw-empty', role: 'status' }, t('opening')),
      (view.phase === 'expired' || view.phase === 'closed') && h('p', { className: 'btw-empty' }, t('expired')),
      view.phase === 'ready' && rows.length === 0 && !running && h('p', { className: 'btw-empty' }, t('empty')),
      ...rows.map(row => row.kind === 'tool'
        ? h('details', { className: 'btw-tool', key: row.id }, h('summary', null, row.title), h('pre', null, row.text))
        : h('article', { className: 'btw-message', 'data-role': row.kind, 'aria-label': t(row.kind), key: row.id }, row.kind === 'assistant' ? h(Markdown, { text: row.text }) : row.text)),
      live && h('article', { className: 'btw-message', 'data-role': 'assistant' }, live),
      running && h('div', { className: 'btw-status', role: 'status' }, t('running')),
      (view.error || state.error) && h('p', { className: 'btw-error', role: 'alert' }, view.error || state.error)
    ),
    h('form', { className: 'btw-composer', onSubmit: submit },
      h('textarea', {
        ref: editor, value: view.draft, placeholder: t('placeholder'), 'aria-label': t('placeholder'), rows: 2,
        disabled: view.phase !== 'ready' || view.busy,
        onChange: event => controller.setDraft(record, event.target.value),
        onKeyDown: event => {
          if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && !event.isComposing) { event.preventDefault(); void controller.send(record); }
        }
      }),
      h('footer', null,
        running && h('button', { type: 'button', onClick: () => { void controller.stop(record); } }, t('stop')),
        h('button', { type: 'submit', disabled: view.phase !== 'ready' || view.busy || !view.draft.trim() }, t('send'))
      )
    )
  );
}

export const inject = ['slots', 'sidebarRight', 'sidebarRightTabs', 'inputTriggers', 'locale'];

export function apply(ctx) {
  ctx.effect(() => ctx.locale.register(NS, dictionaries), 'btw: locale');
  const t = ctx.locale.bind(NS);
  const api = createApi({ connectionMessage: t('connectionError') });
  const controller = new BtwController(api);
  ctx.effect(() => () => controller.dispose(), 'btw: memory-only UI lifetime');
  ctx.effect(() => ctx.sidebarRightTabs.register({
    id: PLUGIN_ID, kind: TAB_KIND, multiple: true, keepMounted: true,
    title: () => t('title'),
    guide: [{ id: 'new', order: 40, icon: SideGlyph, title: () => t('title'), description: () => t('description') }]
  }), 'btw: native multiple tab and default guide entry');

  ctx.effect(() => {
    const inventory = ctx.sidebarRight.openTabs;
    const initial = inventory.getSnapshot();
    const restoration = controller.restore(initial);
    const off = inventory.subscribe(() => controller.reconcile(inventory.getSnapshot()));
    restoration.catch(() => {});
    return off;
  }, 'btw: snapshot at native tab creation');
  ctx.effect(() => ctx.sidebarRight.registerCloseHandler(TAB_KIND, (sessionId, tab) => {
    controller.close(normalizeTab(sessionId, tab));
  }), 'btw: explicit close destroys; collapse retains');
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register({ name: 'sidebar.right.pane.tab.title', key: PLUGIN_ID, locale: NS }, props => h(SideTitle, { ...props, controller, t }))), 'btw: distinct native tab titles');
  ctx.effect(() => ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({ name: 'conversation.composer.dock', id: 'btw-cleanup-notice', locale: NS }, () => h(CleanupNotice, { controller, t }))), 'btw: visible cleanup failure and retry');

  const openNew = newTabOperation(controller, ctx.sidebarRight, api, { wrongSession: t('wrongSession') });
  ctx.effect(() => ctx.inputTriggers.registerSource(btwSource(openNew, t)), 'btw: transactional input-trigger submit');
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab', key: PLUGIN_ID, locale: NS
  }, props => h(SideChat, { ...props, controller, t }))), 'btw: native tab body');
}
