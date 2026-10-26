import {createHash} from 'node:crypto';
import {readFile,writeFile,rename,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
const hash=s=>createHash('sha256').update(s).digest('hex');
const valid=s=>typeof s==='string'&&s.length>0&&s.length<=512&&!/[\x00-\x1f]/.test(s);
const clean=(s,n)=>[...String(s??'').replace(/[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/g,' ')].slice(0,n).join('');
const numeric=v=>v!==null&&v!==undefined&&v!==''&&Number.isFinite(Number(v))?Number(v):null;
const restricted=e=>numeric(e?.code)===11253||[401,403].includes(numeric(e?.status));
function errorCode(e){return numeric(e?.code)??numeric(e?.status);}
export class GroupDirectory {
 static async open(options){const instance=new GroupDirectory(options);await instance.init();return instance;}
 constructor({root,client,now=Date.now,ttlMs=30*60_000,restrictedTtlMs=24*3600_000,maxPages=10}={}){
  Object.assign(this,{root,client,now,ttlMs,restrictedTtlMs,maxPages:Math.max(1,Math.min(10,Math.trunc(maxPages)||10))});this.rooms={};this.inflight=new Map();this.tail=Promise.resolve();this.persistQueue=Promise.resolve();this.stopped=false;this.requestTimes={state:[],members:[]};
 }
 async init(){await mkdir(join(this.root,'data'),{recursive:true});this.path=join(this.root,'data','group_directory.json');
  try{const data=JSON.parse(await readFile(this.path,'utf8'));for(const [scope,value]of Object.entries(data.rooms||{}).slice(-128)){
   if(!/^[a-f0-9]{64}$/.test(scope)||!value||typeof value!=='object')continue;
   const members=(value.members||[]).filter(v=>/^member_[a-f0-9]{16}$/.test(v?.speaker)).slice(0,300).map(v=>({speaker:v.speaker,name:clean(v.name,60),role:clean(v.role,30),bot:v.bot===true}));
   this.rooms[scope]={status:['complete','partial','restricted','unavailable'].includes(value.status)?value.status:'unavailable',members,
    updatedAt:Number.isFinite(value.updatedAt)?value.updatedAt:0,retryAt:Number.isFinite(value.retryAt)?value.retryAt:0,
    permission:this.permission(value.permission),member_error_code:Number.isInteger(value.member_error_code)?value.member_error_code:null};
  }}catch(e){if(e.code!=='ENOENT')throw e;}
 }
 permission(source){if(!source||typeof source!=='object')return {status:'unknown'};
  return {status:['available','restricted','unavailable'].includes(source.status)?source.status:'unknown',
   ...(typeof source.allow_proactive_msg==='boolean'?{allow_proactive_msg:source.allow_proactive_msg}:{}),
   ...(['all','only_mention','mention_and_context'].includes(source.recv_msg_setting)?{recv_msg_setting:source.recv_msg_setting}:{}),
   ...(source.member_role!==undefined?{member_role:clean(source.member_role,30)}:{}),
   ...(Number.isInteger(source.error_code)?{error_code:source.error_code}:{})};
 }
 persist(){const body=JSON.stringify({version:1,rooms:this.rooms},null,2)+'\n';const task=this.persistQueue.catch(()=>{}).then(async()=>{await writeFile(this.path+'.tmp',body,{mode:0o600});await rename(this.path+'.tmp',this.path);});this.persistQueue=task.catch(()=>{});return task;}
 observe(event){
  const group=event?.group_openid;if(this.stopped||!valid(group)||!valid(event?.id)||event.is_self||event.author?.bot||!valid(event.author?.member_openid||event.author?.id))return Promise.resolve(false);
  const scope=hash(group),current=this.rooms[scope];if(current&&current.retryAt>this.now())return Promise.resolve(false);
  if(this.inflight.has(scope))return this.inflight.get(scope);
  // At most one directory lookup runs globally. Ordinary conversation never waits for it.
  const task=this.tail.catch(()=>{}).then(()=>this.stopped?false:this.refresh(group,scope)).finally(()=>this.inflight.delete(scope));
  this.tail=task.catch(()=>{});this.inflight.set(scope,task);return task;
 }
 async refresh(group,scope){
  const row={status:'unavailable',members:[],permission:{status:'unknown'},updatedAt:this.now(),retryAt:this.now()+this.ttlMs,member_error_code:null};
  try{await this.rateLimit('state',29);const value=await this.client.groupBotState(group);row.permission=this.permission({...value,status:'available'});}
  catch(e){const code=errorCode(e);row.permission={status:restricted(e)?'restricted':'unavailable',error_code:code};}
  let cursor='',complete=false,overflow=false;const cursors=new Set(),seen=new Set();
  try{
   for(let page=0;page<this.maxPages&&!this.stopped;page++){
    await this.rateLimit('members',59);const data=await this.client.groupMembers(group,{cursor});if(!Array.isArray(data.members))throw Error('qq_invalid_member_result');
    if(data.members.length>30)overflow=true;
    for(const member of data.members.slice(0,30)){
     if(!valid(member?.member_openid))continue;const speaker='member_'+hash(JSON.stringify([group,member.member_openid])).slice(0,16);if(seen.has(speaker))continue;seen.add(speaker);
     row.members.push({speaker,name:clean(member.username,60),role:clean(member.member_role,30),bot:member.bot===true});
    }
    if(!data.next_cursor){complete=true;break;}
    if(typeof data.next_cursor!=='string'||data.next_cursor.length>4096||cursors.has(data.next_cursor))break;
    cursor=data.next_cursor;cursors.add(cursor);
   }
   row.status=complete&&!overflow?'complete':'partial';
  }catch(e){const code=errorCode(e);row.member_error_code=code;row.status=row.members.length?'partial':restricted(e)?'restricted':'unavailable';}
  if(this.stopped)return false;
  if(row.status==='restricted')row.retryAt=this.now()+this.restrictedTtlMs;
  this.rooms[scope]=row;
  const keys=Object.keys(this.rooms);if(keys.length>128)for(const key of keys.slice(0,keys.length-128))delete this.rooms[key];
  await this.persist();return true;
 }
 async rateLimit(kind,limit){
  // A shared local cache stays below the documented per-endpoint QPM limits.
  const times=this.requestTimes[kind],current=Date.now();while(times.length&&times[0]<=current-60_000)times.shift();
  if(times.length>=limit)await new Promise(resolve=>setTimeout(resolve,Math.max(1,times[0]+60_001-current)));
  const after=Date.now();while(times.length&&times[0]<=after-60_000)times.shift();times.push(after);
 }
 context(group,{limit=40}={}){
  if(!valid(group))return null;const row=this.rooms[hash(group)];if(!row)return {status:'not_queried',members:[],coverage:'only_actual_observations_available'};
  const members=row.members.slice(0,Math.max(0,Math.min(300,limit))).map(member=>({...member}));
  return {status:row.status,updated_at:new Date(row.updatedAt).toISOString(),stale:this.now()-row.updatedAt>this.ttlMs,
   members,member_count_cached:row.members.length,returned_count:members.length,members_truncated:members.length<row.members.length,
   coverage:row.status==='complete'?'complete_at_last_successful_page':'partial_or_unavailable_do_not_claim_full_roster',permission:{...row.permission}};
 }
 snapshot(){return Object.entries(this.rooms).map(([scope,row])=>({scope,status:row.status,member_count:row.members.length,updatedAt:row.updatedAt,permission:{...row.permission}}));}
 stop(){this.stopped=true;}
}
