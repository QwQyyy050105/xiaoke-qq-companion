import {createHash} from 'node:crypto';

export const channelReviewHash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export function channelReviewPages(text) {
  const chars=Array.from(text),pages=[];
  // Leave room for controls in one QQ bubble, even after a progress reply.
  for(let offset=0;offset<chars.length;offset+=1200)pages.push(chars.slice(offset,offset+1200).join(''));
  return pages;
}

export function channelAtomicReview(command,parameters,mediaBinding=null) {
  return {version:1,payloadHash:channelReviewHash({action:command.name,parameters,...(mediaBinding?{mediaBinding}:{})}),
    text:`操作：${command.description||command.name}\n接口：${command.name}\n完整目标与参数（正文按原文保留）：\n${JSON.stringify(parameters,null,2)}${mediaBinding?'\n按此顺序发送的图片（内容变化须重新审阅）：\n'+JSON.stringify(mediaBinding.assets,null,2):''}`};
}

export function channelReviewProgress(text) {
  return {hash:channelReviewHash(text),nextPage:0,pageCount:channelReviewPages(text).length};
}

export function channelReviewProgressValid(progress,text) {
  return Boolean(progress&&progress.hash===channelReviewHash(text)&&progress.pageCount===channelReviewPages(text).length
    &&Number.isInteger(progress.nextPage)&&progress.nextPage>=0&&progress.nextPage<=progress.pageCount);
}

export function channelReviewPageText(text,id,page,{continuation=false}={}) {
  const pages=channelReviewPages(text);
  if(!Number.isSafeInteger(page)||page<1||page>pages.length)throw Error('channel_review_invalid_page');
  const footer=page===pages.length?`确认执行：/channel-confirm ${id}`:`下一页：/channel-review ${id} ${page+1}\n看完全部 ${pages.length} 页后才能确认`;
  return `频道${continuation?'续接':'操作'}草稿（${page}/${pages.length}）：\n${pages[page-1]}\n\n${footer}\n取消：/channel-cancel ${id}`;
}

export function channelReviewDelivered(delivery,text) {
  return delivery?.sent_text===text.trim()&&Array.isArray(delivery.delivered_messages)
    &&delivery.delivered_messages.some(message=>message.content===text.trim()&&typeof message.messageId==='string'&&message.messageId.length>0);
}
