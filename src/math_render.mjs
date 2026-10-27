import {isAbsolute as isPortableAbsolute} from 'node:path';
import { readFile, writeFile, mkdir, mkdtemp, rm, stat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { mathChatRows, mathChatGroups } from './math_chat_projection.mjs';
export { mathChatRows, mathChatGroups } from './math_chat_projection.mjs';

const require = createRequire(import.meta.url);
const WIDTH = 720, HEIGHT = 1040, MAX_PAGES = 12, MAX_BYTES = 3 * 1024 * 1024;
const escape = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const unsupported = /\\(?:href|url|includegraphics|html\w*|def|gdef|edef|xdef|newcommand|renewcommand|providecommand|let|futurelet|input|include|write|catcode|csname|class|style|cssId|tiny|scriptsize|footnotesize|small|large|Large|LARGE|huge|Huge)\b/;
let cssPromise;
async function physicalD(file,inside) {
  const resolved=await realpath(file);
  if(!isPortableAbsolute(resolved))throw Error('math_path_must_be_physical_D');
  if(inside){const rel=path.relative(inside,resolved);if(rel==='..'||rel.startsWith('..'+path.sep)||path.isAbsolute(rel))throw Error('math_path_outside_project');}
  return resolved;
}

export function validateMathDocument(value) {
  if (!value || typeof value!=='object' || Array.isArray(value) || typeof value.title!=='string' || !value.title.trim() || value.title.length>80
    || typeof value.summary!=='string' || value.summary.length>1200 || !Array.isArray(value.blocks) || value.blocks.length<1 || value.blocks.length>32) throw Error('math_document_invalid');
  let chars=0, mathCount=0;
  const blocks=value.blocks.map(block=>{
    if(!block || !['text','math'].includes(block.type) || typeof block.content!=='string' || !block.content.trim() || block.content.length>4000)throw Error('math_document_invalid');
    chars+=block.content.length;
    if(chars>24000)throw Error('math_document_too_long');
    if(block.type==='math'){
      mathCount++;
      if(unsupported.test(block.content))throw Error('math_command_not_allowed');
    }
    return {type:block.type,content:block.content.trim()};
  });
  if(!mathCount)throw Error('math_document_no_formulas');
  return {title:value.title.trim(),blocks,summary:value.summary.trim()};
}

async function fontCss() {
  if(!cssPromise)cssPromise=(async()=>{
    const base=await physicalD(path.dirname(require.resolve('katex/package.json')));
    const css=await readFile(path.join(base,'dist','katex.min.css'),'utf8');
    const urls=[...new Set([...css.matchAll(/url\(([^)]+)\)/g)].map(m=>m[1].replace(/["']/g,'')))];
    let embedded=css;
    for(const url of urls){
      if(!/^fonts\/[\w.-]+\.(woff2?|ttf)$/.test(url))throw Error('math_font_path_invalid');
      const bytes=await readFile(await physicalD(path.join(base,'dist',url),base));
      const mime=url.endsWith('.woff2')?'font/woff2':url.endsWith('.woff')?'font/woff':'font/ttf';
      embedded=embedded.split(url).join(`data:${mime};base64,${bytes.toString('base64')}`);
    }
    return embedded;
  })();
  return cssPromise;
}

export async function mathHtml(value) {
  const doc=validateMathDocument(value);
  const {default:katex}=await import('katex');
  const blocks=doc.blocks.map((block,index)=>{
    if(block.type==='text')return `<section class="block prose" data-index="${index}">${escape(block.content).replace(/\n/g,'<br>')}</section>`;
    let html;
    try{html=katex.renderToString(block.content,{displayMode:true,output:'htmlAndMathml',throwOnError:true,trust:false,strict:'error',maxSize:8,maxExpand:500});}
    catch{throw Error('math_formula_invalid');}
    return `<section class="block formula" data-index="${index}">${html}</section>`;
  }).join('');
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; font-src data:; img-src data:"><title>${escape(doc.title)}</title><style>${await fontCss()}
*{box-sizing:border-box}html,body{margin:0;background:#fff;color:#20202a;font-family:"Microsoft YaHei","Noto Sans CJK SC",sans-serif}body{width:${WIDTH}px}.sheet{width:${WIDTH}px;height:${HEIGHT}px;padding:36px 38px 54px;position:relative;overflow:hidden;background:#fff;break-after:page;page-break-after:always}.sheet:last-child{break-after:auto;page-break-after:auto}.header{padding-bottom:18px;border-bottom:2px solid #d9d1e8;margin-bottom:20px}.eyebrow{font-size:16px;letter-spacing:2px;color:#695778;margin-bottom:8px}.title{font-size:32px;font-weight:700;line-height:1.4;overflow-wrap:anywhere}.content{height:818px}.block{break-inside:avoid;margin:0 0 18px}.prose{font-size:26px;line-height:1.65;white-space:normal;overflow-wrap:anywhere}.formula{font-size:30px;line-height:1.5;padding:8px 0 10px;text-align:center}.katex{font-size:1.08em}.katex-display{margin:0;overflow:visible}.footer{position:absolute;bottom:22px;left:38px;right:38px;display:flex;justify-content:space-between;color:#776a83;font-size:15px;border-top:1px solid #e6e1eb;padding-top:10px}#source{width:644px}#source .block{margin:0 0 18px}@page{size:${WIDTH}px ${HEIGHT}px;margin:0} @media print{body{width:${WIDTH}px}.sheet{-webkit-print-color-adjust:exact;print-color-adjust:exact}}
.formula.wrap .katex,.formula.wrap .katex-html{white-space:normal}.formula.wrap .base{margin-bottom:.25em}
</style></head><body><div id="source">${blocks}</div></body></html>`;
}

const CHAT_WIDTH=448,CHAT_HEIGHT=640,CHAT_CONTENT_WIDTH=400;

export async function mathChatHtml(value) {
  const doc=validateMathDocument(value);
  const {default:katex}=await import('katex');
  const blocks=doc.blocks.flatMap((block,index)=>{
    if(block.type==='text')return [`<section class="block prose" data-index="${index}" data-fragment="0">${escape(block.content).replace(/\n/g,'<br>')}</section>`];
    return mathChatRows(block.content).map((row,fragment)=>{
      let html;
      try{html=mathChatGroups(row).map(group=>`<span class="math-group">${katex.renderToString(group,{displayMode:true,output:'htmlAndMathml',throwOnError:true,trust:false,strict:'error',maxSize:8,maxExpand:500})}</span>`).join(' ');}
      catch{throw Error('math_formula_invalid');}
      return `<section class="block formula" data-index="${index}" data-fragment="${fragment}">${html}</section>`;
    });
  }).join('');
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; font-src data:; img-src data:"><title>${escape(doc.title)}</title><style>${await fontCss()}
*{box-sizing:border-box}html,body{margin:0;background:#fff;color:#20202a;font-family:"Microsoft YaHei","Noto Sans CJK SC",sans-serif}body{width:${CHAT_WIDTH}px}.sheet{width:${CHAT_WIDTH}px;height:${CHAT_HEIGHT}px;padding:22px 24px 48px;position:relative;overflow:hidden;background:#fff}.header{padding-bottom:12px;border-bottom:2px solid #d9d1e8;margin-bottom:18px}.title{font-size:30px;font-weight:700;line-height:1.35;overflow-wrap:anywhere}.block{margin:0 0 18px;break-inside:avoid}.prose{font-size:28px;line-height:1.55;white-space:normal;overflow-wrap:anywhere}.formula{font-size:32px;line-height:1.5;padding:6px 0;text-align:center}.math-group{display:inline-block;vertical-align:middle;max-width:100%;margin-bottom:.25em}.katex{font-size:1.08em}.katex-display{margin:0;overflow:visible}.formula.wrap .katex,.formula.wrap .katex-html{white-space:normal}.formula.wrap .base{margin-bottom:.25em}.footer{position:absolute;bottom:18px;left:24px;right:24px;display:flex;justify-content:space-between;color:#776a83;font-size:20px;border-top:1px solid #e6e1eb;padding-top:8px}#source{width:${CHAT_CONTENT_WIDTH}px}
</style></head><body><div id="source">${blocks}</div></body></html>`;
}

function visibleChatBlocks(doc,box) {
  return box.fragments.map(({blockIndex,fragment})=>({blockIndex,fragment,
    content:doc.blocks[blockIndex].type==='math'?mathChatRows(doc.blocks[blockIndex].content)[fragment]:doc.blocks[blockIndex].content}));
}

async function layoutMathChatPage(page,doc) {
  return page.evaluate(({title,width,height,contentWidth})=>{
      const source=document.querySelector('#source'),blocks=[...source.children];
      for(const block of blocks){
        const glyph=block.querySelector('.katex-html');
        if(block.scrollWidth>contentWidth+1||(glyph&&glyph.getBoundingClientRect().width>contentWidth+1))block.classList.add('wrap');
        if(block.scrollWidth>contentWidth+1||(glyph&&glyph.getBoundingClientRect().width>contentWidth+1))return {error:'math_formula_too_wide'};
      }
      const pages=[];
      function addPage(){
        const sheet=document.createElement('article');sheet.className='sheet';
        const header=document.createElement('header');header.className='header';
        const heading=document.createElement('div');heading.className='title';heading.textContent=title;header.append(heading);
        const content=document.createElement('main');content.className='content';
        const footer=document.createElement('footer');footer.className='footer';sheet.append(header,content,footer);document.body.append(sheet);
        const available=height-62-content.getBoundingClientRect().top+sheet.getBoundingClientRect().top;content.style.height=available+'px';
        const item={sheet,content,footer,available};pages.push(item);return item;
      }
      let current=addPage();
      for(const block of blocks){
        const clone=block.cloneNode(true);current.content.append(clone);
        if(current.content.scrollHeight>current.available+1){
          clone.remove();if(!current.content.children.length)return {error:'math_block_too_tall'};
          if(pages.length>=32)return {error:'math_too_many_pages'};
          current=addPage();current.content.append(clone);if(current.content.scrollHeight>current.available+1)return {error:'math_block_too_tall'};
        }
      }
      source.remove();
      pages.forEach(({footer},index)=>{const left=document.createElement('span'),right=document.createElement('span');left.textContent='小柯 · 公式讲解';right.textContent=`${index+1} / ${pages.length}`;footer.append(left,right);});
      return {pages:pages.length,boxes:pages.map(({sheet,content})=>({width:sheet.offsetWidth,height:sheet.offsetHeight,overflow:content.scrollHeight>content.clientHeight+1,blockIndexes:[...new Set([...content.children].map(x=>Number(x.dataset.index)))],fragments:[...content.children].map(x=>({blockIndex:Number(x.dataset.index),fragment:Number(x.dataset.fragment)}))}))};
    },{title:doc.title,width:CHAT_WIDTH,height:CHAT_HEIGHT,contentWidth:CHAT_CONTENT_WIDTH});
}

/** Preview-only QQ size correction. The production document/PDF path is unchanged. */
export async function renderMathChatPreview({root,document,signal}={}) {
  if(typeof root!=='string'||!isPortableAbsolute(root))throw Error('math_root_must_be_D');
  root=await physicalD(root);const doc=validateMathDocument(document);signal?.throwIfAborted();
  const html=await mathChatHtml(doc),binary=await runtimePath(root);
  const base=path.join(root,'research','math_layout_preview');
  await mkdir(base,{recursive:true});await physicalD(base,root);
  const review=JSON.parse(await readFile(path.join(base,'size_review.json'),'utf8'));
  if(!['fail','pass'].includes(review.entries?.at(-1)?.judgment)||!review.entries.at(-1).planned_correction)throw Error('math_preview_size_review_required');
  const outputDir=path.join(base,'chat_cards'),profile=await mkdtemp(path.join(base,'browser_'));
  await physicalD(profile,base);let context,timeout,abortHandler,created=false,complete=false;
  const cleanupWarnings=[];
  try{
    // No reuse/overwrite: a revised preview requires a new reviewed operation.
    await mkdir(outputDir);created=true;await physicalD(outputDir,base);
    const env={TEMP:base,TMP:base};
    for(const key of ['SystemRoot','WINDIR','PATH','PATHEXT','COMSPEC','NUMBER_OF_PROCESSORS','PROCESSOR_ARCHITECTURE'])if(process.env[key])env[key]=process.env[key];
    abortHandler=()=>void context?.close().catch(()=>{});signal?.addEventListener('abort',abortHandler,{once:true});
    timeout=setTimeout(abortHandler,30000);timeout.unref();
    const {chromium}=await import('playwright-core');
    signal?.throwIfAborted();
    context=await chromium.launchPersistentContext(profile,{executablePath:binary,headless:true,viewport:{width:CHAT_WIDTH,height:CHAT_HEIGHT},deviceScaleFactor:2,timeout:10000,javaScriptEnabled:false,serviceWorkers:'block',acceptDownloads:false,env,args:['--disable-background-networking','--disable-sync','--no-first-run','--disable-extensions','--disable-gpu']});
    signal?.throwIfAborted();await context.route('**/*',route=>route.abort());
    const page=context.pages()[0]||await context.newPage();await page.setContent(html,{waitUntil:'load',timeout:10000});await page.evaluate(()=>document.fonts.ready);
    const layout=await layoutMathChatPage(page,doc);
    if(layout.error)throw Error(layout.error);if(layout.boxes.some(x=>x.overflow))throw Error('math_layout_overflow');
    const sourcePath=path.join(outputDir,'source.json'),htmlPath=path.join(outputDir,'cards.html');
    await writeFile(sourcePath,JSON.stringify(doc,null,2)+'\n');await writeFile(htmlPath,await page.content());
    const images=[];
    for(let index=0;index<layout.pages;index++){
      signal?.throwIfAborted();const fileName=`card_${String(index+1).padStart(2,'0')}.png`,file=path.join(outputDir,fileName);
      const buffer=await page.locator('.sheet').nth(index).screenshot({path:file,type:'png',animations:'disabled',timeout:10000});
      if(buffer.length>MAX_BYTES)throw Error('math_image_too_large');
      images.push({path:file,buffer,mime:'image/png',fileName,blockIndexes:layout.boxes[index].blockIndexes,fragments:layout.boxes[index].fragments,visibleBlocks:visibleChatBlocks(doc,layout.boxes[index]),width:CHAT_WIDTH*2,height:CHAT_HEIGHT*2});
    }
    complete=true;return {outputDir,images,sourcePath,htmlPath,layout,cleanupWarnings};
  }finally{
    clearTimeout(timeout);signal?.removeEventListener('abort',abortHandler);await context?.close().catch(()=>{});
    await physicalD(profile,base).then(()=>rm(profile,{recursive:true,force:true,maxRetries:3,retryDelay:100})).catch(error=>{if(error.code!=='ENOENT')cleanupWarnings.push('browser_profile_cleanup_incomplete');});
    if(created&&!complete)await physicalD(outputDir,base).then(()=>rm(outputDir,{recursive:true,force:true})).catch(error=>{if(error.code!=='ENOENT')cleanupWarnings.push('failed_output_cleanup_incomplete');});
  }
}

async function runtimePath(root) {
  const runtime=JSON.parse(await readFile(path.join(root,'runtime','math_runtime.json'),'utf8'));
  const binary=runtime.chromiumPath;
  if(typeof binary!=='string'||!isPortableAbsolute(binary)||!(await stat(binary)).isFile())throw Error('math_runtime_unavailable');
  return physicalD(binary,root);
}

/** Deterministic offline typesetting. No image-generation model, remote page or user HTML executes. */
export async function renderMathReply({root,document,signal,sizeProof=false}={}) {
  if(typeof root!=='string'||!isPortableAbsolute(root))throw Error('math_root_must_be_D');
  root=await physicalD(root);
  const doc=validateMathDocument(document);
  signal?.throwIfAborted();
  const html=await mathHtml(doc),binary=await runtimePath(root);
  const tempRoot=path.join(root,'temp','math_render');
  await mkdir(tempRoot,{recursive:true});
  await physicalD(tempRoot,root);
  const profile=await mkdtemp(path.join(tempRoot,'browser_'));
  await physicalD(profile,tempRoot);
  const id=randomUUID(),outputDir=path.join(root,'data','math_documents',id);
  const cleanupWarnings=[];
  let context,timeout,abortHandler,complete=false;
  try{
    const browserEnv={TEMP:tempRoot,TMP:tempRoot};
    for(const key of ['SystemRoot','WINDIR','PATH','PATHEXT','COMSPEC','NUMBER_OF_PROCESSORS','PROCESSOR_ARCHITECTURE'])if(process.env[key])browserEnv[key]=process.env[key];
    abortHandler=()=>void context?.close().catch(()=>{});
    signal?.addEventListener('abort',abortHandler,{once:true});
    timeout=setTimeout(abortHandler,30000);timeout.unref();
    const {chromium}=await import('playwright-core');
    signal?.throwIfAborted();
    context=await chromium.launchPersistentContext(profile,{executablePath:binary,headless:true,viewport:{width:WIDTH,height:HEIGHT},deviceScaleFactor:2,
      timeout:10000,javaScriptEnabled:false,serviceWorkers:'block',acceptDownloads:false,env:browserEnv,
      args:['--disable-background-networking','--disable-sync','--no-first-run','--disable-extensions','--disable-gpu']});
    signal?.throwIfAborted();
    await context.route('**/*',route=>route.abort());
    const page=context.pages()[0]||await context.newPage();
    await page.setContent(html,{waitUntil:'load',timeout:10000});
    await page.evaluate(()=>document.fonts.ready);
    // Keep the fixed type size. An overwide or oversize formula is rejected, never silently shrunk/cropped.
    const pdfLayout=await page.evaluate(({title,width,height,maxPages})=>{
      const source=document.querySelector('#source'),blocks=[...source.children];
      for(const block of blocks){
        const glyph=block.querySelector('.katex-html');
        // KaTeX's base atoms keep fractions/brackets intact and supply legal
        // relation/binary-operation break opportunities. No TeX is rewritten.
        if(block.scrollWidth>646||(glyph&&glyph.getBoundingClientRect().width>644))block.classList.add('wrap');
        if(block.scrollWidth>646||(glyph&&glyph.getBoundingClientRect().width>644))return {error:'math_formula_too_wide'};
      }
      const pages=[];
      function addPage(){
        const sheet=document.createElement('article');sheet.className='sheet';
        const header=document.createElement('header');header.className='header';
        const label=document.createElement('div');label.className='eyebrow';label.textContent='小柯 · 公式讲解';
        const heading=document.createElement('div');heading.className='title';heading.textContent=title;
        header.append(label,heading);
        const content=document.createElement('main');content.className='content';
        const footer=document.createElement('footer');footer.className='footer';
        sheet.append(header,content,footer);document.body.append(sheet);
        const available=height-54-content.getBoundingClientRect().top+sheet.getBoundingClientRect().top;
        content.style.height=available+'px';
        const item={sheet,content,footer,available};pages.push(item);return item;
      }
      let current=addPage();
      for(const block of blocks){
        const clone=block.cloneNode(true);current.content.append(clone);
        if(current.content.scrollHeight>current.available+1){
          clone.remove();
          if(!current.content.children.length)return {error:'math_block_too_tall'};
          if(pages.length>=maxPages)return {error:'math_too_many_pages'};
          current=addPage();current.content.append(clone);
          if(current.content.scrollHeight>current.available+1)return {error:'math_block_too_tall'};
        }
      }
      source.remove();
      pages.forEach(({footer},i)=>{const left=document.createElement('span'),right=document.createElement('span');left.textContent='公式排版 · 可放大查看';right.textContent=`${i+1} / ${pages.length}`;footer.append(left,right);});
      const boxes=pages.map(({sheet,content})=>({width:sheet.offsetWidth,height:sheet.offsetHeight,overflow:content.scrollHeight>content.clientHeight+1,
        blockIndexes:[...content.children].map(block=>Number(block.dataset.index))}));
      return {pages:pages.length,boxes};
    },{title:doc.title,width:WIDTH,height:HEIGHT,maxPages:MAX_PAGES});
    if(pdfLayout.error)throw Error(pdfLayout.error);
    if(pdfLayout.boxes.some(x=>x.overflow))throw Error('math_layout_overflow');
    const outputParent=path.dirname(outputDir);
    await mkdir(outputParent,{recursive:true});await physicalD(outputParent,root);
    await mkdir(outputDir);await physicalD(outputDir,outputParent);
    const sourcePath=path.join(outputDir,'source.json'),htmlPath=path.join(outputDir,'solution.html'),pdfPath=path.join(outputDir,'solution.pdf');
    await writeFile(sourcePath,JSON.stringify(doc,null,2)+'\n');
    await writeFile(htmlPath,await page.content());
    // Preserve the complete paper layout as PDF; QQ images use the reviewed
    // short-card layout so that their224px chat thumbnails remain readable.
    if(!sizeProof)await page.pdf({path:pdfPath,width:WIDTH+'px',height:HEIGHT+'px',printBackground:true,preferCSSPageSize:true,timeout:10000});
    await page.setViewportSize({width:CHAT_WIDTH,height:CHAT_HEIGHT});
    await page.setContent(await mathChatHtml(doc),{waitUntil:'load',timeout:10000});
    await page.evaluate(()=>document.fonts.ready);
    const layout=await layoutMathChatPage(page,doc);
    if(layout.error)throw Error(layout.error);
    if(layout.boxes.some(x=>x.overflow))throw Error('math_layout_overflow');
    const cardsHtmlPath=path.join(outputDir,'cards.html');
    await writeFile(cardsHtmlPath,await page.content());
    const images=[];
    for(let index=0;index<layout.pages;index++){
      signal?.throwIfAborted();
      const fileName=`page_${String(index+1).padStart(2,'0')}.png`,file=path.join(outputDir,fileName);
      const buffer=await page.locator('.sheet').nth(index).screenshot({path:file,type:'png',animations:'disabled',timeout:10000});
      if(buffer.length>MAX_BYTES)throw Error('math_image_too_large');
      images.push({path:file,buffer,mime:'image/png',fileName,width:CHAT_WIDTH*2,height:CHAT_HEIGHT*2,blockIndexes:layout.boxes[index].blockIndexes,fragments:layout.boxes[index].fragments,visibleBlocks:visibleChatBlocks(doc,layout.boxes[index])});
    }
    complete=true;
    return {id,outputDir,images,pdfPath:sizeProof?null:pdfPath,sourcePath,summary:doc.summary,layout,pdfLayout,cardsHtmlPath,cleanupWarnings};
  }finally{
    clearTimeout(timeout);signal?.removeEventListener('abort',abortHandler);
    await context?.close().catch(()=>{});
    const rel=path.relative(tempRoot,profile);
    if(rel&&!rel.startsWith('..')&&!path.isAbsolute(rel))await physicalD(profile,tempRoot).then(()=>rm(profile,{recursive:true,force:true,maxRetries:3,retryDelay:100})).catch(error=>{if(error.code!=='ENOENT')cleanupWarnings.push('browser_profile_cleanup_incomplete');});
    if(!complete){const base=path.join(root,'data','math_documents'),relOutput=path.relative(base,outputDir);if(relOutput&&!relOutput.startsWith('..')&&!path.isAbsolute(relOutput))await physicalD(outputDir,base).then(()=>rm(outputDir,{recursive:true,force:true})).catch(error=>{if(error.code!=='ENOENT')cleanupWarnings.push('failed_output_cleanup_incomplete');});}
    if(cleanupWarnings.length)await writeFile(path.join(tempRoot,'cleanup_warnings.json'),JSON.stringify({at:new Date().toISOString(),profile,outputDir,warnings:cleanupWarnings},null,2)+'\n').catch(()=>{});
  }
}
