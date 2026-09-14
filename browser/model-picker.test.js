import {afterEach,expect,it} from 'vitest';
import {bindModelPicker} from './model-picker.js';
import {normalizeModel} from './models.js';
afterEach(()=>document.body.replaceChildren());
function setup(model='deepseek-flash'){
  document.body.innerHTML='<form><input name="base_url" value="https://api.deepseek.com"><select id="model-choice"></select><label id="custom-model"><input name="model"></label></form>';
  const form=document.querySelector('form'),select=document.querySelector('select');
  return {form,select,picker:bindModelPicker(form,model)};
}
it('lists both models even with Flash already selected, and switches the submitted model',()=>{
  const {select,picker}=setup();
  picker.setModels(['deepseek-flash','deepseek-v4-pro']);
  expect([...select.options].map(o=>o.value)).toContain('deepseek-v4-pro');
  select.value='deepseek-v4-pro';select.dispatchEvent(new Event('change'));
  expect(picker.value()).toBe('deepseek-v4-pro');
  picker.setModels(['deepseek-flash','deepseek-v4-pro']);expect(select.value).toBe('deepseek-v4-pro');
});
it('migrates legacy Flash settings and deduplicates server aliases without changing Pro',()=>{
  const {select,picker}=setup('deepseek-v4-flash-vision-exp');
  expect(select.value).toBe('deepseek-flash');
  expect(picker.setModels(['deepseek-v4-flash','deepseek-v4-flash-vision-exp','deepseek-flash','deepseek-v4-pro'])).toBe(2);
  expect(select.textContent).not.toContain('exp');expect(picker.value()).toBe('deepseek-flash');
});
it('preserves manual IDs and resets available models when switching providers',()=>{
  const {form,select,picker}=setup();
  form.elements.base_url.value='https://custom.example/v1';form.elements.base_url.dispatchEvent(new Event('input'));
  expect(select.textContent).not.toContain('deepseek-flash');expect(picker.value()).toBe('');
  select.value='__custom__';select.dispatchEvent(new Event('change'));
  expect(document.querySelector('#custom-model').hidden).toBe(false);
  form.elements.model.value='deepseek-v4-flash-vision-exp';picker.normalize();
  expect(picker.value()).toBe('deepseek-v4-flash-vision-exp');
  expect(normalizeModel('https://api.deepseek.com.evil.test','deepseek-v4-flash')).toBe('deepseek-v4-flash');
});
