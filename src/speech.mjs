import {isAbsolute as isPortableAbsolute} from 'node:path';
import {realpath,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {encode} from 'silk-wasm';
import {inspectVoice} from './voice_library.mjs';
import {speechEngine} from './qwen_speech.mjs';
import {MAX_SPEECH_CHARACTERS} from './shared_voice_speech.mjs';
export function speechRequest(event){
 const text=String(event?.addressed_content??event?.content??'');
 return !/(?:不要|不用|别|暂时不).{0,8}(?:语音|说出来|念|读出来)/.test(text)&&/(?:用|发|来|听|说|回).{0,12}(?:语音|声音)|(?:语音).{0,12}(?:说|回|发|聊)|念给我听|读出来/.test(text);
}
export function validateSpeechText(text){
 if(typeof text!=='string'||!text.trim()||[...text].length>MAX_SPEECH_CHARACTERS||/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text))throw Error('voice_text_limit');
 return text.trim();
}
export async function synthesizeSpeech(root,text,{previewPath,signal,requestId,deadlineMs,engine=speechEngine(root),encoder=encode}={}){
 text=validateSpeechText(text);
 const generation=await engine.generate(text,{signal,requestId,deadlineMs});
 const wav=Buffer.from(generation.buffer||[]);
 if(createHash('sha256').update(wav).digest('hex')!==generation.sha256)throw Error('voice_audio_hash_mismatch');
 inspectVoice(wav);
 const identity=Object.freeze({profileHash:generation.profileHash,modelIdentity:generation.modelIdentity});
 if(!engine.isCurrent(identity))throw Error('voice_paused');
 const encoded=await encoder(wav,0);const voice=inspectVoice(Buffer.from(encoded.data));
 if(signal?.aborted||!await engine.verifyCurrent(identity,{signal}))throw Error('voice_paused');
 if(previewPath){
  const base=await realpath(root),parent=await realpath(path.dirname(previewPath));
  const relative=path.relative(base,parent);
  if(!isPortableAbsolute(base)||!isPortableAbsolute(previewPath)||relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative)||path.extname(previewPath).toLowerCase()!=='.wav')throw Error('voice_preview_path_invalid');
  // Never overwrite an existing path or a shared cache file through a preview.
  await writeFile(previewPath,wav,{flag:'wx'});
 }
 if(signal?.aborted||!engine.isCurrent(identity))throw Error('voice_paused');
 return {...voice,label:text,duration:encoded.duration/1000,synthetic:true,generationMs:generation.elapsed_ms,sharedVoice:identity};
}

export function isPreparedSpeechCurrent(root,prepared){
 try{return prepared?.synthetic===true&&speechEngine(root).isCurrent(prepared.sharedVoice)===true;}catch{return false;}
}
export async function verifyPreparedSpeech(root,prepared,{signal}={}){
 try{return prepared?.synthetic===true&&await speechEngine(root).verifyCurrent(prepared.sharedVoice,{signal})===true;}catch{return false;}
}
