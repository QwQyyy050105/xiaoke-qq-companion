import { createHash } from 'node:crypto';

// Keep base64 plus JSON safely below QQ's documented 5 MB direct-upload limit.
export const MAX_IMAGE_BYTES = 3 * 1024 * 1024;
export const MAX_IMAGE_PIXELS = 16_000_000;
export const MAX_ANIMATION_FRAMES = 240;
export const MAX_ANIMATION_PIXELS = 160_000_000;
const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

/** Extended received formats are opt-in; generated output and ordinary QQ upload stay PNG/JPEG. */
export function inspectImage(buffer, expectedMime = '', {allowExtended=false}={}) {
  if (!Buffer.isBuffer(buffer) || !buffer.length || buffer.length > MAX_IMAGE_BYTES) throw new Error('media_image_size');
  let mime, width, height, frameCount;
  if (buffer.subarray(0, 8).equals(PNG)) {
    let offset = 8, data = false, end = false, first = true;
    while (offset + 12 <= buffer.length) {
      const length = buffer.readUInt32BE(offset);
      if (length > buffer.length - offset - 12) throw new Error('media_invalid_png');
      const type = buffer.toString('ascii', offset + 4, offset + 8);
      if (first && (type !== 'IHDR' || length !== 13)) throw new Error('media_invalid_png');
      if (type === 'IHDR') {
        if (!first) throw new Error('media_invalid_png');
        width = buffer.readUInt32BE(offset + 8); height = buffer.readUInt32BE(offset + 12);
      }
      if (type === 'acTL') throw new Error('media_animated_png_unsupported');
      if (type === 'IDAT') data = true;
      offset += length + 12; first = false;
      if (type === 'IEND') { end = length === 0 && offset === buffer.length; break; }
    }
    if (!data || !end) throw new Error('media_invalid_png');
    mime = 'image/png';
  } else if (buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer.at(-2) === 0xff && buffer.at(-1) === 0xd9) {
    let offset = 2, scan = false;
    while (offset + 4 <= buffer.length) {
      if (buffer[offset++] !== 0xff) throw new Error('media_invalid_jpeg');
      while (buffer[offset] === 0xff) offset++;
      const marker = buffer[offset++];
      if (marker === 0xda) { scan = true; break; }
      const length = buffer.readUInt16BE(offset);
      if (length < 2 || offset + length > buffer.length) throw new Error('media_invalid_jpeg');
      if ([0xc0, 0xc1, 0xc2].includes(marker)) {
        if (length < 8 || width !== undefined) throw new Error('media_invalid_jpeg');
        height = buffer.readUInt16BE(offset + 3); width = buffer.readUInt16BE(offset + 5);
      }
      offset += length;
    }
    if (!scan) throw new Error('media_invalid_jpeg');
    mime = 'image/jpeg';
  } else if(allowExtended && ['GIF87a','GIF89a'].includes(buffer.toString('ascii',0,6))) {
    if(buffer.length<14)throw new Error('media_invalid_gif');
    mime='image/gif';width=buffer.readUInt16LE(6);height=buffer.readUInt16LE(8);frameCount=0;
    let offset=13+(buffer[10]&128?3*(2**((buffer[10]&7)+1)):0),ended=false;
    const blocks=()=>{while(offset<buffer.length){const length=buffer[offset++];if(!length)return;if(offset+length>buffer.length)throw new Error('media_invalid_gif');offset+=length;}throw new Error('media_invalid_gif');};
    while(offset<buffer.length) {
      const marker=buffer[offset++];
      if(marker===0x3b){ended=offset===buffer.length;break;}
      if(marker===0x21){if(offset>=buffer.length)throw new Error('media_invalid_gif');offset++;blocks();continue;}
      if(marker!==0x2c||offset+9>buffer.length)throw new Error('media_invalid_gif');
      const x=buffer.readUInt16LE(offset),y=buffer.readUInt16LE(offset+2),w=buffer.readUInt16LE(offset+4),h=buffer.readUInt16LE(offset+6),packed=buffer[offset+8];
      if(!w||!h||x+w>width||y+h>height)throw new Error('media_image_dimensions');
      offset+=9+(packed&128?3*(2**((packed&7)+1)):0);
      if(offset>=buffer.length||buffer[offset]<2||buffer[offset]>8)throw new Error('media_invalid_gif');
      offset++;blocks();frameCount++;if(frameCount>MAX_ANIMATION_FRAMES)throw new Error('media_animation_frames');
    }
    if(!ended||!frameCount)throw new Error('media_invalid_gif');
  } else if(allowExtended && buffer.length>=20 && buffer.toString('ascii',0,4)==='RIFF'&&buffer.toString('ascii',8,12)==='WEBP') {
    if(buffer.readUInt32LE(4)+8!==buffer.length)throw new Error('media_invalid_webp');
    mime='image/webp';let offset=12,imageData=false,animation=false;frameCount=0;
    while(offset+8<=buffer.length) {
      const kind=buffer.toString('ascii',offset,offset+4),length=buffer.readUInt32LE(offset+4),start=offset+8;
      if(length>buffer.length-start)throw new Error('media_invalid_webp');
      if(kind==='VP8X') {if(length!==10||width!==undefined)throw new Error('media_invalid_webp');width=1+buffer.readUIntLE(start+4,3);height=1+buffer.readUIntLE(start+7,3);animation=!!(buffer[start]&2);}
      else if(kind==='VP8 ') {if(length<10||buffer.toString('hex',start+3,start+6)!=='9d012a')throw new Error('media_invalid_webp');if(width===undefined){width=buffer.readUInt16LE(start+6)&0x3fff;height=buffer.readUInt16LE(start+8)&0x3fff;}imageData=true;}
      else if(kind==='VP8L') {if(length<5||buffer[start]!==0x2f)throw new Error('media_invalid_webp');if(width===undefined){width=1+((buffer[start+1]|buffer[start+2]<<8)&0x3fff);height=1+((buffer[start+2]>>6|buffer[start+3]<<2|buffer[start+4]<<10)&0x3fff);}imageData=true;}
      else if(kind==='ANMF') {if(!animation||length<16)throw new Error('media_invalid_webp');const x=2*buffer.readUIntLE(start,3),y=2*buffer.readUIntLE(start+3,3),w=1+buffer.readUIntLE(start+6,3),h=1+buffer.readUIntLE(start+9,3);if(x+w>width||y+h>height)throw new Error('media_image_dimensions');frameCount++;if(frameCount>MAX_ANIMATION_FRAMES)throw new Error('media_animation_frames');}
      offset=start+length+(length&1);
    }
    if(offset!==buffer.length||!(animation?frameCount:imageData))throw new Error('media_invalid_webp');
    if(!animation)frameCount=1;
  } else throw new Error('media_unsupported_image');
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || width > 16384 || height > 16384 || width * height > MAX_IMAGE_PIXELS) throw new Error('media_image_dimensions');
  if(frameCount&&width*height*frameCount>MAX_ANIMATION_PIXELS)throw new Error('media_animation_dimensions');
  const expected = String(expectedMime).split(';')[0].trim().toLowerCase();
  if (expected && !['application/octet-stream', 'binary/octet-stream', mime].includes(expected)) throw new Error('media_image_mime_mismatch');
  const sha256 = createHash('sha256').update(buffer).digest('hex');
  const extension={'image/png':'png','image/jpeg':'jpg','image/gif':'gif','image/webp':'webp'}[mime];
  return { buffer, mime, width, height, sha256, fileName: `image_${sha256.slice(0, 16)}.${extension}`,
    ...(frameCount!==undefined?{animated:frameCount>1,frameCount}:{} ) };
}
