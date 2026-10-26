import {isAbsolute as isPortableAbsolute} from 'node:path';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { inspectImage, MAX_IMAGE_BYTES } from './media_image.mjs';

const DECODE = String.raw`
import sys, io, json, base64, warnings
from PIL import Image
Image.MAX_IMAGE_PIXELS = 16000000
warnings.simplefilter('error', Image.DecompressionBombWarning)
raw = sys.stdin.buffer.read(3 * 1024 * 1024 + 1)
if len(raw) > 3 * 1024 * 1024: raise ValueError('input_limit')
with Image.open(io.BytesIO(raw)) as im:
    if im.format not in ('GIF', 'WEBP'): raise ValueError('format')
    width, height = im.size
    count = getattr(im, 'n_frames', 1)
    if count < 1 or count > 240 or width * height > 16000000 or width * height * count > 160000000: raise ValueError('dimensions')
    limit = int(sys.argv[1])
    wanted = [0] if limit == 1 or count == 1 else sorted(set([0, count - 1] if limit == 2 else [0, (count - 1) // 2, count - 1]))
    frames = []
    for index in wanted:
        im.seek(index)
        if im.size != (width, height): raise ValueError('frame_dimensions')
        frame = im.convert('RGBA')
        target = io.BytesIO()
        frame.save(target, format='PNG')
        value = target.getvalue()
        if len(value) > 3 * 1024 * 1024: raise ValueError('output_limit')
        frames.append({'index': index, 'data': base64.b64encode(value).decode('ascii')})
    print(json.dumps({'count': count, 'frames': frames}, separators=(',', ':')))
`;

/** Decode verified GIF/WebP in the owner-selected Python/venv. -I keeps that
 * interpreter site-packages, while excluding cwd, user site and PYTHONPATH. */
export async function prepareImageFrames(image, {root, maxFrames=3, pythonPath=process.env.XIAOKE_PYTHON_PATH||'', timeoutMs=15000, spawnProcess=spawn}={}) {
  const checked=inspectImage(image?.buffer,'',{allowExtended:true});
  if(['image/png','image/jpeg'].includes(checked.mime))return [{...checked}];
  if(!pythonPath)throw new Error('media_decoder_unavailable');
  const realRoot=await fs.realpath(root);
  const python=await fs.realpath(pythonPath);
  if(!isPortableAbsolute(realRoot)||!isPortableAbsolute(python)||!(await fs.stat(python)).isFile())throw new Error('media_decoder_boundary');
  const temp=path.join(realRoot,'temp');await fs.mkdir(temp,{recursive:true});
  if(!(await fs.realpath(temp)).startsWith(realRoot+path.sep))throw new Error('media_decoder_boundary');
  const count=Math.max(1,Math.min(3,Math.trunc(maxFrames)||1));
  const raw=await new Promise((resolve,reject)=>{
    let settled=false,child,total=0,parts=[];
    const finish=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);child?.kill();error?reject(error):resolve(value);};
    const timer=setTimeout(()=>finish(new Error('media_decoder_timeout')),Math.max(100,Math.min(30000,timeoutMs)));
    try {
      const env={...process.env,TEMP:temp,TMP:temp,PYTHONNOUSERSITE:'1',PYTHONDONTWRITEBYTECODE:'1'};
      for(const key of Object.keys(env))if(/(?:TOKEN|SECRET|PASSWORD|API_KEY|CODEX|OPENAI|PYTHONPATH|PYTHONHOME)/i.test(key))delete env[key];
      child=spawnProcess(python,['-B','-I','-c',DECODE,String(count)],{cwd:realRoot,windowsHide:true,stdio:['pipe','pipe','pipe'],env});
      child.on('error',()=>finish(new Error('media_decoder_unavailable')));
      child.stdout.on('data',chunk=>{total+=chunk.length;if(total>MAX_IMAGE_BYTES*4+4096)return finish(new Error('media_decoder_output_limit'));parts.push(chunk);});
      child.stderr.on('data',()=>{});
      child.stdin.on('error',()=>finish(new Error('media_decoder_failed')));
      child.on('close',code=>{if(code!==0)return finish(new Error('media_decoder_failed'));finish(null,Buffer.concat(parts).toString('utf8'));});
      child.stdin.end(checked.buffer);
    }catch{finish(new Error('media_decoder_unavailable'));}
  });
  let result;try{result=JSON.parse(raw);}catch{throw new Error('media_decoder_invalid_output');}
  if(result.count!==checked.frameCount||!Array.isArray(result.frames)||!result.frames.length||result.frames.length>count)throw new Error('media_decoder_invalid_output');
  const indices=result.frames.map(item=>item.index);
  if(new Set(indices).size!==indices.length||indices.some(index=>!Number.isInteger(index)||index<0||index>=checked.frameCount))throw new Error('media_decoder_invalid_output');
  return result.frames.map(item=>{
    if(typeof item.data!=='string'||!/^[A-Za-z0-9+/]+={0,2}$/.test(item.data))throw new Error('media_decoder_invalid_output');
    const frame=inspectImage(Buffer.from(item.data,'base64'),'image/png');
    if(frame.width!==checked.width||frame.height!==checked.height)throw new Error('media_decoder_invalid_output');
    return {...frame,source_mime:checked.mime,source_sha256:checked.sha256,animated:checked.animated,frame_index:item.index,frame_count:checked.frameCount,
      animation_note:checked.animated?`动态图共 ${checked.frameCount} 帧，仅查看采样帧 ${indices.map(index=>index+1).join('、')}；不能据此声称看过完整动画。`:'由静态 WebP/GIF 转为 PNG，画面尺寸保持不变。'};
  });
}
