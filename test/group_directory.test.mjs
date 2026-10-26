import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,rm} from 'node:fs/promises';import {resolve,join} from 'node:path';
import {GroupDirectory} from '../src/group_directory.mjs';import {QQClient} from '../src/qq.mjs';
async function setup(t,client,options={}){const parent=resolve('temp');await mkdir(parent,{recursive:true});const root=await mkdtemp(join(parent,'directory_test_'));t.after(()=>rm(root,{recursive:true,force:true}));return {root,directory:await GroupDirectory.open({root,client,...options})};}
const event={id:'m',group_openid:'actual-group',author:{member_openid:'a'}};
test('official group query encodes observed IDs and cursor without inventing parameters',async()=>{
 const client=new QQClient('fixture','unused');const calls=[];client.api=async(...args)=>{calls.push(args);return {};};
 await client.groupMembers('group/a',{cursor:'x+y=='});await client.groupBotState('group/a');
 assert.deepEqual(calls.map(a=>a[0]),['/v2/groups/group%2Fa/members?cursor=x%2By%3D%3D','/v2/groups/group%2Fa/bot_state']);
 await assert.rejects(client.groupMembers('',{}),/invalid_group_query/);assert.equal(calls.length,2);
});
test('directory uses real paged members, scoped IDs and separate true permission fields',async t=>{
 let calls=0;const client={groupBotState:async()=>({allow_proactive_msg:true,recv_msg_setting:'all',member_openid:'private-raw',member_role:2}),
 groupMembers:async(g,{cursor})=>{calls++;return cursor?{members:[{member_openid:'b',username:'第二位',member_role:1}],next_cursor:''}:{members:[{member_openid:'a',username:'第一位',member_role:2,union_openid:'do-not-store'}],next_cursor:'page2'};}};
 const {root,directory}=await setup(t,client);await directory.observe(event);
 const context=directory.context(event.group_openid);assert.equal(context.status,'complete');assert.equal(context.members.length,2);assert.equal(context.permission.recv_msg_setting,'all');assert.equal(context.permission.allow_proactive_msg,true);assert.match(context.members[0].speaker,/^member_[a-f0-9]{16}$/);
 assert.equal(directory.context('another').status,'not_queried');await directory.observe({...event,id:'m2'});assert.equal(calls,2);
 const saved=await readFile(join(root,'data','group_directory.json'),'utf8');assert.doesNotMatch(saved,/private-raw|do-not-store|actual-group|member_openid/);
 const restarted=await GroupDirectory.open({root,client});assert.equal(restarted.context(event.group_openid).members[0].name,'第一位');
});
test('invite-only errors back off and never claim roster access',async t=>{
 let calls=0,now=1000;const fail=async()=>{calls++;throw Object.assign(Error('qq_api_error_11253'),{code:11253});};
 const {directory}=await setup(t,{groupBotState:fail,groupMembers:fail},{now:()=>now,ttlMs:100,restrictedTtlMs:1000});
 await Promise.all([directory.observe(event),directory.observe(event)]);assert.equal(calls,2);assert.equal(directory.context(event.group_openid).status,'restricted');assert.equal(directory.context(event.group_openid).permission.status,'restricted');
 now+=200;await directory.observe(event);assert.equal(calls,2);now+=900;await directory.observe(event);assert.equal(calls,4);
});
test('pagination limits remain partial and no malformed or bot event triggers queries',async t=>{
 let calls=0;const {directory}=await setup(t,{groupBotState:async()=>({}),groupMembers:async()=>{calls++;return {members:[{member_openid:'x',username:'x'}],next_cursor:'same'};}},{maxPages:2});
 await directory.observe({...event,author:{bot:true,member_openid:'a'}});await directory.observe({...event,id:''});assert.equal(calls,0);
 await directory.observe(event);assert.equal(calls,2);assert.equal(directory.context(event.group_openid).status,'partial');assert.equal(directory.context(event.group_openid).members.length,1);
 directory.stop();await directory.observe({...event,group_openid:'new'});assert.equal(calls,2);
});
test('HTTP authorization cannot be hidden by a business code and overflowing pages are partial',async t=>{
 for(const code of [null,123456]){
  const fail=async()=>{throw Object.assign(Error('denied'),{status:403,code});};
  const {directory}=await setup(t,{groupBotState:fail,groupMembers:fail});await directory.observe(event);
  assert.equal(directory.context(event.group_openid).status,'restricted');assert.equal(directory.context(event.group_openid).permission.status,'restricted');
 }
 const {directory}=await setup(t,{groupBotState:async()=>({}),groupMembers:async()=>({members:Array.from({length:31},(_,i)=>({member_openid:'id'+i,username:'member'+i})),next_cursor:''})});
 await directory.observe(event);const context=directory.context(event.group_openid,{limit:2});assert.equal(context.status,'partial');assert.equal(context.members_truncated,true);assert.equal(context.returned_count,2);
 context.members[0].name='mutated';assert.notEqual(directory.context(event.group_openid).members[0].name,'mutated');
});
