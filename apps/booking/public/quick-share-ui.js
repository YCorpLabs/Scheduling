// Share from Home: the link, and the code for a website. Nothing else; the full
// Share dialog (inline or popup, preview, motion) is one "More options" away.
import {createDialog,dialogHead,copyText,esc} from './workspace-ui.js';
import {embedCode} from './share-ui.js';

export function showQuickShare({trigger,liveUrl,onMore}){
  const {dialog}=createDialog({label:'Share',className:'booking-dialog quick-share',trigger});
  const code=embedCode(liveUrl,'popup').replace('>Book a meeting<','>Book a call<');
  const row=(id,title,value,primary,mono)=>`<section class="qs-row" aria-labelledby="${id}-title"><h3 id="${id}-title">${title}</h3><div class="qs-field"><input id="${id}" class="${mono?'qs-code':''}" readonly value="${esc(value)}" aria-labelledby="${id}-title"><button type="button" class="${primary?'primary':'secondary'} compact-button" data-copy="${id}">Copy</button></div></section>`;
  dialog.innerHTML=`${dialogHead('Share','Close')}<div class="qs-body">${row('qs-link','Send the link',liveUrl.replace(/^https?:\/\//,''),true,false)}${row('qs-code','Put it on your website',code,false,true)}${onMore?'<button type="button" class="link-button qs-more" data-more>More options</button>':''}<p class="sr-only" role="status" data-status></p></div>`;
  const values={'qs-link':liveUrl,'qs-code':code},status=dialog.querySelector('[data-status]');
  dialog.querySelector('[data-close]').onclick=()=>dialog.close();
  dialog.querySelectorAll('[data-copy]').forEach(button=>button.onclick=async()=>{
    const id=button.dataset.copy,ok=await copyText(values[id],dialog.querySelector('#'+id));
    button.textContent=ok?'Copied':'Copy';status.textContent=ok?'Copied':'Select the text to copy it';
    if(ok)setTimeout(()=>{if(button.isConnected)button.textContent='Copy';},2000);
  });
  dialog.querySelector('[data-more]')?.addEventListener('click',()=>{dialog.close();onMore();});
  dialog.showModal();dialog.querySelector('[data-copy="qs-link"]').focus();
  return dialog;
}
