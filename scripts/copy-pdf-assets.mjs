import { cp, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const root = path.dirname(require.resolve('pdfjs-dist/package.json'));
await mkdir('public/pdfjs', {recursive:true});
for(const folder of ['cmaps','standard_fonts','wasm']) await cp(path.join(root,folder),`public/pdfjs/${folder}`,{recursive:true});
