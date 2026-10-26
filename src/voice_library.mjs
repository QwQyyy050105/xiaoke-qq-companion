import {readFile,realpath,open} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
const MAX_BYTES=3*1024*1024;
const inside=(base,file)=>{const r=path.relative(base,file);return r&&!r.startsWith('..'+path.sep)&&r!=='..'&&!path.isAbsolute(r);};
const clean=(s,n=160)=>[...String(s||'').replace(/[\x00-\x1f\x7f]/g,' ')].slice(0,n).join('');
export function inspectVoice(buffer){
 if(!Buffer.isBuffer(buffer)||buffer.length<12||buffer.length>MAX_BYTES)throw Error('voice_invalid_bytes');
 let mime,extension,duration=null;
 if(buffer.toString('ascii',0,4)==='RIFF'&&buffer.toString('ascii',8,12)==='WAVE'){
  let rate=0,data=0,fmt=false;
  for(let p=12;p+8<=buffer.length;){const name=buffer.toString('ascii',p,p+4),size=buffer.readUInt32LE(p+4);if(p+8+size>buffer.length)throw Error('voice_invalid_wav');
   if(name==='fmt '&&size>=16){const format=buffer.readUInt16LE(p+8);if(![1,3,65534].includes(format))throw Error('voice_unsupported_codec');rate=buffer.readUInt32LE(p+16);fmt=true;}
   if(name==='data')data+=size;p+=8+size+(size%2);
  }
  if(!fmt||!rate||!data)throw Error('voice_invalid_wav');duration=data/rate;mime='audio/wav';extension='wav';
 }else if(buffer.subarray(0,10).toString('ascii').includes('#!SILK_V3')){mime='audio/silk';extension='silk';}
 else{
  let p=0;
  if(buffer.toString('ascii',0,3)==='ID3'){
   if([buffer[6],buffer[7],buffer[8],buffer[9]].some(b=>b>127))throw Error('voice_invalid_mp3');
   p=10+((buffer[6]<<21)|(buffer[7]<<14)|(buffer[8]<<7)|buffer[9]);
  }
  let seconds=0,frames=0;
  const bitrate1=[0,32,40,48,56,64,80,96,112,128,160,192,224,256,320,0],bitrate2=[0,8,16,24,32,40,48,56,64,80,96,112,128,144,160,0];
  while(p+4<=buffer.length){
   if(buffer.toString('ascii',p,p+3)==='TAG'&&buffer.length-p===128)break;
   const h=buffer.readUInt32BE(p);if((h>>>21)!==2047)throw Error('voice_invalid_mp3');
   const version=(h>>>19)&3,layer=(h>>>17)&3,br=(h>>>12)&15,sr=(h>>>10)&3,padding=(h>>>9)&1;
   if(version===1||layer!==1||sr===3)throw Error('voice_invalid_mp3');
   const rate=[44100,48000,32000][sr]/(version===3?1:version===2?2:4);
   const bitrate=(version===3?bitrate1:bitrate2)[br]*1000;if(!bitrate)throw Error('voice_invalid_mp3');
   const length=Math.floor((version===3?144:72)*bitrate/rate)+padding;
   if(p+length>buffer.length)throw Error('voice_invalid_mp3');p+=length;frames++;seconds+=(version===3?1152:576)/rate;
  }
  if(!frames||p<buffer.length-128)throw Error('voice_invalid_mp3');duration=seconds;mime='audio/mpeg';extension='mp3';
 }
 if(duration!==null&&(!Number.isFinite(duration)||duration<=0||duration>180))throw Error('voice_duration_limit');
 return {buffer,mime,extension,duration,bytes:buffer.length,sha256:createHash('sha256').update(buffer).digest('hex'),fileName:`voice.${extension}`};
}
export class VoiceLibrary{
 constructor({root,manifest='assets/voices_approved.json'}={}){this.root=root;this.manifest=manifest;this.entries=new Map();}
 static async open(options){const library=new VoiceLibrary(options);await library.refresh();return library;}
 async refresh(){
  const base=await realpath(this.root);let manifest;
  try{const target=await realpath(path.resolve(base,this.manifest));if(!inside(base,target))throw Error('voice_path_boundary');const contents=await readFile(target);if(contents.length>128*1024)throw Error('voice_manifest_size');manifest=JSON.parse(contents.toString('utf8'));}catch(e){if(e.code==='ENOENT'){this.entries.clear();return;}throw e;}
  if(!Array.isArray(manifest.voices)||manifest.voices.length>64)throw Error('voice_invalid_manifest');
  const next=new Map();
  for(const item of manifest.voices){
   if(!/^[a-z0-9_-]{1,48}$/i.test(item?.id||'')||!/^assets\/voices\/[a-z0-9_./-]+\.(mp3|wav|silk)$/i.test(item?.path||'')||item.path.split('/').includes('..')||!/^[a-f0-9]{64}$/.test(item?.sha256||''))throw Error('voice_invalid_manifest');
   if(next.has(item.id))throw Error('voice_invalid_manifest');next.set(item.id,{...item,label:clean(item.label),title:clean(item.title,80)});
  }
  this.entries=next;
 }
 catalog(){return [...this.entries.values()].map(({id,title,label})=>({id:`voice_${id}`,title,label}));}
 async prepare(id){
  await this.refresh();const item=this.entries.get(String(id).replace(/^voice_/,''));if(!item)throw Error('voice_not_found');
  const base=await realpath(this.root),file=await realpath(path.resolve(base,item.path));if(!inside(path.join(base,'assets','voices'),file))throw Error('voice_path_boundary');
  const handle=await open(file,'r');let buffer;
  try{const stat=await handle.stat();if(!stat.isFile()||stat.size>MAX_BYTES)throw Error('voice_invalid_bytes');buffer=await handle.readFile();}finally{await handle.close();}
  const result=inspectVoice(buffer);if(result.sha256!==item.sha256)throw Error('voice_hash_changed');return {...result,id:`voice_${item.id}`,label:item.label||item.title};
 }
}
