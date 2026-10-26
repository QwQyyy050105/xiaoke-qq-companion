import {readFile, mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {durableWriteFile} from './durable_write.mjs';
export const CONFIG_VERSION=1;
export const defaults=()=>({schemaVersion:1,appId:'',pairingHash:'',proxy:'',modelProvider:{type:'mock',baseURL:'https://api.openai.com/v1',model:'',envKey:'MODEL_API_KEY',timeoutMs:60000,maxOutputTokens:1200,tokenLimitField:'max_tokens',responseFormat:'json_object'},character:{aliases:['小柯','小珂'],style:'自然简短，有自己的兴趣，先理解上下文再接话'},participation:{mode:'mentioned',quietStart:0,quietEnd:0,timeZone:'Asia/Shanghai'},scope:{groups:[],privateUsers:[]},media:{vision:false,asr:false,tts:false,imageGeneration:false},plugins:[],consolePort:8794});
const obj=v=>v&&typeof v==='object'&&!Array.isArray(v);
const strings=(v,max=100)=>Array.isArray(v)&&v.length<=max&&v.every(x=>typeof x==='string'&&x.length>0&&x.length<=160&&!/[\x00-\x1f]/.test(x));
export function validateConfig(value){
 if(!obj(value)||value.schemaVersion!==1||Object.keys(value).some(k=>!Object.hasOwn(defaults(),k)))throw Error('config_schema_invalid');
 const c={...defaults(),...value};
 if(!['appId','pairingHash','proxy'].every(k=>typeof c[k]==='string')||c.appId.length>160||c.pairingHash&&!/^[a-f0-9]{64}$/.test(c.pairingHash))throw Error('config_credentials_invalid');
 if(obj(c.modelProvider))c.modelProvider={...defaults().modelProvider,...c.modelProvider};
 const p=c.modelProvider;
 if(!obj(p)||!['mock','openai-compatible','codex'].includes(p.type)||Object.keys(p).some(k=>!['type','baseURL','model','envKey','timeoutMs','maxOutputTokens','tokenLimitField','responseFormat'].includes(k))||typeof p.model!=='string'||p.model.length>160||!/^[_A-Z][_A-Z0-9]{0,79}$/.test(p.envKey)||!Number.isInteger(p.timeoutMs)||p.timeoutMs<100||p.timeoutMs>180000||!['max_tokens','max_completion_tokens'].includes(p.tokenLimitField)||!['json_object','prompt'].includes(p.responseFormat)||!Number.isInteger(p.maxOutputTokens)||p.maxOutputTokens<16||p.maxOutputTokens>16000)throw Error('config_model_invalid');
 let url;try{url=new URL(p.baseURL);}catch{throw Error('config_base_url_invalid');}
 if(url.username||url.password||url.hash||url.search||!(url.protocol==='https:'||url.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(url.hostname)))throw Error('config_base_url_invalid');
 if(!obj(c.character)||Object.keys(c.character).some(k=>!['aliases','style'].includes(k))||!strings(c.character.aliases,20)||typeof c.character.style!=='string'||c.character.style.length>1600)throw Error('config_character_invalid');
 if(!obj(c.participation)||Object.keys(c.participation).some(k=>!['mode','quietStart','quietEnd','timeZone'].includes(k))||!['mentioned','contextual','active'].includes(c.participation.mode)||!['quietStart','quietEnd'].every(k=>Number.isInteger(c.participation[k])&&c.participation[k]>=0&&c.participation[k]<24))throw Error('config_participation_invalid');
 try{new Intl.DateTimeFormat('en',{timeZone:c.participation.timeZone});}catch{throw Error('config_timezone_invalid');}
 if(!obj(c.scope)||Object.keys(c.scope).some(k=>!['groups','privateUsers'].includes(k))||!strings(c.scope.groups)||!strings(c.scope.privateUsers))throw Error('config_scope_invalid');
 if(!obj(c.media)||Object.keys(c.media).some(k=>!['vision','asr','tts','imageGeneration'].includes(k))||!['vision','asr','tts','imageGeneration'].every(k=>typeof c.media[k]==='boolean'))throw Error('config_media_invalid');
 if(!Array.isArray(c.plugins)||c.plugins.length>20||!c.plugins.every(x=>typeof x==='string'&&/^\.\/(?:plugins|examples)\/[a-zA-Z0-9_./-]+\.mjs$/.test(x)&&!x.split('/').includes('..')))throw Error('config_plugins_invalid');
 if(!Number.isInteger(c.consolePort)||c.consolePort<0||c.consolePort>65535)throw Error('config_console_invalid');
 return structuredClone(c);
}
export async function loadEnv(root,env=process.env){
 let raw;try{raw=await readFile(join(root,'.env'),'utf8');}catch(e){if(e.code==='ENOENT')return;throw e;}
 for(const line of raw.split(/\r?\n/)){const m=line.match(/^\s*([A-Z_][A-Z_0-9]*)\s*=\s*(.*?)\s*$/);if(!m||env[m[1]]!==undefined)continue;let v=m[2];if(v.startsWith('"')&&v.endsWith('"')||v.startsWith("'")&&v.endsWith("'"))v=v.slice(1,-1);env[m[1]]=v;}
}
export async function openPublicConfig(root){
 const file=join(root,'config.local.json');let saved;try{saved=JSON.parse(await readFile(file,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
 let value=validateConfig(saved||defaults()),writes=Promise.resolve();
 return {get:()=>structuredClone(value),async update(patch){const task=writes.catch(()=>{}).then(async()=>{if(!obj(patch))throw Error('config_patch_invalid');const next=validateConfig({...value,...patch});await mkdir(root,{recursive:true});await durableWriteFile(file,JSON.stringify(next,null,2)+'\n');value=next;return structuredClone(next);});writes=task.catch(()=>{});return task;}};
}
export function isEventAllowed(config,event,now=new Date()){
 const id=event.group_openid||event.author?.user_openid||event.author?.id;
 if(!(event.group_openid?config.scope.groups:config.scope.privateUsers).includes(id))return false;
 const {quietStart:a,quietEnd:b,timeZone}=config.participation;
 const hour=Number(new Intl.DateTimeFormat('en-GB',{hour:'2-digit',hourCycle:'h23',timeZone}).format(now));
 return a===b||!(a<b?hour>=a&&hour<b:hour>=a||hour<b);
}
