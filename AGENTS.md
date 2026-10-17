# dsh-btw contributor instructions

## Product contract

- Target the existing DSH Web/Desktop GUI, currently DSH 0.2.1-rc.2. Never start a replacement server.
- Use the native right sidebar, its tab registry and its default guide entry (fourth entry, order 40). Never replace the whole sidebar or create another window/iframe.
- Every submitted `/btw` and every guide click creates a NEW tab. Never reuse another side conversation.
- Freeze the main conversation's committed context when creation is accepted, even for an empty side tab. Continuations use that snapshot plus their own history, never a later main snapshot.
- Multiple side conversations run independently. Only their existing tabs provide UI continuation.
- Collapsing the sidebar, switching tabs/main sessions, docking or presentation changes must not destroy a side conversation.
- Explicit tab close immediately closes admission, cancels/drains work and clears all side history, drafts, snapshots and caches. Late responses never recreate a closed conversation.
- Side histories are memory-only. Browser refresh may reconnect to unclosed conversations in the same Host process. Host restart expires them; do not silently recreate an expired tab.
- No side completion messages, questions, or results enter the main conversation. Inherited tasks/goals/approvals are reference only.
- Preserve parent model/cwd/policy boundaries, without widening privileges. Do not bypass native authorization or approvals.

## Development

- Keep Host code in `src/host`, Client code in `src/client`, shared contracts in `src/shared`.
- Use native theme tokens and locale. No runtime import of Harness Client packages: consume services and slots instead. React is supplied by ModuleLoader.
- UI native Chat reuse is preferred but must not bypass SessionProvider identity validation or register ephemeral data in global persistence to make it work. A theme-matched transcript inside our native tab is safer than violating isolation.
- Do not edit the DSH profile or installation. Installation uses the Harness plugin manager.
- Do not commit tokens, credentials, personal paths, session contents, screenshots with private data, node_modules, or verification scratch output.
- GitHub synchronization to `https://github.com/pyh-pan/dsh-btw` is authorized. Do not publish npm packages, create releases, or change repository visibility without a separate user request.

## Team ownership

- Lead: root manifest, scripts, `src/shared`, `src/index.js`, transport/tool adapters, docs and integration.
- host-runtime: `src/host/**`, `tests/host/**`.
- client-ui: `src/client/**`, `tests/client/**`.
- Read the latest shared task before changing its status; coordinate scope changes with Lead.
