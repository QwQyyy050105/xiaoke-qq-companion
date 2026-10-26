import {readFile} from 'node:fs/promises';
const failure=code=>Object.assign(Error(code),{code});
export function isKeylessLocalApi(baseURL){
 try{const url=new URL(baseURL);return url.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(url.hostname)&&!url.username&&!url.password&&!url.search&&!url.hash;}
 catch{return false;}
}
function apiBaseURL(value){
 let url;try{url=new URL(value);}catch{throw failure('model_base_url_invalid');}
 if(url.username||url.password||url.search||url.hash||!(url.protocol==='https:'||isKeylessLocalApi(url.href)))throw failure('model_base_url_invalid');
 return url;
}
export function createModelProvider(settings,{fetcher=globalThis.fetch,env=process.env}={}){
 const type=settings.type;
 if(type==='mock')return {id:'mock',capabilities:{chat:true,vision:false,web:false},async complete({input,signal}){if(signal?.aborted)throw failure('model_aborted');const reply=`演示回复：${String(input.text||'你好').slice(0,100)}`;if(input.mode==='routing')return 'TALK';if(input.mode==='memory_capture')return JSON.stringify({personal:[],room:[]});if(input.mode==='vocabulary_research')return '{"actions":[]}';if(input.mode==='proactive')return JSON.stringify({reply:'',social:{action:'silent'}});return input.structured?JSON.stringify({reply,memories:[],social:{action:'say'}}):reply;}};
 if(type!=='openai-compatible')throw failure('model_provider_unsupported');
 return {id:type,capabilities:{chat:true,vision:true,web:false},async complete({prompt,input,images=[],signal}){
  if(signal?.aborted)throw failure('model_aborted');
  const baseURL=apiBaseURL(settings.baseURL);
  const key=typeof env[settings.envKey]==='string'?env[settings.envKey].trim():'';
  if(!key&&!isKeylessLocalApi(baseURL.href))throw failure('model_key_missing');
  if(!settings.model)throw failure('model_name_missing');
  const controller=new AbortController();let timedOut=false;
  const abort=()=>controller.abort();signal?.addEventListener('abort',abort,{once:true});
  const timer=setTimeout(()=>{timedOut=true;controller.abort();},settings.timeoutMs);
  try{
   if(images.length>3)throw failure('model_image_count_limit');
   let imageBytes=0;const content=[{type:'text',text:prompt}];
   for(const file of images){const bytes=await readFile(file);imageBytes+=bytes.length;if(bytes.length>8*1024*1024||imageBytes>16*1024*1024)throw failure('model_image_limit');const mime=/\.jpe?g$/i.test(file)?'image/jpeg':'image/png';content.push({type:'image_url',image_url:{url:`data:${mime};base64,${bytes.toString('base64')}`}});}
   const endpoint=baseURL.href.replace(/\/+$/,'')+'/chat/completions';
   const response=await fetcher(endpoint,{method:'POST',redirect:'error',signal:controller.signal,headers:{'content-type':'application/json',...(key?{authorization:`Bearer ${key}`}:{})},body:JSON.stringify({model:settings.model,messages:[{role:'user',content:images.length?content:prompt}],[settings.tokenLimitField||'max_tokens']:settings.maxOutputTokens,...(input.structured&&settings.responseFormat!=='prompt'?{response_format:{type:'json_object'}}:{})})});
   if(!response.ok)throw failure(`model_http_${response.status}`);
   let size=0;const chunks=[];for await(const chunk of response.body){size+=chunk.length;if(size>2*1024*1024){controller.abort();throw failure('model_response_limit');}chunks.push(chunk);}
   let data;try{data=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw failure('model_invalid_envelope');}
   const answer=data?.choices?.[0]?.message?.content;
   if(typeof answer!=='string'||!answer.trim())throw failure('model_empty_response');
   if(signal?.aborted)throw failure('model_aborted');return answer.trim();
  }catch(e){if(signal?.aborted)throw failure('model_aborted');if(timedOut)throw failure('model_timeout');if(e.code?.startsWith('model_'))throw e;throw failure('model_connection_failed');}
  finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);}
 }};
}
