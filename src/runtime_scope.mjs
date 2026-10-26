import {createHash} from 'node:crypto';
import {AsyncLocalStorage} from 'node:async_hooks';
import {isEventAllowed} from './public_config.mjs';
export const RUNTIME_AUTHORIZATION=Symbol('runtime_authorization');
const denied=()=>Object.assign(Error('scope_revoked'),{code:'scope_revoked',messageNotSent:true});
const target=event=>event?.group_openid?{group_openid:event.group_openid}:{author:{user_openid:event?.author?.user_openid||event?.author?.id}};
const same=(a,b)=>Boolean(a?.group_openid&&a.group_openid===b?.group_openid||!a?.group_openid&&!b?.group_openid&&a?.author?.user_openid===b?.author?.user_openid);
/** Authorization belongs to an observed event epoch, never to a late result. */
export class RuntimeScopeGuard {
 constructor(getConfig){this.getConfig=getConfig;this.epoch=0;this.context=new AsyncLocalStorage();this.active=new Map();}
 issue(event){const token={epoch:this.epoch,event:target(event),origin:event,controller:new AbortController()};this.assert(token,event);return token;}
 current(){return this.context.getStore();}
 valid(token,event=token?.event){return Boolean(token&&token.epoch===this.epoch&&!token.controller.signal.aborted&&same(token.event,target(event))&&isEventAllowed(this.getConfig(),event));}
 assert(token=this.current(),event=token?.event){if(!this.valid(token,event))throw denied();return token;}
 async withAuthorization(token,callback){this.assert(token);this.active.set(token,(this.active.get(token)||0)+1);try{return await this.context.run(token,callback);}finally{const count=this.active.get(token)-1;if(count)this.active.set(token,count);else this.active.delete(token);}}
 withEvent(event,callback){return this.withAuthorization(event?.[RUNTIME_AUTHORIZATION]||this.issue(event),callback);}
 revoke(){this.epoch++;const events=[];for(const token of this.active.keys()){events.push(token.origin);token.controller.abort(Object.assign(Error('scope_revoked'),{code:'scope_revoked',deliveryUncertain:true}));}return events;}
 wrapGenerator(generate){return input=>this.run(input,generate);}
 async run(input,operation){const token=this.assert();return this.withAuthorization(token,async()=>{const signal=input?.signal?AbortSignal.any([input.signal,token.controller.signal]):token.controller.signal;const value=await operation({...input,signal});this.assert(token);if(signal.aborted)throw denied();return value;});}
 fetcher(fetcher){return (url,init={})=>{
  const parsed=new URL(url),match=parsed.pathname.match(/^\/v2\/(groups|users)\/([^/]+)(?:\/|$)/);
  if(!match)return fetcher(url,init); // Token/gateway requests contain no conversation data.
  const event=match[1]==='groups'?{group_openid:decodeURIComponent(match[2])}:{author:{user_openid:decodeURIComponent(match[2])}};
  const token=this.assert(this.current(),event),signal=init.signal?AbortSignal.any([init.signal,token.controller.signal]):token.controller.signal;
  return this.withAuthorization(token,()=>fetcher(url,{...init,signal}));
 };}
}

export async function applyRuntimeConfig({store,config,patch,guard,inbox,social,onRevoked=()=>{},onScopeChanged=()=>{}}){
 const previous=JSON.stringify(config.scope),next=await store.update(patch);
 Object.assign(config,next);
 if(previous!==JSON.stringify(next.scope)){
  const events=guard.revoke();inbox?.invalidateAll();social?.invalidateAuthorization();
  await Promise.all([onScopeChanged(),...events.map(event=>onRevoked(event))]);
 }
 return next;
}

export function eventForMemoryCapture(input,config,owner){
 if(input.runtimeRoom==='private_owner'&&input.conversationKind==='private')return {author:{user_openid:owner}};
 const group=config.scope.groups.find(id=>createHash('sha256').update(id).digest('hex')===input.runtimeRoom);
 if(!group)throw denied();return {group_openid:group};
}
