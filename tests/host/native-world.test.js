import test from 'node:test';
import assert from 'node:assert/strict';
import { createNativeWorld } from '../../src/host/native-world.js';

// Contract doubles verify composition and ownership; they deliberately do NOT
// claim to prove the installed native implementation or the Host transport.
function nativeFixture() {
  const roots=[]; const restrictions=[]; const bindings=[]; const prompts=[]; const approvals=[];
  const original=Symbol('cordis.original'); const schedulerKey=Symbol('scheduler');
  class Context {
    constructor() {
      roots.push(this); this.services={}; this.hooks=new Map(); this.disposed=false;
      this.reflect={provide:(key,value)=>{this.services[key]=value; this[key]=value;}};
      this.fiber={dispose:async()=>{this.disposed=true;}};
    }
    get(key) { return this.services[key]; }
    async plugin(Plugin) { if (typeof Plugin === 'function') new Plugin(this); else Plugin.apply(this); }
    on(name,callback) { const list=this.hooks.get(name)??[]; list.push(callback); this.hooks.set(name,list); return ()=>{}; }
    emit(name,...args) { for(const cb of this.hooks.get(name)??[]) cb(...args); }
  }
  const guardedService=(ctx,name,value)=>{
    ctx.services[name]=value;
    Object.defineProperty(ctx,name,{get(){throw new Error(`cannot get property "${name}" without inject`);}});
  };
  class AgentRegistry { constructor(ctx) { this.ctx=ctx; guardedService(ctx,'agents',this); } }
  class SessionStore { constructor(ctx) { const map=new Map(); this.map=map; this.get=id=>map.get(id); guardedService(ctx,'sessions',this); } }
  class SessionProjectionRegistry { constructor(ctx) {this.snapshot=s=>({asOfSeq:s.seq-1,values:{}}); guardedService(ctx,'sessionProjections',this);} }
  class AgentLoop {
    constructor(ctx,config) {
      if (!ctx.injected?.has('sessionProjections')) throw new Error('cannot get property "sessionProjections" without inject');
      assert.equal(config.maxParallelToolCalls.get(),10);
      this.ctx=ctx;
      const root=ctx.privateRoot;
      root.get('agents').create=async options=>{
        const {sessionId:id,seed}=options;
        const pending={'next-step':[],'next-turn':[]};
        for(const e of seed) if(e.type==='agent/inbox/spliced') {
          const d=e.data; pending[d.target].splice(d.start,d.removedCount??0,...d.inserted);
        }
        const session={id,header:{id,...options.meta},inheritedEventCount:options.inheritedEventCount,seq:seed.length};
        const cleanups=[];
        const agentCtx={tools:{restrict:x=>restrictions.push(x),presentAs:mode=>assert.equal(mode,'native')},systemPrompt:{section:x=>prompts.push(x)},effect:callback=>{cleanups.push(callback());}};
        const agent={id,session,ctx:agentCtx,status:'idle',inbox:{nextTurn:pending['next-turn'],nextStep:pending['next-step']},
          followup(message) {
            this.status='running';
            root.emit('agent/status',{agent:this});
            root.emit('session/event',session,{seq:session.seq++,type:'user/message',time:1,surfaceOp:'append',data:message});
          },
          cancel(cause, options) {this.cancelCause=cause;this.cancelOptions=options;this.status='idle';root.emit('agent/status',{agent:this});},
        };
        await options.setup(agentCtx,agent);
        root.get('sessions').map.set(id,session);
        return {agent,dispose:async()=>{agent.cancel({kind:'disposed'});for(const cleanup of cleanups) await cleanup();root.get('sessions').map.delete(id);}};
      };
    }
  }
  const native={version:'0.2.1-rc.2',Context,AgentRegistry,SessionStore,SessionProjectionRegistry,AgentLoop,symbols:{original},
    TOOL_RUNTIME_SCHEDULER:schedulerKey,getTraceable:(_ctx,value)=>value,scopeTarget:(_base,key)=>({key}),
    TimeoutPolicy:{inject:['tools'],apply(){}},
    createScope:(owner,key)=>{
      if (!(owner instanceof Context)) {
        const scope={key,disposed:false};
        return {ctx:{on:(name,callback)=>approvals.push({name,callback,scope})},dispose:async()=>{scope.disposed=true;}};
      }
      return {ctx:{privateRoot:owner,
        inject: async (names, callback) => {
          for (const name of ['agents','sessions','llm','tools','systemPrompt','sessionProjections']) assert.ok(names.includes(name));
          callback({privateRoot:owner, injected:new Set(names)});
        },
      },dispose:async()=>{}};
    },
    bindScopeParent:(child,parent)=>bindings.push({child,parent}),
    buildForkSeed:(events,boundary)=>[...events.slice(0,boundary+1),{type:'session/end-seed',seq:boundary+1,time:1,data:{inherited:true}}],
    createUserMessage:input=>({id:'new-message',role:'user',...input}),
  };
  const raw={llm:{},tools:{schemas:()=>['read','send_message','create_goal'].map(name=>({name})),
    execute:async()=>({isError:false,content:[]}),executionMode:()=>({kind:'exclusive'}),[schedulerKey]:{}},systemPrompt:{}};
  const parent={id:'parent',ctx:{get:key=>key==='agents'?{withInitiator:(_agent,operation)=>operation()}:({[original]:raw[key]}),tools:raw.tools,
    waterfall:(_carrier,_name,...args)=>args.at(-1)(),events:{dispatch:()=>[]}}};
  const capture={events:[{type:'agent/inbox/spliced',seq:0,time:1,data:{target:'next-turn',start:0,inserted:[{id:'do-not-execute'}]}}],model:{provider:'p',model:'m'},cwd:'/work',agentPreset:'coding'};
  return {native,parent,capture,roots,raw,restrictions,bindings,prompts,approvals};
}

test('private native composition borrows only capability services and never global sessions', async()=>{
  const f=nativeFixture(); let changed=0;
  const world=await createNativeWorld({...f,sideId:'side',onChange:()=>changed++});
  const root=f.roots[0];
  assert.deepEqual(Object.keys(root.services).sort(),['agents','llm','sessionProjections','sessions','systemPrompt','tools']);
  for(const key of ['llm','systemPrompt']) assert.equal(root.services[key],f.raw[key]);
  assert.notEqual(root.services.tools,f.raw.tools); assert.equal(Object.getPrototypeOf(root.services.tools),f.raw.tools);
  assert.equal(root.get('sessionPersistence'),undefined);
  assert.equal(f.bindings[0].child,world.agent); assert.equal(f.bindings[0].parent,f.parent);
  assert.deepEqual(f.restrictions,[{allow:['read']}]);
  assert.match(f.prompts[0].text,/reference material only/);
  assert.equal(world.read().running,false);
  assert.equal(world.read().inheritedEventCount,1);
  assert.equal(world.agent.inbox.nextTurn.length,0);
  assert.equal(world.read().events.at(-1).data.outcome,'canceled');
  world.send('new side input');
  assert.equal(world.read().running,true);
  assert.equal(world.read().events.at(-1).data.content[0].text,'new side input');
  assert.notEqual(world.agent,f.parent); assert.ok(changed>0);
  world.stop(); assert.equal(world.read().status,'idle');
  assert.deepEqual(world.agent.cancelOptions,{keepInbox:true});
  let delegated=false;
  assert.equal(await f.approvals[0].callback({agent:world.agent},()=>{delegated=true;}),'rejected');
  assert.equal(delegated,false);
  assert.equal(await f.approvals[0].callback({agent:f.parent},()=> 'not-my-request'),'not-my-request');
  await world.dispose(); assert.equal(root.disposed,true); assert.equal(root.get('sessions').get('side'),undefined);
  assert.ok(f.approvals[0].scope.disposed);
});

test('assistant frames and errors belong only to their private side root',async()=>{
  const f=nativeFixture();const world=await createNativeWorld({...f,sideId:'side',onChange:()=>{}});const root=f.roots[0];
  root.emit('agent/assistant-stream',{agent:{id:'unrelated'},frame:{type:'start'}});
  assert.deepEqual(world.read().assistantFrames,[]);
  root.emit('agent/assistant-stream',{agent:world.agent,frame:{type:'start',attemptId:'a'}});
  root.emit('agent/assistant-stream',{agent:world.agent,frame:{type:'chunk',chunk:{type:'text-delta',text:'live'}}});
  assert.equal(world.read().assistantFrames.length,2);
  root.emit('agent/assistant-stream',{agent:world.agent,frame:{type:'end'}});
  assert.deepEqual(world.read().assistantFrames,[]);
  root.emit('agent/error',{agent:world.agent,error:new Error('native error')});
  assert.equal(world.read().error,'native error');
  await world.dispose();
});

test('unsupported native composition fails closed and disposes the private root',async()=>{
  const f=nativeFixture();
  f.native.SessionStore=class {constructor(){throw new Error('missing projection interpreter');}};
  await assert.rejects(createNativeWorld({...f,sideId:'side',onChange:()=>{}}),/missing projection interpreter/);
  assert.equal(f.roots[0].disposed,true);
  assert.equal(f.bindings.length,0);
});

test('canonical native exports are required, without fallback to a global factory',async()=>{
  const f=nativeFixture();delete f.native.createScope;
  await assert.rejects(createNativeWorld({...f,sideId:'side',onChange:()=>{}}),/Missing canonical native export: createScope/);
  assert.equal(f.roots.length,0);
});
