import {mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
// Prepare only project-local fixture storage, including on a fresh checkout.
await mkdir(fileURLToPath(new URL('../temp/',import.meta.url)),{recursive:true});
