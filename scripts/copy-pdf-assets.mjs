import { cp, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const root = path.dirname(require.resolve('pdfjs-dist/package.json'));
await mkdir('public/pdfjs', {recursive:true});
for(const folder of ['cmaps','standard_fonts','wasm']) await cp(path.join(root,folder),`public/pdfjs/${folder}`,{recursive:true});

await mkdir('public/vendor/typst', {recursive:true});
for (const [source, name] of [
  ['node_modules/@myriaddreamin/typst-ts-web-compiler/pkg/typst_ts_web_compiler_bg.wasm', 'typst_ts_web_compiler_bg.wasm'],
  ['node_modules/@myriaddreamin/typst-ts-renderer/pkg/typst_ts_renderer_bg.wasm', 'typst_ts_renderer_bg.wasm'],
  ['assets/parallel/noto-serif-sc-400.ttf', 'noto-serif-sc-400.ttf'],
  ['assets/parallel/OFL.txt', 'noto-serif-sc-OFL.txt'],
  ['node_modules/dejavu-fonts-ttf/ttf/DejaVuMathTeXGyre.ttf', 'dejavu-math-tex-gyre.ttf'],
  ['node_modules/dejavu-fonts-ttf/LICENSE', 'dejavu-fonts-LICENSE.txt'],
]) await cp(source, `public/vendor/typst/${name}`);
