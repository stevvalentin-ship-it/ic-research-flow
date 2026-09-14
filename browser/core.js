/* Native ES2022 components: no CDN, npm bootstrap, or template/demo data. */
(() => {
'use strict';
const C=globalThis.ICRF={};
C.$=(s,r=document)=>r.querySelector(s);C.$$=(s,r=document)=>[...r.querySelectorAll(s)];
C.escape=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
C.clamp=(x,a,b)=>Math.max(a,Math.min(b,Number.isFinite(+x)?+x:a));
// Browser storage can be blocked. Fall back explicitly to this page's memory, not a hidden server key store.
const ephemeral={local:new Map(),session:new Map()};C.volatileStorage=false;
C.storage=(kind='local')=>{try{return kind==='session'?window.sessionStorage:window.localStorage}catch{C.volatileStorage=true;const m=ephemeral[kind]||ephemeral.local;return {getItem:k=>m.get(k)??null,setItem:(k,v)=>m.set(k,v),removeItem:k=>m.delete(k)}}};
C.read=(key,fallback,kind='local')=>{try{return JSON.parse(C.storage(kind).getItem(key))??fallback}catch{return fallback}};
C.write=(key,value,kind='local')=>{try{C.storage(kind).setItem(key,JSON.stringify(value));return true}catch{return false}};
C.remove=(key,kind='local')=>{try{C.storage(kind).removeItem(key)}catch{}};
C.paths={book:'M4 19.5A2.5 2.5 0 0 1 6.5 17H20 M6.5 3H20v19H6.5A2.5 2.5 0 0 1 4 19.5v-14A2.5 2.5 0 0 1 6.5 3Z',grid:'M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z',search:'M21 21l-5.2-5.2 M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0',spark:'m12 3 2.8 6.2L21 12l-6.2 2.8L12 21l-2.8-6.2L3 12l6.2-2.8Z',upload:'M12 16V3 m-5 5 5-5 5 5 M3 16v5h18v-5',download:'M12 3v13 m-5-5 5 5 5-5 M3 17v4h18v-4',arrow:'M5 12h14 m-5-5 5 5-5 5',left:'m15 5-7 7 7 7',right:'m9 5 7 7-7 7',close:'m6 6 12 12 M18 6 6 18',check:'m4 12 5 5 11-11',clock:'M12 7v5l3 2 M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0',settings:'M12 8a4 4 0 1 1 0 8 4 4 0 0 1 0-8 M12 2v3 M12 19v3 M2 12h3 M19 12h3 M5 5l2 2 M17 17l2 2 M5 19l2-2 M17 7l2-2',chat:'M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.4 8.4 0 0 1 3.8-.9h.5a8.5 8.5 0 0 1 8 8z',graph:'M12 4v5 M6 16l4-4 M18 16l-4-4 M14 3a2 2 0 1 1-4 0 2 2 0 0 1 4 0 M8 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0 M22 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0 M15 11a3 3 0 1 1-6 0 3 3 0 0 1 6 0',sun:'M12 2v2 M12 20v2 M2 12h2 M20 12h2 M4.9 4.9l1.4 1.4 M17.7 17.7l1.4 1.4 M4.9 19.1l1.4-1.4 M17.7 6.3l1.4-1.4 M17 12a5 5 0 1 1-10 0 5 5 0 0 1 10 0',moon:'M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8',pen:'m16 3 5 5-13 13H3v-5Z M13 6l5 5',box:'M3 3h18v18H3z',text:'M4 4h16 M12 4v16 M8 20h8',link:'M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-2 2 M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l2-2',shield:'M12 3 3 7v6c0 5 9 9 9 9s9-4 9-9V7Z m-5 10 3 3 5-6',file:'M14 2H5v20h14V7Z M14 2v5h5 M8 12h8 M8 16h8',trash:'M3 6h18 M9 6V3h6v3 M5 6l1 15h12l1-15 M10 10v7 M14 10v7',stop:'M5 5h14v14H5z',menu:'M3 6h18 M3 12h18 M3 18h18',expand:'M8 3H3v5 M16 3h5v5 M3 16v5h5 M21 16v5h-5',restore:'M3 12a9 9 0 1 0 3-6 M3 3v6h6',folder:'M3 5h6l2 2h10v14H3Z'};
C.icon=(name,cls='')=>`<svg class="icon ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${C.paths[name]||C.paths.file}"/></svg>`;
C.profile=()=>{
 const saved=C.read('icrf.v3.profile',{}),p=saved&&typeof saved==='object'?saved:{};
 const key=C.read('icrf.v3.key','','session')||C.read('icrf.v3.key','');
 return {base_url:typeof p.base_url==='string'?p.base_url:'https://api.deepseek.com',model:typeof p.model==='string'?p.model:'',api_key:typeof key==='string'?key:''};
};
C.validateProfile=(profile,{requireKey=true,requireModel=true}={})=>{
 if(!profile||typeof profile!=='object')throw new Error('模型配置无效，请到「设置与数据」重新保存。');
 let u;try{u=new URL(profile.base_url)}catch{throw new Error('请填写有效的 HTTPS API 基础地址。')}
 if(u.protocol!=='https:'||u.username||u.password||u.search||u.hash||(u.port&&u.port!=='443')||/[\x00-\x20\x7f]/.test(profile.base_url)||!(C.session?.apiHosts||[]).includes(u.hostname))throw new Error('请使用允许域名、不含账号或查询参数的 HTTPS API 基础地址。');
 const key=typeof profile.api_key==='string'?profile.api_key.trim():'';
 if(requireKey&&!key)throw new Error('请先在「设置与数据」填写 API Key 并保存。');
 if(key&&(key.length>4096||!/^[\x21-\x7e]+$/.test(key)))throw new Error('API Key 含空白、中文或全角符号。请只粘贴密钥本身，不要带 Bearer 前缀或说明文字。');
 if(requireModel&&!(typeof profile.model==='string'&&profile.model.trim()))throw new Error('请先填写账户实际可用的模型 ID 并保存；获取模型列表失败时也可以手动填写。');
 return profile;
};
C.api=async(path,{method='GET',body,signal}={})=>{
 // Never auto-retry AI requests: they may have been processed/billed upstream.
 if(path==='/api/models'&&body)C.validateProfile(body,{requireModel:false});
 else if((path==='/api/chat'||/^\/api\/papers\/[^/]+\/translate$/.test(path))&&body?.profile)C.validateProfile(body.profile);
 const headers={};if(method!=='GET')headers['X-CSRF-Token']=C.session?.csrf||'';
 if(body && !(body instanceof FormData)){headers['Content-Type']='application/json';body=JSON.stringify(body)}
 let res;try{res=await fetch(path,{method,headers,body,signal,credentials:'same-origin'})}catch(e){if(e.name==='AbortError')throw e;throw new Error('无法连接本站服务。请检查启动窗口是否仍在运行；本站没有自动重发请求。')}
 let value;try{value=await res.json()}catch{throw new Error(`本站响应不是有效 JSON（HTTP ${res.status}）。请检查启动窗口；不要连续点击重发。`)}
 if(!res.ok){
  if(res.status===401)C.expired=true;
  const error=new Error(typeof value?.detail==='string'?value.detail:`请求失败（本站 HTTP ${res.status}）`);
  error.status=res.status;error.code=typeof value?.code==='string'?value.code:'';error.upstreamStatus=value?.upstreamStatus;error.action=value?.action;
  throw error;
 }
 return value;
};
C.errorText=e=>{
 const message=e?.message||'操作失败，请重试。';
 return e?.code?`${message} [${e.code}]`:message;
};
C.toast=(message,type='info')=>{let root=C.$('#toasts');if(!root)return;const n=document.createElement('div');n.className='toast '+type;n.setAttribute('role',type==='error'?'alert':'status');n.textContent=message;root.append(n);setTimeout(()=>n.remove(),7000)};
C.error=e=>{if(e?.name!=='AbortError')C.toast(C.errorText(e),'error')};
C.button=(label,action,cls='secondary',icon='')=>`<button class="btn ${cls}" data-action="${action}">${icon?C.icon(icon):''}${C.escape(label)}</button>`;
C.empty=(title,desc,action='')=>`<div class="empty-state">${C.icon('book')}<h2>${C.escape(title)}</h2><p>${C.escape(desc)}</p>${action}</div>`;
C.time=t=>new Date(t*1000).toLocaleString('zh-CN',{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'});
C.elapsed=t=>{const n=Math.max(0,Math.floor(Date.now()/1000-t));return n<60?`${n} 秒`:`${Math.floor(n/60)} 分 ${n%60} 秒`};
C.modal=(title,html,onMount)=>{
 const old=C.$('#dialog');if(old.open)old.close();old.innerHTML=`<header><h2>${C.escape(title)}</h2><button class="icon-btn" data-close aria-label="关闭对话框">${C.icon('close')}</button></header><div class="dialog-body">${html}</div>`;
 C.$('[data-close]',old).onclick=()=>old.close();old.showModal();old.addEventListener('click',e=>{if(e.target===old){const r=old.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)old.close()}},{once:true});onMount?.(old);return old;
};
C.confirm=async(title,text)=>new Promise(resolve=>{
 const d=C.modal(title,`<p>${C.escape(text)}</p><div class="dialog-actions"><button class="btn secondary" id="no">取消</button><button class="btn danger" id="yes">确认</button></div>`,d=>{C.$('#yes',d).onclick=()=>{resolve(true);d.close()};C.$('#no',d).onclick=()=>d.close()});d.addEventListener('close',()=>resolve(false),{once:true});
});
C.downloadText=(name,text,type='text/plain')=>{const url=URL.createObjectURL(new Blob([text],{type}));const a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),3000)};
C.bind=(root,handlers)=>{C.$$('[data-action]',root).forEach(e=>{const fn=handlers[e.dataset.action];if(fn)e.onclick=async ev=>{try{await fn(ev,e)}catch(err){C.error(err)}}})};
C.route=()=>{const raw=location.hash.replace(/^#/,'')||'/';return new URL(raw,'https://icrf.invalid')};
C.go=path=>{if(location.hash==='#'+path)C.render();else location.hash=path};
C.state={papers:[],jobs:[],reader:null,chat:{normal:[],evidence:[],local:[]},routeVersion:0};
C.theme=()=>{document.documentElement.dataset.theme=C.read('icrf.v3.theme','light');document.documentElement.dataset.motion=C.read('icrf.v3.motion',true)?'on':'off'};
C.toggleTheme=()=>{C.write('icrf.v3.theme',document.documentElement.dataset.theme==='dark'?'light':'dark');C.theme()};
C.intro=(force=false)=>{
 if(!force && (C.read('icrf.v3.introSeen',false,'session')||!C.read('icrf.v3.intro',true)||matchMedia('(prefers-reduced-motion: reduce)').matches))return;
 C.write('icrf.v3.introSeen',true,'session');const n=document.createElement('div');n.className='intro';n.setAttribute('role','dialog');n.setAttribute('aria-label','芯研流欢迎动画');
 n.innerHTML=`<div class="intro-grid"></div><div class="intro-center"><div class="intro-mark">${C.icon('spark')}</div><p>IC RESEARCH FLOW</p><h1>让知识，从连接中生长。</h1><span>READ · CONNECT · UNDERSTAND</span></div><button class="btn secondary intro-skip">跳过动画 ${C.icon('arrow')}</button>`;document.body.append(n);C.$('button',n).onclick=()=>n.remove();setTimeout(()=>n.remove(),1700);
};
})();
