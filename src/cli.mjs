import {isKeylessLocalApi} from './model_providers.mjs';
import {fileURLToPath} from 'node:url';
import {dirname,join} from 'node:path';
import {readFile,mkdir,copyFile,access} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createInterface} from 'node:readline/promises';
import {defaults,loadEnv,openPublicConfig} from './public_config.mjs';
import {generator,chatGenerator} from './model_client.mjs';
import {loadExtensions,loadConfiguredExtensions,wrapGenerate} from './extensions.mjs';
import {startLocalConsole} from './local_console.mjs';
const root=dirname(dirname(fileURLToPath(import.meta.url)));
await mkdir(join(root,'temp'),{recursive:true});
await loadEnv(root);
const store=await openPublicConfig(root),command=process.argv[2]||'doctor';
const flags=new Set(process.argv.slice(3));
if(command==='init'){
 let exists=true;try{await access(join(root,'config.local.json'));}catch{exists=false;}
 let c=store.get();if(!exists){await store.update(c);try{await copyFile(join(root,'.env.example'),join(root,'.env'),1);}catch(e){if(e.code!=='EEXIST')throw e;}}
 if(process.env.QQ_PAIRING_CODE){c=await store.update({pairingHash:createHash('sha256').update(process.env.QQ_PAIRING_CODE).digest('hex')});}
 console.log('配置已准备，现有配置不会被覆盖。\n1. npm run demo（离线，不需要账号）\n2. .env 填 QQ_APP_ID、QQ_APP_SECRET、QQ_PAIRING_CODE 和模型密钥\n3. 再运行 npm run init 生成配对哈希；在面板选择模型和允许的群/私聊ID\n4. npm run doctor 检查，再 npm start\nQQ 必须是官方机器人应用，不是个人QQ号。');
}else if(command==='doctor'){
 const c=store.get(),checks=[{id:'node',ok:Number(process.versions.node.split('.')[0])>=22,detail:'Node.js >= 22 required; current '+process.version},{id:'config',ok:true,detail:'schemaVersion=1; config validated'},{id:'qq_credentials',ok:Boolean((process.env.QQ_APP_ID||c.appId)&&process.env.QQ_APP_SECRET),detail:'QQ official AppID/AppSecret; no values displayed'},{id:'pairing',ok:Boolean(c.pairingHash),detail:'Set QQ_PAIRING_CODE in .env then npm run init'},{id:'allowed_targets',ok:c.scope.groups.length+c.scope.privateUsers.length>0,detail:'Empty lists intentionally reject all real conversations'},{id:'model',ok:c.modelProvider.type==='mock'||c.modelProvider.type==='codex'&&Boolean(process.env.CODEX_CLI_PATH)||c.modelProvider.type==='openai-compatible'&&Boolean(c.modelProvider.model&&(process.env[c.modelProvider.envKey]||isKeylessLocalApi(c.modelProvider.baseURL))),detail:c.modelProvider.type+'; credentials not tested online'}];
 const report={status:checks.every(x=>x.ok)?'ready':'needs_setup',platform:process.platform,checks,networkTested:false,next:'npm run demo; configure local files; npm start'};console.log(flags.has('--json')?JSON.stringify(report):checks.map(x=>(x.ok?'OK ':'SETUP ')+x.id+': '+x.detail).join('\n')); // Missing optional setup is diagnostic, not CI failure.
}else if(command==='start'){await import('./main.mjs');
}else if(command==='demo'||command==='panel'){
 const demo=command==='demo';
 const config=store.get();if(demo)config.modelProvider={...config.modelProvider,type:'mock'};
 const extensions=await loadConfiguredExtensions({root,paths:config.plugins,config,offline:demo});
 const generate=()=>wrapGenerate(chatGenerator(root,config),extensions);
 const server=await startLocalConsole({root,port:flags.has('--smoke')?0:config.consolePort,callbacks:{
   publicConfig:()=>store.get(),updatePublicConfig:async patch=>{if('plugins'in patch)throw Error('plugins_require_restart');Object.assign(config,await store.update(patch));if(demo)config.modelProvider={...config.modelProvider,type:'mock'};return {ok:true,restart:[]};},
   capabilities:()=>({official_qq_transport:!demo,character_card:true,chat:true,model:config.modelProvider.type,vision:!demo&&config.media.vision,asr:extensions.supports('asr'),tts:extensions.supports('tts'),web_search:config.modelProvider.type==='codex',native_image_generation:false,plugins:extensions.ids}),
   demoChat:async body=>{if(typeof body.text!=='string'||!body.text.trim()||body.text.length>2000)throw Error('invalid_demo_text');return generate()({text:body.text,history:[],memory:[]});},
   settings:()=>({proactiveEnabled:false,allowWebSearch:false,spontaneousStickers:false,allowImageCreation:false})}});
 if(demo&&config.plugins.length)console.log('Configured plugins disabled in offline demo.');
 console.log((demo?'Offline Mock demo':'Configuration panel')+': '+server.url+' (QQ is not connected)');
 if(flags.has('--smoke')){try{const page=await (await fetch(server.url)).text();const csrf=page.match(/const csrf='([^']+)'/)?.[1];const result=await fetch(server.url+'/api/demo',{method:'POST',headers:{origin:server.url,'content-type':'application/json','x-console-csrf':csrf},body:JSON.stringify({text:'hello'})});const value=await result.json();if(!result.ok||!value.reply?.includes('hello'))throw Error('demo_smoke_failed');console.log('DEMO_SMOKE_OK');}finally{await server.close();}}
 else{const close=async()=>{await server.close();process.exit(0);};process.once('SIGINT',close);process.once('SIGTERM',close);}
}else if(command==='chat'){
 const config=store.get(),extensions=await loadExtensions({root,paths:config.plugins,config}),generate=wrapGenerate(generator(root,config),extensions);
 const rl=createInterface({input:process.stdin,output:process.stdout}),history=[];
 try{while(true){const text=await rl.question('You > ');if(text==='/quit')break;const output=await generate({text,history,memory:[]});const answer=typeof output==='string'?output:output.reply;console.log('小柯 > '+answer);history.push({role:'user',content:text},{role:'assistant',content:answer});history.splice(0,Math.max(0,history.length-40));}}finally{rl.close();}
}else{console.error('Commands: init | doctor [--json] | demo [--smoke] | panel | chat | start');process.exitCode=1;}
