import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { createOwnerBrowserWorker, ownerBrowserToolSpecs, ownerBrowserWorkerArgs, ownerBrowserEnvironment } from '../src/owner_browser_worker.mjs';

// Synthetic bytes only; this suite never opens a browser or calls a model.
const PNG=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l2kAAAAASUVORK5CYII=','base64');
const hash=value=>createHash('sha256').update(value).digest('hex');
const TEMP=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../temp');
const JOB={ownerId:'synthetic-owner',jobId:'synthetic-job'};
const names=['navigate','snapshot','scroll','follow','wait'];
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const completion=(child,text='Observed the visible page.')=>{
  child.message({method:'item/completed',params:{threadId:'thread-one',turnId:'turn-one',item:{id:'answer-one',type:'agentMessage',text}}});
  child.message({method:'turn/completed',params:{threadId:'thread-one',turn:{id:'turn-one',status:'completed',items:[]}}});
};
const toolCall=(child,{id='server-one',callId='call-one',threadId='thread-one',turnId='turn-one',tool='owner_browser_snapshot',arguments:args={}}={})=>{
  child.message({id,method:'item/tool/call',params:{threadId,turnId,callId,tool,arguments:args}});
};
function fakeProcess({onTurn,onResponse,rpcError,closeAt,initializeError,threadOverrides={},eofBehavior='close',closeDelay=0,killBehavior='close'}={}) {
  const calls=[],launches=[];
  const spawn=(command,args,options)=>{
    const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.killed=false;child.didClose=false;child.killCount=0;child.eofCount=0;
    child.message=value=>{if(!child.killed)child.stdout.write(JSON.stringify(value)+'\n');};
    child.finishProcess=(close=true)=>{
      if(!child.exited){child.exited=true;child.emit('exit',0,null);}
      if(close&&!child.didClose){child.didClose=true;child.emit('close',0,null);}
    };
    child.kill=()=>{
      child.killCount++;
      if(killBehavior==='throw')throw Error('private failure detail');
      if(killBehavior==='ignore')return false;
      child.killed=true;queueMicrotask(()=>child.finishProcess(killBehavior!=='exit_only'));return true;
    };
    child.stdin=new Writable({write(chunk,encoding,callback){
      let request;try{request=JSON.parse(chunk.toString());}catch(error){callback(error);return;}
      calls.push(request);callback();
      queueMicrotask(async()=>{
        try {
          if(!request.method){await onResponse?.(child,request);return;}
          if(request.id===undefined)return;
          if(closeAt===request.method){child.kill();return;}
          if(rpcError===request.method||(initializeError&&request.method==='initialize')){child.message({id:request.id,error:{code:-32602,message:'private provider detail'}});return;}
          if(request.method==='initialize')child.message({id:request.id,result:{}});
          if(request.method==='thread/start')child.message({id:request.id,result:{thread:{id:'thread-one'},...threadOverrides}});
          if(request.method==='turn/interrupt')child.message({id:request.id,result:{}});
          if(request.method==='turn/start') {
            if(onTurn)await onTurn(child,request);
            else {child.message({id:request.id,result:{turn:{id:'turn-one'}}});toolCall(child);}
          }
        }catch(error){child.emit('error',error);}
      });
    }});
    child.stdin.on('finish',()=>{
      child.eofCount++;
      if(eofBehavior==='ignore')return;
      if(eofBehavior==='error'){child.stdin.emit('error',Error('private EOF detail'));child.finishProcess();return;}
      if(eofBehavior==='exit_only'){child.finishProcess(false);return;}
      if(closeDelay>0){child.finishProcess(false);setTimeout(()=>child.finishProcess(),closeDelay);}
      else queueMicrotask(()=>child.finishProcess());
    });
    launches.push({command,args,options,child});return child;
  };
  return {spawn,calls,launches};
}
function output(action='snapshot',overrides={}) {
  const observation={url:'https://www.douyin.com/video/example?token=SECRET#private',title:'Synthetic page',text:'Actual offline fixture',
    truncated:false,links:[{id:'link-1',text:'Next',url:'https://www.douyin.com/video/next?token=SECRET'}],pageVersion:1,viewport:{width:1280,height:720}};
  const receipt={id:'receipt-one',action,observedAt:'2026-10-24T12:00:00Z',ownerHash:hash(JOB.ownerId),jobHash:hash(JOB.jobId),
    pageVersion:1,status:'observed',url:observation.url,textSha256:hash(observation.text),screenshotSha256:hash(PNG)};
  return {status:'observed',observation,image:{bytes:PNG,mimeType:'image/png'},receipt,...overrides};
}
async function fixture(t,options={}) {
  await fs.mkdir(TEMP,{recursive:true});const base=await fs.mkdtemp(path.join(TEMP,'owner_browser_worker_test_'));
  assert.ok(base.startsWith(TEMP+path.sep));t.after(()=>fs.rm(base,{recursive:true,force:true}));
  const root=path.join(base,'project'),codexHome=path.join(base,'codex_home');
  await fs.mkdir(root);await fs.mkdir(codexHome);
  const fake=fakeProcess({onResponse:(child,request)=>{if(request.result?.success)completion(child);},...options});
  const executed=[],closed=[],opened=[];
  const session=Object.fromEntries(names.map(action=>[action,async args=>{executed.push({action,args});return options.execute?options.execute(action,args):output(action);} ]));
  session.close=async()=>{closed.push(true);};
  const openBrowser=async params=>{opened.push(params);return session;};
  const run=createOwnerBrowserWorker({spawnProcess:fake.spawn,resolveExecutable:async()=> 'synthetic-codex',codexHome,timeoutMs:2000,
    shutdownGraceMs:40,shutdownForceMs:20,...options.limits});
  const input={root,task:'Read the visible page.',job:JOB,isCurrent:async()=>true,openBrowser};
  return {base,root,codexHome,fake,session,executed,closed,opened,run,input};
}

test('registers experimental fixed tools and executes the real supplied callback before recording success',async t=>{
  const f=await fixture(t);const reported=[];
  const result=await f.run({...f.input,config:{model:'configured-model',serviceTier:'fast'},onReceipt:receipt=>reported.push(receipt)});
  assert.equal(result.status,'completed');assert.equal(result.text,'Observed the visible page.');
  assert.equal(f.executed.length,1);assert.equal(f.closed.length,1);assert.equal(f.opened.length,1);
  assert.equal(f.opened[0].ownerId,JOB.ownerId);assert.equal(f.opened[0].jobId,JOB.jobId);
  assert.equal(result.receipts[0].observed,true);assert.equal(result.receipts[0].callId,'call-one');
  assert.deepEqual(result.receipts,reported);assert.ok(!JSON.stringify(result.receipts).includes(JOB.ownerId));
  assert.ok(!JSON.stringify(result).includes('SECRET'));assert.equal(result.receipts[0].url,'https://www.douyin.com/video/example');
  const response=f.fake.calls.find(item=>item.id==='server-one');assert.equal(response.result.success,true);
  assert.equal(response.result.contentItems[1].imageUrl,`data:image/png;base64,${PNG.toString('base64')}`);
  assert.ok(!response.result.contentItems[0].text.includes('SECRET'));
  const initialize=f.fake.calls.find(item=>item.method==='initialize');assert.equal(initialize.params.capabilities.experimentalApi,true);
  const start=f.fake.calls.find(item=>item.method==='thread/start');assert.equal(start.params.model,'configured-model');
  assert.equal(start.params.ephemeral,true);assert.equal(start.params.serviceTier,null);assert.equal(start.params.config.features.fast_mode,false);
  assert.equal(start.params.config.features.shell_tool,false);assert.deepEqual(start.params.config.mcp_servers,{});
  assert.deepEqual(start.params.dynamicTools,ownerBrowserToolSpecs());
  const turn=f.fake.calls.find(item=>item.method==='turn/start');assert.equal(turn.params.effort,'low');assert.equal(turn.params.serviceTier,null);
  const launch=f.fake.launches[0];assert.equal(launch.options.windowsHide,true);assert.equal(launch.options.env.CODEX_HOME,f.codexHome);
  assert.ok(launch.options.env.TEMP.startsWith(f.root));assert.equal(launch.child.didClose,true);assert.equal(launch.child.killCount,0);
  assert.equal(result.cleanup.appServer.status,'graceful');assert.equal(result.cleanup.appServer.exitObserved,true);assert.equal(result.cleanup.appServer.closeObserved,true);
  assert.equal(result.cleanup.tempDirectory.status,'removed');
  assert.equal(f.fake.calls.filter(item=>item.method==='turn/start').length,1);
  assert.deepEqual(await fs.readdir(path.join(f.root,'temp','owner_browser_jobs')),[]);
});

test('tool requests before the turn response are deferred until their lifecycle IDs are bound',async t=>{
  const f=await fixture(t,{onTurn:async(child,request)=>{toolCall(child);await wait(5);child.message({id:request.id,result:{turn:{id:'turn-one'}}});}});
  const result=await f.run(f.input);assert.equal(result.status,'completed');assert.equal(f.executed.length,1);
});

test('all five registered tool schemas dispatch only their fixed session methods',async t=>{
  const argumentsByAction={navigate:{url:'https://www.douyin.com/'},snapshot:{},scroll:{direction:'down',pixels:350},follow:{linkId:'link-1'},wait:{ms:10}};
  for(const action of names) {
    const f=await fixture(t,{onTurn:(child,request)=>{child.message({id:request.id,result:{turn:{id:'turn-one'}}});toolCall(child,{tool:`owner_browser_${action}`,arguments:argumentsByAction[action]});}});
    await f.run(f.input);assert.equal(f.executed[0].action,action);
  }
});

test('wrong thread, turn, namespace, duplicate call and duplicate request never gain authority',async t=>{
  for(const wrong of [{threadId:'unrelated'},{turnId:'unrelated'}]) {
    const f=await fixture(t,{onTurn:(child,request)=>{child.message({id:request.id,result:{turn:{id:'turn-one'}}});toolCall(child,wrong);}});
    await assert.rejects(f.run(f.input),{code:'owner_browser_call_binding'});assert.equal(f.executed.length,0);
  }
  const namespace=await fixture(t,{onTurn:(child,request)=>{child.message({id:request.id,result:{turn:{id:'turn-one'}}});child.message({id:'ns',method:'item/tool/call',params:{threadId:'thread-one',turnId:'turn-one',callId:'call-one',namespace:'shell',tool:'owner_browser_snapshot',arguments:{}}});}});
  await assert.rejects(namespace.run(namespace.input),{code:'owner_browser_call_binding'});assert.equal(namespace.opened.length,0);
  const duplicate=await fixture(t,{onResponse:(child,request)=>{if(request.id==='server-one')toolCall(child,{id:'server-two'});}});
  await assert.rejects(duplicate.run(duplicate.input),{code:'owner_browser_duplicate_call'});assert.equal(duplicate.executed.length,1);
  const duplicateId=await fixture(t,{onTurn:(child,request)=>{child.message({id:request.id,result:{turn:{id:'turn-one'}}});toolCall(child);toolCall(child);}});
  await assert.rejects(duplicateId.run(duplicateId.input),{code:'owner_browser_duplicate_request'});assert.equal(duplicateId.executed.length,0);
});

test('unexpected shell/approval requests and unknown tool names are denied without opening a browser',async t=>{
  for(const method of ['item/commandExecution/requestApproval','process/spawn','tool/requestUserInput']) {
    const f=await fixture(t,{onTurn:(child,request)=>{child.message({id:request.id,result:{turn:{id:'turn-one'}}});child.message({id:'approval',method,params:{}});}});
    await assert.rejects(f.run(f.input),{code:'owner_browser_unexpected_request'});assert.equal(f.opened.length,0);
    assert.equal(f.fake.calls.find(item=>item.id==='approval').error.code,-32601);
  }
  const f=await fixture(t,{onTurn:(child,request)=>{child.message({id:request.id,result:{turn:{id:'turn-one'}}});toolCall(child,{tool:'owner_browser_evaluate',arguments:{script:'fetch()'}});}});
  await assert.rejects(f.run(f.input),{code:'owner_browser_tool_unknown'});assert.equal(f.opened.length,0);
});

test('invalid or extra model arguments cannot choose owner, job, script, file or unbounded waits',async t=>{
  const cases=[['snapshot',{ownerId:'attacker'}],['navigate',{url:'file:///D:/private'}],['navigate',{url:'https://secret@example.com/'}],
    ['scroll',{direction:'down',pixels:901}],['wait',{ms:3001}],['follow',{linkId:'../outside'}],['snapshot',[]]];
  for(const [action,args] of cases) {
    const f=await fixture(t,{onTurn:(child,request)=>{child.message({id:request.id,result:{turn:{id:'turn-one'}}});toolCall(child,{tool:`owner_browser_${action}`,arguments:args});}});
    await assert.rejects(f.run(f.input),{code:'owner_browser_tool_arguments'});assert.equal(f.opened.length,0);
  }
});

test('abort interrupts exactly once, aborts executor signal, closes session and ignores its late result',async t=>{
  let release,entered;const started=new Promise(resolve=>entered=resolve),blocked=new Promise(resolve=>release=resolve);
  const f=await fixture(t,{execute:async()=>{entered();await blocked;return output();}});
  const controller=new AbortController();const receipts=[];
  const pending=f.run({...f.input,signal:controller.signal,onReceipt:receipt=>receipts.push(receipt)});
  await started;controller.abort();await assert.rejects(pending,{code:'owner_browser_aborted'});
  assert.equal(f.opened[0].signal.aborted,true);assert.equal(f.closed.length,1);
  assert.equal(f.fake.calls.filter(item=>item.method==='turn/interrupt').length,1);
  release();await wait(10);assert.equal(receipts.length,0);assert.ok(!f.fake.calls.some(item=>item.id==='server-one'));
  assert.equal(f.fake.calls.filter(item=>item.method==='turn/start').length,1);
});

test('late session opening after timeout is closed and never executes a tool',async t=>{
  let release,entered;const opening=new Promise(resolve=>entered=resolve),blocked=new Promise(resolve=>release=resolve);
  const f=await fixture(t,{limits:{timeoutMs:50}});
  const pending=f.run({...f.input,openBrowser:async()=>{entered();await blocked;return f.session;}});
  await opening;await assert.rejects(pending,{code:'owner_browser_timeout'});release();await wait(10);
  assert.equal(f.closed.length,1);assert.equal(f.executed.length,0);
});

test('owner/job liveness is asynchronous and checked before and after real execution',async t=>{
  let live=true;const f=await fixture(t,{execute:async()=>{live=false;return output();}});
  await assert.rejects(f.run({...f.input,isCurrent:async()=>live}),{code:'owner_browser_job_stale'});
  assert.equal(f.executed.length,1);assert.ok(!f.fake.calls.some(item=>item.id==='server-one'&&item.result?.success));
  const stale=await fixture(t);await assert.rejects(stale.run({...stale.input,isCurrent:async()=>false}),{code:'owner_browser_job_stale'});
  assert.equal(stale.fake.launches.length,0);
});

test('final text and unrelated thread notifications are not browser evidence',async t=>{
  const f=await fixture(t,{onTurn:(child,request)=>{
    child.message({id:request.id,result:{turn:{id:'turn-one'}}});
    child.message({method:'item/completed',params:{threadId:'other',turnId:'turn-one',item:{id:'other-message',type:'agentMessage',text:'PRIVATE'}}});
    completion(child,'I browsed everything.');
  }});
  const result=await f.run(f.input);assert.equal(result.status,'unavailable');assert.equal(result.reason,'no_observation');
  assert.deepEqual(result.receipts,[]);assert.equal(f.opened.length,0);assert.ok(!result.text.includes('PRIVATE'));
  assert.equal(result.text,'这次没有取得真实页面内容，浏览还没完成。');assert.ok(!result.text.includes('browsed everything'));
});

test('login-required state has no screenshot or private page content and is not completed work',async t=>{
  const f=await fixture(t,{execute:async()=>{
    const value=output();value.status=value.receipt.status='login_required';return value;
  },onResponse:(child,request)=>{if(request.id==='server-one')completion(child,'Please sign in.');}});
  const result=await f.run(f.input);assert.equal(result.status,'awaiting_login');assert.equal(result.receipts[0].observed,false);
  assert.equal(result.text,'页面要求登录或验证，需要你先在独立浏览窗口里完成。');
  const response=f.fake.calls.find(item=>item.id==='server-one').result;assert.equal(response.success,false);
  assert.deepEqual(response.contentItems,[{type:'inputText',text:'{"status":"login_required"}'}]);
});

test('receipt identity, actual action, page version and evidence hashes are validated independently of model text',async t=>{
  for(const patch of [{ownerHash:hash('different-owner')},{jobHash:hash('different-job')},{action:'post'},{pageVersion:2},{textSha256:null,screenshotSha256:null}]) {
    const f=await fixture(t,{execute:async()=>{const value=output();Object.assign(value.receipt,patch);return value;}});
    await assert.rejects(f.run(f.input),error=>['owner_browser_receipt_invalid','owner_browser_observation_invalid'].includes(error.code));
  }
});

test('limits bound execution, images and protocol; images beyond cumulative budget become explicit text-only observations',async t=>{
  const f=await fixture(t,{limits:{maxToolCalls:1},onResponse:(child,request)=>{if(request.id==='server-one')toolCall(child,{id:'server-two',callId:'call-two'});}});
  await assert.rejects(f.run(f.input),{code:'owner_browser_tool_limit'});assert.equal(f.executed.length,1);
  const large=await fixture(t,{limits:{maxImageBytes:10}});await large.run(large.input);
  const largeResponse=large.fake.calls.find(item=>item.id==='server-one').result;
  assert.equal(largeResponse.contentItems.length,1);assert.match(largeResponse.contentItems[0].text,/image_budget_exhausted/);
  const images=await fixture(t,{limits:{maxImages:1},onResponse:(child,request)=>{
    if(request.id==='server-one')toolCall(child,{id:'server-two',callId:'call-two'});else if(request.id==='server-two')completion(child);
  }});
  const result=await images.run(images.input);assert.equal(result.status,'completed');assert.equal(result.receipts.length,2);
  const response=images.fake.calls.find(item=>item.id==='server-two').result;
  assert.equal(response.contentItems.length,1);assert.match(response.contentItems[0].text,/image_budget_exhausted/);
  const protocol=await fixture(t,{limits:{maxProtocolBytes:200}});await assert.rejects(protocol.run(protocol.input),{code:'owner_browser_protocol_limit'});
});

test('unsupported experimental field, transport failure and tool failure never replay a model turn',async t=>{
  for(const [options,code] of [[{rpcError:'thread/start'},'owner_browser_rpc_failed'],[{closeAt:'turn/start'},'owner_browser_process_closed'],
    [{execute:async()=>{throw new Error('secret detail');}},'owner_browser_tool_failed']]) {
    const f=await fixture(t,options);await assert.rejects(f.run(f.input),error=>error.code===code&&!JSON.stringify(error).includes('secret detail'));
    assert.ok(f.fake.calls.filter(item=>item.method==='turn/start').length<=1);assert.equal(f.fake.launches.length,1);assert.equal(f.fake.launches[0].child.didClose,true);
  }
});

test('worker environment strips desktop helper bindings without inspecting or persisting their values',()=>{
  const env=ownerBrowserEnvironment('D:\\home','D:\\temp',null,{PATH:'node',OPENAI_API_KEY:'secret',QQ_APP_SECRET:'secret',
    BROWSER_USE_ACCESS_EXECUTOR_ID:'secret',BROWSER_USE_ACCESS_PIPE_PATH:'secret',CODEX_WINDOWS_REGISTERED_CORE:'secret',
    SKY_CUA_NATIVE_PIPE:'secret',NODE_REPL_TRUSTED_SERVICES:'secret',CUA_REPL_ENABLED_SURFACES:'secret'});
  assert.deepEqual(env,{PATH:'node',CODEX_HOME:'D:\\home',TEMP:'D:\\temp',TMP:'D:\\temp'});
  const args=ownerBrowserWorkerArgs();
  for(const feature of ['shell_tool','unified_exec','apps','plugins','browser_use','computer_use','fast_mode','code_mode','image_generation'])assert.ok(args.some((value,index)=>value==='--disable'&&args[index+1]===feature));
  assert.ok(args.includes('forced_login_method="chatgpt"'));assert.ok(args.includes('mcp_servers={}'));
  const first=ownerBrowserToolSpecs();first[0].name='tampered';assert.equal(ownerBrowserToolSpecs()[0].name,'owner_browser_navigate');
});

test('missing executor/identity and relative roots are rejected before any process or browser starts',async t=>{
  const f=await fixture(t);
  for(const patch of [{openBrowser:null},{isCurrent:null},{job:{ownerId:'',jobId:'j'}},{job:{ownerId:'x',jobId:'../x'}}]) {
    await assert.rejects(f.run({...f.input,...patch}),{code:'owner_browser_job_required'});
  }
  await assert.rejects(f.run({...f.input,root:'relative/invalid'}),{code:'owner_browser_storage_boundary'});
  assert.equal(f.fake.launches.length,0);assert.equal(f.opened.length,0);
});

test('effective Fast/priority tier or changed requested model is rejected before inference starts',async t=>{
  for(const [threadOverrides,code] of [[{serviceTier:'fast'},'owner_browser_nonstandard_tier'],
    [{serviceTier:'priority'},'owner_browser_nonstandard_tier'],[{model:'different-model'},'owner_browser_model_changed']]) {
    const f=await fixture(t,{threadOverrides});await assert.rejects(f.run({...f.input,config:{model:'configured-model'}}),{code});
    assert.equal(f.fake.calls.filter(item=>item.method==='turn/start').length,0);assert.equal(f.opened.length,0);
  }
});

test('timeout bounds a hung liveness callback and pre-aborted jobs never launch',async t=>{
  const f=await fixture(t,{limits:{timeoutMs:25}});
  await assert.rejects(f.run({...f.input,isCurrent:()=>new Promise(()=>{})}),error=>error.code==='owner_browser_timeout'&&error.text==='这次浏览超时了，还没有取得可核验的结果。');
  assert.equal(f.fake.launches.length,0);
  const controller=new AbortController();controller.abort();
  await assert.rejects(f.run({...f.input,signal:controller.signal}),{code:'owner_browser_aborted'});
  assert.equal(f.fake.launches.length,0);
});

test('turn completion cannot race an unfinished tool and accept its late successful result',async t=>{
  let completeTool,entered;const blocked=new Promise(resolve=>completeTool=resolve),started=new Promise(resolve=>entered=resolve);
  const f=await fixture(t,{execute:async()=>{entered();await blocked;return output();}});
  const pending=f.run(f.input);await started;completion(f.fake.launches[0].child);completeTool();
  await assert.rejects(pending,{code:'owner_browser_late_tool_result'});
  assert.ok(!f.fake.calls.some(item=>item.id==='server-one'&&item.result?.success));
});

test('runtime page-version link IDs survive projection and are passed intact to follow',async t=>{
  const linkId='2:abcd1234-ef0';
  const f=await fixture(t,{execute:async action=>{
    const value=output(action);value.observation.links[0].id=linkId;return value;
  },onResponse:(child,request)=>{
    if(request.id==='server-one') {
      const visible=JSON.parse(request.result.contentItems[0].text);assert.equal(visible.observation.links[0].id,linkId);
      toolCall(child,{id:'server-two',callId:'call-two',tool:'owner_browser_follow',arguments:{linkId}});
    } else if(request.id==='server-two')completion(child);
  }});
  const result=await f.run(f.input);assert.equal(result.status,'completed');
  assert.deepEqual(f.executed[1],{action:'follow',args:linkId});
});

test('graceful shutdown sends EOF and waits for actual stdio close after process exit',async t=>{
  const f=await fixture(t,{closeDelay:30,limits:{shutdownGraceMs:100}});let settled=false;
  const pending=f.run(f.input).finally(()=>{settled=true;});
  while(!f.fake.launches[0]?.child.exited)await wait(1);
  assert.equal(settled,false);assert.equal(f.fake.launches[0].child.didClose,false);
  const result=await pending,child=f.fake.launches[0].child;
  assert.equal(child.eofCount,1);assert.equal(child.killCount,0);assert.equal(child.didClose,true);
  assert.deepEqual(result.cleanup.appServer,{status:'graceful',stdinEnded:true,exitObserved:true,closeObserved:true,
    exitCode:0,signal:null,forceAttempted:false,killAccepted:false,errors:[],streamsDetached:false});
});

test('only an unresponsive live process is force-stopped after the graceful EOF budget',async t=>{
  const f=await fixture(t,{eofBehavior:'ignore'}),result=await f.run(f.input),child=f.fake.launches[0].child;
  assert.equal(child.eofCount,1);assert.equal(child.killCount,1);assert.equal(child.didClose,true);
  assert.equal(result.cleanup.appServer.status,'forced');assert.equal(result.cleanup.appServer.forceAttempted,true);
  assert.equal(result.cleanup.appServer.killAccepted,true);assert.deepEqual(result.cleanup.appServer.errors,[]);
});

test('exited parent with helper-held stdio is unconfirmed and retains diagnostic cwd and receipts',async t=>{
  const f=await fixture(t,{eofBehavior:'exit_only'});
  let caught;try{await f.run(f.input);}catch(error){caught=error;}
  assert.equal(caught.code,'owner_browser_cleanup_unconfirmed');assert.equal(caught.receipts.length,1);
  assert.equal(caught.cleanup.appServer.status,'unconfirmed');assert.equal(caught.cleanup.appServer.exitObserved,true);
  assert.equal(caught.cleanup.appServer.closeObserved,false);assert.equal(caught.cleanup.appServer.forceAttempted,false);
  assert.deepEqual(caught.cleanup.appServer.errors,['stdio_close_unconfirmed']);assert.equal(f.fake.launches[0].child.killCount,0);
  assert.equal(caught.cleanup.tempDirectory.status,'retained');assert.ok((await fs.stat(caught.cleanup.tempDirectory.path)).isDirectory());
  assert.ok(caught.cleanup.tempDirectory.path.startsWith(path.join(f.root,'temp','owner_browser_jobs')));
});

test('kill rejection or exception is bounded and retains safe cleanup evidence without provider details',async t=>{
  for(const killBehavior of ['ignore','throw']) {
    const f=await fixture(t,{eofBehavior:'ignore',killBehavior});
    await assert.rejects(f.run(f.input),error=>error.code==='owner_browser_cleanup_unconfirmed'&&
      error.cleanup.appServer.forceAttempted&&error.cleanup.appServer.status==='unconfirmed'&&
      error.cleanup.appServer.errors.includes('process_exit_unconfirmed')&&!JSON.stringify(error).includes('private failure'));
    assert.equal(f.fake.launches[0].child.killCount,1);
  }
});

test('an original tool failure remains primary when process cleanup is also unconfirmed',async t=>{
  const f=await fixture(t,{execute:async()=>{throw Error('private callback detail');},eofBehavior:'exit_only'});
  await assert.rejects(f.run(f.input),error=>error.code==='owner_browser_tool_failed'&&
    error.cleanup.appServer.status==='unconfirmed'&&error.cleanup.tempDirectory.status==='retained');
});

test('EOF and browser-close failures are retained instead of being silently suppressed',async t=>{
  const eof=await fixture(t,{eofBehavior:'error'});
  await assert.rejects(eof.run(eof.input),error=>error.code==='owner_browser_cleanup_unconfirmed'&&
    error.cleanup.appServer.closeObserved&&error.cleanup.appServer.errors.includes('stdin_eof_failed')&&!JSON.stringify(error).includes('private EOF'));
  const browser=await fixture(t);browser.session.close=async()=>{throw Error('private browser detail');};
  await assert.rejects(browser.run(browser.input),error=>error.code==='owner_browser_cleanup_unconfirmed'&&
    error.cleanup.browser.status==='failed'&&error.cleanup.browser.error==='browser_close_failed'&&error.receipts.length===1);
});
