import { createHash } from 'node:crypto';
import {channelReviewPages} from './channel_review.mjs';
import {channelMediaInput} from './channel_media.mjs';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const names = new Set(['feed.latest-feeds-detail','feed.hot-feeds-detail','manage.search-and-join','feed.search-and-comment','feed.quick-publish']);
const reads = new Set(['feed.latest-feeds-detail','feed.hot-feeds-detail']);
const complete = result => result?.success === true && !result.truncated && !result._projection?.truncated;
const text = (value,max=1500) => typeof value === 'string' && value.trim() && value.length <= max && !/[\x00-\x1f]/.test(value);
const identifier = value => typeof value === 'string' && /^\d{1,30}$/.test(value);
const session = value => typeof value === 'string' && /^s-[A-Za-z0-9_-]{1,120}$/.test(value);
export const isChannelShortcut = name => names.has(name);
export const isChannelReadShortcut = name => reads.has(name);
export const shortcutRequestHash = parameters => hash(parameters);

export function validateShortcutRequest(action, parameters) {
  if (!names.has(action) || !parameters || typeof parameters !== 'object' || Array.isArray(parameters)) throw Error('channel_shortcut_invalid_request');
  if(['resume-id','pick','set','time-stamp','yes','confirm'].some(key=>Object.hasOwn(parameters,key)))throw Error('channel_shortcut_initial_control');
  if(action==='feed.quick-publish'&&Object.keys(parameters).some(key=>!['content','markdown-content','title','feed-type','at-user','link','topic-name','image-ids'].includes(key)))throw Error('channel_shortcut_initial_parameter');
  if(Object.hasOwn(parameters,'image-ids')){if(action!=='feed.quick-publish')throw Error('channel_shortcut_media_unsupported');channelMediaInput(action,parameters);}
  if (reads.has(action)) {
    const count = parameters.count ?? 10;
    if (!Number.isInteger(Number(count)) || Number(count) < 1 || Number(count) > 10) throw Error('channel_shortcut_invalid_count');
  } else if (action === 'manage.search-and-join') {
    if (!text(parameters.keyword,200)) throw Error('channel_shortcut_missing_keyword');
  } else if (action === 'feed.search-and-comment') {
    if (!identifier(parameters['guild-id']) || !text(parameters.query,200) || typeof parameters.content !== 'string' || !parameters.content.trim()) throw Error('channel_shortcut_missing_comment');
  } else {
    const content = parameters.content, markdown = parameters['markdown-content'];
    if ((typeof content === 'string' && content.trim() ? 1 : 0) + (typeof markdown === 'string' && markdown.trim() ? 1 : 0) !== 1) throw Error('channel_shortcut_missing_body');
    if (content !== undefined && markdown !== undefined) throw Error('channel_shortcut_conflicting_body');
    if ((markdown !== undefined || Number(parameters['feed-type']) === 2) && !text(parameters.title,200)) throw Error('channel_shortcut_missing_title');
    if ((parameters.title || Number(parameters['feed-type']) === 2) && parameters['topic-name']?.length) throw Error('channel_shortcut_long_post_topic');
  }
}

function checkedRequest(source) {
  validateShortcutRequest(source.action,source.parameters);
  if (source.requestHash !== hash(source.parameters)) throw Error('channel_shortcut_request_changed');
  if(Object.hasOwn(source.parameters,'image-ids')){
    const binding=source.mediaBinding,lease=source.mediaLease;
    if(source.mediaLeaseState||source.mediaLeaseHash!==hash(lease)||binding?.version!==1||binding.scope!==source.scope||binding.action!==source.action||binding.parametersHash!==source.requestHash||!Array.isArray(binding.assets)||JSON.stringify(binding.assets.map(a=>a.id))!==JSON.stringify(source.parameters['image-ids'])||lease?.bindingHash!==hash(binding)||!Array.isArray(lease.files)||lease.files.length!==binding.assets.length)throw Error('channel_shortcut_media_changed');
  }
}

function guild(option) {
  if (!option || typeof option !== 'object' || !identifier(option.guild_id) || !text(option.name || option.guild_name)) throw Error('channel_shortcut_unknown_guild');
  return {kind:'guild',guild_id:option.guild_id,label:(option.name || option.guild_name).trim()};
}

export function channelShortcutStep(source, selection) {
  if (!names.has(source?.action) || source.status !== 'waiting') throw Error('channel_shortcut_unavailable');
  checkedRequest(source);
  const result=source.result,data=result?.data,pending=data?.pending;
  if (!complete(result) || data.status !== 'waiting' || !session(data.id) || pending?.type !== 'pick' || !Array.isArray(pending.options) || !pending.options.length || pending.options.length > 20) throw Error('channel_shortcut_unknown_step');
  if ((source.steps || []).some(step=>step.receiptHash===hash(result))) throw Error('channel_shortcut_consumed_receipt');
  if (selection?.kind !== 'pick' || !/^\d+$/.test(String(selection.value))) throw Error('channel_shortcut_invalid_selection');
  const value=Number(selection.value),option=pending.options[value];
  if (!Number.isSafeInteger(value) || value >= pending.options.length || !option || (option._index !== undefined && option._index !== value)) throw Error('channel_shortcut_invalid_selection');
  let target,effect='read',review;
  const applied=(source.steps || []).filter(step=>step.status==='applied');
  if (reads.has(source.action) || source.action==='manage.search-and-join') {
    if (applied.length) throw Error('channel_shortcut_unexpected_step');
    target=guild(option);
    if (source.action==='manage.search-and-join') { effect='write'; review=`加入腾讯频道「${target.label}」。若需要验证，会保留返回的问题，不会代填答案。`; }
    else review=`查看「${target.label}」的${source.action.includes('latest')?'最新':'热门'}帖子详情。`;
  } else if (source.action==='feed.search-and-comment') {
    if (applied.length || !text(option.feed_id,200) || !text(option.title || option.label || option.name)) throw Error('channel_shortcut_unknown_post');
    if (option.guild_id !== undefined && option.guild_id !== source.parameters['guild-id']) throw Error('channel_shortcut_target_changed');
    target={kind:'feed',guild_id:source.parameters['guild-id'],feed_id:option.feed_id,label:(option.title || option.label || option.name).trim()};
    effect='write'; review=`在帖子「${target.label}」下发表评论：\n${source.parameters.content}`;
  } else if (!applied.length) {
    // A board pick can publish even without --yes. Treat only the exact known
    // guild phase as read-only; an unexpected phase must never auto-resume.
    if (data.step!=='1/3' || ['channel_id','channel_name','board_id','board_name'].some(key=>Object.hasOwn(option,key))) throw Error('channel_shortcut_unknown_publish_stage');
    target=guild(option);review=`选择发帖频道「${target.label}」，接下来选择版块；此步不发布。`;
  } else {
    if (data.step!=='2/3' || applied.length!==1 || applied[0].receiptStep!=='1/3' || applied[0].target?.kind!=='guild' || !identifier(option.channel_id) || !text(option.name || option.channel_name)) throw Error('channel_shortcut_unknown_board');
    const previous=applied[0].target;
    if (option.guild_id !== undefined && option.guild_id !== previous.guild_id) throw Error('channel_shortcut_target_changed');
    target={kind:'board',guild_id:previous.guild_id,guild_label:previous.label,channel_id:option.channel_id,label:(option.name || option.channel_name).trim()};
    effect='write';review=`发布到「${target.guild_label}」→「${target.label}」：\n${JSON.stringify(source.parameters,null,2)}`;
    if(source.mediaBinding)review+='\n图片（按发送顺序）：\n'+source.mediaBinding.assets.map((asset,index)=>`${index+1}. ${asset.label}（${asset.mime}，${asset.width}×${asset.height}，${asset.bytes} 字节）`).join('\n');
  }
  const args=[...source.action.split('.'),'--json','--resume-id='+data.id,'--pick='+value];
  if (reads.has(source.action)) args.push('--count='+(source.parameters.count ?? 10));
  if (source.action==='feed.search-and-comment') args.push('--content='+source.parameters.content);
  if (effect==='write') args.push('--yes');
  return {sessionId:data.id,receiptHash:hash(result),receiptStep:data.step,requestHash:source.requestHash,...(source.mediaBinding?{mediaBindingHash:hash(source.mediaBinding),mediaLeaseHash:hash(source.mediaLease)}:{}),selection:{kind:'pick',value},target,effect,review,args};
}

export function channelShortcutSummary(source,id) {
  if (source.blockedReason==='verification_required') return '频道要求补充入群验证，尚未确认加入成功。实际问题回执已保存；当前快捷流程还不能提交验证答案。';
  try {
    const options=source.result?.data?.pending?.options;
    if (!Array.isArray(options) || !options.length || options.length>20) throw Error('unknown');
    const lines=options.map((_,value)=>{
      const step=channelShortcutStep(source,{kind:'pick',value});
      const chars=Array.from(step.target.label);
      return `${value}：${chars.length>50?chars.slice(0,50).join('')+'…（名称省略，写入前会完整展示）':step.target.label}`;
    });
    return `请选择${source.action==='feed.search-and-comment'?'帖子':source.action==='feed.quick-publish'&&(source.steps||[]).some(s=>s.status==='applied')?'发帖版块':'频道'}：\n${lines.join('\n')}\n/channel-resume ${id} pick 序号\n取消：/channel-cancel ${id}`;
  } catch { return '这项频道操作还没有完成，回执中的下一步格式尚不能可靠续接。已保留回执和完成过的步骤，不会重复执行，也不会执行回执附带的命令。'; }
}

export function channelShortcutReviewPages(step) {return channelReviewPages(step.review);}

function verification(result) {
  return [result?.data,result?.data?.result,result?.data?.result?.data].some(value=>value?.need_verification===true || value?.status==='need_verification');
}

export function classifyShortcutResult(source,result,step=null) {
  if (!result || result.truncated || result._projection?.truncated) return {status:'uncertain'};
  if (verification(result)) return {status:'waiting',blockedReason:'verification_required'};
  if (result.success===false) return {status:'failed'};
  if (!complete(result)) return {status:'uncertain'};
  const data=result.data;
  if (step && data?.id && data.id!==step.sessionId) return {status:'uncertain'};
  if (data?.status==='waiting') {
    if (step && (!session(data.id) || data.id!==step.sessionId || hash(result)===step.receiptHash)) return {status:'uncertain'};
    return {status:'waiting'};
  }
  // The installed read shortcuts return result.feeds/count/guild_id, without a
  // nested success flag. Writes still require explicit terminal action evidence.
  if (data?.status!=='done' || !step) return {status:'uncertain'};
  if (reads.has(source.action)) {
    const value=data.result,requested=Number(source.parameters.count ?? 10);
    if (!value || !Array.isArray(value.feeds) || value.feeds.length>requested || !Number.isInteger(value.count) || value.count<0 || value.count>requested || value.guild_id!==step.target.guild_id) return {status:'uncertain'};
    if (value.feeds.some(item=>!item?.feed || !text(item.feed.feed_id,200) || (item.feed.guild_id!==undefined && item.feed.guild_id!==step.target.guild_id))) return {status:'uncertain'};
    return {status:'completed'};
  }
  if (step.effect!=='write' || typeof data.result?.success!=='boolean') return {status:'uncertain'};
  return {status:data.result.success?'completed':'failed'};
}
