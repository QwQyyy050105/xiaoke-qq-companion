import {createHash,randomUUID} from 'node:crypto';
import {channelAtomicReview,channelReviewProgress,channelReviewProgressValid,channelReviewPages,channelReviewDelivered} from './channel_review.mjs';

const hash=value=>createHash('sha256').update(JSON.stringify(value??null)).digest('hex');
const author=e=>e.group_openid?e.author?.member_openid||e.author?.id:e.author?.user_openid||e.author?.id;
const scope=e=>hash([e.group_openid||'private',e.group_openid?'':author(e)]);
const plain=value=>value&&typeof value==='object'&&!Array.isArray(value);
const text=value=>typeof value==='string'&&value.trim()&&value.length<=10000&&!/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value);
const activeStatuses=new Set(['verification_required','verification_reserved','verification_unknown']);
const answerCommand=/^\/channel-join-answer\s+([a-f0-9]{12})\s+([\s\S]+)$/;
export const hasChannelJoinAnswers=(action,parameters)=>action==='manage.join-guild'&&plain(parameters)&&('join_guild_comment'in parameters||'join_guild_answers'in parameters);

export function channelJoinNeedsVerification(result){
  const visit=(value,depth=0)=>{
    if(depth>12||!value||typeof value!=='object')return false;
    return Object.entries(value).some(([key,item])=>key==='need_verification'&&(item===true||plain(item))
      ||['status','state','code','type'].includes(key)&&item==='need_verification'||visit(item,depth+1));
  };
  return visit(result);
}

export function channelJoinVerification(result){
  if(!channelJoinNeedsVerification(result)||result.truncated||result._projection?.truncated)return null;
  const data=result.data;if(!plain(data))return null;
  // Only known setting fields are interpreted. An unfamiliar reply remains
  // unfinished rather than having questions or a successful membership made up.
  const setting=data.setting??data.join_setting??data;
  if(!plain(setting))return null;
  const rawType=setting.joinType??setting.join_type??data.joinType??data.join_type;
  const types={JOIN_GUILD_TYPE_ADMIN_AUDIT:2,JOIN_GUILD_TYPE_QUESTION_WITH_ADMIN_AUDIT:5,JOIN_GUILD_TYPE_MULTI_QUESTION:6,JOIN_GUILD_TYPE_QUIZ:7};
  const type=typeof rawType==='number'?rawType:types[rawType];
  if(type===2)return {type,kind:'comment',questions:[],review:'这个频道需要管理员审核。请提供你想附在入群申请里的原文；目前还没有加入成功。'};
  if(![4,5,6,7].includes(type))return null;
  const list=type===7?setting.quiz?.items:setting.question?.items;
  if(!Array.isArray(list)||!list.length||list.length>20||([4,5].includes(type)&&list.length!==1))return null;
  const questions=[];
  for(const item of list){
    if(!plain(item))return null;
    const question=item.question??item.title;
    if(!text(question)||(item.question!==undefined&&item.title!==undefined&&item.question!==item.title))return null;
    const q={question};
    if(type===7){if(!Array.isArray(item.answers)||item.answers.length<2||item.answers.length>20||!item.answers.every(text)||new Set(item.answers).size!==item.answers.length)return null;q.options=[...item.answers];}
    questions.push(q);
  }
  const review='这个频道需要先回答验证问题，目前还没有加入成功。请按原顺序提供你的答案：\n'+questions.map((q,i)=>`${i+1}. ${q.question}${q.options?'\n'+q.options.map((option,j)=>`  ${j+1}) ${option}`).join('\n'):''}`).join('\n\n');
  return {type,kind:[4,5].includes(type)?'comment':'answers',questions,review};
}

function answerInput(details,raw){
  if(!plain(raw)||Object.keys(raw).some(k=>!['comment','answers'].includes(k)))throw Error('channel_join_invalid_answer');
  if(details.kind==='comment'){
    if(Object.hasOwn(raw,'answers')||!text(raw.comment))throw Error('channel_join_comment_required');
    return {join_guild_comment:raw.comment};
  }
  if(Object.hasOwn(raw,'comment')||!Array.isArray(raw.answers)||raw.answers.length!==details.questions.length)throw Error('channel_join_answer_count');
  const answers=raw.answers.map((item,index)=>{
    let answer=typeof item==='string'?item:plain(item)&&Object.keys(item).length===1?item.answer:undefined;
    if(!text(answer))throw Error('channel_join_invalid_answer');
    const options=details.questions[index].options;
    if(options&&!options.includes(answer)&&/^[1-9]\d*$/.test(answer)&&Number(answer)<=options.length)answer=options[Number(answer)-1];
    if(details.questions[index].options&&!details.questions[index].options.includes(answer))throw Error('channel_join_answer_not_option');
    return {answer};
  });
  return {join_guild_answers:answers};
}

export class ChannelJoinFlow{
  constructor(service){this.service=service;}
  // Cancellation statuses survive restarts. The saved epoch is diagnostic;
  // only a method's captured current-runtime epoch guards its own awaits.
  sourceLive(source,e){const s=this.service;return Boolean(source&&s.owner(e)&&source.owner===s.getOwner()&&source.scope===scope(e)
    &&s.now()-(source.updatedAt||source.at)<30*60_000&&source.joinVerification);}
  latest(e){return Object.entries(this.service.state.proposals).filter(([,p])=>p.action==='manage.join-guild'&&p.status==='verification_required'&&this.sourceLive(p,e))
    .sort((a,b)=>(b[1].updatedAt||b[1].at)-(a[1].updatedAt||a[1].at))[0];}
  accepts(e){return /^\/channel-join-answer(?:\s|$)/.test(String(e.content||'').trim())||Boolean(this.latest(e)&&!String(e.content||'').trim().startsWith('/'));}
  forget(e){for(const p of Object.values(this.service.state.proposals))if(p.scope===scope(e)&&activeStatuses.has(p.status))p.status='canceled';}
  validateProposal(p,e){
    if(!hasChannelJoinAnswers(p?.action,p?.parameters))return !p?.joinAnswer;
    const binding=p.joinAnswer,source=this.service.state.proposals[binding?.sourceId];
    if(!binding||!this.sourceLive(source,e)||source.status!=='verification_reserved'||source.joinVerification.pendingAnswerId!==binding.proposalId)return false;
    const actual=channelJoinVerification(source.result),review=source.joinVerification;
    return Boolean(actual&&hash(source.result)===binding.receiptHash&&hash(actual)===binding.questionHash
      &&hash(actual)===review.questionHash&&channelReviewProgressValid(review.progress,actual.review)&&review.progress.nextPage===review.progress.pageCount
      &&source.parameters['guild-id']===p.parameters['guild-id']&&binding.payloadHash===hash(p.parameters));
  }
  recordAnswerOutcome(p,id,status,result){
    const source=this.service.state.proposals[p.joinAnswer?.sourceId];
    if(source?.joinVerification?.pendingAnswerId===id)source.joinVerification.answerOutcome={proposalId:id,status,at:this.service.now(),receiptHash:hash(result),membershipConfirmed:false};
  }
  async capture(p,id,result,e,send,valid=()=>true){
    if(p.action!=='manage.join-guild')return false;
    const s=this.service,details=channelJoinVerification(result),epoch=s.epochs.get(scope(e))||0;
    const owner=p.owner,live=()=>valid()&&s.owner(e)&&s.getOwner()===owner&&(s.epochs.get(scope(e))||0)===epoch;
    if(!channelJoinNeedsVerification(result)){
      p.result=result;p.membershipConfirmed=false;
      // A successful submission can still await administrator approval. The
      // CLI request receipt alone is not proof of actual group membership.
      p.status=result?.success===true&&!result.truncated&&!result._projection?.truncated&&result.data?.status!=='waiting'?'completed':result?.success===false?'failed':'uncertain';
      this.recordAnswerOutcome(p,id,p.status,result);await s.save();
      if(live())await send(p.status==='completed'?'入群请求已提交；是否已经加入，还要以频道的审核结果和成员状态为准。':p.status==='failed'?'入群请求没有成功，实际回执已保存；没有自动重复提交。':'没有拿到明确的入群结果，实际回执已保留；请先核对频道，不会重复提交。');
      return true;
    }
    p.result=result;p.updatedAt=s.now();
    p.joinVerification={version:1,epoch,receiptHash:hash(result),questionHash:details?hash(details):null,details,progress:details?channelReviewProgress(details.review):null};
    p.status=live()?(details?'verification_required':'verification_unknown'):'canceled';this.recordAnswerOutcome(p,id,p.status,result);await s.save();
    if(!live()||p.status==='canceled'){p.status='canceled';await s.save();return true;}
    if(!details){await send('频道要求补充入群验证，实际回执已保留，但这次的问题结构还不能可靠读取；目前没有加入成功，也不会编造答案或自动重试。');return true;}
    await this.show(e,id,1,send,valid);return true;
  }
  async show(e,id,page,send,valid=()=>true){
    if(!valid())return;
    const s=this.service,p=s.state.proposals[id],v=p?.joinVerification,details=channelJoinVerification(p?.result),epoch=s.epochs.get(scope(e))||0;
    if(!this.sourceLive(p,e)||p.status!=='verification_required'||!details||v.receiptHash!==hash(p.result)||v.questionHash!==hash(details)||!channelReviewProgressValid(v.progress,details.review))return send('这份验证问题已变化、过期或失效，请重新核对频道，尚未提交答案。');
    const pages=channelReviewPages(details.review),progress=v.progress;
    if(!Number.isInteger(page)||page<1||page>pages.length||page>progress.nextPage+1)return send(`/channel-review ${id} ${Math.min(progress.nextPage+1,pages.length)}`);
    const footer=page<pages.length?`下一页：/channel-review ${id} ${page+1}`:details.kind==='comment'?'下一句直接回复申请附言或答案即可；我会先给你看提交草稿。':`请按 1. 答案、2. 答案的顺序逐行回复，共 ${details.questions.length} 题；我会先给你看提交草稿。`;
    const body=`频道加入验证（${page}/${pages.length}）：\n${pages[page-1]}\n\n${footer}\n精确输入：/channel-join-answer ${id} ${details.kind==='comment'?'{"comment":"你的原文"}':'{"answers":["第一题原文","第二题原文"]}'}\n取消：/channel-cancel ${id}`;
    const receipt=await send(body);
    if(!valid()||(s.epochs.get(scope(e))||0)!==epoch||!this.sourceLive(p,e)||p.status!=='verification_required'||hash(p.result)!==v.receiptHash)return;
    if(!channelReviewDelivered(receipt,body))return send(`验证问题尚未完整送达，请重看：/channel-review ${id} ${page}`);
    if(page>progress.nextPage){s.reviewWrites.add(id);v.progress={...progress,nextPage:page,lastDeliveredAt:s.now()};try{await s.save();}catch(error){v.progress=progress;throw error;}finally{s.reviewWrites.delete(id);}}
  }
  async prepare(e,id,raw,send,valid=()=>true){
    if(!valid())return;
    const s=this.service,source=s.state.proposals[id],v=source?.joinVerification,details=channelJoinVerification(source?.result),epoch=s.epochs.get(scope(e))||0;
    if(!this.sourceLive(source,e)||source.status!=='verification_required'||!details||v.receiptHash!==hash(source.result)||v.questionHash!==hash(details))return send('没有找到当前会话可继续的入群验证，未提交答案。');
    if(s.reviewWrites.has(id)||!channelReviewProgressValid(v.progress,details.review)||v.progress.nextPage!==v.progress.pageCount)return send(`请先完整看完实际问题：/channel-review ${id} ${Math.min((v.progress?.nextPage||0)+1,v.progress?.pageCount||1)}`);
    let answer;try{answer=answerInput(details,raw);}catch{return send(details.kind==='comment'?'请提供一条完整的申请附言或答案原文。':'答案数量或选项不匹配，请按题目原顺序填写；选择题请使用完整选项文字。');}
    const parameters={'guild-id':source.parameters['guild-id'],...answer},command=s.commands.find(c=>c.name==='manage.join-guild');
    const proposalId=randomUUID().replaceAll('-','').slice(0,12),atomicReview=channelAtomicReview(command,parameters);
    s.state.proposals[proposalId]={scope:scope(e),owner:s.getOwner(),action:'manage.join-guild',parameters,status:'pending',at:s.now(),atomicReview,reviewProgress:channelReviewProgress(atomicReview.text),
      joinAnswer:{sourceId:id,proposalId,receiptHash:v.receiptHash,questionHash:v.questionHash,payloadHash:hash(parameters)}};
    source.status='verification_reserved';v.pendingAnswerId=proposalId;await s.save();
    if(!valid()||(s.epochs.get(scope(e))||0)!==epoch||!this.validateProposal(s.state.proposals[proposalId],e))return;
    return s.sendChannelReview(e,proposalId,1,send,valid);
  }
  async handle(e,send,valid=()=>true){
    if(!valid())return true;
    const s=this.service,content=String(e.content||'').trim(),review=content.match(/^\/channel-review\s+([a-f0-9]{12})\s+(\d+)$/);
    if(review&&s.state.proposals[review[1]]?.joinVerification){await this.show(e,review[1],Number(review[2]),send,valid);return true;}
    const cancel=content.match(/^\/channel-cancel\s+([a-f0-9]{12})$/),p=cancel&&s.state.proposals[cancel[1]];
    if(p&&activeStatuses.has(p.status)){
      if(!this.sourceLive(p,e)){await send('没有找到当前会话的入群验证。');return true;}
      p.status='canceled';const child=s.state.proposals[p.joinVerification?.pendingAnswerId],mayHaveSubmitted=child&&['executing','completed','uncertain','failed','verification_required','verification_reserved','verification_unknown'].includes(child.status);
      if(child?.status==='pending')child.status='canceled';await s.save();
      await send(mayHaveSubmitted?'已停止后续入群步骤；如果请求已经发出，本地取消不能撤回。已提交请求的实际回执会保留，不会重复发送。':'这次入群验证已取消，尚未提交的答案不会发送。');return true;
    }
    const explicit=content.match(answerCommand);
    if(explicit){let raw;try{raw=JSON.parse(explicit[2]);}catch{await send('答案格式没有读懂，请按刚才的问题直接回复原文，或使用提示里的 JSON 格式。');return true;}await this.prepare(e,explicit[1],raw,send,valid);return true;}
    if(/^\/channel-join-answer(?:\s|$)/.test(content)){await send('请使用当前验证问题下方的答案命令，或按提示直接回复答案原文。');return true;}
    const pending=this.latest(e);if(!pending||!content||content.startsWith('/'))return false;
    const [id,source]=pending,details=source.joinVerification.details;
    if(/^(?:取消|不加了|算了|停止这次入群)[。！!\s]*$/.test(content)){source.status='canceled';await s.save();await send('这次入群验证已取消。');return true;}
    if(details.kind==='comment'){await this.prepare(e,id,{comment:content},send,valid);return true;}
    const lines=content.split(/\r?\n/).map(x=>x.trim()).filter(Boolean),matches=lines.map(x=>x.match(/^(\d+)[.、):：]\s*(.+)$/));
    if(matches.length!==details.questions.length||matches.some((m,i)=>!m||Number(m[1])!==i+1))return false;
    await this.prepare(e,id,{answers:matches.map(m=>m[2])},send,valid);return true;
  }
}
