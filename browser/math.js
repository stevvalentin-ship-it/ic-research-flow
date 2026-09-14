(() => {
'use strict';
const C=ICRF;
const originals=new WeakMap();
let queue=Promise.resolve();
// No raw HTML, no remotely loaded TeX extensions, no links or user-defined macros.
const forbidden=/\\(?:require|autoload|href|url|class|cssId|style|html\w*|includegraphics|def|gdef|edef|xdef|newcommand|renewcommand|let|csname)\b/;
const tokenPattern=/```(?:latex|tex|math)\s*\n([\s\S]*?)```|```[^\n]*\n[\s\S]*?```|\$\$([\s\S]*?)\$\$|\\\[([\s\S]*?)\\\]|\\\(([\s\S]*?)\\\)|(?<![\\$])\$(?!\$)([^\n$]+?)(?<!\\)\$/g;
C.mathHTML=text=>`<div class="math-block"><div class="math-actions"><button class="btn text tiny math-toggle" type="button">显示原始文本 / LaTeX</button><button class="btn text tiny math-copy" type="button">复制原始文本</button></div><div class="math-output prose" data-math>${C.escape(text)}</div><pre class="math-raw" hidden>${C.escape(text)}</pre><small class="math-status" role="status"></small></div>`;
function plain(container, text){container.append(document.createTextNode(text));}
async function convert(el, text, current){
  if(!window.MathJax?.startup?.promise)throw new Error('公式组件未加载，请刷新页面。');
  await MathJax.startup.promise;
  if(!el.isConnected||el.dataset.mathVersion!==current)return;
  const fragment=document.createDocumentFragment();let last=0,count=0,failed=0;
  for(const match of text.matchAll(tokenPattern)){
    plain(fragment,text.slice(last,match.index));last=match.index+match[0].length;
    let formula=match[1]??match[2]??match[3]??match[4]??match[5];
    if(formula===undefined){plain(fragment,match[0]);continue;}
    const display=match[1]!==undefined||match[2]!==undefined||match[3]!==undefined;
    if(++count>80||formula.length>8000||forbidden.test(formula)){
      plain(fragment,match[0]);failed++;continue;
    }
    // Avoid interpreting common dollar-denominated prose as mathematical input.
    if(match[5]!==undefined&&/^\s*\d[\d,.]*\s+(?:and|or|to)\s*$/i.test(formula)){
      plain(fragment,match[0]);continue;
    }
    try{
      const svg=await MathJax.tex2svgPromise(formula,{display});
      if(svg.querySelector('[data-mjx-error], [data-mml-node="merror"]')){
        plain(fragment,match[0]);failed++;
      }else{
        svg.setAttribute('aria-label',formula);svg.setAttribute('role','math');
        fragment.append(svg);
      }
    }catch{plain(fragment,match[0]);failed++;}
  }
  plain(fragment,text.slice(last));
  if(!el.isConnected||el.dataset.mathVersion!==current)return;
  // Direct tex2svg conversion needs the official SVG + assistive MathML CSS.
  // Without it the hidden accessibility expression is visibly duplicated.
  MathJax.startup.document.clear().updateDocument();
  el.replaceChildren(fragment);
  const status=el.closest('.math-block')?.querySelector('.math-status');
  if(status)status.textContent=failed?`${failed} 处公式无法安全排版，已保留原始文本；可修正 LaTeX 后重试。`:'';
}
C.mathRender=(el,text)=>{
  if(!el)return Promise.resolve();
  text=String(text??'');originals.set(el,text);
  const current=String((+el.dataset.mathVersion||0)+1);el.dataset.mathVersion=current;el.textContent=text;
  if(text.length>40000){const status=el.closest('.math-block')?.querySelector('.math-status');if(status)status.textContent='长文本保留完整原文显示，未执行公式排版。';return Promise.resolve();}
  queue=queue.catch(()=>{}).then(()=>convert(el,text,current)).catch(error=>{
    if(el.isConnected&&el.dataset.mathVersion===current){
      el.textContent=text;
      const status=el.closest('.math-block')?.querySelector('.math-status');
      if(status)status.textContent=error.message||'公式排版失败；原始内容保留。';
    }
  });
  return queue;
};
C.mathEnhance=(root=document)=>{
  C.$$('[data-math]',root).forEach(el=>{
    if(originals.has(el))return;
    const block=el.closest('.math-block'),raw=block?.querySelector('.math-raw');
    if(block){
      block.querySelector('.math-toggle').onclick=e=>{const show=raw.hidden;raw.hidden=!show;el.hidden=show;e.currentTarget.textContent=show?'显示公式排版':'显示原始文本 / LaTeX';};
      block.querySelector('.math-copy').onclick=async()=>{try{await navigator.clipboard.writeText(originals.get(el)||raw.textContent);C.toast('原始文本已复制。');}catch{raw.hidden=false;el.hidden=true;C.toast('浏览器未允许自动复制，请从原始文本中手动复制。');}};
    }
    C.mathRender(el,el.textContent);
  });
};
})();
