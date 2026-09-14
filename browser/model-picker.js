import {defaultModels,modelOptions,modelLabel,normalizeModel} from './models.js';

// A select lists every model, unlike a datalist filtered by the current ID.
export function bindModelPicker(form,initialModel){
  const select=form.querySelector('#model-choice'),input=form.elements.model;
  const custom=form.querySelector('#custom-model'),base=()=>form.elements.base_url.value.trim();
  let available=defaultModels(base());
  function render(model){
    const id=normalizeModel(base(),model);
    select.replaceChildren(new Option('请选择模型',''));
    for(const value of available)select.add(new Option(modelLabel(base(),value),value));
    select.add(new Option('手动填写其他模型 ID','__custom__'));
    select.value=available.includes(id)?id:id?'__custom__':'';
    input.value=id;custom.hidden=select.value!=='__custom__';
  }
  select.addEventListener('change',()=>{
    custom.hidden=select.value!=='__custom__';
    input.value=custom.hidden?select.value:'';
    if(!custom.hidden)input.focus();
  });
  form.elements.base_url.addEventListener('input',()=>{
    available=defaultModels(base());render('');
  });
  render(initialModel);
  return {
    value:()=>normalizeModel(base(),input.value),
    setModels(models){available=modelOptions(base(),models);render(input.value);return available.length},
    normalize(){render(input.value)},
  };
}
