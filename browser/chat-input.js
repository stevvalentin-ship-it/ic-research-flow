export function bindChatComposer(textarea,form,submit){
  let composing=false;
  textarea.addEventListener('compositionstart',()=>composing=true);
  textarea.addEventListener('compositionend',()=>composing=false);
  textarea.addEventListener('keydown',event=>{
    if(event.key!=='Enter'||event.shiftKey||event.ctrlKey||event.altKey||event.metaKey
      ||composing||event.isComposing||event.keyCode===229)return;
    event.preventDefault();
    if(!event.repeat&&!submit.disabled)form.requestSubmit(submit);
  });
}
