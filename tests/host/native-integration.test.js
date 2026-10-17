import test from 'node:test';
import assert from 'node:assert/strict';
import { loadNativeModules } from '../../src/native-loader.js';
import { createNativeWorld } from '../../src/host/native-world.js';

// Opt in from the serving Electron Host or an unpacked supported DSH checkout.
// Ordinary Node cannot read app.asar; do NOT shell-extract or scan the archive.
const enabled = Boolean(process.env.DSH_BTW_NATIVE_TEST_ROOT || process.versions.electron);
test('real canonical native loop and tool scheduler isolate checkpoints, not parent guards', {
  skip: enabled ? false : 'Requires serving Host or DSH_BTW_NATIVE_TEST_ROOT pointing to an unpacked supported runtime',
}, async () => {
  const native = await loadNativeModules({ runtimePath: process.env.DSH_BTW_NATIVE_TEST_ROOT });
  assert.equal(typeof native.ToolRuntime, 'function', 'Integration fixture needs canonical public ToolRuntime export');
  const parentRoot = new native.Context();
  let globalCreates = 0, globalEvents = 0, checkpointCalls = 0, preCalls = 0, bodies = 0;
  parentRoot.on('session/created', () => globalEvents++);
  parentRoot.on('session/event', () => globalEvents++);
  parentRoot.reflect.provide('sessionPersistence', {
    create() { globalCreates++; throw new Error('Global persistence was reached'); },
  });
  // LLM is unused. The Session/Agent/projection/tool registries, dependency
  // enforcement, guard resolver, scheduler and lifecycle are all REAL native
  // code. Prompt inputs alone are inert because this fixture makes no request.
  parentRoot.reflect.provide('llm', {});
  parentRoot.reflect.provide('systemPrompt', {
    variable: () => () => {}, section: () => () => {}, tools: () => () => {},
    getSectionOrder: () => 1, getContextOrder: () => 1,
  });
  await parentRoot.plugin(native.AgentRegistry);
  await parentRoot.plugin(native.ToolRuntime, { mode: 'native' });
  const rawTools = parentRoot.get('tools');
  rawTools.register({ name: 'read', description: 'integration fixture', parameters: {type:'object'},
    output: { schema: {type:'string'}, render: (_args,value) => [{type:'text',text:value}] },
    execute: async () => { bodies++; return 'fixture content'; },
  });
  rawTools.guard(exec => exec.arguments.guardDeny ? 'original parent guard' : undefined);
  parentRoot.on('tools/pre-execute', async (exec,next) => {
    preCalls++; return exec.arguments.policyDeny ? {kind:'deny',reason:'original parent policy'} : next();
  });
  parentRoot.on('tools/execute', async () => {
    checkpointCalls++; throw new Error('session is not live in this store');
  });
  const originalScheduler = rawTools[native.TOOL_RUNTIME_SCHEDULER];
  const parent = { id: 'btw-native-integration-parent', ctx: parentRoot };
  let world;
  try {
    world = await createNativeWorld({ native, hostCtx: parentRoot, parent,
      sideId: 'btw-native-integration-private',
      capture: { events: [], model: {}, cwd: undefined }, onChange() {},
    });
    assert.equal(world.agent.status, 'idle');
    assert.equal(world.agent.inbox.nextTurn.length, 0);
    assert.equal(world.agent.inbox.nextStep.length, 0);
    assert.equal(world.read().header.isSeeded, true);
    assert.equal(world.read().events[0].type, 'session/end-seed');
    const scheduler = world.agent.ctx.get('tools')[native.TOOL_RUNTIME_SCHEDULER];
    const run = async arguments_ => {
      const input = {name:'read',callId:'native-contract-call',agent:world.agent,
        arguments:arguments_,signal:new AbortController().signal};
      const prepared = await scheduler.prepare(input);
      assert.equal(prepared.kind,'dispatch');
      const dispatched = await scheduler.dispatch(prepared.exec);
      assert.equal(dispatched.kind,'final-result'); assert.equal(input.parent,undefined);
      return scheduler.finish(prepared.exec,dispatched.result);
    };
    assert.equal((await run({})).isError,false);
    const guardDenied=await run({guardDeny:true});
    assert.equal(guardDenied.isError,true); assert.match(guardDenied.content[0].text,/original parent guard/);
    const policyDenied=await run({policyDeny:true});
    assert.equal(policyDenied.isError,true); assert.match(policyDenied.content[0].text,/original parent policy/);
    assert.equal(preCalls,3); assert.equal(bodies,1); assert.equal(checkpointCalls,0);
    assert.equal(rawTools[native.TOOL_RUNTIME_SCHEDULER],originalScheduler);
    assert.equal(globalCreates,0); assert.equal(globalEvents,0);
    await world.dispose(); world=undefined;
    assert.equal(globalCreates,0); assert.equal(globalEvents,0);
  } finally {
    await world?.dispose();
    await Promise.resolve(parentRoot.fiber.dispose());
    while (parentRoot.fiber.inertia !== undefined) await parentRoot.fiber.inertia;
  }
});
