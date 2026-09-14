export function validateProfile(p,{requireKey=true,requireModel=true}={}){
  let u;try{u=new URL(p?.base_url)}catch{throw new Error('请填写完整的 HTTPS API 基础地址。')}
  if(u.protocol!=='https:'||u.username||u.password||u.search||u.hash||/[\x00-\x20\x7f]/.test(p.base_url))throw new Error('API 地址须为 HTTPS，且不含账号、查询参数或片段。');
  if(requireKey&&!p.api_key?.trim())throw new Error('请先在设置中填写 API Key。');
  if(p.api_key&&(!/^[\x21-\x7e]+$/.test(p.api_key.trim())||p.api_key.length>4096))throw new Error('API Key 含无效字符，请只粘贴密钥本身。');
  if(requireModel&&!p.model?.trim())throw new Error('请填写账户实际可用的模型 ID；不会自动选择或替换模型。');
  return p;
}
export function endpoint(base,kind){
  const u=new URL(base);const path=u.pathname.replace(/\/+$/,'').replace(/\/(chat\/completions|models)$/,'');u.pathname=path+'/'+kind;return u.href;
}
export async function requestAI(profile,kind,payload,{signal,fetchImpl=fetch,timeoutMs=120000}={}){
  validateProfile(profile,{requireModel:kind!=='models'});
  const controller=new AbortController(),abort=()=>controller.abort(signal.reason);signal?.throwIfAborted();signal?.addEventListener('abort',abort,{once:true});
  const timeout=setTimeout(()=>controller.abort(new Error('请求超时；本站没有自动重发。')),timeoutMs);
  try{
    const response=await fetchImpl(endpoint(profile.base_url,kind),{method:payload?'POST':'GET',headers:{Authorization:'Bearer '+profile.api_key.trim(),...(payload?{'Content-Type':'application/json'}:{})},...(payload?{body:JSON.stringify(payload)}:{}),signal:controller.signal,credentials:'omit',redirect:'error',referrerPolicy:'no-referrer'});
    const result=await response.json().catch(()=>null);
    if(!response.ok){const names={400:'模型或请求参数不被接口支持',401:'密钥无效',403:'账户没有访问权限',402:'账户余额不足',404:'接口或模型不存在',429:'请求频率或额度受限'};const detail=String(result?.error?.message||'').replaceAll(profile.api_key.trim(),'[已隐藏]').slice(0,400);throw new Error(`${names[response.status]||'模型服务返回错误'}（HTTP ${response.status}）${detail?'：'+detail:''}`)}
    if(!result||typeof result!=='object')throw new Error('接口未返回有效 JSON。');
    return result;
  }catch(e){
    if(signal?.aborted)throw new DOMException('已停止等待','AbortError');
    if(controller.signal.aborted)throw new Error('模型请求超时；已完成的译文保留，请手动继续。');
    if(e instanceof TypeError)throw new Error('浏览器无法连接模型接口。请确认网络正常，且服务商允许当前网站域名的 CORS 请求。');
    throw e;
  }finally{clearTimeout(timeout);signal?.removeEventListener('abort',abort)}
}
export async function complete(profile,messages,options={}){
  const data=await requestAI(profile,'chat/completions',{model:profile.model.trim(),messages,stream:false},options);
  const text=data.choices?.[0]?.message?.content;
  if(typeof text!=='string'||!text.trim())throw new Error('模型返回空内容，请核对模型是否支持聊天。');
  if(data.choices?.[0]?.finish_reason==='length')throw new Error('模型输出被长度限制截断；本段未写入完整译文缓存。');
  return {text,model:data.model||profile.model,usage:data.usage||{}};
}
