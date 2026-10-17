import test from 'node:test';
import assert from 'node:assert/strict';
import { createPrivateToolFacade } from '../../src/host/dispatch-adapter.js';

class Events {
  constructor(){this.hooks=new Map();this.events={dispatch:(_mode,args)=>{args.shift();const name=args.shift();return this.hooks.get(name)??[];}};}
  on(name,callback){const callbacks=this.hooks.get(name)??[];callbacks.push(callback);this.hooks.set(name,callbacks);}
  waterfall(_carrier,name,...args){const callbacks=[...(this.hooks.get(name)??[])];const fallback=args.pop();const next=()=>callbacks.length?callbacks.shift()(...args,next):fallback();return next();}
  emit(name,...args){for(const callback of this.hooks.get(name)??[])callback(...args);}
}
function fixture(){
  const host=new Events();const privateCtx=new Events();const scheduler=Symbol('scheduler');const original=Symbol('original');
  let checkpoint=0,pre=0,post=0,results=0,bodies=0; let initiatingAgent;
  host.get=name=>name==='agents'?{withInitiator:(agent,operation)=>{initiatingAgent=agent;return operation();}}:undefined;
  host.on('tools/execute',()=>{checkpoint++;throw new Error('session is not live in this store');});
  host.on('tools/pre-execute',async(exec,next)=>{pre++;return exec.arguments.policyDeny?{kind:'deny',reason:'parent policy'}:next();});
  host.on('tools/post-execute',async(_exec,result,next)=>{post++;return {...await next(),postChecked:true};});
  host.on('tools/result',()=>{results++;});
  const raw={ctx:host,
    [scheduler]:Object.freeze({prepare(){throw new Error('original scheduler');}}),
    schemas:()=>[{name:'read'}],executionMode:()=>({kind:'parallel'}),
    // Public execute's native ordering: original pre, monotonic guards, around
    // dispatch, post and final observer. State remains on the same raw object.
    guard:exec=>exec.arguments.guardDeny?'parent guard':undefined,
    async execute(exec){
      const gate=await this.ctx.waterfall({},'tools/pre-execute',exec,async()=>({kind:'allow'}));
      const denial=gate.kind==='deny'?gate.reason:this.guard(exec);
      let result=denial?{isError:true,content:[{type:'text',text:denial}]}:
        await this.ctx.waterfall({},'tools/execute',exec,async()=>{bodies++;return {isError:false,content:[{type:'text',text:'read content'}]};});
      result=await this.ctx.waterfall({},'tools/post-execute',exec,result,async()=>result);
      this.ctx.emit('tools/result',exec,result);return result;
    },
  };
  const native={version:'0.2.1-rc.2',symbols:{original},TOOL_RUNTIME_SCHEDULER:scheduler,
    scopeTarget:(_raw,agent)=>({agent}),
    getTraceable:(ctx,target)=>new Proxy(target,{get:(target,key,receiver)=>key==='ctx'?ctx:Reflect.get(target,key,receiver)}),
  };
  const facade=createPrivateToolFacade({native,privateCtx,hostCtx:host,parentTools:raw});
  const run=async args=>{const exec={name:'read',agent:{id:'side'},arguments:args,signal:new AbortController().signal,callId:'call'};
    const prepared=await facade[scheduler].prepare(exec);assert.equal(prepared.kind,'dispatch');
    const dispatched=await facade[scheduler].dispatch(prepared.exec);assert.equal(dispatched.kind,'final-result');
    assert.equal(exec.parent,undefined);assert.equal(initiatingAgent,exec.agent);return facade[scheduler].finish(exec,dispatched.result);};
  return {raw,facade,run,scheduler,native,host,privateCtx,stats:()=>({checkpoint,pre,post,results,bodies})};
}

test('private scheduler preserves original service, guard and security policy without global checkpoint',async()=>{
  const f=fixture();const originalScheduler=f.raw[f.scheduler];const originalCtx=f.raw.ctx;
  const success=await f.run({});assert.equal(success.isError,false);assert.equal(success.postChecked,true);
  const denied=await f.run({guardDeny:true});assert.equal(denied.isError,true);assert.equal(denied.content[0].text,'parent guard');
  const policyDenied=await f.run({policyDeny:true});assert.equal(policyDenied.isError,true);assert.equal(policyDenied.content[0].text,'parent policy');
  assert.deepEqual(f.stats(),{checkpoint:0,pre:3,post:3,results:3,bodies:1});
  assert.equal(f.raw[f.scheduler],originalScheduler);assert.equal(f.raw.ctx,originalCtx);
  assert.notEqual(f.facade[f.scheduler],originalScheduler);
  assert.deepEqual(Reflect.ownKeys(f.facade),[f.scheduler]);
  assert.equal(Object.getPrototypeOf(f.facade),f.raw);
});

test('private around-dispatch timeout/wrappers execute, while host around-dispatch does not',async()=>{
  const f=fixture();let localWrapper=0;
  f.privateCtx.on('tools/execute',async(_exec,next)=>{localWrapper++;return next();});
  await f.run({});assert.equal(localWrapper,1);assert.equal(f.stats().checkpoint,0);
});

test('unsupported versions fail closed instead of weakening the tool policy',()=>{
  const f=fixture();assert.throws(()=>createPrivateToolFacade({native:{...f.native,version:'future'},privateCtx:f.privateCtx,hostCtx:f.host,parentTools:f.raw}),/requires DSH/);
});
