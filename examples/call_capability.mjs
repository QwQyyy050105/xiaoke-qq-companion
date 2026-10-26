// Run: node examples/call_capability.mjs
// Installs only this explicit offline example, never the owner's plugins.
import {loadExtensions} from '../src/extensions.mjs';
const root=new URL('..',import.meta.url);
const {fileURLToPath}=await import('node:url');
const extensions=await loadExtensions({root:fileURLToPath(root),paths:['./examples/plugins/mock_search.mjs']});
console.log(await extensions.call('search',{query:'template extension'}));
console.log(await extensions.call('asr',{audioId:'synthetic-fixture'})); // unsupported
