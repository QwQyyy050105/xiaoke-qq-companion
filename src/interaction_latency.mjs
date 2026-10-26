import {isAbsolute as isPortableAbsolute} from 'node:path';
import { readFile } from 'node:fs/promises';
import { durableWriteFile } from './durable_write.mjs';
import { join, isAbsolute } from 'node:path';
const phases=['queue_ms','prepare_ms','model_ms','postprocess_ms','delivery_ms','total_ms'];
const counts=['history_items','room_items','vision_inputs'];
let writes=Promise.resolve();
export function latencySummary(records) {
  return Object.fromEntries(phases.map(phase=>{
    const values=records.map(row=>row[phase]).filter(Number.isFinite).sort((a,b)=>a-b);
    return [phase,{samples:values.length,p50:values.length?values[Math.floor((values.length-1)*.5)]:null,p90:values.length?values[Math.ceil(values.length*.9)-1]:null}];
  }));
}
export function recordInteractionLatency(root, record) {
  if(!isAbsolute(root)||(process.platform==='win32'&&!isPortableAbsolute(root)))return Promise.reject(Error('latency_requires_d_root'));
  const clean={at:new Date(record.at).toISOString(),is_group:record.is_group===true};
  for(const key of [...phases,...counts])if(Number.isFinite(record[key])&&record[key]>=0)clean[key]=record[key];
  const path=join(root,'data','interaction_latency.json');
  const task=writes.then(async()=>{
    let previous={recent:[]};try{previous=JSON.parse(await readFile(path,'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
    if(!Array.isArray(previous.recent))throw Error('latency_log_invalid');
    const recent=[...previous.recent,clean].slice(-200);
    await durableWriteFile(path,JSON.stringify({scope:'Actual completed reply delivery stages; no chat contents or identities',recent,summary:latencySummary(recent)},null,2));
  });
  writes=task.catch(()=>{});return task;
}
