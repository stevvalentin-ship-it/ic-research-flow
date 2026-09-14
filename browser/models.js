import {CURRENT_DEEPSEEK_MODELS,normalizeDeepSeekModelId} from './parallel/engine/core/translate/models.ts';

export function isDeepSeek(base){
  try{return new URL(base).hostname==='api.deepseek.com'}catch{return false}
}
export function normalizeModel(base,model){
  const id=typeof model==='string'?model.trim():'';
  return isDeepSeek(base)?normalizeDeepSeekModelId(id):id;
}
export function modelOptions(base,models){
  return [...new Set(models.filter(m=>typeof m==='string').map(m=>normalizeModel(base,m)).filter(Boolean))];
}
export function defaultModels(base){return isDeepSeek(base)?CURRENT_DEEPSEEK_MODELS.map(m=>m.id):[]}
export function modelLabel(base,id){
  const known=isDeepSeek(base)&&CURRENT_DEEPSEEK_MODELS.find(m=>m.id===id);
  return known?`${id} · ${known.label}`:id;
}
