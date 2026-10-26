import {isAbsolute as isPortableAbsolute} from 'node:path';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {inspectImage} from './media_image.mjs';

export const channelMediaActions=new Set(['feed.publish-feed','feed.quick-publish','feed.alter-feed','feed.do-comment','feed.do-reply']);
export const channelMediaFlag={name:'image-ids',type:'string_array',description:'本次主人私聊图片目录中的已有图片ID，按发布顺序填写；不接受路径或URL。'};
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const ownerScope=e=>hash([e.group_openid||'private',e.author?.user_openid||e.author?.id||'']);
const inside=(base,file)=>{const relative=path.relative(base,file);return relative!==''&&!relative.startsWith('..')&&!path.isAbsolute(relative);};
const stale=()=>{throw Error('channel_media_canceled');};
const check=valid=>{if(!valid())stale();};
const extension={'image/png':'png','image/jpeg':'jpg','image/gif':'gif','image/webp':'webp'};

export function channelMediaInput(action,parameters,trace=[]) {
  if(!Object.hasOwn(parameters,'image-ids'))return null;
  if(!channelMediaActions.has(action))throw Error('channel_media_action_unsupported');
  const ids=parameters['image-ids'];
  if(!Array.isArray(ids)||!ids.length||ids.some(id=>typeof id!=='string'||!/^[A-Za-z0-9_-]{1,100}$/.test(id))||new Set(ids).size!==ids.length)throw Error('channel_media_invalid_ids');
  let limit=1;
  if(action==='feed.publish-feed'||action==='feed.quick-publish')limit=parameters.title||String(parameters['feed-type'])==='2'?50:18;
  if(action==='feed.alter-feed'){
    // Editing inherits the actual original post type; a fresh model parameter
    // cannot turn an existing short post into a long post.
    if(Object.hasOwn(parameters,'feed-type'))throw Error('channel_media_inherited_feed_type');
    const detail=[...trace].reverse().find(t=>t.action==='feed.get-feed-detail'&&t.result?.success===true&&!t.result.truncated&&!t.result._projection?.truncated&&String(t.result.data?.feed?.feed_id)===String(parameters['feed-id']));
    const feed=detail?.result.data.feed;
    if(!feed||!['1','2'].includes(String(feed.feed_type))||['guild-id','channel-id'].some(k=>String(feed[k.replace('-','_')])!==String(parameters[k])))throw Error('channel_media_target_type_unverified');
    limit=String(feed.feed_type)==='2'?50:18;
  }
  if(ids.length>limit)throw Error('channel_media_too_many_images');
  if(action==='feed.do-comment'&&String(parameters['comment-type']??1)!=='1'||action==='feed.do-reply'&&String(parameters['reply-type']??1)!=='1')throw Error('channel_media_requires_publication');
  const clean={...parameters};delete clean['image-ids'];
  return {ids:[...ids],parameters:clean};
}

// The model names existing scoped assets only. Paths are generated just before
// the reviewed operation and are never accepted from model output or storage.
export class ChannelMedia {
  constructor({root,getCatalog,prepare}){Object.assign(this,{root:path.resolve(root),getCatalog,prepare});}
  catalog(event){
    if(event.group_openid)return [];
    return this.getCatalog(event).filter(x=>/^[A-Za-z0-9_-]{1,100}$/.test(x.id||'')).map(x=>({id:x.id,label:String(x.label||x.title||'图片').slice(0,120),source:x.source}));
  }
  async snapshot(event,id,valid){
    check(valid);if(event.group_openid||!event.author?.user_openid&&!event.author?.id)throw Error('channel_media_owner_only');
    const item=this.catalog(event).find(x=>x.id===id);if(!item)throw Error('channel_media_unknown_id');
    const prepared=await this.prepare(event,id,{original:true});check(valid);
    const image=inspectImage(prepared.buffer,prepared.mime,{allowExtended:true});
    if(prepared.sha256!==image.sha256)throw Error('channel_media_source_changed');
    if(!this.catalog(event).some(x=>x.id===id))throw Error('channel_media_unknown_id');
    return {image,asset:{id,label:item.label,mime:image.mime,sha256:image.sha256,bytes:image.buffer.length,width:image.width,height:image.height}};
  }
  async bind(event,action,parameters,trace=[],valid=()=>true){
    const input=channelMediaInput(action,parameters,trace);if(!input)return null;
    const assets=[];
    for(const id of input.ids)assets.push((await this.snapshot(event,id,valid)).asset);
    check(valid);
    return {version:1,scope:ownerScope(event),action,parametersHash:hash(parameters),assets};
  }
  matches(event,action,parameters,binding){
    return Boolean(binding?.version===1&&binding.scope===ownerScope(event)&&binding.action===action&&binding.parametersHash===hash(parameters)
      &&Array.isArray(binding.assets)&&JSON.stringify(binding.assets.map(a=>a.id))===JSON.stringify(parameters['image-ids']));
  }
  // quick-publish remembers its initial --image paths in the vendor session.
  // A lease survives only the reviewed selection flow; resume never substitutes
  // new paths or silently regenerates a missing/changed staged image.
  async leasePaths(lease,{missing=false}={}){
    if(lease?.version!==1||! /^[a-f0-9-]{36}$/.test(lease.id||'')||lease.directory!=='temp/channel_shortcut_'+lease.id||!Array.isArray(lease.files)||!lease.files.length||lease.files.length>50||lease.files.some((file,i)=>!new RegExp('^'+String(i+1).padStart(2,'0')+'\\.(png|jpg|gif|webp)$').test(file)))throw Error('channel_media_lease_invalid');
    const realRoot=await fs.realpath(this.root);if(process.platform==='win32'&&!isPortableAbsolute(realRoot))throw Error('channel_media_not_on_d');
    const realTemp=await fs.realpath(path.join(this.root,'temp'));if(!inside(realRoot,realTemp))throw Error('channel_media_temp_boundary');
    const dir=path.join(realTemp,'channel_shortcut_'+lease.id);
    try{const stat=await fs.lstat(dir);if(stat.isSymbolicLink()||!stat.isDirectory()||await fs.realpath(dir)!==dir)throw Error('channel_media_lease_boundary');}catch(error){if(!missing||error.code!=='ENOENT')throw error;}
    return {dir,files:lease.files.map(file=>path.join(dir,file))};
  }
  async stageLease(event,action,parameters,binding,onLease,valid=()=>true){
    if(action!=='feed.quick-publish'||!this.matches(event,action,parameters,binding))throw Error('channel_media_binding_changed');
    const snapshots=[];
    for(const asset of binding.assets){const current=await this.snapshot(event,asset.id,valid);if(JSON.stringify(current.asset)!==JSON.stringify(asset))throw Error('channel_media_source_changed');snapshots.push(current.image);}
    check(valid);await fs.mkdir(path.join(this.root,'temp'),{recursive:true});
    const id=randomUUID(),lease={version:1,id,directory:'temp/channel_shortcut_'+id,files:snapshots.map((image,i)=>String(i+1).padStart(2,'0')+'.'+extension[image.mime]),bindingHash:hash(binding)};
    // Persist ownership before creating files so interrupted preparation has a
    // precise cleanup receipt rather than an untracked directory to sweep.
    await onLease(lease);check(valid);
    const {dir,files}=await this.leasePaths(lease,{missing:true});await fs.mkdir(dir);
    for(let i=0;i<files.length;i++){check(valid);const handle=await fs.open(files[i],'wx',0o600);try{await handle.writeFile(snapshots[i].buffer);}finally{await handle.close();}}
    check(valid);await this.verifyLease(event,action,parameters,binding,lease,valid);return lease;
  }
  async verifyLease(event,action,parameters,binding,lease,valid=()=>true){
    check(valid);
    if(action!=='feed.quick-publish'||!this.matches(event,action,parameters,binding)||lease?.bindingHash!==hash(binding)||lease?.files?.length!==binding.assets.length)throw Error('channel_media_binding_changed');
    const {files}=await this.leasePaths(lease);
    for(let i=0;i<files.length;i++){
      const asset=binding.assets[i],current=await this.snapshot(event,asset.id,valid);
      if(JSON.stringify(current.asset)!==JSON.stringify(asset)||path.extname(files[i])!=='.'+extension[asset.mime])throw Error('channel_media_source_changed');
      const stat=await fs.lstat(files[i]);if(stat.isSymbolicLink()||!stat.isFile()||await fs.realpath(files[i])!==files[i])throw Error('channel_media_lease_boundary');
      const saved=inspectImage(await fs.readFile(files[i]),asset.mime,{allowExtended:true});
      if(saved.sha256!==asset.sha256||saved.buffer.length!==asset.bytes||saved.width!==asset.width||saved.height!==asset.height||saved.mime!==asset.mime)throw Error('channel_media_staged_bytes_changed');
    }
    check(valid);return files.map(file=>'--image='+file);
  }
  async releaseLease(lease){
    try{
      const {dir,files}=await this.leasePaths(lease,{missing:true});
      for(const file of files){try{await fs.unlink(file);}catch(error){if(error.code!=='ENOENT')throw error;}}
      try{await fs.rmdir(dir);}catch(error){if(error.code!=='ENOENT')throw error;}
      return {cleanupPending:false,cleanup:null};
    }catch{return {cleanupPending:true,cleanup:{directory:lease?.directory,files:lease?.files}};}
  }
  async withFiles(event,action,parameters,binding,operation,valid=()=>true){
    if(!this.matches(event,action,parameters,binding))throw Error('channel_media_binding_changed');
    const snapshots=[];
    for(const asset of binding.assets){
      const current=await this.snapshot(event,asset.id,valid);
      if(JSON.stringify(current.asset)!==JSON.stringify(asset))throw Error('channel_media_source_changed');
      snapshots.push(current.image);
    }
    check(valid);
    const realRoot=await fs.realpath(this.root);if(process.platform==='win32'&&!isPortableAbsolute(realRoot))throw Error('channel_media_not_on_d');
    const temp=path.join(this.root,'temp');await fs.mkdir(temp,{recursive:true});
    const realTemp=await fs.realpath(temp);if(!inside(realRoot,realTemp))throw Error('channel_media_temp_boundary');
    const dir=path.join(realTemp,'channel_upload_'+randomUUID());await fs.mkdir(dir);
    const files=[];let result,failure,cleanupPending=false,submitted=false;
    try{
      for(let i=0;i<snapshots.length;i++){
        check(valid);const image=snapshots[i],file=path.join(dir,String(i+1).padStart(2,'0')+'.'+extension[image.mime]);
        const handle=await fs.open(file,'wx',0o600);files.push(file);
        try{await handle.writeFile(image.buffer);}finally{await handle.close();}
        const persisted=inspectImage(await fs.readFile(file),image.mime,{allowExtended:true});
        if(persisted.sha256!==binding.assets[i].sha256)throw Error('channel_media_staged_bytes_changed');
      }
      check(valid);
      const flag=action==='feed.do-comment'||action==='feed.do-reply'?'image-path':'image';
      submitted=true;
      result=await operation(files.map(file=>'--'+flag+'='+file),{timeoutMs:120000});
    }catch(error){failure=error;}
    finally{
      // Remove only this invocation's own staging files after an exact parent
      // check. Cleanup failure cannot turn an already-issued write into a retry.
      try{
        const actual=await fs.realpath(dir),stat=await fs.lstat(dir);
        if(actual!==dir||stat.isSymbolicLink()||path.dirname(actual)!==realTemp)throw Error('channel_media_cleanup_boundary');
        for(const file of files){if(path.dirname(file)!==dir)throw Error('channel_media_cleanup_boundary');await fs.unlink(file);}
        await fs.rmdir(dir);
      }catch{cleanupPending=true;}
    }
    const cleanup=cleanupPending?{directory:path.relative(realRoot,dir).replaceAll('\\','/'),files:files.map(file=>path.basename(file))}:null;
    if(failure){failure.channelMediaCleanupPending=cleanupPending;failure.channelMediaCleanup=cleanup;failure.channelMediaNotSubmitted=!submitted;throw failure;}
    return {result,cleanupPending,cleanup};
  }
}
