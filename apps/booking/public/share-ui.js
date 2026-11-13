import {DEFAULT,validZone} from './policy.js';
import {normalizeQuestions} from './intake.js';
import {validateBrandImage} from './branding.js';
import {validDuration,normalizeDurationOptions} from './durations.js';
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const text=(value,max=600)=>typeof value==='string'?value.slice(0,max):'';
/** Display-only projection. Grants, calendar IDs, private URLs and settings revisions never cross the frame boundary. */
export function projectPreviewState(state){
 const source=state?.config;if(!source||typeof source!=='object'||!validZone(source.zone))throw Error('Choose a valid timezone to preview.');
 const config={};
 for(const key of ['host','company','title','description','location','question'])config[key]=text(source[key]??DEFAULT[key],key==='description'?600:160);
 config.duration=Number(source.duration);if(!validDuration(config.duration))throw Error('Choose a duration to preview.');
 try{config.durationOptions=normalizeDurationOptions(source.durationOptions??null,config.duration);}catch{config.durationOptions=null;}
 if(config.durationOptions?.length<2)config.durationOptions=null;
 config.zone=source.zone;config.locationType=source.locationType==='google_meet'?'google_meet':'custom';
 config.theme=source.theme==='dark'?'dark':'light';config.accent=['graphite','iris','sage','clay'].includes(source.accent)?source.accent:'graphite';config.motion=source.motion==='none'?'none':'smooth';
 config.required=source.required===true;config.requiresApproval=source.requiresApproval===true;config.approvalExpiryMinutes=Number.isInteger(source.approvalExpiryMinutes)?Math.max(15,Math.min(10080,source.approvalExpiryMinutes)):1440;
 for(const key of ['cancellationNoticeMinutes','rescheduleNoticeMinutes'])config[key]=Number.isInteger(source[key])&&source[key]>=0&&source[key]<=43200?source[key]:0;
 config.extraGuestsLimit=Number.isInteger(source.extraGuestsLimit)?Math.max(0,Math.min(5,source.extraGuestsLimit)):0;
 config.questions=normalizeQuestions(source).map(q=>({id:q.id,type:q.type,label:q.label,required:q.required,...(q.type==='select'?{options:[...q.options]}:{})}));
 for(const key of ['avatarImage','bannerImage'])config[key]=validateBrandImage(source[key]??null,key);
 if(source.team&&['any','choose','all'].includes(source.team.mode)&&Array.isArray(source.team.hosts)&&source.team.hosts.length<=8){
  config.team={mode:source.team.mode,hosts:source.team.hosts.map(h=>({id:text(h.id,100),name:text(h.name,80)}))};
  if(config.team.hosts.some(h=>!h.id||!h.name)||new Set(config.team.hosts.map(h=>h.id)).size!==config.team.hosts.length)throw Error('Choose named hosts to preview.');
 }else config.team=null;
 const hostIds=new Set(config.team?.hosts.map(h=>h.id)||[]);
 const slots=(Array.isArray(state.slots)?state.slots:[]).slice(0,20000).filter(s=>Number.isSafeInteger(s.start)&&Number.isSafeInteger(s.end)&&s.end>s.start&&s.end-s.start===config.duration*60000).map(s=>({start:s.start,end:s.end,...(config.team?{hostIds:[...new Set((Array.isArray(s.hostIds)?s.hostIds:[]).filter(id=>hostIds.has(id)))]}:{})}));
 return {config,slots};
}
export function liveShareUrl(value,origin){
 try{const url=new URL(value);if(url.origin!==origin||!/^\/b\/h_[A-Za-z0-9_-]{24}\/[a-z0-9][a-z0-9-]{0,63}$/.test(url.pathname)||url.username||url.password||url.search||url.hash)return null;return url.href;}catch{return null;}
}
export function embedCode(liveUrl,kind='inline',motion='smooth'){
 const url=new URL(liveUrl);if(!liveShareUrl(liveUrl,url.origin)||!['inline','popup'].includes(kind)||!['smooth','none'].includes(motion))throw Error('Choose a live booking link.');
 const attributes=`data-email-booking="${esc(url.href)}" data-email-motion="${motion}"`;
 return `${kind==='popup'?`<button type="button" ${attributes}>Book a meeting</button>`:`<div ${attributes}></div>`}\n<script src="${esc(url.origin)}/embed.js" defer></script>`;
}
/** Caller captures the current draft before opening. liveUrl is the saved/published baseline only. */
export function showShare({trigger,title='Booking link',liveUrl=null,dirty=false,loadPreview,onSave,onActivate,onEdit,closedState='open',initialView='share'}={}){
 const origin=location.origin,live=liveShareUrl(liveUrl,origin),dialog=document.createElement('dialog');
 let view=initialView==='preview'?'preview':'share',kind='inline',motion='smooth',width='desktop',frame=null,projected=null,loading=null,closed=false,lengthSeq=0;
 dialog.className='share-dialog';dialog.setAttribute('aria-label','Share and preview booking link');
 dialog.innerHTML=`<header class="share-heading"><div><span class="share-eyebrow">Booking link</span><h2>${esc(title)}</h2></div><button type="button" class="share-close" aria-label="Close share and preview">×</button></header><div class="share-tabs" role="tablist" aria-label="Share or preview"><button type="button" role="tab" data-view="share">Share</button><button type="button" role="tab" data-view="preview">Preview</button></div><section class="share-body"></section><p class="share-notice" role="status" aria-live="polite"></p>`;
 const body=dialog.querySelector('.share-body'),notice=dialog.querySelector('.share-notice');
 const tell=value=>{notice.textContent=value;};
 function sendPreview(){if(frame&&projected)frame.contentWindow?.postMessage({type:'email-booking:owner-preview',state:projected},origin);}
 async function preparePreview(){if(projected||loading)return;loading=Promise.resolve().then(()=>{if(typeof loadPreview!=='function')throw Error('Preview is unavailable.');return loadPreview();}).then(projectPreviewState).then(value=>{if(closed)return;projected=value;tell('');sendPreview();}).catch(error=>{if(closed)return;tell(error.message||'Preview could not load.');if(view==='preview'){const retry=document.createElement('button');retry.type='button';retry.className='secondary';retry.textContent='Try again';retry.onclick=()=>{loading=null;draw();};body.querySelector('.share-preview-controls')?.append(retry);}});await loading;}
 function draw(){
  frame=null;tell('');dialog.classList.toggle('showing-preview',view==='preview');
  for(const tab of dialog.querySelectorAll('[data-view]')){const active=tab.dataset.view===view;tab.setAttribute('aria-selected',String(active));tab.tabIndex=active?0:-1;tab.setAttribute('aria-controls','share-panel');}
  body.id='share-panel';body.setAttribute('role','tabpanel');body.setAttribute('aria-label',view==='preview'?'Preview':'Share');
  if(view==='preview'){
   body.innerHTML=`<div class="share-preview-controls"><span>Layout preview · Example times${dirty?' · Unsaved changes':''}</span><div class="share-segment" role="group" aria-label="Preview width"><button type="button" data-width="desktop" aria-pressed="${width==='desktop'}">Desktop</button><button type="button" data-width="phone" aria-pressed="${width==='phone'}">Phone</button></div></div><div class="share-preview-canvas" data-width="${width}"><iframe title="Booking page preview" src="/book?preview=owner&amp;embed=1"></iframe></div>`;
   frame=body.querySelector('iframe');frame.addEventListener('load',sendPreview);
   body.querySelectorAll('[data-width]').forEach(button=>button.onclick=()=>{width=button.dataset.width;body.querySelector('.share-preview-canvas').dataset.width=width;for(const b of body.querySelectorAll('[data-width]'))b.setAttribute('aria-pressed',String(b===button));});
   void preparePreview();return;
  }
  if(['expired','used'].includes(closedState)){body.innerHTML=`<div class="share-unavailable"><h3>${closedState==='expired'?'This link has expired':'This link has been used'}</h3>${onSave?'<button type="button" class="primary" data-save-closed>Save changes</button>':onEdit?'<button type="button" class="primary" data-edit-access>Edit link access</button>':''}<button type="button" class="secondary" data-open-preview>Preview</button></div>`;body.querySelector('[data-open-preview]').onclick=()=>switchView('preview');body.querySelector('[data-edit-access]')?.addEventListener('click',()=>{dialog.close();onEdit();});body.querySelector('[data-save-closed]')?.addEventListener('click',()=>{dialog.close();onSave();});return;}
  if(!live){const action=onSave||onActivate;body.innerHTML=`<div class="share-unavailable"><h3>${onSave?'Save this link to share it':'Activate this link to share it'}</h3>${action?`<button type="button" class="primary" data-enable>${onSave?'Save changes':'Activate link'}</button>`:''}<button type="button" class="secondary" data-open-preview>Preview</button></div>`;body.querySelector('[data-open-preview]').onclick=()=>switchView('preview');const button=body.querySelector('[data-enable]');if(button)button.onclick=()=>{dialog.close();action();};return;}
  body.innerHTML=`<div class="share-link-label"><label for="share-live-url">${dirty?'Saved link':'Booking link'}</label>${dirty?'<span>Unsaved changes are in Preview</span>':''}</div><div class="share-copy-row"><input id="share-live-url" readonly value="${esc(live)}"><button type="button" class="primary" data-copy-link>Copy link</button></div><a class="share-open" href="${esc(live)}" target="_blank" rel="noopener">Open live page ↗</a><section class="share-embed"><h3>Add to your website</h3><div class="share-embed-controls"><div class="share-segment" role="group" aria-label="Embed type"><button type="button" data-kind="inline" aria-pressed="${kind==='inline'}">Inline</button><button type="button" data-kind="popup" aria-pressed="${kind==='popup'}">Button</button></div><label class="share-motion">Transitions<select aria-label="Embed transitions"><option value="smooth" ${motion==='smooth'?'selected':''}>Smooth</option><option value="none" ${motion==='none'?'selected':''}>Instant</option></select></label></div><textarea class="share-code" readonly aria-label="Website embed code" spellcheck="false"></textarea><button type="button" class="secondary" data-copy-code>Copy code</button></section>`;
  const code=body.querySelector('.share-code'),update=()=>{code.value=embedCode(live,kind,motion);};update();
  body.querySelectorAll('[data-kind]').forEach(button=>button.onclick=()=>{kind=button.dataset.kind;for(const b of body.querySelectorAll('[data-kind]'))b.setAttribute('aria-pressed',String(b===button));update();});
  body.querySelector('select').onchange=event=>{motion=event.target.value;update();};
  body.querySelector('[data-copy-link]').onclick=()=>copy(live,body.querySelector('#share-live-url'),'Link copied');body.querySelector('[data-copy-code]').onclick=()=>copy(code.value,code,'Code copied');
 }
 async function copy(value,field,message){try{await navigator.clipboard.writeText(value);if(!closed)tell(message);}catch{if(closed)return;field.focus();field.select();tell('Select and copy.');}}
 function switchView(next){view=next;draw();dialog.querySelector(`[data-view="${view}"]`).focus();}
 // Frame asks for another allowed length. Only loadPreview(duration) runs: local example times, no fetch, provider, visit or booking.
 async function previewLength({duration,request}){
  const target=frame,reply=message=>{if(!closed&&frame===target)target.contentWindow?.postMessage({...message,request},origin);};
  if(!Number.isSafeInteger(request))return;
  const allowed=projected?.config.durationOptions||[];
  if(!projected||typeof loadPreview!=='function'||!allowed.includes(duration)){reply({type:'email-booking:owner-preview-error'});return;}
  const seq=++lengthSeq;
  try{const value=projectPreviewState(await loadPreview(duration));if(closed||frame!==target||seq!==lengthSeq)return;if(value.config.duration!==duration)throw Error('Preview could not load.');projected=value;reply({type:'email-booking:owner-preview',state:value});}
  catch{if(!closed&&frame===target&&seq===lengthSeq)reply({type:'email-booking:owner-preview-error'});}
 }
 function receive(event){if(event.origin!==origin||event.source!==frame?.contentWindow)return;if(event.data?.type==='email-booking:owner-ready')sendPreview();if(event.data?.type==='email-booking:owner-duration')void previewLength(event.data);if(event.data?.type==='email-booking:preview-close'){dialog.close();}}
 window.addEventListener('message',receive);
 dialog.querySelector('.share-close').onclick=()=>dialog.close();
 dialog.querySelectorAll('[data-view]').forEach(button=>{button.onclick=()=>switchView(button.dataset.view);button.onkeydown=event=>{if(['ArrowLeft','ArrowRight','Home','End'].includes(event.key)){event.preventDefault();switchView(event.key==='Home'?'share':event.key==='End'?'preview':view==='share'?'preview':'share');}};});
 dialog.addEventListener('close',()=>{closed=true;window.removeEventListener('message',receive);dialog.remove();if(trigger?.isConnected)trigger.focus();},{once:true});
 dialog.addEventListener('click',event=>{if(event.target!==dialog)return;const r=dialog.getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)dialog.close();});
 document.body.append(dialog);draw();dialog.showModal();dialog.querySelector('.share-close').focus();return dialog;
}
