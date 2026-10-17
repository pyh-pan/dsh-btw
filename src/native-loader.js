import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { isAbsolute, join } from 'node:path';

const SUPPORTED_DSH = '0.2.1-rc.2';
const PACKAGES = {
  '@deepseek-ai/cordis': ['Context', 'symbols', 'getTraceable'],
  '@deepseek-ai/dsh-agent': ['AgentRegistry'],
  '@deepseek-ai/dsh-session': ['SessionStore', 'buildForkSeed'],
  '@deepseek-ai/dsh-session-projection': ['SessionProjectionRegistry'],
  '@deepseek-ai/dsh-agent-loop': ['AgentLoop'],
  '@deepseek-ai/dsh-scope': ['bindScopeParent', 'createScope', 'scopeTarget'],
  '@deepseek-ai/dsh-tools': ['TOOL_RUNTIME_SCHEDULER', 'ToolRuntime'],
  '@deepseek-ai/dsh-llm': ['createUserMessage'],
};

/** Resolve the serving runtime, not a second npm copy with distinct scope WeakMaps. */
export async function loadNativeModules(options = {}) {
  const anchors = [];
  if (options.runtimePath) anchors.push(pathToFileURL(join(options.runtimePath, 'package.json')).href);
  if (process.resourcesPath) anchors.push(pathToFileURL(join(process.resourcesPath, 'app.asar', 'dsh', 'package.json')).href);
  if (process.argv[1] && isAbsolute(process.argv[1])) anchors.push(pathToFileURL(process.argv[1]).href);
  anchors.push(import.meta.url);
  const attempts = [];
  for (const anchor of [...new Set(anchors)]) {
    try {
      const probe = createRequire(anchor);
      const manifestPath = probe.resolve('@deepseek-ai/dsh/package.json');
      const resolve = createRequire(manifestPath);
      const manifest = resolve(manifestPath);
      if (manifest.version !== SUPPORTED_DSH) {
        throw new Error(`dsh-btw requires DSH ${SUPPORTED_DSH}; found ${manifest.version}`);
      }
      const native = { version: manifest.version };
      for (const [name, symbols] of Object.entries(PACKAGES)) {
        const entry = resolve.resolve(name);
        const module = await import(pathToFileURL(entry).href);
        for (const symbol of symbols) {
          const expected = symbol === 'symbols' ? 'object' : symbol === 'TOOL_RUNTIME_SCHEDULER' ? 'symbol' : 'function';
          if (typeof module[symbol] !== expected || module[symbol] === null) throw new Error(`Missing public export ${name}#${symbol}`);
          native[symbol] = module[symbol];
        }
      }
      native.TimeoutPolicy = await import(pathToFileURL(resolve.resolve('@deepseek-ai/dsh-tool-call-timeout-policy')).href);
      if (typeof native.TimeoutPolicy.apply !== 'function' || !Array.isArray(native.TimeoutPolicy.inject)) {
        throw new Error('Missing public timeout policy module');
      }
      return native;
    } catch (error) {
      attempts.push(error.message);
    }
  }
  throw new Error(`Cannot resolve the supported serving DSH runtime: ${[...new Set(attempts)].join('; ')}`);
}

export { SUPPORTED_DSH };
