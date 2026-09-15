import {afterEach,expect,it,vi} from 'vitest';
import {bindChatComposer} from './chat-input.js';
afterEach(()=>document.body.replaceChildren());
function setup(){
  document.body.innerHTML='<form><textarea required>问题</textarea><button>发送</button></form>';
  const form=document.querySelector('form'),input=document.querySelector('textarea'),button=document.querySelector('button');
  const submit=vi.fn(event=>event.preventDefault());form.addEventListener('submit',submit);bindChatComposer(input,form,button);
  const key=options=>{const event=new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true,...options});input.dispatchEvent(event);return event;};
  return {form,input,button,submit,key};
}
it('submits through the real form on Enter and leaves Shift+Enter to insert a newline',()=>{
  const {submit,key}=setup();expect(key({shiftKey:true}).defaultPrevented).toBe(false);expect(submit).not.toHaveBeenCalled();
  expect(key().defaultPrevented).toBe(true);expect(submit).toHaveBeenCalledTimes(1);
});
it('does not send while selecting Chinese input or holding down Enter',()=>{
  const {input,submit,key}=setup();input.dispatchEvent(new CompositionEvent('compositionstart'));
  key();input.dispatchEvent(new CompositionEvent('compositionend'));key({isComposing:true});key({keyCode:229});key({repeat:true});
  expect(submit).not.toHaveBeenCalled();key();expect(submit).toHaveBeenCalledTimes(1);
});
it('does not submit while busy or bypass native empty-input validation',()=>{
  const {input,button,submit,key}=setup();button.disabled=true;key();button.disabled=false;input.value='';key();expect(submit).not.toHaveBeenCalled();
});
