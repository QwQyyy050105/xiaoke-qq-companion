import {messageIndex} from './media.mjs';

/** Only an actual event/history entry from this conversation can supply the QQ reference index. */
export function resolveReplyReference(event,history,targetId){
 if(!event?.group_openid||typeof targetId!=='string'||!targetId||targetId.length>512)return '';
 const turns=event.turn_messages?.length?event.turn_messages:[event];
 for(const message of turns){
  if(message.group_openid&&message.group_openid!==event.group_openid)continue;
  const reference=messageIndex(message);
  if(reference&&(message.id===targetId||reference===targetId))return reference;
 }
 const entry=(Array.isArray(history)?history:[]).find(item=>item?.messageId===targetId||item?.referenceId===targetId);
 return typeof entry?.referenceId==='string'&&entry.referenceId.length<=512&&!/[\x00-\x20]/.test(entry.referenceId)?entry.referenceId:'';
}
