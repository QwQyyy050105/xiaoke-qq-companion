import {createHash} from 'node:crypto';
const digest=v=>createHash('sha256').update(v).digest('hex');
const valid=value=>typeof value==='string'&&/^[a-zA-Z0-9_+=/-]{1,512}$/.test(value);
const memberFor=(group,raw)=>'member_'+digest(JSON.stringify([group,raw])).slice(0,16);
function actualMembers(event){
 if(!event?.group_openid)return [];
 const rows=event.turn_messages?.length?event.turn_messages:[event],members=[];
 for(const row of rows){
  if(row.group_openid&&row.group_openid!==event.group_openid)continue;
  const raw=row.author?.member_openid||row.author?.id;
  if(valid(raw)&&row.author?.bot!==true&&!row.is_self)members.push(raw);
  for(const mention of (Array.isArray(row.mentions)?row.mentions:[])){
   if(!mention||mention.scope==='all'||mention.is_you===true||mention.bot===true)continue;
   const id=mention.member_openid||mention.id;if(valid(id))members.push(id);
  }
 }
 return [...new Set(members)];
}
export function resolveMentionTargets(event,speakers){
 if(!event?.group_openid||!Array.isArray(speakers))return [];
 const map=new Map(actualMembers(event).map(id=>[memberFor(event.group_openid,id),id]));
 return [...new Set(speakers.filter(s=>map.has(s)).map(s=>map.get(s)))].slice(0,3);
}
/** Actual group-member openids stay only in bounded memory for native mentions, not in the model prompt. */
export class MentionDirectory {
 constructor(){this.groups=new Map();}
 observe(event){
  if(!valid(event?.group_openid)||event.is_self||event.author?.bot)return;
  const scope=digest(event.group_openid),map=this.groups.get(scope)||new Map();
  for(const raw of actualMembers(event)){const speaker=memberFor(event.group_openid,raw);map.delete(speaker);map.set(speaker,raw);}
  while(map.size>300)map.delete(map.keys().next().value);this.groups.delete(scope);this.groups.set(scope,map);
  while(this.groups.size>128)this.groups.delete(this.groups.keys().next().value);
 }
 resolve(event,speakers){
  this.observe(event);if(!event?.group_openid||!Array.isArray(speakers))return [];
  const map=this.groups.get(digest(event.group_openid));
  return [...new Set(speakers.filter(s=>map?.has(s)).map(s=>map.get(s)))].slice(0,3);
 }
 forget(group){if(typeof group==='string')this.groups.delete(digest(group));}
}
export function textWithMentions(text,ids=[]){
 const body=String(text??'').replace(/<\/?qqbot-at-[^>]*>/gi,'').replace(/<@!?[^>]*>/g,'');
 const prefix=[...new Set((Array.isArray(ids)?ids:[]).filter(valid))].slice(0,3).map(id=>'<qqbot-at-user id="'+id+'" />').join(' ');
 return prefix?prefix+(body?' ':'')+body:body;
}
