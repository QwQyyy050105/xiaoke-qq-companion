import {readFile,stat,realpath} from 'node:fs/promises';
import {join,relative,isAbsolute} from 'node:path';
import {resolveCodexExecutable} from './codex_executable.mjs';
import {loadCharacter,characterEditorText} from './character.mjs';
import {prepareConversationInput} from './conversation_input.mjs';
import {readSpeechCapability} from './speech_capability.mjs';
import {residentSpeechStatus} from './reply_speech_route.mjs';
const unavailable=reason=>({available:false,reason});
async function file(path){try{return (await stat(path)).isFile();}catch{return false;}}
async function directory(path){try{return (await stat(path)).isDirectory();}catch{return false;}}
async function approvedReference(root){try{const raw=await readFile(join(root,'assets','media_approved.json'),'utf8');if(raw.length>131072)return false;const rows=JSON.parse(raw).images||[],reference=rows.find(row=>row.type==='avatar'||row.id==='approved_xiao_ke');if(!reference||typeof reference.path!=='string')return false;const base=await realpath(root),program=await realpath(join(base,reference.path)),rel=relative(base,program);return Boolean(rel&&!rel.startsWith('..')&&!isAbsolute(rel)&&await file(program));}catch{return false;}}
async function projectProgram(root,name,key){try{const raw=await readFile(join(root,'runtime',name),'utf8');if(raw.length>32768)return false;const value=JSON.parse(raw),base=await realpath(root),program=await realpath(value[key]),rel=relative(base,program);return Boolean(rel&&!rel.startsWith('..')&&!isAbsolute(rel)&&await file(program));}catch{return false;}}
export async function inspectRuntimeCapabilities(root,config,{findCodex=resolveCodexExecutable,env=process.env}={}){
 let image=unavailable('disabled');
 if(config.media?.imageGeneration===true){try{await findCodex(config);image=!await directory(env.CODEX_HOME||join(root,'runtime','codex_home'))?unavailable('codex_home_missing'):!await approvedReference(root)?unavailable('image_reference_missing'):{available:true,reason:'configured_worker_requires_actual_success'};}catch{image=unavailable('codex_cli_missing');}}
 const math=await projectProgram(root,'math_runtime.json','chromiumPath');
 const channelPath=env.XIAOKE_CHANNEL_CLI||join(root,'runtime','tencent_channel','node_modules','tencent-channel-cli-win32-x64','bin','tencent-channel-cli.exe');
 const channel=(Boolean(env.XIAOKE_CHANNEL_CLI)||process.platform==='win32')&&await file(channelPath);
 return {image_generation:image,math:math?{available:true,reason:'configured_browser_requires_actual_success'}:unavailable('math_browser_missing'),channel:channel?{available:true,reason:'configured_cli_permissions_unverified'}:unavailable('channel_cli_missing'),vision:{available:config.media?.vision===true&&config.modelProvider?.type!=='mock'},tts:{available:config.media?.tts===true}};
}
export function capabilityDescriptions(capabilities={}){
 return {
  media:'QQ图片传输实现可处理PNG/JPEG；GIF/WebP需可选采样器。可按实际目录选择现有图片和语音；没有图像输入就不能声称看清画面，动画只看提供的采样帧。已有语音目录独立判断，动态合成当前能力以speech_status为准，状态只用于选择表达方式。视频解码尚未接入当前模板，不能猜测QQ本身不支持。'+(capabilities.image_generation?.available?'原生生图执行器已配置，可按当前明确请求申请；实际成功前不能声称已生成或已发送。':'当前原生生图不可用，不申请制作或声称能直接生成图片。'),
  math:capabilities.math?.available?'数学排版浏览器已配置，可请求KaTeX排版；QQ实际发送PNG，本机PDF不等于上传。执行或回执失败时改用完整文字解答。':'当前数学图片/PDF执行器不可用，使用可读文字和公式，不承诺生成或发送PNG/PDF。',
  channel:capabilities.channel?.available?'腾讯频道CLI已配置，账号权限与登录尚需实际结果确认；群内仅公开只读搜索，主人私聊写入须准备草稿并确认。不能把它当QQ群管理。':'当前腾讯频道工具不可用，不声称已接入、搜索或管理频道。'
 };
}
export function ttsCapability(config,engine){return config.media?.tts===true?readSpeechCapability(engine):{available:false,ready:false,paused:true,phase:'unsupported',max_chars:120};}
export function ttsResidentStatus(config,engine){return config.media?.tts===true?residentSpeechStatus(engine.status()):{available:false,ready:false,paused:true,phase:'unsupported',pending:0,model_resident:false};}
export function requireTTS(config){if(config.media?.tts!==true)throw Object.assign(Error('tts_disabled'),{code:'tts_disabled',messageNotSent:true});}
export async function effectiveRole(root,config){const card=await loadCharacter(root);return {name:card.name,aliases:[...new Set([card.name,...(config.character?.aliases||[])])],description:characterEditorText(card)};}
export async function prepareRuntimeInput({media,event,roomHistory=[],getConfig}){
 const input=await prepareConversationInput(media,event,roomHistory,{visionEnabled:getConfig().media?.vision===true});
 if(getConfig().media?.vision!==true&&input.visionFiles.length){await media.releaseVisionFiles(input.visionFiles);input.visionFiles=[];input.mediaErrors=[];}
 return input;
}
