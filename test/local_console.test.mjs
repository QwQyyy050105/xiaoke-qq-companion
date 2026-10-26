import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,copyFile,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import http from 'node:http';
import vm from 'node:vm';
import {startLocalConsole,usageSummary} from '../src/local_console.mjs';
const parent=resolve('temp');
async function setup(t,callbacks={}){
 await mkdir(parent,{recursive:true});const root=await mkdtemp(join(parent,'console_test_'));
 await mkdir(join(root,'assets'));await writeFile(join(root,'persona.txt'),'小柯是聪明温柔的白发紫瞳龙娘，聊天自然灵动，会认真听大家说话。\n');
 await copyFile(resolve('assets/console.html'),join(root,'assets/console.html'));
 await writeFile(join(root,'config.local.json'),JSON.stringify({secret:'never_expose_fixture'}));
 const server=await startLocalConsole({root,port:0,callbacks});
 t.after(async()=>{await server.close();assert.ok(root.startsWith(parent));await rm(root,{recursive:true,force:true});});
 const html=await (await fetch(server.url)).text(),csrf=html.match(/const csrf='([^']+)'/)[1];
 const post=(path,body,extra={})=>fetch(server.url+path,{method:'POST',headers:{Origin:server.url,'Content-Type':'application/json','X-Console-CSRF':csrf,...extra},body:JSON.stringify(body)});
 return {root,server,html,post};
}
test('console is loopback only, rejects cross-origin writes and never serves arbitrary files',async t=>{
 const {server,post,html}=await setup(t);
 assert.match(server.url,/127\.0\.0\.1/);assert.doesNotMatch(html,/never_expose_fixture/);
 for(const path of ['/config.local.json','/credentials.xml','/../config.local.json'])assert.equal((await fetch(server.url+path)).status,404);
 assert.equal((await post('/api/roles',{operation:'create',name:'坏请求',content:'a'.repeat(30)},{Origin:'https://evil.invalid'})).status,403);
 assert.equal((await post('/api/roles',{operation:'create',name:'坏请求',content:'a'.repeat(30)},{'X-Console-CSRF':'incorrect'})).status,403);
 const remote=await fetch(server.url+'/api/state',{headers:{'Sec-Fetch-Site':'cross-site'}});assert.equal(remote.status,403);
 const rebound=await new Promise((resolve,reject)=>{const request=http.get(server.url+'/api/state',{headers:{Host:'attacker.invalid'}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});request.on('error',reject);});assert.equal(rebound,403);
 const script=html.match(/<script[^>]*>([\s\S]*?)<\/script>/)[1];assert.doesNotThrow(()=>new vm.Script(script));
});
test('roles save and activate the actual persona file, and active role deletion is rejected',async t=>{
 const {root,server,post}=await setup(t);
 const first=await (await fetch(server.url+'/api/roles')).json();assert.equal(first.active,'xiao_ke');
 const content='小柯保留白发紫瞳龙娘形象，说话简洁、调皮、有自己的主见，认真对待朋友。';
 const created=await (await post('/api/roles',{operation:'create',name:'小柯新版',content})).json();assert.ok(created.id);
 assert.equal((await post('/api/roles',{operation:'activate',id:created.id})).status,200);
 assert.equal((await readFile(join(root,'persona.txt'),'utf8')).trim(),content);
 assert.equal((await post('/api/roles',{operation:'delete',id:created.id})).status,400);
 assert.equal((await post('/api/roles',{operation:'delete',id:'xiao_ke'})).status,200);
 const changed=content+' 喜欢接梗。';await post('/api/roles',{operation:'save',id:created.id,name:'小柯',content:changed});
 assert.equal((await readFile(join(root,'persona.txt'),'utf8')).trim(),changed);
 const selected=await (await fetch(server.url+'/api/roles')).json();assert.equal(selected.items.length,1);
});
test('status and settings remain bounded projections, stale READY is not presented as connected',async t=>{
 const settings={proactiveEnabled:true};let reviewed;
 const {root,server,post}=await setup(t,{status:()=>({connected:true,updatedAt:'2000-01-01T00:00:00Z',pid:23,secret:'hidden'}),
 settings:()=>settings,updateSettings:b=>Object.assign(settings,b),reviewVocabulary:(...args)=>{reviewed=args;return {ok:true};}});
 await writeFile(join(root,'data','model_usage.json'),JSON.stringify({recent:[{at:new Date().toISOString(),mode:'reply',elapsed_ms:1200,usage:{input_tokens:20,cached_input_tokens:4,output_tokens:8},prompt:'hidden'}]}));
 const state=await (await fetch(server.url+'/api/state')).json();assert.equal(state.status.connected,false);assert.equal(state.status.secret,undefined);assert.doesNotMatch(JSON.stringify(state),/hidden|never_expose/);
 await post('/api/settings',{proactiveEnabled:false});assert.equal(settings.proactiveEnabled,false);
 assert.equal((await post('/api/settings',{codexPath:'bad'})).status,400);
 assert.equal((await post('/api/vocabulary',{scope:'a'.repeat(64),id:'candidate_1',operation:'confirm',meaning:'本群叫法'})).status,200);
 assert.deepEqual(reviewed,['a'.repeat(64),'candidate_1',{operation:'confirm',meaning:'本群叫法'}]);
 assert.equal((await post('/api/vocabulary',{scope:'../other',id:'x',operation:'delete'})).status,400);
});
test('usage summary shows exact local totals and missing duration stays unknown',()=>{
 const value=usageSummary([{at:'2026-10-21T23:00:00Z',mode:'reply',elapsed_ms:2000,usage:{input_tokens:50,cached_input_tokens:20,output_tokens:10},web_searches:1,image_count:2},
 {at:'2026-10-22T03:00:00Z',mode:'routing',elapsed_ms:300,usage:{input_tokens:5,output_tokens:1}}]);
 assert.equal(value.totals.input_tokens,55);assert.equal(value.days[0].day,'2026-10-22');assert.equal(value.reply_median_ms,2000);assert.equal(value.totals.image_inputs,2);
 assert.equal(usageSummary([]).reply_median_ms,null);assert.match(value.scope,/不是账号/);
});

test('a corrupt optional usage record does not hide live connectivity or pretend usage is zero',async t=>{
 const {root,server}=await setup(t,{status:()=>({connected:true,updatedAt:new Date().toISOString(),pid:123})});
 const invalid=Buffer.alloc(1234);await writeFile(join(root,'data','model_usage.json'),invalid);
 const response=await fetch(server.url+'/api/state');assert.equal(response.status,200);
 const state=await response.json();assert.equal(state.status.connected,true);
 assert.equal(state.usage.available,false);assert.equal(state.usage.totals.calls,null);assert.equal(state.usage.reply_median_ms,null);
 assert.deepEqual(await readFile(join(root,'data','model_usage.json')),invalid);
});

test('browser login actions are host-only CSRF operations and unsupported actions cannot invoke callback',async t=>{
 const calls=[];
 const {server,post}=await setup(t,{browserStatus:()=>({configured:true,authentication:'login_required',jobs:[]}),
 browserAction:action=>{calls.push(action);return {ok:true,authentication:'unverified'};}});
 const state=await (await fetch(server.url+'/api/state')).json();assert.equal(state.browser.authentication,'login_required');
 assert.equal((await post('/api/browser',{action:'open_login'})).status,200);
 assert.equal((await post('/api/browser',{action:'confirm_login'})).status,200);
 assert.equal((await post('/api/browser',{action:'navigate',url:'https://example.com'})).status,400);
 assert.equal((await post('/api/browser',{action:'open_login'},{Origin:'https://evil.invalid'})).status,403);
 assert.deepEqual(calls,['open_login','confirm_login']);
});
