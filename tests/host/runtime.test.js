import test from 'node:test';
import assert from 'node:assert/strict';
import { createRuntime, captureParent } from '../../src/host/runtime.js';
import { cancelInheritedInbox, sideToolNames } from '../../src/host/seed.js';

const deferred = () => { let resolve, reject; const promise = new Promise((a,b) => {resolve=a; reject=b;}); return {promise,resolve,reject}; };
const event = (seq, text) => ({ type: 'user/message', seq, time: 1, surfaceOp: 'append', data: { content: [{type:'text',text}] } });
async function fixture(options = {}) {
  const parentEvents = [event(0, 'main history')];
  const parent = { id: 'main', options: {provider:'p',model:'m'}, session: { seq: 1, header: {cwd:'/work'} } };
  const globalWrites = [];
  const worlds = [];
  const ctx = { agents: { get: id => id === 'main' ? parent : undefined },
    // These deliberately fail if the runtime ever takes the global creation path.
    sessionPersistence: { create: () => globalWrites.push('persist') },
    sessions: { create: () => globalWrites.push('global-session') } };
  let n = 0;
  const runtime = await createRuntime(ctx, {
    mintId: () => `side-${++n}`, now: () => 123,
    capture: async (_ctx, _parent, boundary) => ({events: structuredClone(parentEvents.slice(0,boundary)),model:{provider:'p',model:'m'},cwd:'/work'}),
    createWorld: async ({capture,sideId,onChange,parent: explicitParent}) => {
      const log = structuredClone(capture.events);
      const world = { capture, sideId, explicitParent, sent: [], disposed: false, stopped: false, onChange,
        read: () => ({header:{id:sideId},inheritedEventCount:capture.events.length,events:log,projections:{asOfSeq:log.length-1,values:{}},running:world.sent.length>0,status:world.sent.length?'running':'idle',assistantFrames:[]}),
        send: text => { world.sent.push(text); log.push(event(log.length,text)); onChange(); },
        stop: () => { world.stopped = true; },
        dispose: async () => {world.disposed = true; log.length = 0;},
      };
      worlds.push(world); return world;
    }, ...options,
  });
  const create = (extra={}) => runtime.create({parentSessionId:'main',requestId:`r-${n+1}`,tabId:`tab-${n+1}`,...extra});
  const addr = sideId => ({sideId,parentSessionId:'main'});
  return {runtime,create,addr,parent,parentEvents,globalWrites,worlds};
}

test('creation freezes even an empty tab; continuation never re-reads the parent', async () => {
  const f = await fixture();
  const a = await f.create();
  f.parentEvents.push(event(1,'new main content')); f.parent.session.seq++;
  const b = await f.create({question:'second question'});
  f.runtime.send({...f.addr(a.sideId),requestId:'s1',text:'first tab question'});
  assert.equal(a.snapshotSeq,0); assert.equal(b.snapshotSeq,1);
  assert.equal(a.createdAt,123); assert.equal(a.tabId,'tab-1');
  assert.deepEqual(f.worlds[0].capture.events.map(e=>e.data.content[0].text),['main history']);
  assert.deepEqual(f.worlds[0].sent,['first tab question']);
  assert.deepEqual(f.worlds[1].sent,['second question']);
  assert.deepEqual(f.globalWrites,[]);
  await f.runtime.dispose();
});

test('create and send are idempotent, distinct create requests always get new tabs', async () => {
  const f = await fixture();
  const request = {parentSessionId:'main',requestId:'same',tabId:'one',question:'q'};
  const [a,b] = await Promise.all([f.runtime.create(request),f.runtime.create(request)]);
  assert.equal(a.sideId,b.sideId); assert.equal(f.worlds.length,1); assert.deepEqual(f.worlds[0].sent,['q']);
  await assert.rejects(f.runtime.create({...request,question:'other'}),{code:'BTW_CONFLICT'});
  await assert.rejects(f.runtime.create({...request,tabId:'other'}),{code:'BTW_CONFLICT'});
  const s = {...f.addr(a.sideId),requestId:'send',text:'continue'};
  f.runtime.send(s); f.runtime.send(s);
  assert.equal(f.worlds[0].sent.length,2);
  assert.throws(()=>f.runtime.send({...s,text:'different'}),/different text/);
  assert.notEqual((await f.create()).sideId,a.sideId);
  await f.runtime.dispose();
});

test('returned event snapshots cannot mutate live history', async () => {
  const f = await fixture(); const a = await f.create();
  const first = f.runtime.state(f.addr(a.sideId));
  first.events[0].data.content[0].text = 'corrupt'; first.events.length = 0;
  assert.equal(f.runtime.state(f.addr(a.sideId)).events[0].data.content[0].text,'main history');
  await f.runtime.dispose();
});

test('display state projects before clone while default state preserves full detached semantics', async()=>{
  let projectedCalls=0;
  const f=await fixture({projectState:raw=>{
    projectedCalls++;return {sideId:raw.sideId,contextEventCount:raw.inheritedEventCount,
      events:raw.events.filter(e=>e.seq>=raw.inheritedEventCount)};
  }});
  const a=await f.create({question:'own message'});
  const originalRead=f.worlds[0].read;
  f.worlds[0].read=()=>({...originalRead(),internalOnly:()=>{}});
  // A function cannot be structured-cloned. The display projection must run
  // before clone to remove this internal fixture sentinel, not after a copy.
  const displayed=f.runtime.state({...f.addr(a.sideId),display:true});
  assert.equal(projectedCalls,1);assert.equal(displayed.contextEventCount,1);
  assert.equal(displayed.events.length,1);assert.equal(displayed.events[0].data.content[0].text,'own message');
  displayed.events[0].data.content[0].text='not live';
  f.worlds[0].read=originalRead;
  const full=f.runtime.state(f.addr(a.sideId));assert.equal(projectedCalls,1);
  assert.equal(full.events.length,2);assert.equal(full.events[1].data.content[0].text,'own message');
  await f.runtime.dispose();
});

test('parent authority is checked for every read and mutation', async () => {
  const f = await fixture(); const a = await f.create(); const bad = {sideId:a.sideId,parentSessionId:'other'};
  for (const method of ['state','stop','close']) assert.throws(()=>f.runtime[method](bad),{code:'BTW_FORBIDDEN'});
  assert.throws(()=>f.runtime.send({...bad,requestId:'x',text:'x'}),{code:'BTW_FORBIDDEN'});
  assert.deepEqual(f.runtime.list({parentSessionId:'other'}),[]);
  await f.runtime.dispose();
});

test('close synchronously rejects admission, drains once, purges caches and ignores late events', async () => {
  const drain = deferred(); const f = await fixture(); const a = await f.create();
  let disposals = 0;
  f.worlds[0].dispose = async () => {disposals++; await drain.promise; f.worlds[0].disposed=true;};
  const seen=[]; f.runtime.subscribe(a.sideId,e=>seen.push(e));
  const closing = f.runtime.close(f.addr(a.sideId));
  const duplicate = f.runtime.close(f.addr(a.sideId));
  assert.equal(closing,duplicate);
  assert.throws(()=>f.runtime.state(f.addr(a.sideId)),{code:'BTW_EXPIRED'});
  assert.throws(()=>f.runtime.send({...f.addr(a.sideId),requestId:'late',text:'late'}),{code:'BTW_EXPIRED'});
  f.worlds[0].onChange(); assert.equal(seen.length,0);
  drain.resolve(); await closing;
  assert.equal(disposals,1); assert.equal(seen.length,1); assert.equal(seen[0].closed,true);
  assert.deepEqual(f.runtime.list({parentSessionId:'main'}),[]);
  await assert.rejects(f.runtime.create({parentSessionId:'main',requestId:'r-1',tabId:'tab-1'}),{code:'BTW_EXPIRED'});
  await f.runtime.dispose();
});

test('close by tab rejects an initializing tab before its side ID reaches the Client', async () => {
  const capture=deferred(); const f=await fixture({capture:()=>capture.promise});
  const creation=f.create({question:'must never run'}); const rejected=assert.rejects(creation,{code:'BTW_EXPIRED'});
  const closed=f.runtime.close({parentSessionId:'main',tabId:'tab-1'});
  capture.resolve({events:[]}); await rejected; await closed;
  assert.equal(f.worlds.length,0); assert.deepEqual(f.runtime.list({parentSessionId:'main'}),[]);
  await f.runtime.dispose();
});

test('close-before-create records a tab tombstone against reordered requests', async()=>{
  const f=await fixture(); await f.runtime.close({parentSessionId:'main',tabId:'tab-1'});
  await assert.rejects(f.create(),{code:'BTW_EXPIRED'}); assert.equal(f.worlds.length,0);
  await f.runtime.dispose();
});

test('unload during snapshot capture does not create or resurrect a world', async () => {
  const capture = deferred(); const f = await fixture({capture:()=>capture.promise});
  const creation = f.create(); const rejected = assert.rejects(creation,{code:'BTW_EXPIRED'});
  const dispose = f.runtime.dispose(); capture.resolve({events:[]});
  await rejected; await dispose;
  assert.equal(f.worlds.length,0);
  assert.deepEqual(f.runtime.list({parentSessionId:'main'}),[]);
  await assert.rejects(f.create(),{code:'BTW_EXPIRED'});
});

test('a creation failure is cleaned and cannot silently replay an old request', async () => {
  const f = await fixture({createWorld:async()=>{throw new Error('native failure');}});
  await assert.rejects(f.create(),/native failure/);
  assert.deepEqual(f.runtime.list({parentSessionId:'main'}),[]);
  await assert.rejects(f.runtime.create({parentSessionId:'main',requestId:'r-1',tabId:'tab-1'}),{code:'BTW_EXPIRED'});
  await f.runtime.dispose();
});

test('cleanup failure stays closed, reports failure and permits an explicit retry', async () => {
  const f = await fixture(); const a = await f.create(); let attempts=0;
  f.worlds[0].dispose=async()=>{ if (++attempts===1) throw new Error('cleanup failed'); };
  await assert.rejects(f.runtime.close(f.addr(a.sideId)),/cleanup failed/);
  assert.ok(f.runtime.hasSide(a.sideId));
  assert.throws(()=>f.runtime.state(f.addr(a.sideId)),{code:'BTW_EXPIRED'});
  assert.deepEqual(f.runtime.list({parentSessionId:'main'}),[]);
  await f.runtime.close(f.addr(a.sideId)); assert.equal(attempts,2);
  await f.runtime.dispose();
});

test('subscribers are bounded by ownership and can unsubscribe', async () => {
  const f = await fixture(); const a = await f.create(); const b = await f.create();
  let count=0; const undo=f.runtime.subscribe(a.sideId,()=>count++);
  f.worlds[1].onChange(); assert.equal(count,0);
  f.worlds[0].onChange(); assert.equal(count,1);
  undo(); f.worlds[0].onChange(); assert.equal(count,1);
  f.runtime.stop(f.addr(b.sideId)); assert.equal(f.worlds[1].stopped,true);
  await f.runtime.dispose(); assert.ok(f.worlds.every(w=>w.disposed));
});

test('capture observes only the synchronously admitted prefix and releases its lease', async () => {
  const read=deferred(); let released=false;
  const parent={id:'p',options:{provider:'x',model:'old'},session:{seq:1,header:{cwd:'/before',agentPreset:'coding'},requestHeader:()=>({config:{provider:'x',model:'old'}})}};
  const ctx={workingDirectory:{get:()=>'/before'},sessionQuery:{observeSession:()=>read.promise}};
  const capture=captureParent(ctx,parent);
  parent.options.model='new'; parent.session.header.cwd='/after';
  read.resolve({events:[event(0,'before'),event(1,'after')],[Symbol.dispose](){released=true;}});
  const result=await capture;
  assert.equal(result.events.length,1); assert.equal(result.model.model,'old'); assert.equal(result.cwd,'/before'); assert.equal(result.snapshotSeq,0); assert.ok(released);
});

test('capture uses only pending model selection, not an old consumed selection', async()=>{
  const events=[{type:'model/selection',seq:0,time:1,data:{provider:'old',model:'consumed'}}];
  let pending=null;
  const parent={id:'p',options:{},session:{seq:1,header:{},requestHeader:()=>({config:{provider:'current',model:'logged',reasoningEffort:'auto'},adapterDefaults:{reasoningEffort:true}})}};
  const ctx={get:name=>name==='sessionProjections'?{stateOf:(_session,key)=>key==='modelSelection'?{pending}:undefined}:undefined,
    sessionQuery:{observeSession:async()=>({events,[Symbol.dispose](){}})}};
  const consumed=await captureParent(ctx,parent);assert.deepEqual(consumed.model,{provider:'current',model:'logged'});
  pending={provider:'next',model:'pending'};
  const selected=await captureParent(ctx,parent);assert.deepEqual(selected.model,{provider:'next',model:'pending'});
});

test('blank main model default and tool names are captured before an async observation',async()=>{
  const read=deferred();let selected={provider:'p',model:'default'};const tools=[{name:'read'}];
  const parent={id:'p',ctx:{tools:{schemas:()=>tools}},options:{},session:{seq:0,header:{}}};
  const ctx={get:name=>name==='agentDefaultModel'?{currentSelection:()=>selected}:undefined,
    sessionQuery:{observeSession:()=>read.promise}};
  const capture=captureParent(ctx,parent);selected={provider:'changed',model:'later'};tools.push({name:'edit'});
  read.resolve({events:[],[Symbol.dispose](){}});const result=await capture;
  assert.deepEqual(result.model,{provider:'p',model:'default'});assert.deepEqual(result.toolNames,['read']);
});

test('inherited pending turn and step inputs are canceled without altering any prefix', () => {
  const input=[{type:'agent/inbox/spliced',seq:0,time:1,data:{target:'next-turn',start:0,inserted:[{id:'parent-pending'}]}},
    {type:'agent/inbox/spliced',seq:1,time:1,data:{target:'next-step',start:0,inserted:[{id:'parent-steering'}]}},
    {type:'session/end-seed',seq:2,time:1,data:{inherited:true}}];
  const seed=cancelInheritedInbox(input,()=>5);
  assert.deepEqual(seed.slice(0,3),input); assert.equal(input.length,3);
  assert.deepEqual(seed.slice(3).map(e=>[e.data.target,e.data.removedCount,e.data.outcome]),[['next-step',1,'canceled'],['next-turn',1,'canceled']]);
  assert.deepEqual(seed.map(e=>e.seq),[0,1,2,3,4]);
});

test('side tool mask keeps workspace capabilities, not delegation or durable control', () => {
  const names=['read','write','edit','pwsh','web_search','subagent','subagent_fork','send_message','create_goal','schedule_create','plugin_manager','job_output','run_code','team_task_update','btw'];
  assert.deepEqual(sideToolNames(names.map(name=>({name}))),['read','write','edit','web_search']);
  assert.deepEqual(sideToolNames(['bash','terminal','terminal_create','ask_user_question','custom_unknown_tool','pty','exec','browser_use'].map(name=>({name}))),[]);
});
