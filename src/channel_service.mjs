import { spawn } from 'node:child_process';
import { readFile, mkdir } from 'node:fs/promises';
import { durableWriteFile } from './durable_write.mjs';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { isChannelShortcut, isChannelReadShortcut, validateShortcutRequest, shortcutRequestHash, channelShortcutStep, channelShortcutSummary, channelShortcutReviewPages, classifyShortcutResult } from './channel_shortcuts.mjs';
import {channelAtomicReview,channelReviewProgress,channelReviewProgressValid,channelReviewPageText,channelReviewDelivered} from './channel_review.mjs';
import {channelMediaActions,channelMediaFlag} from './channel_media.mjs';
import {ChannelJoinFlow,hasChannelJoinAnswers} from './channel_join_flow.mjs';
import {channelJoinSettingsInput,channelJoinSettingsCommand} from './channel_join_settings.mjs';
const hash = s => createHash('sha256').update(s).digest('hex');
const author = e => e.group_openid ? e.author?.member_openid || e.author?.id : e.author?.user_openid || e.author?.id;
const scope = e => hash(JSON.stringify([e.group_openid || 'private', e.group_openid ? '' : author(e)]));
const publicCommands = new Set(['manage.search-guild-content','feed.get-feed-detail','feed.get-feed-comments','feed.get-next-page-replies']);
const unsupportedCommands = new Set(['manage.notify-daemon','manage.subscribe-notices','manage.unsubscribe-notices','manage.notices-on','manage.notices-off']);
const blockedFlags = /(?:file|path|image|video|avatar|ref$|resume|session|token|secret|cookie|yes|confirm)/i;
// These vendor fields are ordinary business data, not credentials or paths.
// They still require an exact flag in the selected command's official schema.
const businessFlags = new Set(['next-page-token','next-page-cookie','guild-profile']);
const blockedFlag = name => ['push-command','__worker__'].includes(name) || (!businessFlags.has(name) && blockedFlags.test(name));
const waitingMessage = '频道工具仍在等待后续选择或参数，这项操作尚未完成。当前回执的这类步骤还不能可靠续接，需要在本机腾讯频道 CLI 按已保存的原回执核对；已有步骤可能生效，不会重复执行原请求。';
const unsupportedMessage = '频道自动通知需要真实的 OpenClaw 会话和推送路由，目前还没有接入小柯的聊天通道。这次没有启动、关闭或确认订阅；现有频道查询仍可使用。';
const receiptHash = result => hash(JSON.stringify(result));
const resumeCommand = /^\/channel-resume\s+([a-f0-9]{12})\s+(pick|time-stamp)\s+(\d+)$/;
const reviewCommand = /^\/channel-review\s+([a-f0-9]{12})\s+(\d+)$/;
const resumeUnavailable = '这一步的回执格式或目标信息还不能可靠续接，未执行后续操作。请保留原回执在本机核对，不要重新发起同一写入。';

// This adapter implements only the documented delete-and-mute flow. It never
// executes resume_command. That string is evidence for a single known flag,
// while command, session, arguments and target remain bound to our own receipt.
export function channelResumeStep(proposal, selection) {
  if(proposal?.action!=='feed.delete-and-mute'||proposal.status!=='waiting')throw Error('channel_resume_unsupported');
  const result=proposal.result,data=result?.data,pending=data?.pending;
  if(!completePage(result)||data.status!=='waiting'||!/^s-[A-Za-z0-9_-]{1,120}$/.test(data.id||'')||!pending||typeof pending!=='object')throw Error('channel_resume_invalid_receipt');
  if((proposal.steps||[]).some(s=>s.receiptHash===receiptHash(result)))throw Error('channel_resume_consumed_receipt');
  if(!selection||!['pick','time-stamp'].includes(selection.kind)||!/^\d+$/.test(String(selection.value)))throw Error('channel_resume_invalid_selection');
  const value=Number(selection.value);
  if(!Number.isSafeInteger(value))throw Error('channel_resume_invalid_selection');
  let target,review;
  if(selection.kind==='pick'){
    if(pending.type!=='pick'||!Array.isArray(pending.options)||!pending.options.length||pending.options.length>20||value>=pending.options.length)throw Error('channel_resume_invalid_pick');
    const option=pending.options[value];
    const label=typeof option==='string'?option:option?.title||option?.label||option?.name;
    if(typeof label!=='string'||!label.trim()||label.length>1500||/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(label))throw Error('channel_resume_unreviewable_target');
    target={label:label.trim(),option:structuredClone(option)};
    review=`删除选项 ${value} 对应的帖子：${target.label}\n这一步可能立即删除帖子；后续是否禁言会单独确认。`;
  }else{
    // The installed schema documents --time-stamp but not every pending.type.
    // Accept it only when the receipt explicitly supplies this exact command
    // template and a prior confirmed pick identifies the affected author/post.
    const escaped=data.id.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
    const template=new RegExp('^tencent-channel-cli feed delete-and-mute --resume-id(?:=| )'+escaped+' --time-stamp(?:=| )(?:<[A-Za-z_][A-Za-z0-9_-]*>|\\d+) --json(?: --yes)?$');
    const previous=[...(proposal.steps||[])].reverse().find(s=>s.status==='applied'&&s.selection?.kind==='pick'&&s.target?.label);
    if(pending.type==='pick'||!template.test(pending.resume_command||'')||!previous||value<1||value>2592000)throw Error('channel_resume_unverified_duration_step');
    target=structuredClone(previous.target);
    review=`对刚才所选帖子「${target.label}」的作者执行禁言步骤，时长 ${value} 秒。\n已执行的删帖步骤不会重做。`;
  }
  const args=['feed','delete-and-mute','--json','--resume-id='+data.id,'--'+selection.kind+'='+value,'--yes'];
  return {sessionId:data.id,receiptHash:receiptHash(result),selection:{kind:selection.kind,value},target,review,args};
}

function waitingSummary(proposal,id){
  if(isChannelShortcut(proposal?.action))return channelShortcutSummary(proposal,id);
  try{
    const data=proposal.result?.data,pending=data?.pending;
    if(!completePage(proposal.result)||data.status!=='waiting'||proposal.action!=='feed.delete-and-mute')return waitingMessage;
    if(pending?.type==='pick'&&Array.isArray(pending.options)&&pending.options.length&&pending.options.length<=20){
      const options=pending.options.map((_,i)=>{
        const step=channelResumeStep(proposal,{kind:'pick',value:i}),chars=Array.from(step.target.label);
        // Only the menu label is abbreviated. The stored option and selected
        // step retain the exact target for the complete paginated review.
        const label=chars.length>50?chars.slice(0,50).join('')+'…（名称省略，写入前会完整展示）':step.target.label;
        return `${i}：${label}`;
      });
      return `频道操作尚未完成，当前需选择具体帖子。选择后还会展示删帖确认草稿。\n${options.join('\n')}\n选择：/channel-resume ${id} pick 序号\n取消后续：/channel-cancel ${id}`;
    }
    channelResumeStep(proposal,{kind:'time-stamp',value:1});
    return `这项快捷操作尚未完成，已执行的步骤不会重做。下一步可指定禁言秒数（1–2592000），之后会再次展示具体确认草稿。\n/channel-resume ${id} time-stamp 秒数\n取消后续：/channel-cancel ${id}`;
  }catch{return waitingMessage;}
}
export function channelRequest(text) { return /(?:腾讯频道|QQ频道|频道.{0,16}(?:搜|看|帖|评论|浏览|管理|加入|通知|推送)|(?:搜|看看|浏览|发帖).{0,16}频道|pd\.qq\.com\/|^\/(?:channel|频道)(?:\s|$))/i.test(String(text)); }
export function channelArgs(command, parameters) {
  if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters)) throw Error('channel_invalid_parameters');
    const args = command.name.split('.'); args.push('--json');
  for (const [key,value] of Object.entries(parameters)) {
    const f = command.flags.find(x=>x.name===key);
    if (!f || blockedFlag(key)) throw Error('channel_parameter_not_supported');
    if(command.flags.some(x=>x.name==='resume-id')&&['pick','set','time-stamp'].includes(key))throw Error('channel_resume_requires_saved_receipt');
    const values = Array.isArray(value) ? value : [value];
    if(values.length>20 || (Array.isArray(value) && !/array|slice/i.test(f.type))) throw Error('channel_invalid_array');
    for (const item of values) {
      if (!['string','number','boolean'].includes(typeof item) || String(item).length>10000 || /\x00/.test(String(item))) throw Error('channel_invalid_value');
      if (f.enum && !f.enum.map(String).includes(String(item))) throw Error('channel_invalid_enum');
      if (/int/.test(f.type) && !/^-?\d+$/.test(String(item))) throw Error('channel_invalid_number');
      if (f.pattern==='uint' && !/^\d+$/.test(String(item))) throw Error('channel_invalid_id');
      args.push(`--${key}=${item}`);
    }
  }
  for(const f of command.flags) if(f.required && !Object.hasOwn(parameters,f.name)) throw Error('channel_missing_'+f.name);
  return args;
}
export function channelInvocation(command, parameters) {
  const input=channelJoinSettingsInput(command,parameters);
  if(!input)return {args:channelArgs(command,parameters)};
  // Validate required fields and enums against the installed command schema,
  // but place the complete request solely on stdin, without duplicate flags.
  channelArgs(command,input.flagParameters);
  return {args:[...command.name.split('.'),'--json'],stdin:input.stdin};
}
const businessResultFields = new Set(['next_page_token','next-page-token','next_page_cookie','next-page-cookie','attach_info','attach-info']);
export function sanitizeChannelResult(value) {
  const omissions=[];
  const omitted=(path,kind)=>{if(omissions.length<12)omissions.push({path,kind});};
  const visit=(item,depth=0,key='',path='$')=>{
    if(depth>12){omitted(path,'depth_limit');return '[nested content omitted]';}
    if(typeof item==='string'){
      if(businessResultFields.has(key)){
        if(item.length>10000){omitted(path,'cursor_too_long');return null;}
        return item;
      }
      if(item.length>4500)omitted(path,'text_truncated');
      return item.slice(0,4500);
    }
    if(Array.isArray(item)){
      if(item.length>20)omitted(path,'array_truncated');
      return item.slice(0,20).map((v,i)=>visit(v,depth+1,'',path+'['+i+']'));
    }
    if(!item||typeof item!=='object')return item;
    return Object.fromEntries(Object.entries(item)
      .filter(([k])=>k!=='_projection'&&(businessResultFields.has(k)||!/(?:access[_-]?token|refresh[_-]?token|app[_-]?secret|cookie|credential|qr[_-]?code|device[_-]?code|authorization)/i.test(k)))
      .map(([k,v])=>[k,visit(v,depth+1,k,path+'.'+k)]));
  };
  const clean=visit(value),text=JSON.stringify(clean);
  const projection={truncated:true,paginationAllowed:false,omissions,
    note:'This is a partial result. Do not claim the full page was read or advance its cursor; narrow the request first.'};
  if(text.length>24000){omitted('$','result_size_limit');return {success:clean?.success===true,truncated:true,_projection:projection,excerpt:text.slice(0,20000)};}
  if(omissions.length)return clean&&!Array.isArray(clean)&&typeof clean==='object'?{...clean,_projection:projection}:{data:clean,_projection:projection};
  return clean;
}
const completePage = result => result?.success===true&&!result.truncated&&!result._projection?.truncated;
export function groupChannelParametersAllowed(name,parameters,trace,publicFeedIds){
  const feed=String(parameters['feed-id']);
  if(!publicFeedIds.has(feed))return false;
  const integer=(value,min,max)=>/^\d+$/.test(String(value))&&Number(value)>=min&&Number(value)<=max;
  if(name==='feed.get-next-page-replies'){
    if(Object.keys(parameters).some(k=>!['feed-id','comment-id','guild-id','channel-id','count','attach-info'].includes(k)))return false;
    if(typeof parameters['comment-id']!=='string'||!parameters['comment-id']||!parameters['guild-id']||!parameters['channel-id'])return false;
    if(parameters.count!==undefined&&!integer(parameters.count,1,20))return false;
    const comment=parameters['comment-id'],cursor=parameters['attach-info'];
    if(typeof cursor!=='string'||!cursor||cursor.length>10000)return false;
    const detail=[...trace].reverse().find(t=>t.action==='feed.get-feed-detail'&&String(t.result?.data?.feed?.feed_id)===feed);
    if(!detail||!completePage(detail.result)||['guild-id','channel-id'].some(k=>String(detail.result.data.feed[k.replace('-','_')])!==String(parameters[k])))return false;
    const previous=[...trace].reverse().find(t=>t.action===name&&String(t.parameters?.['feed-id'])===feed&&String(t.parameters?.['comment-id'])===comment);
    if(previous)return completePage(previous.result)&&previous.result.data?.attach_info===cursor
      &&['guild-id','channel-id'].every(k=>String(previous.parameters?.[k])===String(parameters[k]));
    // The initial reply cursor belongs to one comment, never the comment-list
    // page itself. Unknown vendor shapes deliberately require fresh evidence.
    const comments=[...trace].reverse().find(t=>t.action==='feed.get-feed-comments'&&String(t.parameters?.['feed-id'])===feed);
    if(!comments||!completePage(comments.result)||!Array.isArray(comments.result.data?.comments))return false;
    const target=comments.result.data.comments.find(c=>String(c.comment_id)===comment);
    return Boolean(target&&target.attach_info===cursor);
  }
  for(const [key,value] of Object.entries(parameters)){
    if(key==='feed-id')continue;
    if(['guild-id','channel-id'].includes(key)){
      if(!trace.some(t=>t.action==='feed.get-feed-detail'&&completePage(t.result)&&String(t.result.data?.feed?.feed_id)===feed&&String(t.result.data?.feed?.[key.replace('-','_')])===String(value)))return false;
      continue;
    }
    if(name!=='feed.get-feed-comments')return false;
    if(key==='count'){if(!integer(value,1,20))return false;continue;}
    if(key==='rank-type'){if(!integer(value,0,2))return false;continue;}
    if(key==='reply-list-num'){if(!integer(value,0,10))return false;continue;}
    if(key!=='attach-info'||typeof value!=='string'||value.length>10000)return false;
    if(!value)continue;
    const previous=[...trace].reverse().find(t=>t.action===name&&String(t.parameters?.['feed-id'])===feed);
    if(!previous||!completePage(previous.result)||previous.result.data?.attach_info!==value
      ||Number(previous.parameters?.['rank-type']??0)!==Number(parameters['rank-type']??0))return false;
  }
  return true;
}
export function channelCli(root, args, {stdin,timeoutMs=25000,spawnProcess=spawn,signal}={}) {
  return new Promise((resolve,reject)=>{
    if(signal?.aborted)return reject(Object.assign(Error('channel_cancelled'),{code:'channel_cancelled',messageNotSent:true}));
    if(stdin!==undefined&&(typeof stdin!=='string'||Buffer.byteLength(stdin,'utf8')>128*1024||stdin.includes('\0')))return reject(Error('channel_invalid_stdin'));
    if(!Number.isSafeInteger(timeoutMs)||timeoutMs<25000||timeoutMs>120000)return reject(Error('channel_invalid_timeout'));
    const exe=process.env.XIAOKE_CHANNEL_CLI || join(root,'runtime','tencent_channel','node_modules','tencent-channel-cli-win32-x64','bin','tencent-channel-cli.exe');
    const env={...process.env,TEMP:join(root,'temp'),TMP:join(root,'temp')};delete env.QQ_APP_SECRET;delete env.QQ_APP_ID;delete env.QQ_PAIRING_CODE;delete env.MODEL_API_KEY;
    const child=spawnProcess(exe,args,{cwd:root,env,windowsHide:true,shell:false,stdio:[stdin===undefined?'ignore':'pipe','pipe','pipe']});
    let out='',size=0,done=false;
    let abort=()=>{};
    const end=(err,value)=>{if(done)return;done=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);err?reject(err):resolve(value);};
    const timer=setTimeout(()=>{child.kill();end(Error('channel_timeout'));},timeoutMs);
    abort=()=>{child.kill();end(Object.assign(Error('channel_cancelled'),{code:'channel_cancelled',deliveryUncertain:true}));};
    signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
    child.stdout.on('data',chunk=>{size+=chunk.length;if(size>2e6){child.kill();end(Error('channel_output_too_large'));}else out+=chunk;});
    child.stderr.resume();child.on('error',()=>end(Error('channel_launch_failed')));
    if(stdin!==undefined){child.stdin.on('error',()=>{child.kill();end(Error('channel_stdin_failed'));});child.stdin.end(stdin+'\n','utf8');}
    child.on('close',code=>{try {end(null,sanitizeChannelResult(JSON.parse(out)));}catch{end(Error('channel_invalid_response_'+code));}});
  });
}
export class ChannelService {
  constructor({root,generate,getOwner,run,media=null,now=Date.now}) {Object.assign(this,{root,generate,getOwner,media,now});this.run=run||((args,options)=>channelCli(root,args,options));this.tails=new Map();this.jobs=new Set();this.writes=Promise.resolve();this.epochs=new Map();this.reviewWrites=new Set();this.mediaPreparing=new Map();this.joinFlow=new ChannelJoinFlow(this);}
  async init() {
    this.commands=JSON.parse(await readFile(join(this.root,'src','channel_commands.json'),'utf8'));
    this.path=join(this.root,'data','channel_sessions.json');
    try{this.state=JSON.parse(await readFile(this.path,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;this.state={sessions:{},proposals:{},completed:[]};}
    // An interrupted write must never be automatically retried.
    for(const p of Object.values(this.state.proposals)){
      if(p.status==='executing')p.status='uncertain';
      if(p.status==='preparing_media')p.status='canceled';
      for(const step of p.steps||[])if(step.status==='executing')step.status='uncertain';
      if(p.mediaLease){
        const event={author:{user_openid:p.owner}};
        if(p.status==='waiting'){
          try{
            if(!this.owner(event)||p.scope!==scope(event)||this.now()-(p.updatedAt||p.at)>30*60_000||p.mediaLeaseState)throw Error('channel_media_expired');
            channelShortcutStep(p,{kind:'pick',value:0});
            await this.media.verifyLease(event,p.action,p.parameters,p.mediaBinding,p.mediaLease);
          }catch{p.status='canceled';}
        }
        if(p.status!=='waiting')await this.releaseShortcutMedia(p);
      }
    }
    this.leaseTimer=setInterval(()=>{const job=this.expireShortcutMedia().catch(()=>{});this.jobs.add(job);void job.finally(()=>this.jobs.delete(job));},60000);this.leaseTimer.unref();
    await this.save();return this;
  }
  save(){const snapshot=JSON.stringify(this.state,null,2)+'\n';const work=this.writes.catch(()=>{}).then(async()=>{await mkdir(join(this.root,'data'),{recursive:true});await durableWriteFile(this.path,snapshot);});this.writes=work;return work;}
  owner(e){return !e.group_openid && Boolean(this.getOwner()) && author(e)===this.getOwner();}
  accepts(e){const t=String(e.content||'').trim(),session=this.state.sessions[scope(e)];return this.joinFlow.accepts(e)||channelRequest(t)||/^\/channel-(?:confirm|cancel|resume|review)\s/.test(t)||Boolean(session&&this.now()-session.at<15*60_000&&/^(?:第[一二三四五六七八九十\d]+|继续(?:看|读|搜)|看(?:看)?(?:第|评论)|读(?:第|评论)|评论(?:第|这)|回复(?:第|这)|发(?:出去|布吧))/.test(t));}
  async forget(e){const key=scope(e);this.epochs.set(key,(this.epochs.get(key)||0)+1);delete this.state.sessions[key];this.joinFlow.forget(e);for(const [id,p] of Object.entries(this.state.proposals))if(p.scope===key&&['pending','waiting','preparing_media'].includes(p.status)){p.status='canceled';if(p.mediaLease&&!this.mediaPreparing.has(id))await this.releaseShortcutMedia(p);}return this.save();}
  async releaseShortcutMedia(source){
    if(!source?.mediaLease||source.mediaLeaseState)return;
    // Record the attempted release before touching files. A blocked cleanup is
    // retained once, never retried on every restart or request.
    source.mediaLeaseState='cleanup_pending';source.mediaCleanupPending={directory:source.mediaLease.directory,files:source.mediaLease.files};await this.save();
    const outcome=this.media&&source.mediaLeaseHash===shortcutRequestHash(source.mediaLease)?await this.media.releaseLease(source.mediaLease):{cleanupPending:true,cleanup:source.mediaCleanupPending};
    if(!outcome.cleanupPending){source.mediaLeaseState='released';source.mediaLeaseReleasedAt=this.now();delete source.mediaCleanupPending;}
    else source.mediaCleanupPending=outcome.cleanup;
    await this.save();
  }
  async expireShortcutMedia(){
    let changed=false;
    for(const [id,p] of Object.entries(this.state.proposals))if(p.mediaLease&&p.status==='waiting'&&this.now()-(p.updatedAt||p.at)>30*60_000){
      p.status='canceled';for(const child of Object.values(this.state.proposals))if(child.resume?.sourceId===id&&child.status==='pending')child.status='canceled';
      await this.releaseShortcutMedia(p);changed=true;
    }
    if(changed)await this.save();
  }
  invocation(command,parameters){
    if(!Object.hasOwn(parameters,'image-ids'))return channelInvocation(command,parameters);
    if(!this.media||!channelMediaActions.has(command.name))throw Error('channel_media_unavailable');
    const clean={...parameters};delete clean['image-ids'];return channelInvocation(command,clean);
  }
  async prepareResume(e,sourceId,selection,send,valid=()=>true){
    await this.expireShortcutMedia();
    const source=this.state.proposals[sourceId],key=scope(e),epoch=this.epochs.get(key)||0,owner=this.getOwner();
    if(!this.owner(e)||!source||source.scope!==key||source.owner!==this.getOwner())return send('没有找到这次会话的频道操作草稿。');
    if(source.status!=='waiting'||this.now()-(source.updatedAt||source.at)>30*60_000)return send('这一步已处理或过期，不会重复执行。');
    if(isChannelShortcut(source.action))return this.prepareShortcutResume(e,sourceId,selection,send,valid);
    let step;try{step=channelResumeStep(source,selection);}catch{return send(resumeUnavailable);}
    if(!valid())return;
    // One review per source receipt. Repeated selections cannot fan out writes.
    for(const p of Object.values(this.state.proposals))if(p.resume?.sourceId===sourceId&&p.status==='pending')p.status='canceled';
    const id=randomUUID().replaceAll('-','').slice(0,12);
    this.state.proposals[id]={scope:key,owner,action:source.action,parameters:{},status:'pending',at:this.now(),resume:{sourceId,...step},reviewProgress:channelReviewProgress(step.review)};
    await this.save();
    if(!valid()||(this.epochs.get(key)||0)!==epoch||this.getOwner()!==owner)return;
    return this.sendChannelReview(e,id,1,send,valid);
  }
  async executeResume(e,id,send,valid=()=>true){
    const p=this.state.proposals[id],source=this.state.proposals[p?.resume?.sourceId],key=scope(e),epoch=this.epochs.get(key)||0,owner=this.getOwner();
    if(isChannelShortcut(source?.action))return this.executeShortcutResume(e,id,send,valid);
    if(String(e.content||'').trim()!=='/channel-confirm '+id||!this.owner(e)||!p||p.scope!==scope(e)||p.owner!==this.getOwner()||p.status!=='pending'||this.now()-p.at>30*60_000)return send('这份续接草稿尚未确认、已处理、过期或不属于当前会话，不会执行。');
    if(!source||source.owner!==this.getOwner()||source.scope!==p.scope||source.status!=='waiting'||this.now()-(source.updatedAt||source.at)>30*60_000){p.status='canceled';await this.save();return send('原操作已变更或过期，这份续接草稿已失效。');}
    let step;try{step=channelResumeStep(source,p.resume.selection);}catch{p.status='canceled';await this.save();return send(resumeUnavailable);}
    if(p.action!==source.action||JSON.stringify(step)!==JSON.stringify(Object.fromEntries(Object.entries(p.resume).filter(([name])=>name!=='sourceId')))){p.status='canceled';await this.save();return send('原回执、续接参数或操作目标已变化，未执行旧的确认草稿。');}
    const live=()=>valid()&&(this.epochs.get(key)||0)===epoch&&this.getOwner()===owner&&this.owner(e)&&p.owner===owner&&source.owner===owner;
    if(!live())return;
    // Legacy continuation drafts also lack delivery proof. Their first
    // confirmation only presents the review, and never executes the step.
    if(!p.reviewProgress){
      p.reviewProgress=channelReviewProgress(step.review);await this.save();
      if(!live())return;
      return this.sendChannelReview(e,id,1,send,valid);
    }
    if(this.reviewWrites.has(id)||!channelReviewProgressValid(p.reviewProgress,step.review)||p.reviewProgress.nextPage!==p.reviewProgress.pageCount){
      const page=channelReviewProgressValid(p.reviewProgress,step.review)?Math.min(p.reviewProgress.nextPage+1,p.reviewProgress.pageCount):1;
      return send(`请先完整查看草稿，尚未执行：/channel-review ${id} ${page}`);
    }
    const binding=JSON.stringify(p.resume),action=p.action;
    const record={proposalId:id,at:this.now(),status:'executing',receiptHash:step.receiptHash,selection:step.selection,target:step.target};
    source.steps=[...(source.steps||[]),record];source.status='executing';p.status='executing';
    // Persist the execution marker before starting a potentially destructive
    // child. A failed disk write or interrupted process must never be replayed.
    await this.save();
    if(!live()||p.action!==action||source.action!==action||JSON.stringify(p.resume)!==binding||receiptHash(source.result)!==step.receiptHash){p.status='canceled';source.status='canceled';record.status='canceled';await this.save();return;}
    let result;try{result=await this.run(step.args);}catch{
      p.status='uncertain';source.status='uncertain';record.status='uncertain';await this.save();
      if(live())return send('这一步没有拿到明确回执，操作可能已经生效；已停止续接，不会重复执行。请先在目标频道核对。');return;
    }
    p.result=result;record.result=result;source.result=result;source.updatedAt=this.now();
    const isWaiting=result?.success===true&&result.data?.status==='waiting'&&completePage(result)&&result.data.id===step.sessionId&&receiptHash(result)!==step.receiptHash;
    const isDone=result?.success===true&&result.data?.status==='done'&&completePage(result)&&typeof result.data.result?.success==='boolean'
      &&(!result.data.id||result.data.id===step.sessionId);
    if(!isWaiting&&!isDone){p.status='uncertain';source.status='uncertain';record.status='uncertain';await this.save();if(live())return send('这一步没有返回可确认的进展，可能已有部分操作生效；回执已保留，不会重做。');return;}
    const success=!(isDone&&result.data.result?.success===false);
    record.status=success?'applied':'failed';p.status=success?'completed':'failed';source.status=isWaiting?'waiting':success?'completed':'failed';
    if(!live()&&source.status==='waiting')source.status='canceled';
    await this.save();
    if(live())return send(isWaiting?waitingSummary(source,p.resume.sourceId):success?'频道操作已完成。':'频道操作返回失败；已保存实际回执，之前的步骤不会重做。');
  }
  async beginShortcut(e,command,parameters,args,trace,send,valid=()=>true){
    validateShortcutRequest(command.name,parameters);
    const key=scope(e),epoch=this.epochs.get(key)||0,owner=this.getOwner();
    const live=()=>valid()&&(this.epochs.get(key)||0)===epoch&&this.owner(e)&&this.getOwner()===owner;
    if(!live())return;
    const id=randomUUID().replaceAll('-','').slice(0,12);
    const imageRequest=Object.hasOwn(parameters,'image-ids');
    const p={scope:key,owner,action:command.name,parameters:structuredClone(parameters),requestHash:shortcutRequestHash(parameters),status:imageRequest?'preparing_media':'executing',at:this.now(),requestText:String(e.content||''),steps:[]};
    this.state.proposals[id]=p;await this.save();
    if(!live()){p.status='canceled';await this.save();return;}
    let result;
    if(imageRequest){
      const preparing={submitted:false};this.mediaPreparing.set(id,preparing);
      const current=()=>live()&&['preparing_media','executing'].includes(p.status)&&p.requestHash===shortcutRequestHash(p.parameters);
      try{
        p.mediaBinding=await this.media.bind(e,p.action,p.parameters,trace,current);
        await this.media.stageLease(e,p.action,p.parameters,p.mediaBinding,async lease=>{p.mediaLease=lease;p.mediaLeaseHash=shortcutRequestHash(lease);await this.save();},current);
        if(!current())throw Error('channel_media_canceled');p.status='executing';await this.save();
        const images=await this.media.verifyLease(e,p.action,p.parameters,p.mediaBinding,p.mediaLease,current);
        if(!current())throw Error('channel_media_canceled');preparing.submitted=true;
        result=await this.run([...args,...images],{timeoutMs:120000});
      }catch{
        p.status=preparing.submitted?'uncertain':'canceled';await this.releaseShortcutMedia(p);await this.save();
        if(live())return send(preparing.submitted?'图文快捷流程没有拿到明确回执，已保留状态，不会重放请求。':'这次图片准备已停止，没有提交到频道；请重新核对原图和正文。');return;
      }finally{this.mediaPreparing.delete(id);}
    }else try{result=await this.run(args);}catch{p.status='uncertain';await this.save();if(live())return send('频道快捷流程没有拿到明确回执，已保存状态，不会重复执行。');return;}
    p.result=result;p.updatedAt=this.now();Object.assign(p,classifyShortcutResult(p,result));
    if(!live()&&p.status==='waiting')p.status='canceled';
    if(p.mediaLease&&p.status==='waiting')try{channelShortcutStep(p,{kind:'pick',value:0});}catch{p.status='uncertain';}
    if(p.status!=='waiting')await this.releaseShortcutMedia(p);
    if(live())this.state.sessions[key]={at:this.now(),trace:[...trace,{action:p.action,parameters:p.parameters,result}].slice(-6),publicFeedIds:[]};
    await this.save();
    if(live())return send(p.status==='waiting'?waitingSummary(p,id):p.status==='failed'?'频道快捷流程返回失败，尚未完成。':'频道快捷流程未返回预期的选择步骤，目前无法确认结果。回执已保留，不会重放请求。');
  }
  async prepareShortcutResume(e,sourceId,selection,send,valid=()=>true){
    const source=this.state.proposals[sourceId],key=scope(e),epoch=this.epochs.get(key)||0;
    if(!this.owner(e)||!source||source.scope!==key||source.owner!==this.getOwner()||source.status!=='waiting'||this.now()-(source.updatedAt||source.at)>30*60_000)return send(resumeUnavailable);
    let step;try{step=channelShortcutStep(source,selection);}catch{if(source.mediaLease){source.status='canceled';await this.releaseShortcutMedia(source);await this.save();}return send(waitingSummary(source,sourceId));}
    if(!valid()||(this.epochs.get(key)||0)!==epoch)return;
    for(const p of Object.values(this.state.proposals))if(p.resume?.sourceId===sourceId&&p.status==='pending')p.status='canceled';
    const id=randomUUID().replaceAll('-','').slice(0,12);
    this.state.proposals[id]={scope:key,owner:this.getOwner(),action:source.action,parameters:{},status:'pending',at:this.now(),resume:{sourceId,...step}};
    if(step.effect==='write')this.state.proposals[id].reviewProgress=channelReviewProgress(step.review);
    await this.save();
    if(!valid()||(this.epochs.get(key)||0)!==epoch)return;
    if(step.effect==='read')return this.executeShortcutResume(e,id,send,valid);
    return this.sendShortcutReview(e,id,1,send,valid);
  }
  async sendShortcutReview(e,id,page,send,valid=()=>true){
    return this.sendChannelReview(e,id,page,send,valid);
  }
  atomicReviewMatches(p,command,e){
    return Boolean(command&&command.name===p.action&&p.atomicReview&&this.joinFlow.validateProposal(p,e)&&JSON.stringify(p.atomicReview)===JSON.stringify(channelAtomicReview(command,p.parameters,p.mediaBinding)));
  }
  async sendChannelReview(e,id,page,send,valid=()=>true){
    const p=this.state.proposals[id],source=this.state.proposals[p?.resume?.sourceId],key=scope(e),epoch=this.epochs.get(key)||0;
    if(!this.owner(e)||!p||p.owner!==this.getOwner()||p.scope!==key||p.status!=='pending'||this.now()-p.at>30*60_000)return send(resumeUnavailable);
    let reviewText,bound;
    if(p.resume){
      if(!source||source.owner!==this.getOwner()||source.scope!==key||source.status!=='waiting'||this.now()-(source.updatedAt||source.at)>30*60_000)return send(resumeUnavailable);
      const savedStep=Object.fromEntries(Object.entries(p.resume).filter(([name])=>name!=='sourceId'));
      bound=()=>{try{const shortcut=isChannelShortcut(source.action),step=shortcut?channelShortcutStep(source,p.resume.selection):channelResumeStep(source,p.resume.selection);return p.action===source.action&&source.status==='waiting'&&(!shortcut||step.effect==='write')&&JSON.stringify(step)===JSON.stringify(savedStep);}catch{return false;}};
      reviewText=p.resume.review;
    }else{
      const command=this.commands.find(c=>c.name===p.action);
      if(!command||unsupportedCommands.has(p.action)||isChannelShortcut(p.action))return send(resumeUnavailable);
      try{this.invocation(command,p.parameters);}catch{return send(resumeUnavailable);}
      bound=()=>this.atomicReviewMatches(p,command,e);
      reviewText=p.atomicReview?.text;
    }
    const progress=p.reviewProgress;
    if(!bound()||!channelReviewProgressValid(progress,reviewText))return send('草稿内容或目标已变化，请重新提出操作并审阅，旧草稿没有执行。');
    if(!Number.isSafeInteger(page)||page<1||page>progress.pageCount||page>progress.nextPage+1)return send(`请先完整查看第 ${Math.min(progress.nextPage+1,progress.pageCount)} 页：/channel-review ${id} ${Math.min(progress.nextPage+1,progress.pageCount)}`);
    const live=()=>valid()&&(this.epochs.get(key)||0)===epoch&&p.status==='pending'&&p.owner===this.getOwner()&&this.owner(e)&&bound();
    if(!live())return;
    const text=channelReviewPageText(reviewText,id,page,{continuation:Boolean(p.resume)});
    const delivery=await send(text);
    if(!live())return;
    if(!channelReviewDelivered(delivery,text))return send(`这一页还没有完整送达确认，暂不能执行。请重看本页：/channel-review ${id} ${page}`);
    if(page<=progress.nextPage)return;
    this.reviewWrites.add(id);p.reviewProgress={...progress,nextPage:page,lastDeliveredAt:this.now()};
    try{await this.save();}catch(error){p.reviewProgress=progress;throw error;}finally{this.reviewWrites.delete(id);}
  }
  async executeShortcutResume(e,id,send,valid=()=>true){
    await this.expireShortcutMedia();
    const p=this.state.proposals[id],source=this.state.proposals[p?.resume?.sourceId],key=scope(e),epoch=this.epochs.get(key)||0;
    if(!this.owner(e)||!p||!source||p.owner!==this.getOwner()||source.owner!==this.getOwner()||p.scope!==key||source.scope!==key||p.status!=='pending'||source.status!=='waiting'||this.now()-p.at>30*60_000||this.now()-(source.updatedAt||source.at)>30*60_000)return send(resumeUnavailable);
    let step;try{step=channelShortcutStep(source,p.resume.selection);}catch{p.status='canceled';if(source.mediaLease){source.status='canceled';await this.releaseShortcutMedia(source);}await this.save();return send(resumeUnavailable);}
    if(JSON.stringify(step)!==JSON.stringify(Object.fromEntries(Object.entries(p.resume).filter(([name])=>name!=='sourceId')))){p.status='canceled';if(source.mediaLease){source.status='canceled';await this.releaseShortcutMedia(source);}await this.save();return send('原回执、正文或目标已变化，旧草稿没有执行。');}
    if(step.effect==='write'&&String(e.content||'').trim()!=='/channel-confirm '+id)return send('请先确认已经展示的具体目标和正文，尚未执行写入。');
    if(step.effect==='write'&&(this.reviewWrites.has(id)||!p.reviewProgress||p.reviewProgress.hash!==shortcutRequestHash(step.review)||p.reviewProgress.pageCount!==channelShortcutReviewPages(step).length||p.reviewProgress.nextPage!==p.reviewProgress.pageCount))return send(`请先完整查看草稿，尚未执行：/channel-review ${id} ${(p.reviewProgress?.nextPage||0)+1}`);
    const live=()=>valid()&&(this.epochs.get(key)||0)===epoch&&this.owner(e)&&p.owner===this.getOwner();
    if(!live())return;
    let preparing;
    if(source.mediaLease){
      preparing={submitted:false};this.mediaPreparing.set(id,preparing);this.mediaPreparing.set(p.resume.sourceId,preparing);p.status='preparing_media';
      const current=()=>live()&&p.status==='preparing_media'&&source.status==='waiting'&&!source.mediaLeaseState;
      try{
        await this.save();await this.media.verifyLease(e,source.action,source.parameters,source.mediaBinding,source.mediaLease,current);
        if(JSON.stringify(channelShortcutStep(source,p.resume.selection))!==JSON.stringify(step)||!current())throw Error('channel_media_changed');
      }catch{
        source.status=p.status='canceled';await this.releaseShortcutMedia(source);await this.save();this.mediaPreparing.delete(id);this.mediaPreparing.delete(p.resume.sourceId);
        if(live())return send('原图、正文或图片暂存已变化，这次没有继续提交；请重新指定图片和目标。');return;
      }
    }
    const record={proposalId:id,at:this.now(),status:'executing',receiptHash:step.receiptHash,receiptStep:step.receiptStep,requestHash:step.requestHash,selection:step.selection,target:step.target,effect:step.effect};
    source.steps=[...(source.steps||[]),record];source.status='executing';p.status='executing';
    try{await this.save();}catch(error){
      if(source.mediaLease){source.status=p.status=record.status='canceled';try{await this.releaseShortcutMedia(source);}finally{this.mediaPreparing.delete(id);this.mediaPreparing.delete(p.resume.sourceId);}}
      throw error;
    }
    if(!live()){source.status=p.status=record.status='uncertain';await this.releaseShortcutMedia(source);await this.save();this.mediaPreparing.delete(id);this.mediaPreparing.delete(p.resume.sourceId);return;}
    let result;try{
      if(source.mediaLease){
        const current=()=>{
          if(!live()||p.status!=='executing'||source.status!=='executing')return false;
          try{return JSON.stringify(channelShortcutStep({...source,status:'waiting',steps:source.steps.filter(s=>s!==record)},p.resume.selection))===JSON.stringify(step)&&JSON.stringify(p.resume)===JSON.stringify({sourceId:p.resume.sourceId,...step});}catch{return false;}
        };
        await this.media.verifyLease(e,source.action,source.parameters,source.mediaBinding,source.mediaLease,current);if(!current())throw Error('channel_media_canceled');preparing.submitted=true;
      }
      result=await this.run(step.args,source.mediaLease?{timeoutMs:120000}:undefined);
    }catch{
      source.status=p.status=record.status=preparing&&!preparing.submitted?'canceled':'uncertain';await this.releaseShortcutMedia(source);await this.save();
      if(live())return send(preparing&&!preparing.submitted?'图片核验已失效，这次没有继续提交。':'这一步没有拿到明确回执，可能已有部分操作生效；已保存状态，不会重复执行。');return;
    }finally{this.mediaPreparing.delete(id);this.mediaPreparing.delete(p.resume.sourceId);}
    source.result=p.result=record.result=result;source.updatedAt=this.now();
    const outcome=classifyShortcutResult(source,result,step);Object.assign(source,outcome);
    record.status=outcome.status==='waiting'||outcome.status==='completed'?'applied':outcome.status;
    p.status=record.status==='applied'?'completed':record.status;
    if(!live()&&source.status==='waiting')source.status='canceled';
    if(source.mediaLease&&source.status==='waiting')try{channelShortcutStep(source,{kind:'pick',value:0});}catch{source.status='uncertain';}
    if(source.status!=='waiting')await this.releaseShortcutMedia(source);
    if(live()&&source.status==='completed'&&isChannelReadShortcut(source.action)){
      const old=this.state.sessions[key];this.state.sessions[key]={at:this.now(),trace:[...(old?.trace||[]),{action:source.action,parameters:source.parameters,result}].slice(-6),publicFeedIds:[]};
    }
    await this.save();if(!live())return;
    if(source.status==='waiting')return send(waitingSummary(source,p.resume.sourceId));
    if(source.status==='completed'&&isChannelReadShortcut(source.action))return this.summarizeShortcut(source,step,send,live);
    return send(source.status==='completed'?'频道操作已完成。':source.status==='failed'?'频道操作返回失败；之前完成的步骤不会重做。':'这一步未返回可确认的完成结果，实际回执已保留，不会重复执行。');
  }
  async summarizeShortcut(source,step,send,valid){
    const result=source.result,feeds=result.data.result.feeds;
    if(!feeds.length)return send(`「${step.target.label}」暂时没有这类帖子。`);
    let plan;try{plan=await this.generate({mode:'channel',structured:true,text:source.requestText+'\n已选定频道「'+step.target.label+'」，请根据现有详情直接总结并 finish，不再调用工具。',channelCommands:[],channelTrace:[{action:source.action,parameters:source.parameters,result}],channelOwner:true});}catch{}
    if(!valid())return;
    if(plan?.action==='finish'&&typeof plan.reply==='string'&&plan.reply.trim())return send(plan.reply);
    return send(feeds.map(({feed},i)=>`${i+1}. ${String(feed.title||'无标题').slice(0,120)}\n${String(feed.content||'').slice(0,350)}${feed.share_url?'\n'+feed.share_url:''}`).join('\n\n'));
  }
  start(e,send){
    if(!this.accepts(e))return false;
    const key=scope(e),id=hash(key+':'+e.id),epoch=this.epochs.get(key)||0;
    const valid=()=>epoch===(this.epochs.get(key)||0);
    if(this.state.completed.includes(id))return true;
    const cancel=String(e.content||'').trim().match(/^\/channel-cancel\s+([a-f0-9]{12})$/),proposal=cancel&&this.state.proposals[cancel[1]],preparing=cancel&&this.mediaPreparing.get(cancel[1]);
    if(cancel&&proposal?.joinVerification&&['verification_required','verification_reserved','verification_unknown'].includes(proposal.status)&&this.owner(e)&&proposal.owner===this.getOwner()&&proposal.scope===key){
      const job=this.joinFlow.handle(e,send,valid).catch(()=>{});this.jobs.add(job);void job.finally(()=>this.jobs.delete(job));return true;
    }
    // Cancellation must not wait behind a slow image download in this scope's
    // serial queue. Once the runner is entered its result may be uncertain.
    if(preparing&&this.owner(e)&&proposal?.owner===this.getOwner()&&proposal.scope===key){
      const beforeSubmission=!preparing.submitted;
      if(beforeSubmission)proposal.status='canceled';
      const job=(beforeSubmission?this.save():Promise.resolve()).then(()=>valid()&&this.owner(e)?send(beforeSubmission?'这次图片发布已取消，没有提交到频道。':'图片发布请求已经开始执行，本地取消不能确认撤回；我会按实际回执告诉你结果。'):undefined).catch(()=>{});
      this.jobs.add(job);void job.finally(()=>this.jobs.delete(job));return true;
    }
    const job=(this.tails.get(key)||Promise.resolve()).catch(()=>{}).then(async()=>{
      if(this.state.completed.includes(id)||!valid())return;
      let sent=false;
      const reply=async text=>{if(!valid())return;const result=await send(text);sent=true;return result;};
      const proposalId=String(e.content||'').trim().match(/^\/channel-confirm\s+([a-f0-9]{12})$/)?.[1];
      const timer=setTimeout(()=>{if(!sent&&(!proposalId||this.state.proposals[proposalId]?.status!=='canceled'))void reply('我去频道里看看，找到后接着说。').catch(()=>{});},5000);
      try{await this.process(e,reply,valid);if(valid()){this.state.completed=[...this.state.completed,id].slice(-500);await this.save();}}
      catch{await reply('频道查询这次没完成，刚才的聊天不受影响。可以稍后让我接着查。').catch(()=>{});}
      finally{clearTimeout(timer);}
    });
    this.tails.set(key,job);this.jobs.add(job);void job.finally(()=>{this.jobs.delete(job);if(this.tails.get(key)===job)this.tails.delete(key);});return true;
  }
  async process(e,send,valid=()=>true){
    await this.expireShortcutMedia();
    const text=String(e.content||'').trim(),key=scope(e),isOwner=this.owner(e);
    if(await this.joinFlow.handle(e,send,valid))return;
    const review=text.match(reviewCommand);
    if(review)return this.sendChannelReview(e,review[1],Number(review[2]),send,valid);
    if(/^\/channel-review(?:\s|$)/.test(text))return send('请使用当前草稿中的页码命令查看完整正文，尚未执行写入。');
    const resume=text.match(resumeCommand);
    if(resume)return this.prepareResume(e,resume[1],{kind:resume[2],value:resume[3]},send,valid);
    if(/^\/channel-resume(?:\s|$)/.test(text))return send('请使用当前回执提供的续接格式，填写具体序号或秒数；未执行后续操作。');
    const confirm=text.match(/^\/channel-(confirm|cancel)\s+([a-f0-9]{12})$/);
    if(confirm){
      const p=this.state.proposals[confirm[2]];
      if(!isOwner||!p||p.scope!==key||p.owner!==this.getOwner())return send('没有找到这次会话的频道操作草稿。');
      if(confirm[1]==='cancel'&&['pending','waiting','preparing_media'].includes(p.status)){
        p.status='canceled';for(const child of Object.values(this.state.proposals))if(child.resume?.sourceId===confirm[2]&&child.status==='pending')child.status='canceled';
        const source=p.resume?this.state.proposals[p.resume.sourceId]:p;
        if(source?.mediaLease){source.status='canceled';await this.releaseShortcutMedia(source);}
        await this.save();return send('后续频道操作已取消，已经执行的步骤不会撤回或重做。');
      }
      if(unsupportedCommands.has(p.action)){p.status='unsupported';await this.save();return send(unsupportedMessage);}
      if(p.status==='waiting')return send(waitingSummary(p,confirm[2]));
      if(p.status==='unsupported')return send(unsupportedMessage);
      if(p.status!=='pending'||this.now()-p.at>30*60_000)return send('这份操作草稿已处理或过期，不会重复执行。');
      if(p.resume)return this.executeResume(e,confirm[2],send,valid);
      if(isChannelShortcut(p.action)){p.status='uncertain';await this.save();return send('这份旧快捷草稿没有可核验的选择步骤，未执行；请重新定位目标。');}
      const cmd=this.commands.find(x=>x.name===p.action);
      if(!cmd||unsupportedCommands.has(cmd.name)){p.status='unsupported';await this.save();return send(unsupportedMessage);}
      let invocation;try{invocation=this.invocation(cmd,p.parameters);}catch{p.status='canceled';await this.save();return send('草稿参数不完整或格式已变化，未执行；请补齐设置后重新审阅。');}
      if(Object.hasOwn(p.parameters,'image-ids')&&!this.media?.matches(e,cmd.name,p.parameters,p.mediaBinding)){
        p.status='canceled';await this.save();return send('图片草稿的内容核验已失效，请重新指定图片和发布目标。');
      }
      const executionEpoch=this.epochs.get(key)||0,executionOwner=this.getOwner();
      if(!valid())return;
      // Old pending drafts predate proof of complete delivery. The first
      // confirmation only prepares their review; it cannot authorize a write.
      if(!p.atomicReview){
        p.atomicReview=channelAtomicReview(cmd,p.parameters,p.mediaBinding);p.reviewProgress=channelReviewProgress(p.atomicReview.text);
        await this.save();
        if(!valid()||(this.epochs.get(key)||0)!==executionEpoch||this.getOwner()!==executionOwner)return;
        return this.sendChannelReview(e,confirm[2],1,send,valid);
      }
      if(!this.atomicReviewMatches(p,cmd,e)){
        p.status='canceled';await this.save();return send('原操作、正文或目标已变化，旧草稿没有执行，请重新提出操作并审阅。');
      }
      const progress=p.reviewProgress;
      if(this.reviewWrites.has(confirm[2])||!channelReviewProgressValid(progress,p.atomicReview.text)||progress.nextPage!==progress.pageCount){
        const page=channelReviewProgressValid(progress,p.atomicReview.text)?Math.min(progress.nextPage+1,progress.pageCount):1;
        return send(`请先完整查看草稿，尚未执行：/channel-review ${confirm[2]} ${page}`);
      }
      let result;
      const current=()=>valid()&&(this.epochs.get(key)||0)===executionEpoch&&this.getOwner()===executionOwner&&this.owner(e)&&this.atomicReviewMatches(p,cmd,e);
      if(p.mediaBinding){
        const preparing={submitted:false};this.mediaPreparing.set(confirm[2],preparing);p.status='preparing_media';
        const mediaCurrent=()=>current()&&['preparing_media','executing'].includes(p.status)&&this.media.matches(e,cmd.name,p.parameters,p.mediaBinding);
        try{
          await this.save();
          const outcome=await this.media.withFiles(e,cmd.name,p.parameters,p.mediaBinding,async(extraArgs,options)=>{
            if(!mediaCurrent())throw Error('channel_media_canceled');
            p.status='executing';await this.save();
            if(!mediaCurrent())throw Error('channel_media_canceled');
            preparing.submitted=true;
            return this.run([...invocation.args,...extraArgs,'--yes'],{...options,stdin:invocation.stdin});
          },mediaCurrent);
          result=outcome.result;if(outcome.cleanupPending)p.mediaCleanupPending=outcome.cleanup;
        }catch(error){
          const cancellationAlreadyHandled=p.status==='canceled';
          p.status=preparing.submitted?'uncertain':'canceled';if(error.channelMediaCleanup)p.mediaCleanupPending=error.channelMediaCleanup;await this.save();
          if(!cancellationAlreadyHandled&&current())return send(preparing.submitted?'图片发布没有拿到明确回执，请先查目标帖子；不会自动重发。':'图片准备已停止，没有提交到频道；请重新核对图片或目标。');return;
        }finally{this.mediaPreparing.delete(confirm[2]);}
      }else{
        p.status='executing';await this.save();
        if(!current()){p.status='canceled';await this.save();return;}
        try{result=await this.run([...invocation.args,'--yes'],{stdin:invocation.stdin});}catch{p.status='uncertain';await this.save();return send('这次操作没有拿到明确回执，先不要重复发送；需要查目标频道确认是否已经生效。');}
      }
      p.result=result;
      if(await this.joinFlow.capture(p,confirm[2],result,e,send,current))return;
      if(!result||typeof result.success!=='boolean'||p.mediaBinding&&result.success===true&&!completePage(result)){
        p.status='uncertain';await this.save();if(current())return send('这次操作的回执不完整，实际结果还不能确认；已保留记录，不会自动重复提交。');return;
      }
      // Shortcut success means the CLI call succeeded, not that all of its
      // destructive steps finished. Retain its actual continuation receipt;
      // never execute a model-supplied resume ID or a returned shell command.
      if(result.success===true&&result.data?.status==='waiting'){
        p.status=valid()?'waiting':'canceled';p.updatedAt=this.now();await this.save();if(valid())return send(waitingSummary(p,confirm[2]));return;
      }
      if(result.success===true&&cmd.flags.some(f=>f.name==='resume-id')&&(result.data?.status!=='done'||!completePage(result)||typeof result.data?.result?.success!=='boolean')){
        p.status='uncertain';await this.save();return send('频道快捷操作没有返回明确完成状态，回执已保留；不会重复执行，请在本机核对这项操作。');
      }
      const success=result.success===true&&!(result.data?.status==='done'&&result.data.result?.success===false);
      p.status=success?'completed':'failed';await this.save();
      return send(success?'频道操作已成功执行。':'频道操作未成功：'+String(result.error?.message||result.data?.result?.error?.message||result.message||'平台未返回成功').slice(0,400));
    }
    if(!e.group_openid&&!isOwner)return;
    if(isOwner&&/^(?:(?:请|帮我|给我)\s*){0,3}(?:开启|打开|订阅|关闭|取消|停止)(?:腾讯|QQ)?频道(?:自动|消息|的)?(?:通知|推送)[吧。！!？?\s]*$/i.test(text))return send(unsupportedMessage);
    const available=this.commands.filter(c=>!unsupportedCommands.has(c.name)&&(isOwner||publicCommands.has(c.name))&&!c.flags.some(f=>f.required&&blockedFlag(f.name))).map(c=>channelJoinSettingsCommand({...c,flags:[...c.flags.filter(f=>!blockedFlag(f.name)&&!(c.flags.some(x=>x.name==='resume-id')&&['pick','set','time-stamp'].includes(f.name))),...(isOwner&&this.media&&channelMediaActions.has(c.name)?[channelMediaFlag]:[])]}));
    const old=this.state.sessions[key],fresh=old&&this.now()-old.at<15*60_000,trace=fresh?old.trace.slice(-6):[];
    const publicFeedIds=new Set(fresh?(old.publicFeedIds||[]):[]);
    const session=()=>({at:this.now(),trace:trace.slice(-6),publicFeedIds:[...publicFeedIds].slice(-100)});
    for(let step=0;step<5;step++){
      const plan=await this.generate({mode:'channel',structured:true,text,channelCommands:available,channelTrace:trace,channelOwner:isOwner,channelMediaCatalog:isOwner&&this.media?this.media.catalog(e):[]});
      if(!valid())return;
      if(plan.action==='finish'){await send(plan.reply||'这次没有找到可用的频道结果。');this.state.sessions[key]=session();await this.save();return;}
      if(unsupportedCommands.has(plan.action))return send(unsupportedMessage);
      const command=available.find(c=>c.name===plan.action);
      if(!command){trace.push({error:'Unsupported action; explain available scope and finish.'});continue;}
      let parameters,args;try{parameters=JSON.parse(plan.parameters_json);args=this.invocation(command,parameters).args;}catch{trace.push({action:plan.action,error:'Invalid or unsupported parameters; use listed flags and documented stdin_parameters. Advanced join settings require the complete setting object; ask the owner for missing questions, answers or thresholds.'});continue;}
      if(hasChannelJoinAnswers(command.name,parameters)){trace.push({action:command.name,error:'Join answers must come from the current owner reply to the actual saved verification questions. Finish and ask the owner to answer that pending verification; do not invent or bypass its receipt.'});continue;}
      if(!isOwner && command.name!=='manage.search-guild-content' && !groupChannelParametersAllowed(command.name,parameters,trace,publicFeedIds)){trace.push({error:'Group reads require a public feed from this conversation. Comment paging requires the latest complete result for the same feed and rank; never invent a cursor or advance past omitted content.'});continue;}
      if(isChannelShortcut(command.name)){
        if(!isOwner)return send('这类频道选择涉及账号列表，请在已配对的主人私聊中提出。');
        const evidence=JSON.stringify(trace);
        if(parameters['guild-id']&&!evidence.includes(JSON.stringify(parameters['guild-id']))&&!text.includes(parameters['guild-id'])){trace.push({error:'Resolve the actual guild before starting this shortcut.'});continue;}
        try{validateShortcutRequest(command.name,parameters);}catch{trace.push({error:'Shortcut requires a complete body/title or query and a bounded count. Ask for missing user input; do not fabricate it.'});continue;}
        return this.beginShortcut(e,command,parameters,args,trace,send,valid);
      }
      if(command.risk!=='read'){
        if(!isOwner)return send('账号发帖与管理操作请在已配对的主人私聊中提出。');
        if(command.name==='feed.publish-feed'&&(!parameters['guild-id']||!parameters['channel-id'])){trace.push({error:'A specific guild and channel are required. Ask the user for the destination; global publishing is not enabled.'});continue;}
        const evidence=JSON.stringify(trace);
        if(Object.entries(parameters).some(([k,v])=>/(?:-id|tiny-id)$/.test(k)&&!evidence.includes(JSON.stringify(String(v)))&&!text.includes(String(v)))){trace.push({error:'Resolve target IDs from actual tool results before proposing a write.'});continue;}
        let mediaBinding=null;
        if(Object.hasOwn(parameters,'image-ids')){
          const mediaOwner=this.getOwner(),mediaEpoch=this.epochs.get(key)||0;
          try{mediaBinding=await this.media.bind(e,command.name,parameters,trace,()=>valid()&&this.owner(e)&&this.getOwner()===mediaOwner&&(this.epochs.get(key)||0)===mediaEpoch);}
          catch{if(!valid()||!this.owner(e))return;trace.push({action:command.name,error:'Image preparation failed or the IDs, count, scope or original post type are invalid. Use only the private media catalog; read the exact original post type before editing. Ask for a fresh image if unavailable; do not invent a path or pretend to publish.'});continue;}
          if(!valid()||!this.owner(e)||this.getOwner()!==mediaOwner||(this.epochs.get(key)||0)!==mediaEpoch)return;
        }
        const id=randomUUID().replaceAll('-','').slice(0,12);
        const atomicReview=channelAtomicReview(command,parameters,mediaBinding);
        this.state.proposals[id]={scope:key,owner:this.getOwner(),action:command.name,parameters:structuredClone(parameters),...(mediaBinding?{mediaBinding}:{}),status:'pending',at:this.now(),atomicReview,reviewProgress:channelReviewProgress(atomicReview.text)};await this.save();
        return this.sendChannelReview(e,id,1,send,valid);
      }
      const result=await this.run(args);if(!valid())return;trace.push({action:command.name,parameters,result});
      if(command.name==='manage.search-guild-content'&&result.success===true)for(const feed of result.data?.feeds||[])if(feed.feed_id)publicFeedIds.add(String(feed.feed_id));
      this.state.sessions[key]=session();await this.save();
    }
    return send('已查到一些频道资料，但这次还没整理完。可以说“继续看”，我会沿着刚才的结果接着查。');
  }
  async stop(){clearInterval(this.leaseTimer);await Promise.allSettled([...this.jobs]);await this.writes;}
}
