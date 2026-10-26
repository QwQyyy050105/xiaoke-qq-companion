import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {EventEmitter} from 'node:events';
import {PassThrough, Writable} from 'node:stream';
import {createImageWorker, imageWorkerArgs} from '../src/image_worker.mjs';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l2kAAAAASUVORK5CYII=','base64');
const TEMP = path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../temp');
const review = {status:'pass',notes:'Offline protocol fixture only; no character image production or visual acceptance is claimed.'};
const completed = (child, item, {threadId='thread-one',turnId='turn-one'}={}) => {
  child.message({method:'item/completed',params:{threadId,turnId,item}});
};
const turnDone = (child,status='completed') => child.message({method:'turn/completed',params:{threadId:'thread-one',turn:{id:'turn-one',status,items:[]}}});
function fakeProcess({output,sendTurn,capable=true,rpcError,closeAt,requestApproval}={}) {
  const calls=[],launches=[];
  function spawn(command,args,options) {
    const child = new EventEmitter(); child.stdout=new PassThrough(); child.stderr=new PassThrough(); child.killed=false;
    child.message = value => {if(!child.killed)child.stdout.write(JSON.stringify(value)+'\n');};
    child.kill = () => {if(!child.killed){child.killed=true;queueMicrotask(()=>child.emit('close',0));}return true;};
    child.stdin=new Writable({write(chunk,encoding,callback){
      let request;try{request=JSON.parse(chunk.toString());}catch(error){callback(error);return;}
      calls.push(request);callback();
      if(request.id===undefined)return;
      queueMicrotask(async()=>{
        try {
          if(closeAt===request.method){child.kill();return;}
          if(rpcError===request.method){child.message({id:request.id,error:{code:123,message:'provider raw details must not escape'}});return;}
          if(request.method==='initialize')child.message({id:request.id,result:{}});
          if(request.method==='modelProvider/capabilities/read')child.message({id:request.id,result:{imageGeneration:capable,webSearch:true}});
          if(request.method==='thread/start')child.message({id:request.id,result:{thread:{id:'thread-one'}}});
          if(request.method==='turn/start') {
            if(requestApproval){child.message({id:'approval',method:'item/commandExecution/requestApproval',params:{}});return;}
            if(sendTurn){await sendTurn(child,request);return;}
            child.message({id:request.id,result:{turn:{id:'turn-one'}}});
            completed(child,{type:'imageGeneration',id:'image-one',status:'completed',savedPath:output,result:'unused'});
            turnDone(child);
          }
        }catch(error){child.emit('error',error);}
      });
    }});
    launches.push({command,args,options,child});return child;
  }
  return {spawn,calls,launches};
}
async function fixture(t, options={}) {
  await fs.mkdir(TEMP,{recursive:true});const base=await fs.mkdtemp(path.join(TEMP,'image_worker_test_'));
  assert.ok(base.startsWith(TEMP+path.sep));t.after(()=>fs.rm(base,{recursive:true,force:true}));
  const root=path.join(base,'project'),codexHome=path.join(base,'codex_home');
  await fs.mkdir(path.join(root,'assets'),{recursive:true});await fs.mkdir(path.join(codexHome,'generated_images','thread-one'),{recursive:true});
  const output=path.join(codexHome,'generated_images','thread-one','image.png');await fs.writeFile(output,PNG);
  const fake=fakeProcess({output,...options});
  const create=createImageWorker({spawnProcess:fake.spawn,resolveExecutable:async()=> 'codex',codexHome,timeoutMs:options.timeoutMs||1000});
  const input={root,prompt:'Make one reference-guided expression image.',sizeReview:review};
  return {base,root,codexHome,output,fake,create,input};
}

test('image worker uses current-turn image event, snapshots references and persists validated project bytes',async t=>{
  const f=await fixture(t);const ref=path.join(f.root,'assets','reference.png');await fs.writeFile(ref,PNG);
  const phases=[];const result=await f.create({...f.input,referenceFiles:[ref],config:{model:'configured-model'},onProgress:e=>phases.push(e.phase)});
  assert.deepEqual(await fs.readFile(result.path),PNG);assert.equal(result.savedPath,result.path);
  assert.ok(result.path.startsWith(path.join(f.root,'data','generated_images')+path.sep));
  assert.equal(result.mime,'image/png');assert.deepEqual([result.width,result.height],[1,1]);assert.match(result.sha256,/^[a-f0-9]{64}$/);
  const launch=f.fake.launches[0];assert.equal(launch.options.windowsHide,true);assert.equal(launch.options.env.CODEX_HOME,f.codexHome);
  assert.equal(launch.options.env.OPENAI_API_KEY,undefined);assert.equal(launch.options.env.QQ_APP_SECRET,undefined);
  const start=f.fake.calls.find(call=>call.method==='thread/start');assert.equal(start.params.model,'configured-model');
  assert.equal(start.params.ephemeral,true);assert.equal(start.params.sandbox,'read-only');assert.equal(start.params.approvalPolicy,'never');
  assert.equal(start.params.config.features.image_generation,true);assert.equal(start.params.config.features.shell_tool,false);assert.deepEqual(start.params.config.mcp_servers,{});
  const turn=f.fake.calls.find(call=>call.method==='turn/start');assert.equal(turn.params.input[1].type,'localImage');
  assert.ok(turn.params.input[1].path.startsWith(launch.options.cwd+path.sep));assert.notEqual(turn.params.input[1].path,ref);
  assert.equal(f.fake.calls.filter(call=>call.method==='turn/start').length,1);assert.equal(launch.child.killed,true);
  assert.deepEqual(await fs.readdir(path.join(f.root,'temp','image_jobs')),[]);
  assert.equal(JSON.parse(await fs.readFile(path.join(path.dirname(result.path),'receipt.json'),'utf8')).sizeReview.status,'pass');
  assert.deepEqual(phases,['starting','generated','ready']);
});

test('protocol notifications arriving before turn/start response stay bound to the returned turn',async t=>{
  const f=await fixture(t,{sendTurn:async(child,request)=>{
    completed(child,{type:'imageGeneration',id:'image-one',status:'completed',savedPath:f.output,result:''});
    turnDone(child);child.message({id:request.id,result:{turn:{id:'turn-one'}}});
  }});
  const result=await f.create(f.input);assert.deepEqual(await fs.readFile(result.path),PNG);
});

test('ordinary assistant paths and different thread/turn outputs never authorize reading a file',async t=>{
  for(const scenario of ['assistant','other-thread','other-turn']) {
    const f=await fixture(t,{sendTurn:async(child,request)=>{
      child.message({id:request.id,result:{turn:{id:'turn-one'}}});
      if(scenario==='assistant')completed(child,{type:'agentMessage',id:'text-one',text:f.output,savedPath:f.output});
      else completed(child,{type:'imageGeneration',id:'image-one',status:'completed',savedPath:f.output,result:''},scenario==='other-thread'?{threadId:'unrelated'}:{turnId:'unrelated'});
      turnDone(child);
    }});
    await assert.rejects(f.create(f.input),{code:'image_missing_output'});
  }
});

test('safe usage-limit failure never retries or exposes provider text',async t=>{
  const f=await fixture(t,{sendTurn:async(child,request)=>{
    child.message({id:request.id,result:{turn:{id:'turn-one'}}});
    completed(child,{type:'imageGeneration',id:'image-one',status:'failed',result:'private provider details',failure:{type:'usageLimitExceeded',limitId:'opaque',resetsAt:1900000000}});
  }});
  await assert.rejects(f.create(f.input),error=>error.code==='image_usage_limit'&&error.usageLimit===true&&error.resetsAt===1900000000&&!error.message.includes('provider'));
  assert.equal(f.fake.calls.filter(call=>call.method==='turn/start').length,1);
});

test('reference and generated-output path boundaries, stale outputs and invalid bytes fail closed',async t=>{
  const f=await fixture(t);const outside=path.join(f.base,'outside.png');await fs.writeFile(outside,PNG);
  await assert.rejects(f.create({...f.input,referenceFiles:[outside]}),{code:'image_reference_boundary'});assert.equal(f.fake.launches.length,0);
  const escaped=await fixture(t,{output:outside});await assert.rejects(escaped.create(escaped.input),{code:'image_output_boundary'});
  const stale=await fixture(t);await fs.utimes(stale.output,new Date(0),new Date(0));await assert.rejects(stale.create(stale.input),{code:'image_output_stale'});
  const invalid=await fixture(t);await fs.writeFile(invalid.output,'not an image');await assert.rejects(invalid.create(invalid.input),{code:'image_invalid_bytes'});
  const large=await fixture(t);await fs.writeFile(large.output,Buffer.alloc(3*1024*1024+1));await assert.rejects(large.create(large.input),{code:'image_too_large'});
});

test('visual size review must explicitly pass before subprocess starts',async t=>{
  const f=await fixture(t);
  for(const sizeReview of [undefined,{status:'unverified',notes:'No actual comparison'},{status:'fail',notes:'Head too large'},{status:'pass',notes:''}]) {
    await assert.rejects(f.create({...f.input,sizeReview}),{code:'image_size_review_required'});
  }
  assert.equal(f.fake.launches.length,0);
});

test('unavailable feature, RPC errors and unexpected client requests safely stop the worker',async t=>{
  for(const [options,code] of [[{capable:false},'image_unavailable'],[{rpcError:'thread/start'},'image_rpc_failed'],[{requestApproval:true},'image_unexpected_client_request'],[{closeAt:'thread/start'},'image_process_closed']]) {
    const f=await fixture(t,options);await assert.rejects(f.create(f.input),{code});assert.equal(f.fake.launches[0].child.killed,true);
  }
});

test('aborting and timing out terminate the single generation attempt and clean references',async t=>{
  const f=await fixture(t,{sendTurn:async(child,request)=>child.message({id:request.id,result:{turn:{id:'turn-one'}}})});
  const controller=new AbortController();const pending=f.create({...f.input,signal:controller.signal});
  setTimeout(()=>controller.abort(),30);await assert.rejects(pending,{code:'image_aborted'});assert.equal(f.fake.launches[0].child.killed,true);
  const timed=await fixture(t,{timeoutMs:20,sendTurn:async()=>{}});await assert.rejects(timed.create(timed.input),{code:'image_timeout'});
  assert.deepEqual(await fs.readdir(path.join(timed.root,'temp','image_jobs')),[]);
});

test('a second generation item is rejected and no automatic generation retry is scheduled',async t=>{
  const f=await fixture(t,{sendTurn:async(child,request)=>{
    child.message({id:request.id,result:{turn:{id:'turn-one'}}});
    for(const id of ['first','second'])child.message({method:'item/started',params:{threadId:'thread-one',turnId:'turn-one',item:{type:'imageGeneration',id,status:'in_progress',result:''}}});
  }});
  await assert.rejects(f.create(f.input),{code:'image_multiple_outputs'});assert.equal(f.fake.calls.filter(call=>call.method==='turn/start').length,1);
});

test('worker arguments enable image generation without enabling general agent execution',()=>{
  const args=imageWorkerArgs();assert.deepEqual(args.slice(0,4),['app-server','--stdio','--enable','image_generation']);
  for(const feature of ['shell_tool','unified_exec','plugins','apps','hooks','browser_use','computer_use','code_mode','multi_agent'])assert.ok(args.some((value,i)=>value==='--disable'&&args[i+1]===feature));
  assert.ok(args.includes('forced_login_method="chatgpt"'));assert.ok(args.includes('mcp_servers={}'));
});
