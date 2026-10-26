import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
// Runtime boundaries are code-owned. Historical persona.txt content may be a
// user-edited legacy character, so it must never become a second personality.
const CHARACTER_RUNTIME_PROTOCOL='默认简体中文。当前人格卡是表达的唯一基础，同一会话的成长记录补充相处习惯。示例只示范语感，不是发生过的经历。';
export async function loadCharacter(root) {
 let raw;try{raw=await readFile(join(root,'character_card.local.json'),'utf8');}catch(error){if(error.code!=='ENOENT')throw error;raw=await readFile(join(root,'character_card.json'),'utf8');}
 const card=JSON.parse(raw);
 if(!card.name||!Array.isArray(card.core)||!Array.isArray(card.voice))throw Error('character_invalid');
 if(card.editable_persona!==undefined&&(typeof card.editable_persona!=='string'||card.editable_persona.length>16000))throw Error('character_invalid');
 return card;
}
// The editor and the model use this same expression source. Legacy fields are
// only the initial text, never a second personality appended after an edit.
export function characterEditorText(card){
 if(typeof card.editable_persona==='string'&&card.editable_persona.trim())return card.editable_persona.trim();
 return [card.identity,card.core?.length?`性格：\n${card.core.map(value=>'- '+value).join('\n')}`:'',
  card.voice?.length?`说话方式：\n${card.voice.map(value=>'- '+value).join('\n')}`:'',
  card.emotion?`情绪：${card.emotion}`:'',card.media?`表达偏好：${card.media}`:'',
  Array.isArray(card.examples)&&card.examples.length?`语气示例（不是真实经历）：\n${card.examples.map(value=>`对方：${value.user}\n${card.name}：${value.reply}`).join('\n')}`:'']
  .filter(Boolean).join('\n\n').trim();
}
export function characterPrompt(card){return `【小柯独立人格卡】\n${JSON.stringify({name:card.name,full_name:card.full_name,appearance:card.appearance})}\n${characterEditorText(card)}`}
export function assembleCharacterPersona(card){return `${CHARACTER_RUNTIME_PROTOCOL}\n\n${characterPrompt(card)}`;}
export function characterSummary(card){return `${card.full_name} · ${card.name}\n\n${characterEditorText(card)}`}
export function characterRequest(text){return /^(?:小柯[，,：:\s]*)?(?:\/character|(?:看看|看一下|给我看看|发一下|展示)?(?:你的)?(?:人格卡|角色卡|性格卡))[。！!？?\s]*$/i.test(String(text).trim());}
export function expressionView(value,now=Date.now()){
 if(!value||now-value.at>4*60*60_000)return {mood:'calm',energy:0.6};
 return {mood:value.mood,energy:value.energy,continuity:value.continuity};
}
export function normalizeExpression(value,now=Date.now()){
 if(!['calm','happy','playful','curious','sleepy','concerned','annoyed'].includes(value?.mood))return null;
 return {mood:value.mood,energy:Number.isFinite(value.energy)?Math.max(0,Math.min(1,value.energy)):0.6,
 continuity:typeof value.continuity==='string'?value.continuity.slice(0,120):'',at:now};
}
