import {showAccountDeletion} from './account-deletion-ui.js';
import {esc,createDialog,dialogHead,WORKSPACE_HEADER} from './workspace-ui.js';
// Account and profile data export. The browser reads bounded pages serially and builds the
// file locally; no artifact is stored server-side or in browser storage, and export contents are
// never logged. A partial export is never offered for download.
export const EXPORT_SCHEMA=1;
export const EXPORT_MAX_PAGES=2000;
export const EXPORT_MAX_BYTES=32*1024*1024;
const utf8=new TextEncoder();
const PATHS={account:'/api/live/account/export',workspace:'/api/live/workspace/export'};
const STOP={
 auth:'Sign in again, then export again.',
 forbidden:'You no longer have access to export this.',
 export_changed:'Data changed during export. Export again.',
 export_expired:'Export took too long. Export again.',
 invalid:'Export couldn’t be read. Export again.',
 refused:'Export couldn’t continue. Export again.'
};

export const canExportProfile=workspace=>!!workspace&&!workspace.personal&&workspace.capabilities?.exportProfile===true;

/** Request one page. Account export never sends a profile header; profile export always names the profile chosen at start. */
export function exportRequest({scope,workspaceId,expectedAccountId,fetchImpl=(...args)=>fetch(...args)}){
 if(!PATHS[scope])throw Error('Unknown export.');
 if(scope==='workspace'&&!(typeof workspaceId==='string'&&workspaceId))throw Error('Choose a profile to export.');
 return async(cursor,signal)=>{
  const headers={'Content-Type':'application/json'};if(expectedAccountId)headers['X-Scheduling-Account']=expectedAccountId;if(scope==='workspace')headers[WORKSPACE_HEADER]=workspaceId;
  const response=await fetchImpl(PATHS[scope],{method:'POST',headers,body:JSON.stringify(cursor?{cursor}:{}),credentials:'same-origin',cache:'no-store',signal});
  let value=null;try{value=await response.json();}catch{}
  if(!response.ok)throw Object.assign(Error(value?.error||'Request failed ('+response.status+').'),{status:response.status,code:value?.code});
  return value;
 };
}

/** Recoverable failures keep the cursor and pages for Try again; everything else discards them. */
export function classifyExportError(error){
 const status=error?.status,code=error?.code;
 if(code==='export_account_changed')return {recoverable:false,accountChanged:true,message:'The signed-in account changed. Reload Scheduling.'};
 if(code==='export_too_large')return {recoverable:false,message:'Export exceeds the browser download limit.'};
 if(status===401)return {recoverable:false,authority:true,message:STOP.auth};
 if(status===403)return {recoverable:false,authority:true,message:STOP.forbidden};
 if(code==='export_changed'||code==='export_expired')return {recoverable:false,message:STOP[code]};
 if(status===409)return {recoverable:false,message:STOP.export_changed};
 if(status===410)return {recoverable:false,message:STOP.export_expired};
 if(error?.invalid)return {recoverable:false,message:STOP.invalid};
 if(status===429||status>=500||status==null)return {recoverable:true,message:status===429?'Too many requests. Try again shortly.':'Couldn’t reach Scheduling.'};
 return {recoverable:false,message:STOP.refused};
}

const invalid=detail=>Object.assign(Error('Invalid export page: '+detail),{invalid:true});
export function validateExportPage(page,scope){
 if(!page||typeof page!=='object'||Array.isArray(page))throw invalid('shape');
 if(page.schema!==EXPORT_SCHEMA)throw invalid('schema');
 if(page.scope!==scope)throw invalid('scope');
 if(typeof page.generatedAt!=='string'&&typeof page.generatedAt!=='number')throw invalid('generatedAt');
 if(!Array.isArray(page.sections)||page.sections.some(s=>!s||typeof s.name!=='string'||!s.name||!('data' in s)))throw invalid('sections');
 if(page.nextCursor!==null&&!(typeof page.nextCursor==='string'&&page.nextCursor))throw invalid('cursor');
 return page;
}

/** Ordered sections; consecutive pages of the same array section are joined, nothing is dropped. */
export function assembleExport(pages,scope){
 if(!pages.length||pages.at(-1).nextCursor!==null)throw invalid('incomplete');
 const sections=[];
 for(const page of pages)for(const {name,data} of page.sections){const last=sections.at(-1);if(last&&last.name===name&&Array.isArray(last.data)&&Array.isArray(data))last.data=last.data.concat(data);else sections.push({name,data:Array.isArray(data)?[...data]:data});}
 return {schema:EXPORT_SCHEMA,scope,generatedAt:pages[0].generatedAt,sections};
}

const slug=value=>String(value||'').normalize('NFKD').replace(/[̀-ͯ]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'').slice(0,40);
export function exportFilename(scope,name,now=new Date()){const day=now.toISOString().slice(0,10);return scope==='account'?`scheduling-account-${day}.json`:`scheduling-${slug(name)||'profile'}-${day}.json`;}

/**
 * Serial, bounded export run. DOM-free so it can be tested; onUpdate receives a snapshot.
 * States: idle → preparing → ready | paused (recoverable, keeps cursor+pages) | stopped (discarded).
 */
export function createExportController({request,scope,name='',isCurrent=()=>true,onUpdate=()=>{},onAuthorityLost=()=>{},maxPages=EXPORT_MAX_PAGES,maxBytes=EXPORT_MAX_BYTES,urls=globalThis.URL,BlobImpl=globalThis.Blob,now=()=>new Date()}){
 let status='idle',message='',pages=[],bytes=0,cursor=null,seen=new Set(),url=null,filename='',run=0,abort=null,disposed=false,accountChanged=false;
 const snapshot=()=>({status,message,pages:pages.length,url,filename,accountChanged});
 const emit=()=>{if(!disposed)onUpdate(snapshot());};
 function revoke(){if(url){try{urls.revokeObjectURL(url);}catch{}url=null;filename='';}}
 function discard(){pages=[];bytes=0;cursor=null;seen=new Set();revoke();}
 function stale(){if(disposed)return true;if(!isCurrent()){dispose();return true;}return false;}
 async function loop(id){
  while(id===run&&!disposed){
   if(pages.length>=maxPages){fail(id,Object.assign(Error('Export limit'),{code:'export_too_large'}));return;}
   abort=new AbortController();let page;
   try{page=await request(cursor,abort.signal);}catch(error){if(id!==run||stale())return;fail(id,error);return;}
   if(id!==run||stale())return;
   try{validateExportPage(page,scope);if(page.nextCursor&&(page.nextCursor===cursor||seen.has(page.nextCursor)))throw invalid('repeated cursor');}catch(error){fail(id,error);return;}
   bytes+=utf8.encode(JSON.stringify(page)).byteLength;if(bytes>maxBytes){fail(id,Object.assign(Error('Export limit'),{code:'export_too_large'}));return;}
   pages.push(page);if(cursor)seen.add(cursor);cursor=page.nextCursor;
   if(cursor===null){finish();return;}
   emit();
  }
 }
 function finish(){
  let artifact;try{artifact=assembleExport(pages,scope);}catch(error){fail(run,error);return;}
  const serialized=JSON.stringify(artifact,null,2);if(utf8.encode(serialized).byteLength>maxBytes){fail(run,Object.assign(Error('Export limit'),{code:'export_too_large'}));return;}
  const blob=new BlobImpl([serialized],{type:'application/json'});
  pages=[];bytes=0;cursor=null;seen=new Set();revoke();url=urls.createObjectURL(blob);filename=exportFilename(scope,name,now());status='ready';message='';abort=null;emit();
 }
 function fail(id,error){
  if(id!==run||disposed)return;abort=null;const outcome=classifyExportError(error);message=outcome.message;accountChanged=outcome.accountChanged===true;
  if(outcome.recoverable){status='paused';}else{status='stopped';discard();}
  emit();if(outcome.authority)onAuthorityLost(error);
 }
 function start(){if(disposed||status==='preparing'||stale())return;discard();run++;status='preparing';message='';emit();void loop(run);}
 function retry(){if(disposed||status!=='paused'||stale())return;run++;status='preparing';message='';emit();void loop(run);}
 function cancel(){if(disposed)return;run++;abort?.abort();abort=null;discard();status='idle';message='';emit();}
 function dispose(){if(disposed)return;run++;abort?.abort();abort=null;discard();status='idle';disposed=true;}
 return {start,retry,cancel,dispose,get state(){return snapshot();},get disposed(){return disposed;}};
}

/** Visible text, failure text and actions for one export state. */
export function exportRowView(state,{actionLabel}){
 const s=state||{status:'idle'},busy=s.status==='preparing';
 const status=busy?`Preparing export…${s.pages>0?` ${s.pages} ${s.pages===1?'part':'parts'}`:''}`:s.status==='ready'?'Ready':'';
 const alert=s.status==='paused'?`Export paused. ${s.message}`:s.status==='stopped'?s.message:'';
 const actions=busy?'<button type="button" class="secondary compact-button" data-export-cancel>Cancel</button>'
  :s.status==='ready'&&s.url?`<a class="secondary compact-button" data-export-download href="${esc(s.url)}" download="${esc(s.filename)}">Download</a>`
  :s.status==='paused'?'<button type="button" class="secondary compact-button" data-export-cancel>Cancel</button><button type="button" class="primary compact-button" data-export-retry>Try again</button>'
  :s.status==='stopped'?(s.accountChanged?'':'<button type="button" class="secondary compact-button" data-export-start>Export again</button>')
  :`<button type="button" class="secondary compact-button" data-export-start aria-label="${esc(actionLabel)}">Export</button>`;
 return {status,alert,actions};
}
export function exportRowMarkup(state,{label,actionLabel}){const view=exportRowView(state,{actionLabel});return `<div class="account-data-label"><span>${esc(label)}</span><small class="account-data-status" role="status" aria-live="polite" data-export-status>${esc(view.status)}</small><small class="account-data-status error" role="alert" data-export-alert>${esc(view.alert)}</small></div><div class="account-data-actions" data-export-actions>${view.actions}</div>`;}

/** Updates the row in place (live regions persist) and keeps keyboard focus on the row's next action. */
export function bindExportRow(row,controller,options){
 row.innerHTML=exportRowMarkup({status:'idle'},options);
 const draw=(state=controller.state)=>{if(!row.isConnected)return;const view=exportRowView(state,options),actions=row.querySelector('[data-export-actions]'),hadFocus=actions.contains(document.activeElement);
  row.querySelector('[data-export-status]').textContent=view.status;row.querySelector('[data-export-alert]').textContent=view.alert;actions.innerHTML=view.actions;
  actions.querySelector('[data-export-start]')?.addEventListener('click',event=>{event.currentTarget.focus();controller.start();});actions.querySelector('[data-export-retry]')?.addEventListener('click',event=>{event.currentTarget.focus();controller.retry();});actions.querySelector('[data-export-cancel]')?.addEventListener('click',event=>{event.currentTarget.focus();controller.cancel();});
  if(hadFocus)['[data-export-download]','[data-export-retry]','[data-export-start]','[data-export-cancel]'].map(q=>actions.querySelector(q)).find(Boolean)?.focus();};
 draw();return draw;
}

export const profileExportMarkup=workspace=>canExportProfile(workspace)?`<section class="team-block profile-data" aria-labelledby="profile-data-title"><div class="team-block-head"><h2 id="profile-data-title">${esc(workspace.name)}</h2></div><div class="account-data-row" data-profile-export></div></section>`:'';

/** Manage account: identity, signed-in browsers and account export. */
export function showManageAccount({email,accountId,trigger,onSessions,onDeletionCommitted,fetchImpl}){
 const {dialog}=createDialog({label:'Account',className:'booking-dialog account-manage-dialog',trigger});
 dialog.innerHTML=`${dialogHead('Account','Close account')}<div class="booking-detail-body account-manage"><p class="account-manage-email"><strong>${esc(email)}</strong></p><div class="account-data-row"><div class="account-data-label"><span>Signed-in browsers</span></div><div class="account-data-actions"><button type="button" class="secondary compact-button" data-manage-sessions aria-label="Manage signed-in browsers">Manage</button></div></div><div class="account-data-row" data-account-export></div><div class="account-delete-entry"><button type="button" class="danger-quiet" data-delete-account>Delete account…</button></div></div>`;
 const row=dialog.querySelector('[data-account-export]');let draw=()=>{};
 const controller=createExportController({scope:'account',request:exportRequest({scope:'account',expectedAccountId:accountId,fetchImpl}),isCurrent:()=>dialog.isConnected,onUpdate:state=>draw(state)});
 draw=bindExportRow(row,controller,{label:'Your data',actionLabel:'Export your data'});
 dialog.addEventListener('close',()=>controller.dispose());
 dialog.querySelector('[data-close]').onclick=()=>dialog.close();
 const sessions=dialog.querySelector('[data-manage-sessions]');sessions.onclick=()=>onSessions?.(sessions);
 const deletion=dialog.querySelector('[data-delete-account]');deletion.onclick=()=>{controller.cancel();showAccountDeletion({email,accountId,trigger:deletion,fetchImpl,onCommitted:onDeletionCommitted,onExport:()=>{controller.start();row.querySelector('button,a')?.focus();}});};
 dialog.showModal();sessions.focus();
 return {dialog,controller};
}
