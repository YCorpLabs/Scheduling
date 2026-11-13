// Webhook, Slack and Discord notifications. Destination URLs are write-only: after saving, only the
// backend's destinationLabel is shown. A signing secret returned once is held in this dialog only.
import {esc,createDialog,dialogHead,copyText,confirmAction} from './workspace-ui.js';
export const webhookHostsReady=data=>!!(data?.status?.customWebhookHostsConfigured??data?.customWebhookHostsConfigured);
export const KINDS={webhook:{label:'Webhook',url:'Endpoint URL',placeholder:'https://example.com/hooks/scheduling'},slack:{label:'Slack',url:'Slack webhook URL',placeholder:'https://hooks.slack.com/services/…'},discord:{label:'Discord',url:'Discord webhook URL',placeholder:'https://discord.com/api/webhooks/…'}};
const EVENT_LABELS={'booking.confirmed':'Booking confirmed','booking.requested':'Booking requested','booking.approval_requested':'Approval needed','booking.rejected':'Request declined','booking.expired':'Request expired','booking.rescheduled':'Booking rescheduled','booking.cancelled':'Booking cancelled','integration.test':'Test notification'};
const DEFAULT_EVENTS=['booking.confirmed','booking.cancelled'];
export const eventLabel=type=>EVENT_LABELS[type]||String(type||'');
export function eventCatalog(data){
  const source=data?.capabilities?.events||data?.eventTypes;
  const list=Array.isArray(source)?source.map(e=>typeof e==='string'?e:e?.id).filter(Boolean):Object.keys(EVENT_LABELS).filter(e=>e!=='integration.test');
  return list.map(id=>({id,label:eventLabel(id)}));
}
const STATES={queued:'Queued',retry:'Retrying',in_flight:'Sending',delivered:'Delivered',failed:'Failed',cancelled:'Cancelled',quarantined:'Held'};
export const deliveryStateLabel=state=>STATES[state]||String(state||'Unknown');
export const canRetry=d=>d?.state==='failed';
export const canDiscard=d=>['failed','quarantined'].includes(d?.state);
const ERRORS={rate_limited:'Rate limited by the destination. Retrying.',provider_unavailable:'Destination unavailable. Retrying.',provider_rejected:'Rejected by the destination. Check the URL.',destination_not_public:'Destination is not a public address.',webhook_host_not_approved:'Webhook host is not approved.',delivery_unavailable:'Could not reach the destination.',queue_capacity:'Delivery queue was full.',integration_removed:'Integration was removed.',integration_changed:'Integration changed before sending.',operator_discarded:'Discarded.',restored:'Held after a restore.'};
export function errorLabel(code){if(!code)return '';const http=/^http_(\d{3})$/.exec(code);return http?`HTTP ${http[1]}`:ERRORS[code]||code;}
// Normalises the editor form into the configure request body.
export function integrationPayload(values,existing){
  const body={action:existing?'update':'create',kind:existing?.kind||values.kind,name:String(values.name||'').trim(),events:[...(values.events||[])],includeGuestDetails:!!values.includeGuestDetails,enabled:!!values.enabled};
  if(existing)body.id=existing.id;
  const url=String(values.url||'').trim();if(url)body.url=url;
  return body;
}
export function validateIntegration(body,{requireUrl,webhookHosts=true}){
  if(!KINDS[body.kind])return {field:'kind',message:'Choose a destination type.'};
  if(body.kind==='webhook'&&body.action==='create'&&!webhookHosts)return {field:'kind',message:'Custom webhooks are not available on this service.'};
  if(!body.name)return {field:'name',message:'Enter a name.'};
  if(requireUrl&&!body.url)return {field:'url',message:'Enter the destination URL.'};
  if(body.url){let u;try{u=new URL(body.url);}catch{return {field:'url',message:'Enter a full URL starting with https://'};}if(u.protocol!=='https:')return {field:'url',message:'Use an https:// URL.'};}
  if(!body.events.length)return {field:'events',message:'Choose at least one event.'};
  return null;
}
const n=v=>Number.isSafeInteger(v)&&v>0?v:0;
const kindMark=kind=>`<span class="integration-mark kind-${esc(kind)}" aria-hidden="true">${{webhook:'{ }',slack:'#',discord:'@'}[kind]||'•'}</span>`;
export function integrationsMarkup(data,{loading,error,formatTime}){
  if(loading&&!data)return '<div class="team-state" role="status">Loading integrations…</div>';
  if(!data){return `<div class="team-state"><p class="error" role="alert">${esc(error||'Integrations are unavailable.')}</p><button type="button" class="secondary compact-button" data-integrations-retry>Try again</button></div>`;}
  const items=data.integrations,byId=new Map(items.map(i=>[i.id,i])),deliveries=data.deliveries||[];
  const list=items.length?`<ul class="integration-list">${items.map(i=>`<li class="integration-row ${i.enabled?'':'paused'}">${kindMark(i.kind)}<span class="integration-main"><strong>${esc(i.name)}</strong><small>${esc(KINDS[i.kind]?.label||i.kind)}${i.destinationLabel?` · ${esc(i.destinationLabel)}`:''} · ${i.events?.length||0} ${i.events?.length===1?'event':'events'}${i.includeGuestDetails?' · Guest details':''}</small></span><span class="booking-badge ${i.enabled?'state-confirmed':''}">${i.enabled?'Active':'Paused'}</span><span class="integration-actions"><button type="button" class="quiet-button" data-test-integration="${esc(i.id)}" ${i.enabled?'':'disabled title="Resume to send a test"'} aria-label="Send test notification to ${esc(i.name)}">Send test</button><button type="button" class="quiet-button" data-toggle-integration="${esc(i.id)}" aria-label="${i.enabled?'Pause':'Resume'} ${esc(i.name)}">${i.enabled?'Pause':'Resume'}</button><button type="button" class="quiet-button" data-edit-integration="${esc(i.id)}" aria-label="Edit ${esc(i.name)}">Edit</button></span></li>`).join('')}</ul>`:`<div class="integration-catalog">${['slack','discord','webhook'].map(kind=>`<button type="button" class="integration-connect" data-add-integration data-kind="${kind}" aria-label="Connect ${KINDS[kind].label}">${kindMark(kind)}<strong>${KINDS[kind].label}</strong><span>${{slack:'Booking updates in your channel.',discord:'Booking updates in your server.',webhook:'Booking events to your app.'}[kind]}</span><span class="integration-connect-action">Connect <span aria-hidden="true">↗</span></span></button>`).join('')}</div>`;
  const log=items.length||deliveries.length?`<section class="team-block" aria-labelledby="deliveries-title"><div class="team-block-head"><h2 id="deliveries-title" tabindex="-1">Recent deliveries</h2><span class="team-count">${deliveries.length}</span><button type="button" class="quiet-button delivery-refresh" data-refresh-integrations aria-label="Refresh deliveries">Refresh</button></div>${deliveries.length?`<ul class="delivery-log">${deliveries.map(d=>{const when=d.lastAttemptAt||d.nextAttemptAt;return `<li class="delivery-entry"><span class="delivery-when">${when?esc(formatTime(when)):'Not sent'}</span><span class="delivery-what"><strong>${esc(eventLabel(d.eventType))}</strong><small>${esc(byId.get(d.integrationId)?.name||'Removed integration')}${d.attempts?` · ${d.attempts} ${d.attempts===1?'attempt':'attempts'}`:''}${d.state==='retry'&&d.nextAttemptAt?` · Next ${esc(formatTime(d.nextAttemptAt))}`:''}</small>${d.errorCode?`<small class="${['failed','retry','quarantined'].includes(d.state)?'delivery-error':''}">${esc(errorLabel(d.errorCode))}</small>`:''}</span><span class="booking-badge delivery-state-${esc(d.state)}">${esc(deliveryStateLabel(d.state))}</span><span class="delivery-actions">${canRetry(d)&&byId.get(d.integrationId)?.enabled?`<button type="button" class="secondary compact-button" data-retry-delivery="${esc(d.id)}" aria-label="Retry ${esc(eventLabel(d.eventType))}">Retry</button>`:''}${canDiscard(d)?`<button type="button" class="quiet-button" data-discard-delivery="${esc(d.id)}" aria-label="Discard ${esc(eventLabel(d.eventType))}">Discard</button>`:''}</span></li>`;}).join('')}</ul>${data.deliveriesTruncated||data.truncated?'<p class="booking-zone">Showing the latest deliveries</p>':''}`:'<p class="team-empty">No deliveries yet.</p>'}</section>`:'';
  const held=n(data.status?.summary?.quarantined),failed=n(data.status?.summary?.failed);
  const notice=held?`<div class="setup-callout workspace-notice" role="status"><div><strong>${held} ${held===1?'delivery is':'deliveries are'} held after a restore</strong><span>Held deliveries are not sent. Discard them to let outbound delivery resume.</span></div></div>`:failed?`<div class="setup-callout" role="status"><div><strong>${failed} failed ${failed===1?'delivery':'deliveries'}</strong><span>Retry sends the same event again. Receivers may see it twice.</span></div></div>`:'';
  return `${error?`<p class="error" role="alert">${esc(error)}</p>`:''}${notice}<section class="team-block integrations-block" aria-label="Integrations">${list}</section>${log}`;
}
export function bindIntegrations(container,{api,getData,reload,status}){
  const retry=container.querySelector('[data-integrations-retry]');if(retry)retry.onclick=reload;
  const find=id=>getData()?.integrations?.find(i=>i.id===id);
  const configure=async body=>{const current=body.id?find(body.id):null;return api('integrations',current?{...body,expectedRevision:current.revision}:body);};
  const withButton=async(button,label,fn)=>{button.disabled=true;const text=button.textContent;button.textContent=label;try{await fn();}catch(e){status(e.code==='integration_conflict'?'This integration changed elsewhere. Review and try again.':e.message||'That did not work.');if(e.code==='integration_conflict')await reload();}finally{if(button.isConnected){button.disabled=false;button.textContent=text;}}};
  const refocus=selector=>requestAnimationFrame(()=>document.querySelector(selector)?.focus());
  const refresh=container.querySelector('[data-refresh-integrations]');if(refresh)refresh.onclick=()=>withButton(refresh,'Refreshing…',async()=>{await reload();refocus('[data-refresh-integrations]');});
  container.querySelectorAll('[data-test-integration]').forEach(b=>b.onclick=()=>withButton(b,'Sending…',async()=>{const id=b.dataset.testIntegration;const result=await api('integrations/test',{id});await reload();status(result?.state==='failed'?'Test notification could not be queued':'Test notification queued');refocus(`[data-test-integration="${CSS.escape(id)}"]`);}));
  container.querySelectorAll('[data-toggle-integration]').forEach(b=>b.onclick=()=>withButton(b,'Saving…',async()=>{const i=find(b.dataset.toggleIntegration);if(!i)return;await configure({action:'update',id:i.id,enabled:!i.enabled});await reload();status(i.enabled?`${i.name} paused`:`${i.name} resumed`);refocus(`[data-toggle-integration="${CSS.escape(i.id)}"]`);}));
  container.querySelectorAll('[data-retry-delivery]').forEach(b=>b.onclick=()=>withButton(b,'Retrying…',async()=>{await api('integrations/retry',{deliveryId:b.dataset.retryDelivery});await reload();status('Delivery queued for retry');refocus('#deliveries-title');}));
  container.querySelectorAll('[data-discard-delivery]').forEach(b=>b.onclick=()=>{const d=getData()?.deliveries?.find(x=>x.id===b.dataset.discardDelivery);if(!d)return;
    confirmAction({title:'Discard this delivery?',body:`${eventLabel(d.eventType)} will not be sent${d.state==='quarantined'?' or replayed':''}. This cannot be undone.`,confirmLabel:'Discard delivery',trigger:b,restore:()=>document.querySelector('[data-discard-delivery]')||document.querySelector('#deliveries-title'),run:async()=>{await api('integrations/retry',{deliveryId:d.id,action:'discard'});await reload();status('Delivery discarded');}});});
  container.querySelectorAll('[data-add-integration]').forEach(b=>b.onclick=()=>showIntegrationEditor({configure,getData,reload,status,trigger:b,initialKind:b.dataset.kind}));
  container.querySelectorAll('[data-edit-integration]').forEach(b=>b.onclick=()=>{const i=find(b.dataset.editIntegration);if(i)showIntegrationEditor({configure,getData,reload,status,existing:i,trigger:b});});
}
export function showIntegrationEditor({configure,getData,reload,status,existing,trigger,initialKind}){
  const restore=()=>document.querySelector(existing?`[data-edit-integration="${CSS.escape(existing.id)}"]`:'#add-integration')||document.querySelector('#add-integration')||document.querySelector('h1');
  const {dialog,state,dismiss}=createDialog({label:existing?`Edit ${existing.name}`:'Add integration',trigger,restore});
  const catalog=eventCatalog(getData());
  const selectedEvents=new Set(existing?.events||DEFAULT_EVENTS.filter(e=>catalog.some(c=>c.id===e)));
  let step='form',initial='';
  const kindOf=()=>existing?.kind||dialog.querySelector('[name=kind]:checked')?.value||'webhook';
  function formMarkup(){
    const hostsReady=webhookHostsReady(getData()),kind=existing?.kind||(KINDS[initialKind]?initialKind:'slack'),k=KINDS[kind];
    return `${dialogHead(existing?'Edit integration':'Add integration',existing?`Close edit ${existing.name}`:'Close add integration')}<form class="workspace-form integration-form" novalidate><div class="booking-detail-body">${existing?`<h2>${esc(existing.name)}</h2>`:`<fieldset class="kind-options"><legend>Send to</legend>${['slack','discord','webhook'].map(id=>`<label class="kind-option"><input type="radio" name="kind" value="${id}" ${id===kind?'checked':''}><span>${kindMark(id)}${KINDS[id].label}</span></label>`).join('')}</fieldset><p class="hint webhook-gate" id="webhook-host-note" role="status" hidden>${hostsReady?'Webhooks send only to hostnames approved by the service operator.':'Custom webhooks are not available. The service operator has not approved any webhook hosts.'}</p>`}
      <label class="field-label" for="integration-name">Name</label><input id="integration-name" name="name" required maxlength="80" value="${esc(existing?.name||'')}" autocomplete="off">
      <label class="field-label" for="integration-url" id="integration-url-label">${existing?'Replace URL':esc(k.url)}${existing?' <span class="optional-label">Optional</span>':''}</label><input id="integration-url" name="url" type="url" inputmode="url" autocomplete="off" spellcheck="false" ${existing?'':'required'} placeholder="${esc(existing?'Leave blank to keep the saved URL':k.placeholder)}" aria-describedby="integration-url-hint"><p class="hint" id="integration-url-hint">${existing?.destinationLabel?`Saved: ${esc(existing.destinationLabel)}. `:''}Not shown again after saving.</p>
      <fieldset class="event-options" aria-describedby="integration-events-error"><legend>Events</legend>${catalog.map(e=>`<label class="inline-check"><input type="checkbox" name="events" value="${esc(e.id)}" ${selectedEvents.has(e.id)?'checked':''}>${esc(e.label)}</label>`).join('')}</fieldset>
      <fieldset class="data-options"><legend>Data shared</legend><p class="hint data-base">Event, meeting name, time and booking status. Intake answers are never sent.</p><label class="inline-check"><input type="checkbox" name="includeGuestDetails" ${existing?.includeGuestDetails?'checked':''}>Include guest name and email</label><label class="inline-check"><input type="checkbox" name="enabled" ${existing?existing.enabled?'checked':'':'checked'}>Active</label></fieldset>
      ${existing?`<div class="member-more">${existing.kind==='webhook'?'<button type="button" class="quiet-button" data-rotate>Rotate signing secret…</button>':''}<button type="button" class="danger-quiet integration-remove" data-remove>Remove integration…</button></div>`:''}<p class="error" role="alert" id="integration-events-error"></p></div><footer class="booking-detail-footer"><button type="button" class="secondary" data-cancel>Cancel</button><button type="submit" class="primary">${existing?'Save changes':'Add integration'}</button></footer></form>`;
  }
  const read=()=>{const f=dialog.querySelector('form');return {kind:kindOf(),name:f.elements.name.value,url:f.elements.url.value,events:[...f.querySelectorAll('[name=events]:checked')].map(i=>i.value),includeGuestDetails:f.elements.includeGuestDetails.checked,enabled:f.elements.enabled.checked};};
  const snapshot=()=>JSON.stringify(read());
  state.isDirty=()=>step==='form'&&!!dialog.querySelector('form')&&snapshot()!==initial;
  function bindForm(){
    const form=dialog.querySelector('form'),error=dialog.querySelector('#integration-events-error');
    dialog.querySelector('[data-close]').onclick=dismiss;dialog.querySelector('[data-cancel]').onclick=dismiss;
    form.addEventListener('input',()=>{if(error.textContent){error.textContent='';form.querySelectorAll('[aria-invalid]').forEach(i=>i.removeAttribute('aria-invalid'));}});
    form.querySelectorAll('[name=kind]').forEach(r=>r.onchange=()=>{const k=KINDS[r.value];const gated=r.value==='webhook';dialog.querySelector('#webhook-host-note').hidden=!gated;const blocked=gated&&!webhookHostsReady(getData());['url','name'].forEach(n=>form.elements[n].disabled=blocked);form.querySelector('[type=submit]').disabled=blocked;dialog.querySelector('#integration-url-label').textContent=k.url;form.elements.url.placeholder=k.placeholder;});
    if(!existing)form.querySelector('[name=kind]:checked')?.dispatchEvent(new Event('change'));
    const remove=dialog.querySelector('[data-remove]');if(remove)remove.onclick=()=>{step='remove';drawConfirm('remove');};const rotate=dialog.querySelector('[data-rotate]');if(rotate)rotate.onclick=()=>{step='rotate';drawConfirm('rotate');};
    form.onsubmit=async e=>{e.preventDefault();if(state.working)return;const body=integrationPayload(read(),existing);const invalid=validateIntegration(body,{requireUrl:!existing,webhookHosts:webhookHostsReady(getData())});
      form.querySelectorAll('[aria-invalid]').forEach(i=>i.removeAttribute('aria-invalid'));
      if(invalid){error.textContent=invalid.message;const target=invalid.field==='events'?form.querySelector('[name=events]'):form.elements[invalid.field];if(invalid.field!=='events')target?.setAttribute?.('aria-invalid','true');(target?.length?target[0]:target)?.focus();return;}
      state.working=true;const submit=form.querySelector('[type=submit]');submit.disabled=true;submit.textContent='Saving…';error.textContent='';
      try{const result=await configure(body);form.elements.url.value='';state.working=false;await reload();const secret=result?.signingSecret||result?.secret;status(existing?'Integration saved':'Integration added');if(secret){step='secret';drawSecret(secret,result?.integration?.name||body.name);}else{state.isDirty=()=>false;dialog.close();}}
      catch(err){state.working=false;submit.disabled=false;submit.textContent=existing?'Save changes':'Add integration';if(err.code==='integration_conflict'){await reload();const latest=getData()?.integrations?.find(i=>i.id===existing?.id);if(latest)existing.revision=latest.revision;error.textContent='This integration changed elsewhere. Your edits are still here. Save again to apply them.';}else error.textContent=err.message||'The integration could not be saved.';submit.focus();}};
  }
  function drawConfirm(kind){
    const removing=kind==='remove';
    dialog.innerHTML=`${dialogHead(removing?'Remove integration':'Rotate signing secret',`Close ${removing?'remove':'rotate'} ${existing.name}`)}<div class="booking-detail-body"><div class="member-confirm"><strong>${removing?`Remove ${esc(existing.name)}?`:`Rotate the signing secret for ${esc(existing.name)}?`}</strong><p>${removing?`New events stop sending to ${esc(existing.destinationLabel||'this destination')}.`:'The current secret stops working immediately. Update your receiving service with the new one.'}</p></div><p class="error" role="alert"></p></div><footer class="booking-detail-footer"><button type="button" class="secondary" data-back>Back</button><button type="button" class="danger-button" data-confirm>${removing?'Remove integration':'Rotate secret'}</button></footer>`;
    dialog.querySelector('[data-close]').onclick=()=>{if(!state.working)dialog.close();};
    dialog.querySelector('[data-back]').onclick=()=>{step='form';dialog.innerHTML=formMarkup();bindForm();initial=snapshot();dialog.querySelector(removing?'[data-remove]':'[data-rotate]').focus();};
    const go=dialog.querySelector('[data-confirm]'),label=go.textContent;go.onclick=async()=>{if(state.working)return;state.working=true;go.disabled=true;go.textContent=removing?'Removing…':'Rotating…';
      try{const result=await configure({action:kind,id:existing.id});state.working=false;await reload();
        if(removing){status(`${existing.name} removed`);dialog.close();requestAnimationFrame(()=>(document.querySelector('[data-edit-integration]')||document.querySelector('#add-integration'))?.focus());}
        else{const secret=result?.signingSecret||result?.secret;status('Signing secret rotated');if(secret){step='secret';drawSecret(secret,existing.name);}else dialog.close();}}
      catch(e){state.working=false;go.disabled=false;go.textContent=label;dialog.querySelector('[role=alert]').textContent=e.message||'That did not work. Try again.';go.focus();}};
    dialog.querySelector('[data-back]').focus();
  }
  function drawSecret(secret,name){
    let shown=false;dialog.setAttribute('aria-label','Signing secret');
    const draw=()=>{dialog.innerHTML=`${dialogHead('Signing secret','Close signing secret')}<div class="booking-detail-body"><h2>Signing secret for ${esc(name)}</h2><p class="muted">Verify the x-scheduling-signature header with this secret. It is shown only now.</p><div class="copy-field"><input id="integration-secret" readonly aria-label="Signing secret" spellcheck="false" autocomplete="off" type="${shown?'text':'password'}" value="${esc(secret)}"><button type="button" class="secondary compact-button" data-reveal aria-pressed="${shown}">${shown?'Hide':'Reveal'}</button><button type="button" class="secondary compact-button" data-copy>Copy</button></div><p class="hint" role="status" data-copy-status></p></div><footer class="booking-detail-footer"><button type="button" class="primary" data-done>Done</button></footer>`;
      dialog.querySelector('[data-close]').onclick=()=>dialog.close();dialog.querySelector('[data-done]').onclick=()=>dialog.close();
      dialog.querySelector('[data-reveal]').onclick=()=>{shown=!shown;draw();dialog.querySelector('[data-reveal]').focus();};
      dialog.querySelector('[data-copy]').onclick=async()=>{const field=dialog.querySelector('#integration-secret');const ok=await copyText(secret,shown?field:null);dialog.querySelector('[data-copy-status]').textContent=ok?'Secret copied':'Copy blocked by the browser. Reveal and copy it manually.';};};
    draw();state.isDirty=()=>false;dialog.addEventListener('close',()=>{secret='';},{once:true});dialog.querySelector('[data-reveal]').focus();
  }
  dialog.innerHTML=formMarkup();bindForm();initial=snapshot();dialog.showModal();
  (existing?dialog.querySelector('#integration-name'):dialog.querySelector('[name=kind]:checked'))?.focus();
}
