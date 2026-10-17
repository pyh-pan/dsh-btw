import { loadNativeModules } from './native-loader.js';
import { createRuntime } from './host/runtime.js';
import { publicState, registerTransport } from './transport.js';
import { registerBtwTool } from './tool.js';

export const inject = ['agents', 'sessions', 'sessionQuery', 'workingDirectory', 'tools', 'connection', 'webServer'];

/** One isolated, memory-only runtime; never patches the serving DSH installation. */
export async function apply(ctx, config = {}) {
  const native = await loadNativeModules({ runtimePath: config.runtimePath });
  const runtime = await createRuntime(ctx, { native, projectState: publicState });
  ctx.effect(() => () => runtime.dispose(), 'dsh-btw: temporary worlds');
  ctx.effect(() => registerTransport(ctx, runtime), 'dsh-btw: authenticated transport');
  ctx.effect(() => registerBtwTool(ctx, runtime), 'dsh-btw: service tooling');
  ctx.effect(() => ctx.reflect.provide('btwConversations', runtime), 'dsh-btw: application service');
}
