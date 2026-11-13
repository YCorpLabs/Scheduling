import {esc,createDialog,dialogHead} from './workspace-ui.js';

const RECEIPT_KEY='scheduling.account-deletion.v1';
const TOKEN=/^[A-Za-z0-9_-]{43}$/;
const OP=/^h_[A-Za-z0-9_-]{24}\.[A-Za-z0-9_-]{32}$/;
const STATES=new Set(['prepared','not_started','fencing','needs_review','deleted']);
const PATHS={prepare:'/api/live/account/deletion/prepare',confirm:'/api/live/account/deletion/confirm',status:'/api/account/deletion/status'};
const invalid=()=>Object.assign(Error('Deletion status could not be read.'),{invalid:true});

/** A scoped status receipt is kept only in this tab. It cannot export data or authorize deletion. */
export function deletionReceiptStore(storage){
 if(storage===undefined)try{storage=globalThis.sessionStorage;}catch{storage=null;}
 return {
  read(){try{const value=JSON.parse(storage.getItem(RECEIPT_KEY)||'null');return value&&OP.test(value.operationId)&&TOKEN.test(value.receipt)?{operationId:value.operationId,receipt:value.receipt}:null;}catch{return null;}},
  write(value){try{storage.setItem(RECEIPT_KEY,JSON.stringify({operationId:value.operationId,receipt:value.receipt}));return true;}catch{return false;}},
  clear(){try{storage.removeItem(RECEIPT_KEY);}catch{}}
 };
}

/** Account calls never inherit a selected workspace. Status uses the receipt after sign-out. */
export function deletionRequest({accountId,fetchImpl=(...args)=>fetch(...args)}={}){
 return async(action,data,signal)=>{
  if(!PATHS[action])throw Error('Unknown account action.');
  const headers={'Content-Type':'application/json'};
  if(action!=='status'&&accountId)headers['X-Scheduling-Account']=accountId;
  const response=await fetchImpl(PATHS[action],{method:'POST',headers,body:JSON.stringify(data||{}),credentials:action==='status'?'omit':'same-origin',cache:'no-store',signal});
  let value;try{value=await response.json();}catch{}
  if(!response.ok)throw Object.assign(Error(value?.error||'Request failed.'),{status:response.status,code:value?.code});
  return value;
 };
}

export function validateDeletionPreparation(value){
 if(!value||!OP.test(value.operationId)||!TOKEN.test(value.receipt)||typeof value.confirmationToken!=='string'||!value.confirmationToken||!Number.isSafeInteger(value.expiresAt)||typeof value.canDelete!=='boolean'||!Array.isArray(value.blockers)||value.blockers.some(b=>!b||typeof b.code!=='string'||typeof b.label!=='string')||!value.impact||typeof value.impact!=='object')throw invalid();
 if(value.canDelete&&value.blockers.length)throw invalid();
 return value;
}
export function validateDeletionStatus(value,operationId){
 if(!value||value.operationId!==operationId||!STATES.has(value.state)||typeof value.localDataDeleted!=='boolean'||typeof value.needsReview!=='boolean'||value.providerRevocation!=='not_requested'||value.state==='deleted'&&(value.localDataDeleted!==true||value.needsReview!==false)||value.state!=='deleted'&&value.localDataDeleted===true)throw invalid();
 return value;
}

/** No request is repeated destructively on a timer. A lost Confirm reply is resolved by receipt status. */
export function createDeletionController({request,store=deletionReceiptStore(),onUpdate=()=>{},onCommitted=()=>{},now=()=>Date.now(),setTimer=(fn,ms)=>setTimeout(fn,ms),clearTimer=id=>clearTimeout(id),pollMilliseconds=2000,pollLimitMilliseconds=120000}={}){
 let phase='idle',preparation=null,result=null,message='',busy=false,disposed=false,sequence=0,timer=null,pollStarted=0,receipt=null,committed=false;
 const state=()=>({phase,preparation,result,message,busy,canConfirm:phase==='confirm'&&!!preparation&&now()<preparation.expiresAt});
 const emit=()=>{if(!disposed)onUpdate(state());};
 const clearPoll=()=>{if(timer!==null)clearTimer(timer);timer=null;};
 function accept(value){
  result=validateDeletionStatus(value,receipt.operationId);message='';
  phase=result.state==='needs_review'?'review':result.state==='deleted'?'deleted':['prepared','not_started'].includes(result.state)?'not_started':'pending';
  if(!committed&&['pending','review','deleted'].includes(phase)){committed=true;onCommitted(result);}
  if(phase==='pending'&&now()-pollStarted<pollLimitMilliseconds)timer=setTimer(()=>{timer=null;void check();},pollMilliseconds);
 }
 async function prepare(){
  if(disposed||busy)return;clearPoll();const id=++sequence;busy=true;phase='loading';message='';emit();
  try{const next=validateDeletionPreparation(await request('prepare',{}));if(disposed||id!==sequence)return;preparation=next;result=null;phase=next.canDelete?'confirm':'blocked';}
  catch(error){if(disposed||id!==sequence)return;phase='error';message=error?.status===401?'Sign in again to delete your account.':error?.code==='export_account_changed'||error?.code==='deletion_account_changed'?'The signed-in account changed. Reload this page.':'Couldn’t check your account. Try again.';}
  finally{if(!disposed&&id===sequence){busy=false;emit();}}
 }
 async function confirm(){
  if(disposed||busy||phase!=='confirm'||!preparation)return;
  if(now()>=preparation.expiresAt){phase='expired';message='The confirmation expired. Check your account again.';emit();return;}
  receipt={operationId:preparation.operationId,receipt:preparation.receipt};
  if(!store.write(receipt)){receipt=null;phase='error';message='Your browser couldn’t save deletion status. Allow site storage, then try again.';emit();return;}
  const id=++sequence;busy=true;phase='submitting';message='';pollStarted=now();emit();
  try{const value=await request('confirm',{confirmationToken:preparation.confirmationToken});if(disposed||id!==sequence)return;accept(value);}
  catch(error){if(disposed||id!==sequence)return;phase='unknown';message='The request may have been accepted. Check its status before trying again.';}
  finally{if(!disposed&&id===sequence){busy=false;emit();}}
 }
 async function check(){
  if(disposed||busy||!receipt)return;clearPoll();const id=++sequence;busy=true;message='';emit();
  try{const value=await request('status',receipt);if(disposed||id!==sequence)return;accept(value);}
  catch(error){if(disposed||id!==sequence)return;phase='unknown';message=error?.status===401||error?.status===403?'This status receipt is no longer available. Contact support if you need help.':'Couldn’t check deletion. Try again.';}
  finally{if(!disposed&&id===sequence){busy=false;emit();}}
 }
 function resume(value=store.read()){
  if(disposed||busy||!value)return false;receipt=value;phase='unknown';pollStarted=now();emit();void check();return true;
 }
 function finish(){clearPoll();if(['deleted','not_started'].includes(phase))store.clear();}
 function dispose(){if(disposed)return;disposed=true;sequence++;clearPoll();}
 return {prepare,confirm,check,resume,finish,dispose,get state(){return state();},get hasReceipt(){return !!receipt;}};
}

const date=value=>{if(!Number.isSafeInteger(value)||Math.abs(value)>8640000000000000)return '';try{return new Intl.DateTimeFormat(undefined,{year:'numeric',month:'short',day:'numeric'}).format(value);}catch{return '';}};
export function deletionStatusView(state){
 const r=state.result||{},deadline=date(r.deleteBy);
 if(state.phase==='deleted')return {heading:'Account deleted',body:'Your account data has been removed from active storage.',detail:'Google permissions were not revoked. Your Google calendar events remain in Google.'};
 if(state.phase==='review')return {heading:'Deletion needs review',body:'Access is closed. Some pending work needs to be accounted for before deletion can finish.',detail:deadline?'Deletion due by '+deadline+'.':'Your deletion request is still pending.'};
 if(state.phase==='pending')return {heading:'Deletion in progress',body:'Your access is closed. Pending work is being checked before your data is removed.',detail:deadline?'Deletion due by '+deadline+'.':'You can check the status here.'};
 if(state.phase==='not_started')return {heading:'Deletion has not started',body:'Your account has not been deleted.',detail:'Return to your account to review and confirm a new request.'};
 if(state.phase==='submitting')return {heading:'Requesting deletion…',body:'Keep this page open while the request is checked.',detail:''};
 return {heading:'Check deletion status',body:state.message||'Checking your request…',detail:''};
}

const facts=impact=>[['links','Booking links'],['calendars','Connected calendars'],['bookings','Stored bookings']].filter(([key])=>Number.isSafeInteger(impact?.[key])&&impact[key]>0).map(([key,label])=>`<li><span>${label}</span><strong>${impact[key]}</strong></li>`).join('');
function blockerAction(b){
 const section=['owned_workspace','owned_workspaces'].includes(b.code)?'team':['shared_calendar','legacy_calendar'].includes(b.code)?'calendars':['future_bookings','pending_bookings','workspace_bookings','unresolved_bookings','active_bookings'].includes(b.code)?'bookings':null;
 if(!section)return '';
 const query=typeof b.workspaceId==='string'&&/^h_[A-Za-z0-9_-]{24}$/.test(b.workspaceId)?'?workspace='+encodeURIComponent(b.workspaceId):'';
 const label=section==='team'?'Open Team':section==='calendars'?'Open Calendars':'Open Bookings';
 return `<br><a href="/studio${query}#${section}" data-resolve-deletion>${label}</a>`;
}
const blockersMarkup=blockers=>`<ul class="account-deletion-blockers">${blockers.map(b=>`<li>${esc(b.label)}${Number.isSafeInteger(b.count)&&b.count>1?` (${b.count})`:''}${blockerAction(b)}</li>`).join('')}</ul>`;
export function deletionMarkup(state,{email='',page=false}={}){
 const s=state,close=page?'':'<button type="button" class="secondary" data-deletion-close>Cancel</button>';
 if(s.phase==='loading'||s.phase==='idle')return `<div class="account-deletion-body"><h2 tabindex="-1" data-deletion-status>Checking your account…</h2></div><footer class="booking-detail-footer">${close}</footer>`;
 if(s.phase==='blocked')return `<div class="account-deletion-body"><h2 tabindex="-1" data-deletion-status>Resolve these first</h2><p>Your account is still active.</p>${blockersMarkup(s.preparation.blockers)}</div><footer class="booking-detail-footer">${close}<button type="button" class="primary" data-deletion-prepare>Check again</button></footer>`;
 if(s.phase==='confirm')return `<div class="account-deletion-body"><h2 tabindex="-1" data-deletion-status>Delete your account?</h2>${email?`<p class="account-deletion-email">${esc(email)}</p>`:''}<p>This closes your access immediately and deletes your account data within one month. It can’t be undone.</p>${facts(s.preparation.impact)?`<ul class="account-deletion-facts">${facts(s.preparation.impact)}</ul>`:''}<div class="account-deletion-export"><span>Keep a copy of your data first.</span><button type="button" class="quiet-button" data-deletion-export>Export data</button></div><p>Google calendar events stay in Google. Records held by other profiles stay with those profiles.</p></div><footer class="booking-detail-footer">${close}<button type="button" class="danger-button" data-deletion-confirm>Delete account</button></footer>`;
 if(['error','expired'].includes(s.phase))return `<div class="account-deletion-body"><h2 tabindex="-1" data-deletion-status>Deletion has not started</h2><p class="error" role="alert">${esc(s.message)}</p></div><footer class="booking-detail-footer">${close}<button type="button" class="primary" data-deletion-prepare>Check again</button></footer>`;
 const view=deletionStatusView(s),status=s.phase==='unknown'?'role="alert"':'role="status" aria-live="polite"';
 return `<div class="account-deletion-body"><h2 tabindex="-1" data-deletion-status>${esc(view.heading)}</h2><p ${status}>${esc(view.body)}</p>${view.detail?`<p>${esc(view.detail)}</p>`:''}</div><footer class="booking-detail-footer">${['deleted','not_started'].includes(s.phase)?'<a class="secondary compact-button" href="/studio" data-deletion-done>Done</a>':s.phase==='submitting'?'<button type="button" class="secondary" disabled>Requesting…</button>':`<button type="button" class="primary" data-deletion-check ${s.busy?'disabled':''}>${s.busy?'Checking…':'Check status'}</button>`}</footer>`;
}

/** A nested confirmation keeps the export action in the existing account dialog. */
export function showAccountDeletion({email='',accountId,trigger,onExport,onCommitted,fetchImpl,store=deletionReceiptStore()}={}){
 const {dialog,state:dialogState,dismiss}=createDialog({label:'Delete account',className:'booking-dialog account-deletion-dialog',trigger});
 let controller,prior='',focusAction='';
 const draw=state=>{
  if(!dialog.isConnected)return;const focusInside=dialog.contains(document.activeElement);if(focusInside&&document.activeElement?.hasAttribute('data-deletion-check'))focusAction='check';
  dialogState.working=!!controller?.hasReceipt&&!['deleted','not_started'].includes(state.phase);
  dialog.innerHTML=`${dialogHead('Delete account','Close deletion')}<div data-deletion-content>${deletionMarkup(state,{email})}</div>`;
  const canClose=!controller?.hasReceipt||['deleted','not_started'].includes(state.phase);
  const close=dialog.querySelector('[data-close]');close.disabled=!canClose;close.onclick=()=>{if(canClose){controller.finish();dismiss();}};
  dialog.querySelector('[data-deletion-close]')?.addEventListener('click',()=>dismiss());
  dialog.querySelector('[data-deletion-prepare]')?.addEventListener('click',()=>controller.prepare());
  dialog.querySelector('[data-deletion-confirm]')?.addEventListener('click',()=>controller.confirm());
  dialog.querySelector('[data-deletion-check]')?.addEventListener('click',()=>controller.check());
  dialog.querySelector('[data-deletion-export]')?.addEventListener('click',()=>{dialog.close();onExport?.();});
  dialog.querySelector('[data-deletion-done]')?.addEventListener('click',()=>controller.finish());
  dialog.querySelectorAll('[data-resolve-deletion]').forEach(a=>a.addEventListener('click',()=>dialog.close()));
  if(state.phase!==prior){focusAction='';if(focusInside||dialog.open)(dialog.querySelector('[data-deletion-close]')||dialog.querySelector('[data-deletion-status]'))?.focus();prior=state.phase;}
  else if(focusAction==='check'&&!state.busy)dialog.querySelector('[data-deletion-check]')?.focus();
  else if(focusInside&&!state.busy)dialog.querySelector('[data-deletion-status]')?.focus();
 };
 controller=createDeletionController({request:deletionRequest({accountId,fetchImpl}),store,onUpdate:draw,onCommitted});
 // Once submitted, Escape cannot hide an unresolved result behind a now-revoked account UI.
 dialog.addEventListener('cancel',event=>{if(controller.hasReceipt&&!['deleted','not_started'].includes(controller.state.phase))event.preventDefault();});
 dialog.addEventListener('close',()=>controller.dispose());
 dialog.showModal();draw(controller.state);void controller.prepare();
 return {dialog,controller};
}

/** Called before normal Studio bootstrap. Returns false when this tab has no deletion receipt. */
export function resumeAccountDeletion({root,fetchImpl,store=deletionReceiptStore()}={}){
 const receipt=store.read();if(!receipt)return false;
 let controller;
 const draw=state=>{root.innerHTML=`<main class="account-deletion-page" aria-label="Account deletion">${deletionMarkup(state,{page:true})}</main>`;root.querySelector('[data-deletion-check]')?.addEventListener('click',()=>controller.check());root.querySelector('[data-deletion-done]')?.addEventListener('click',()=>controller.finish());};
 controller=createDeletionController({request:deletionRequest({fetchImpl}),store,onUpdate:draw});
 controller.resume(receipt);return {controller,destroy:()=>controller.dispose()};
}
