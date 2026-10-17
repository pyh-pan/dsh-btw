# dsh-btw

Temporary, concurrent side conversations in **DeepSeek Harness's native right sidebar**.

[简体中文](README.zh-CN.md) · [MIT license](LICENSE)

> Independent community project. Not affiliated with DeepSeek, OpenAI or Anthropic. Currently targets **DSH 0.2.1-rc.2** exactly. Development build with automated code tests and real Host/model/tool checks. Visual/click acceptance is intentionally deferred to subsequent use.

## Interaction contract

- Submit `/btw` to create a new empty side tab, or `/btw your question` to create and send.
- Open the native sidebar's Start tab and choose **Side conversation** (the fourth entry).
- **Every entry invocation creates a new tab.** Select an existing tab to continue that conversation.
- Context is frozen when the Host accepts creation, including for empty tabs. A continuation never silently reads newer main-chat context or another side chat.
- Different side tabs can run concurrently. Their answers never automatically enter the main conversation.
- Collapsing the sidebar, changing tabs, docking, or switching main sessions retains unclosed side chats.
- **Explicitly closing a side tab clears that conversation's history**, cancels/drains its work, and prevents late responses from recreating it. Stop only cancels the current answer.
- Histories are memory-only. A browser refresh reconnects to still-open conversations in the same Host. Restarting the Host expires them; stale tabs never silently start a different conversation.

Temporary conversation history is not a temporary filesystem. Workspace tools keep their authorization boundaries, and completed tool side effects are not rolled back by closing a tab. This project does not claim to erase provider-side logs, copies made by the user, or operating-system traces.

## Architecture

The Client contributes a `multiple: true` tab kind and guide metadata to the official sidebar. The default guide entry is rendered by DSH, not a copied shell or iframe. A tab-owned, theme-matched transcript uses the standard Session event payloads. The current native SessionProvider validates bindings against the global Session pool; this plugin does not bypass that check or persist private side history merely to reuse a renderer.

Each side conversation owns an independent Cordis root with the official AgentRegistry, SessionStore, SessionProjectionRegistry and AgentLoop. No persistence, global Session publication, indexing, team, or completion-delivery subsystem is mounted there. Only model/tool/prompt capabilities are bridged from the serving runtime. The public scope ancestry link preserves parent capability restrictions while tool execution is addressed to the side Agent. Canonical runtime modules are loaded from the serving DSH installation to avoid duplicate scope registries.

UI operations and the `btw_manage` agent tool use the same Host runtime. HTTP endpoints require an authenticated owner connection. Parent identities are checked for each side operation. Browser streams transmit the side suffix only, not inherited main-chat content.

## Current capability limits

- File and web tools use the parent's permitted capability set. Terminal commands, detached jobs, delegation, team/goal control, attachments and interactive approval/question tools are not supported in this release. Operations needing approval fail closed instead of borrowing the main conversation's approval UI.
- The version-locked dispatcher retains native restrictions, monotonic guards and pre/post/result policies. It mounts native timeout handling privately; arbitrary third-party `tools/execute` around-dispatch wrappers are not generically forwarded.
- Some plugin-defined history projections (for example image offload interpreters) may not be available in the private root. Unsupported forks fail visibly rather than dropping inherited history or falling back to permanent sessions.
- Message history, model route and cwd are captured at creation. This is not a frozen clone of every external preset service: later parent-policy/preset reconfiguration has not been separately accepted.
- Original tool artifacts/large-output spill files and provider-side retention are outside the memory-only side-history guarantee.
- Disabling, upgrading or unloading the plugin also expires its temporary conversations, like restarting its Host runtime.

## Local development

Requirements: Node.js 22.19+ and pnpm. Runtime files are prebuilt into `dist`; no installation build script runs.

```sh
pnpm install --ignore-scripts
pnpm check
```

`pnpm check` syntax-checks sources, validates display metadata, checks for forbidden Harness Client imports, runs node:test suites, and builds the Host and ModuleLoader Client artifacts.

Repository: [pyh-pan/dsh-btw](https://github.com/pyh-pan/dsh-btw). Report reproducible problems through [GitHub Issues](https://github.com/pyh-pan/dsh-btw/issues).

The repository includes prebuilt runtime artifacts. To install from GitHub, replace `web` with your actual profile:

```sh
dsh plugin --profile web add github:pyh-pan/dsh-btw
```

Alternatively, clone the repository and install its directory through DSH's plugin manager. Installation affects the selected profile, not only one conversation. Do not manually edit the profile manifest or patch. If DSH reports a restart requirement, follow that result rather than assuming a browser refresh activated new Host code.

## Privacy and lifecycle

- No conversation text is written to plugin localStorage, temporary files, a private JSONL archive, or the ordinary DSH Session store.
- Native sidebar layout metadata may contain tab/resource identifiers; it must not contain conversation text or snapshots.
- Closed conversation IDs remain as bounded, content-free tombstones to reject stale requests.
- Creation and send retries are idempotent. Distinct creation request IDs always mean distinct side conversations.
- A cleanup failure is a failure, not successful deletion: the runtime keeps admission closed and permits cleanup retry.

## Release status

Source and prebuilt artifacts are maintained in the GitHub repository. No npm package or GitHub release has been published; `private: true` intentionally prevents accidental npm publication. Compatibility beyond the exact target version requires a separate verification pass.
