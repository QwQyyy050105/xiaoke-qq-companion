import {speechRequest} from './speech.mjs';
import {replySpeechFallback} from './speech_capability.mjs';

// Permission to generate and a resident model are different. Explicit requests
// may wait in a background job; unsolicited speech must not cold-load a model.
export function residentSpeechStatus(state={}) {
  return {...state,ready:state.ready===true&&state.model_resident===true};
}

export function speechReplyDeadline(event) {
  // Arrival time changes on redelivery. Only QQ's original timestamp may set a
  // durable voice job's expiry; an undated event stays a text-only reply.
  const original=typeof event?.timestamp==='string'?Date.parse(event.timestamp):NaN;
  return Number.isFinite(original)?original+(event.group_openid?270000:3540000):null;
}

export function planReplySpeech({event,content='',options={},capability={},state={},settings={},lastSentAt=0,now=Date.now()}) {
  const requested=speechRequest(event);
  const declined=/(?:不要|不用|别).{0,8}语音/.test(String(event?.content||''));
  const text=String(options.speech?.text||(requested&&[...String(content)].length<=120?content:'')).trim();
  const hasMedia=!!(options.media?.send_id||options.media?.voice_id||options.media?.create_prompt||options.math_document||options.math_continue);
  const unchanged={content:String(content||options.speech?.text||''),replaceMessages:false};
  if(options.chatReply!==true||declined||hasMedia||!text||[...text].length>120)return unchanged;
  if(!requested&&(!settings.spontaneousStickers||state.model_resident!==true||state.pending||now-lastSentAt<=120000))return unchanged;
  if(!capability.available)return {...unchanged,...replySpeechFallback({content,text,requested,state:capability})};
  return {...unchanged,job:{text,requested}};
}
