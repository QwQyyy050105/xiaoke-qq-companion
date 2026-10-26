import {realpath} from 'node:fs/promises';
import {resolve,relative,isAbsolute} from 'node:path';
import {pathToFileURL} from 'node:url';
const allowed=new Set(['chat','beforeGenerate','afterGenerate','vision','asr','tts','search']);
const obj=v=>v&&typeof v==='object'&&!Array.isArray(v);
export async function loadExtensions({root,paths=[],config={},log=()=>{}}){
 const handlers=new Map(),ids=new Set();const base=await realpath(root);
 for(const name of paths){const file=await realpath(resolve(base,name)),rel=relative(base,file);if(!rel||rel.startsWith('..')||isAbsolute(rel))throw Error('plugin_path_rejected');
  const manifest=(await import(pathToFileURL(file).href)).default;
  if(!obj(manifest)||manifest.apiVersion!==1||!/^[_a-z][_a-z0-9-]{1,63}$/.test(manifest.id)||ids.has(manifest.id)||!Array.isArray(manifest.capabilities)||!manifest.capabilities.length||manifest.capabilities.some(c=>!allowed.has(c))||typeof manifest.setup!=='function')throw Error('plugin_manifest_invalid');
  const supplied=await manifest.setup(Object.freeze({apiVersion:1,root,config:structuredClone(config),log}));if(!obj(supplied))throw Error('plugin_setup_invalid');
  for(const capability of manifest.capabilities){if(typeof supplied[capability]!=='function')throw Error('plugin_capability_invalid');if(handlers.has(capability)&&!['beforeGenerate','afterGenerate'].includes(capability))throw Error('plugin_capability_duplicate');const rows=handlers.get(capability)||[];rows.push(supplied[capability]);handlers.set(capability,rows);}
  ids.add(manifest.id);
 }
 return {ids:[...ids],supports:c=>handlers.has(c),async call(capability,input){const rows=handlers.get(capability);if(!rows)return {status:'unsupported',capability};let value=input;for(const fn of rows)value=await fn(value);return value;}};
}
export function wrapGenerate(generate, extensions) {
 return async input => {
  const checkCancelled = () => { if(input.signal?.aborted)throw Error('model_aborted'); };
  checkCancelled();
  const context = extensions.supports('beforeGenerate')
   ? await extensions.call('beforeGenerate',input) : input;
  if(!obj(context))throw Error('plugin_input_invalid');
  checkCancelled();
  let result = extensions.supports('chat')
   ? await extensions.call('chat',{...context,signal:input.signal}) : await generate({...context,signal:input.signal});
  if(extensions.supports('afterGenerate'))result=await extensions.call('afterGenerate',result);
  checkCancelled();
  if((extensions.supports('chat')||context.structured||obj(result)) && (!context.mode||context.mode==='reply')
   && (!obj(result)||typeof result.reply!=='string'||!Array.isArray(result.memories))) {
    throw Error('plugin_chat_result_invalid');
  }
  return result;
 };
}

export function loadConfiguredExtensions({offline=false,...options}){return loadExtensions({...options,paths:offline?[]:options.paths});}
