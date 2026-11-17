// Slack, Discord and webhook notifications. Destination URLs are write-only: after saving, only the
// backend's destinationLabel is shown. A signing secret returned once is held in its dialog only.
// Brand marks: Slack and Discord from Simple Icons (CC0 1.0); the webhook glyph from Lucide (ISC).
import {esc,createDialog,copyText,confirmAction} from './workspace-ui.js';
import {showRowMenu} from './bookings-ui.js';

export const webhookHostsReady=data=>!!(data?.status?.customWebhookHostsConfigured??data?.customWebhookHostsConfigured);
export const KINDS={
  slack:{label:'Slack',url:'Slack webhook URL',placeholder:'https://hooks.slack.com/services/…',blurb:'Post to a channel',help:'https://docs.slack.dev/messaging/sending-messages-using-incoming-webhooks/',helpLabel:'Create an incoming webhook in Slack'},
  discord:{label:'Discord',url:'Discord webhook URL',placeholder:'https://discord.com/api/webhooks/…',blurb:'Post to a server channel',help:'https://support.discord.com/hc/en-us/articles/228383668-Intro-to-Webhooks',helpLabel:'Create a webhook in Discord'},
  webhook:{label:'Webhook',url:'Endpoint URL',placeholder:'https://example.com/hooks/scheduling',blurb:'Send signed events to your app'}
};
const ORDER=['slack','discord','webhook'];
const LOGOS={
  slack:'<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path fill="#E01E5A" d="M5.042 15.165a2.528 2.528 0 0 1-2.52 2.523A2.528 2.528 0 0 1 0 15.165a2.527 2.527 0 0 1 2.522-2.52h2.52v2.52zM6.313 15.165a2.527 2.527 0 0 1 2.521-2.52 2.527 2.527 0 0 1 2.521 2.52v6.313A2.528 2.528 0 0 1 8.834 24a2.528 2.528 0 0 1-2.521-2.522v-6.313z"/><path fill="#36C5F0" d="M8.834 5.042a2.528 2.528 0 0 1-2.521-2.52A2.528 2.528 0 0 1 8.834 0a2.528 2.528 0 0 1 2.521 2.522v2.52H8.834zM8.834 6.313a2.528 2.528 0 0 1 2.521 2.521 2.528 2.528 0 0 1-2.521 2.521H2.522A2.528 2.528 0 0 1 0 8.834a2.528 2.528 0 0 1 2.522-2.521h6.312z"/><path fill="#2EB67D" d="M18.956 8.834a2.528 2.528 0 0 1 2.522-2.521A2.528 2.528 0 0 1 24 8.834a2.528 2.528 0 0 1-2.522 2.521h-2.522V8.834zM17.688 8.834a2.528 2.528 0 0 1-2.523 2.521 2.527 2.527 0 0 1-2.52-2.521V2.522A2.527 2.527 0 0 1 15.165 0a2.528 2.528 0 0 1 2.523 2.522v6.312z"/><path fill="#ECB22E" d="M15.165 18.956a2.528 2.528 0 0 1 2.523 2.522A2.528 2.528 0 0 1 15.165 24a2.527 2.527 0 0 1-2.52-2.522v-2.522h2.52zM15.165 17.688a2.527 2.527 0 0 1-2.52-2.523 2.526 2.526 0 0 1 2.52-2.52h6.313A2.527 2.527 0 0 1 24 15.165a2.528 2.528 0 0 1-2.522 2.523h-6.313z"/></svg>',
  discord:'<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path fill="#5865F2" d="M20.317 4.3698a19.7913 19.7913 0 00-4.8851-1.5152.0741.0741 0 00-.0785.0371c-.211.3753-.4447.8648-.6083 1.2495-1.8447-.2762-3.68-.2762-5.4868 0-.1636-.3933-.4058-.8742-.6177-1.2495a.077.077 0 00-.0785-.037 19.7363 19.7363 0 00-4.8852 1.515.0699.0699 0 00-.0321.0277C.5334 9.0458-.319 13.5799.0992 18.0578a.0824.0824 0 00.0312.0561c2.0528 1.5076 4.0413 2.4228 5.9929 3.0294a.0777.0777 0 00.0842-.0276c.4616-.6304.8731-1.2952 1.226-1.9942a.076.076 0 00-.0416-.1057c-.6528-.2476-1.2743-.5495-1.8722-.8923a.077.077 0 01-.0076-.1277c.1258-.0943.2517-.1923.3718-.2914a.0743.0743 0 01.0776-.0105c3.9278 1.7933 8.18 1.7933 12.0614 0a.0739.0739 0 01.0785.0095c.1202.099.246.1981.3728.2924a.077.077 0 01-.0066.1276 12.2986 12.2986 0 01-1.873.8914.0766.0766 0 00-.0407.1067c.3604.698.7719 1.3628 1.225 1.9932a.076.076 0 00.0842.0286c1.961-.6067 3.9495-1.5219 6.0023-3.0294a.077.077 0 00.0313-.0552c.5004-5.177-.8382-9.6739-3.5485-13.6604a.061.061 0 00-.0312-.0286zM8.02 15.3312c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9555-2.4189 2.157-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.9555 2.4189-2.1569 2.4189zm7.9748 0c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9554-2.4189 2.1569-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.946 2.4189-2.1568 2.4189Z"/></svg>',
  webhook:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M18 16.98h-5.99c-1.1 0-1.95.94-2.48 1.9A4 4 0 0 1 2 17c.01-.7.2-1.4.57-2"/><path d="m6 17 3.13-5.78c.53-.97.1-2.18-.5-3.1a4 4 0 1 1 6.89-4.06"/><path d="m12 6 3.13 5.73C15.66 12.7 16.9 13 18 13a4 4 0 0 1 0 8"/></svg>'
};
const CLOSE='<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg>';
const icon=paths=>`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${paths}</svg>`;
const ICONS={
  check:icon('<path d="m5 12.5 4.5 4.5L19 7.5"/>'),
  cross:icon('<path d="m7 7 10 10M17 7 7 17"/>'),
  send:icon('<path d="M20.5 3.5 10 14"/><path d="m20.5 3.5-6.6 17-3.9-6.5-6.5-3.9z"/>'),
  clock:icon('<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>'),
  alert:icon('<path d="M10.3 4 2.7 17.3a2 2 0 0 0 1.7 3h15.2a2 2 0 0 0 1.7-3L13.7 4a2 2 0 0 0-3.4 0z"/><path d="M12 9v4.2"/><path d="M12 16.6h.01"/>'),
  plus:icon('<path d="M12 5.5v13M5.5 12h13"/>'),
  chevron:icon('<path d="m9 6 6 6-6 6"/>'),
  spinner:'<svg class="integration-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="8.5" opacity=".22"/><path d="M20.5 12A8.5 8.5 0 0 0 12 3.5"/></svg>'
};
export const kindMark=(kind,size='')=>`<span class="integration-mark kind-${esc(kind)}${size?' '+size:''}" aria-hidden="true">${LOGOS[kind]||''}</span>`;

const EVENT_LABELS={'booking.confirmed':'Booking confirmed','booking.requested':'Booking requested','booking.approval_requested':'Approval needed','booking.rejected':'Request declined','booking.expired':'Request expired','booking.rescheduled':'Booking rescheduled','booking.cancelled':'Booking cancelled','integration.test':'Test notification'};
// The editor groups events and drops the repeated noun; the activity list keeps the full labels.
const EVENT_GROUPS=[
  {label:'Bookings',events:{'booking.requested':'Requested','booking.confirmed':'Confirmed','booking.rescheduled':'Rescheduled','booking.cancelled':'Cancelled'}},
  {label:'Approvals',events:{'booking.approval_requested':'Needs approval','booking.rejected':'Declined','booking.expired':'Expired'}}
];
const SHORT=Object.assign({},...EVENT_GROUPS.map(g=>g.events));
const DEFAULT_EVENTS=['booking.confirmed','booking.cancelled'];
export const eventLabel=type=>EVENT_LABELS[type]||String(type||'');
export function eventCatalog(data){
  const source=data?.capabilities?.events||data?.eventTypes;
  const list=Array.isArray(source)?source.map(e=>typeof e==='string'?e:e?.id).filter(Boolean):Object.keys(EVENT_LABELS).filter(e=>e!=='integration.test');
  return list.map(id=>({id,label:eventLabel(id)}));
}
// Groups the backend catalog for the editor; unknown future events land in their own group.
export function eventGroups(catalog){
  const ids=catalog.map(e=>e.id),known=new Set(Object.keys(SHORT));
  const groups=EVENT_GROUPS.map(g=>({label:g.label,events:Object.keys(g.events).filter(id=>ids.includes(id)).map(id=>({id,label:g.events[id]}))}));
  const other=catalog.filter(e=>!known.has(e.id));if(other.length)groups.push({label:'Other',events:other});
  return groups.filter(g=>g.events.length);
}
export function eventSummary(events,catalog=[]){
  const chosen=[...new Set(events||[])];if(!chosen.length)return 'No events';
  if(catalog.length&&catalog.every(e=>chosen.includes(e.id)))return 'All events';
  if(chosen.length>3)return `${chosen.length} events`;
  const rank=Object.keys(SHORT);chosen.sort((a,b)=>(rank.indexOf(a)+1||99)-(rank.indexOf(b)+1||99));
  return chosen.map((id,i)=>{const label=SHORT[id]||eventLabel(id);return i?label.toLowerCase():label;}).join(', ');
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
// Mirrors validateDestination in src/integrations.js so a wrong paste is caught at the field.
// The Worker still decides; webhook hosts are checked there against the operator's list.
const URL_RULES={
  slack:{host:'hooks.slack.com',path:/^\/services\/[A-Za-z0-9]{5,80}\/[A-Za-z0-9]{5,80}\/[A-Za-z0-9_-]{10,256}$/,message:'This isn’t a Slack incoming webhook URL.'},
  discord:{host:'discord.com',path:/^\/api(?:\/v10)?\/webhooks\/[0-9]{5,30}\/[A-Za-z0-9_-]{20,256}$/,message:'This isn’t a Discord webhook URL.'}
};
export function validateIntegration(body,{requireUrl,webhookHosts=true}){
  if(!KINDS[body.kind])return {field:'kind',message:'Choose a destination type.'};
  if(body.kind==='webhook'&&body.action==='create'&&!webhookHosts)return {field:'kind',message:'Custom webhooks are not available on this service.'};
  if(requireUrl&&!body.url)return {field:'url',message:body.kind==='webhook'?'Enter the endpoint URL.':`Paste the ${KINDS[body.kind].label} webhook URL.`};
  if(body.url){
    let u;try{u=new URL(body.url);}catch{return {field:'url',message:'Enter a full URL starting with https://'};}
    if(u.protocol!=='https:')return {field:'url',message:'Use an https:// URL.'};
    if(u.username||u.password||u.hash||(u.port&&u.port!=='443'))return {field:'url',message:'Use a public https:// address without a port or sign-in details.'};
    const rule=URL_RULES[body.kind];if(rule&&(u.hostname!==rule.host||!rule.path.test(u.pathname)||u.search))return {field:'url',message:rule.message};
  }
  if(!body.name)return {field:'name',message:'Enter a name.'};
  if(!body.events.length)return {field:'events',message:'Choose at least one event.'};
  return null;
}
const n=v=>Number.isSafeInteger(v)&&v>0?v:0;
// Whether the person opened or closed the delivery log; null until they touch it, so it can open by itself.
let logOpen=null;
const plural=(count,one,many)=>`${count} ${count===1?one:many}`;

// The newest delivery decides whether a row needs attention; healthy rows stay quiet.
export function integrationHealth(id,deliveries=[]){
  const last=deliveries.find(d=>d.integrationId===id&&d.state!=='cancelled');
  if(!last)return null;
  if(['failed','quarantined'].includes(last.state))return {tone:'failed',label:last.state==='quarantined'?'Held':'Failing',text:`Last delivery ${last.state==='quarantined'?'held':'failed'}${last.errorCode?`: ${errorLabel(last.errorCode)}`:''}`};
  if(last.state==='retry')return {tone:'retry',label:'Retrying',text:`Retrying${last.errorCode?`: ${errorLabel(last.errorCode)}`:''}`};
  return null;
}
// Rows follow Settings: a tile, the name with one muted line, and one control. The name opens
// the editor; the chevron opens the row's menu (test, edit, turn on or off, remove).
const CHEVRON='<svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true" focusable="false"><path d="M7.5 4.5 13 10l-5.5 5.5"/></svg>';
const tile=kind=>`<span class="st-tile st-tile-mark integration-mark kind-${esc(kind)}" aria-hidden="true">${LOGOS[kind]||''}</span>`;
function integrationRow(i,catalog,deliveries){
  const k=KINDS[i.kind],id=esc(i.id),name=esc(i.name),metaId=`integration-meta-${id}`,health=i.enabled?integrationHealth(i.id,deliveries):null;
  const meta=health?[health.label,health.text.replace(/^(Last delivery (failed|held)|Retrying): /,'')].filter(Boolean).join(' · '):[i.enabled?'':'Off',k?.label||i.kind,i.kind==='webhook'?i.destinationLabel:'',eventSummary(i.events,catalog),i.includeGuestDetails?'Shares guest details':''].filter(Boolean).join(' · ');
  return `<div class="st-row integration-row${i.enabled?'':' off'}${health?' has-problem':''}">${tile(i.kind)}<button type="button" class="st-text st-text-button" data-edit-integration="${id}" aria-label="Edit ${name}" aria-describedby="${metaId}"><span class="st-name">${name}</span><span class="st-line${health?' st-line-problem':''}" id="${metaId}">${esc(meta)}</span></button><button type="button" class="st-chev-button" data-integration-menu="${id}" aria-label="More for ${name}" aria-haspopup="menu" aria-expanded="false">${CHEVRON}</button></div>`;
}
// With nothing connected, the same list offers what can be connected.
function choiceRow(kind,{hostsReady,full}){
  const k=KINDS[kind],unavailable=kind==='webhook'&&!hostsReady;
  const action=unavailable||full?'':`<button type="button" class="st-pill" data-add-integration data-kind="${kind}" aria-label="Connect ${k.label}">Connect</button>`;
  return `<div class="st-row integration-row integration-choice${unavailable?' off is-unavailable':''}" data-choice="${kind}">${tile(kind)}<span class="st-text"><span class="st-name">${k.label}</span><span class="st-line">${unavailable?'Not available on this service':k.blurb}</span></span>${action}</div>`;
}
// The header action. Hidden while the empty list already offers every choice.
export function integrationsHeading(data){
  const items=data?.integrations||[],limit=n(data?.limits?.integrations);
  if(!items.length||limit&&items.length>=limit)return '';
  return '<button type="button" class="st-pill" id="add-integration" data-add-menu aria-haspopup="menu" aria-expanded="false">Add integration</button>';
}
function deliveryEntry(d,byId,formatTime){
  const owner=byId.get(d.integrationId),when=d.lastAttemptAt||d.nextAttemptAt,label=esc(eventLabel(d.eventType));
  const tone=['failed','quarantined'].includes(d.state)?'delivery-error':d.state==='retry'?'delivery-warn':'';
  const detail=[d.errorCode?errorLabel(d.errorCode):'',d.attempts>1?plural(d.attempts,'attempt','attempts'):'',d.state==='retry'&&d.nextAttemptAt?`Next try ${formatTime(d.nextAttemptAt)}`:''].filter(Boolean).map(esc).join(' · ');
  const actions=`${canRetry(d)&&owner?.enabled?`<button type="button" class="secondary compact-button" data-retry-delivery="${esc(d.id)}" aria-label="Retry ${label}">Retry</button>`:''}${canDiscard(d)?`<button type="button" class="quiet-button" data-discard-delivery="${esc(d.id)}" aria-label="Discard ${label}">Discard</button>`:''}`;
  return `<div class="delivery-entry" role="listitem"><span class="delivery-when">${when?esc(formatTime(when)):'Not sent yet'}</span>${owner?kindMark(owner.kind,'sm'):'<span class="integration-mark sm" aria-hidden="true"></span>'}<span class="delivery-what"><span class="delivery-title"><strong>${label}</strong><span class="delivery-to">${esc(owner?.name||'Removed integration')}</span></span>${detail?`<small class="${tone}">${detail}</small>`:''}</span><span class="booking-badge delivery-state-${esc(d.state)}">${esc(deliveryStateLabel(d.state))}</span>${actions?`<span class="delivery-actions">${actions}</span>`:''}</div>`;
}
export function integrationsMarkup(data,{loading,error,formatTime}){
  if(loading&&!data)return '<p class="st-note" role="status">Loading…</p>';
  if(!data){return `<p class="st-note error" role="alert">${esc(error||'Notifications are unavailable.')}</p><button type="button" class="st-pill" data-integrations-retry>Try again</button>`;}
  const items=data.integrations||[],byId=new Map(items.map(i=>[i.id,i])),deliveries=data.deliveries||[],catalog=eventCatalog(data);
  const limit=n(data.limits?.integrations),full=!!limit&&items.length>=limit,hostsReady=webhookHostsReady(data);
  const list=`<div class="st-rows integration-card">${items.length?items.map(i=>integrationRow(i,catalog,deliveries)).join(''):ORDER.map(kind=>choiceRow(kind,{hostsReady,full})).join('')}</div>${full?`<p class="st-note">Limit of ${limit} reached</p>`:''}`;
  const held=n(data.status?.summary?.quarantined),failed=n(data.status?.summary?.failed);
  const attention=!!(held||failed||deliveries.some(d=>['failed','retry','quarantined'].includes(d.state))),open=logOpen??attention;
  const trouble=deliveries.filter(d=>['failed','quarantined'].includes(d.state)).length;
  const log=items.length||deliveries.length?`<details class="integration-log" data-integration-log ${open?'open':''}><summary id="deliveries-title"><span class="link-button">Recent deliveries</span>${trouble?`<span class="integration-log-alert">· ${plural(trouble,'needs','need')} attention</span>`:''}</summary><div class="integration-log-body">${deliveries.length?`<div class="card delivery-log" role="list">${deliveries.map(d=>deliveryEntry(d,byId,formatTime)).join('')}</div>`:'<div class="card bk-empty">No deliveries yet</div>'}</div></details>`:'';
  const notice=held?`<div class="integration-notice is-held" role="status">${ICONS.alert}<span><strong>${held} ${held===1?'delivery is':'deliveries are'} held after a restore</strong><span>Discard to resume sending.</span></span></div>`:'';
  return `<div class="integrations-page">${error?`<p class="error" role="alert">${esc(error)}</p>`:''}${notice}<div>${list}</div>${log}</div>`;
}

// After a test, checks back a few times so the result shows without pressing Refresh. It stays out of
// the way: no refresh while a dialog or menu is open or away from this page, and focus is kept.
const PENDING=new Set(['queued','in_flight']);
// Current Workers send a test in the request; older ones only queue it.
export function testStatus(result,name){
  const why=errorLabel(result?.errorCode);
  if(result?.state==='delivered')return `Test delivered to ${name}`;
  if(result?.state==='failed')return result.errorCode&&result.errorCode!=='queue_capacity'?`Test to ${name} failed. ${why}`:'Test notification could not be queued';
  if(result?.state==='retry')return `Test to ${name} not delivered yet. ${why}`.trim();
  return 'Test notification queued';
}
function focusKey(el){if(!el||el===document.body)return '';if(el.id)return '#'+CSS.escape(el.id);return [...el.attributes].filter(a=>a.name.startsWith('data-')||a.name==='aria-label').map(a=>`[${a.name}="${CSS.escape(a.value)}"]`).join('');}
export function followTest(deliveryId,{getData,reload,status},{tries=4,delay=2500}={}){
  const check=async left=>{
    const page=document.querySelector('.integrations-page');if(!page)return;
    if(document.querySelector('dialog[open],.row-menu-pop')||document.activeElement?.matches?.('input,textarea,select')){if(left>1)setTimeout(()=>check(left-1),delay);return;}
    const key=focusKey(document.activeElement);await reload();if(key)document.querySelector(key)?.focus({preventScroll:true});
    const data=getData(),d=data?.deliveries?.find(x=>x.id===deliveryId),name=data?.integrations?.find(i=>i.id===d?.integrationId)?.name||'the destination';
    if(!d)return;if(d.state==='delivered')return status(`Test delivered to ${name}`);
    if(d.state==='failed')return status(`Test to ${name} failed. ${errorLabel(d.errorCode)}`.trim());
    if(PENDING.has(d.state)&&left>1)setTimeout(()=>check(left-1),delay);
  };
  setTimeout(()=>check(tries),delay);
}
export function bindIntegrations(container,{api,getData,reload,status}){
  const retry=container.querySelector('[data-integrations-retry]');if(retry)retry.onclick=reload;
  const log=container.querySelector('[data-integration-log]');
  // Opening the log fetches the latest deliveries, so there is no separate Refresh button.
  if(log){log.querySelector('summary').addEventListener('click',()=>{logOpen=!log.open;if(logOpen)setTimeout(async()=>{await reload();document.getElementById('deliveries-title')?.focus({preventScroll:true});});});log.addEventListener('click',e=>{if(e.target.closest('.integration-log-body button'))logOpen=true;});}
  const find=id=>getData()?.integrations?.find(i=>i.id===id);
  const configure=async body=>{const current=body.id?find(body.id):null;return api('integrations',current?{...body,expectedRevision:current.revision}:body);};
  const fail=async e=>{status(e.code==='integration_conflict'?'This integration changed elsewhere. Review and try again.':e.message||'That did not work.');if(e.code==='integration_conflict')await reload();};
  const withButton=async(button,label,fn)=>{button.disabled=true;const text=button.textContent;if(label)button.textContent=label;try{await fn();}catch(e){await fail(e);}finally{if(button.isConnected){button.disabled=false;button.textContent=text;}}};
  const refocus=selector=>requestAnimationFrame(()=>document.querySelector(selector)?.focus());
  const editor=opts=>showIntegrationEditor({configure,getData,reload,status,sendTest:id=>api('integrations/test',{id}),...opts});
  const menuOf=id=>`[data-integration-menu="${CSS.escape(id)}"]`;
  const toggle=(i,button,label)=>withButton(button,label,async()=>{await configure({action:'update',id:i.id,enabled:!i.enabled});await reload();status(i.enabled?`${i.name} is off`:`${i.name} is on`);refocus(menuOf(i.id));});
  const runTest=(id,button,label)=>withButton(button,label,async()=>{const name=find(id)?.name||'the destination';const result=await api('integrations/test',{id});await reload();
    status(testStatus(result,name));refocus(document.querySelector(`.integration-alert [data-test-integration="${CSS.escape(id)}"]`)?`.integration-alert [data-test-integration="${CSS.escape(id)}"]`:menuOf(id));if(result?.deliveryId&&PENDING.has(result.state))followTest(result.deliveryId,{getData,reload,status});});
  container.querySelectorAll('[data-test-integration]').forEach(b=>b.onclick=()=>runTest(b.dataset.testIntegration,b,'Sending…'));
  container.querySelectorAll('[data-toggle-integration]').forEach(b=>b.onclick=()=>{const i=find(b.dataset.toggleIntegration);if(i)toggle(i,b,'Turning on…');});
  container.querySelectorAll('[data-add-menu]').forEach(b=>b.onclick=()=>{const ready=webhookHostsReady(getData());showRowMenu(b,ORDER.filter(kind=>kind!=='webhook'||ready).map(kind=>[kind,KINDS[kind].label]),kind=>editor({trigger:b,initialKind:kind}));});
  container.querySelectorAll('[data-edit-integration]').forEach(b=>b.onclick=()=>{const i=find(b.dataset.editIntegration);if(i)editor({existing:i,trigger:b});});
  container.querySelectorAll('[data-add-integration]').forEach(b=>b.onclick=()=>editor({trigger:b,initialKind:b.dataset.kind}));
  container.querySelectorAll('[data-integration-menu]').forEach(b=>b.onclick=()=>{const i=find(b.dataset.integrationMenu);if(!i)return;
    const items=i.enabled?[['test','Send test'],['edit','Edit'],['toggle','Turn off'],['remove','Remove…',true]]:[['toggle','Turn on'],['edit','Edit'],['remove','Remove…',true]];
    showRowMenu(b,items,pick=>{if(pick==='test')runTest(i.id,b,'');else if(pick==='edit')editor({existing:i,trigger:b});else if(pick==='remove')editor({existing:i,trigger:b,step:pick});else toggle(i,b,'');});});
  container.querySelectorAll('[data-retry-delivery]').forEach(b=>b.onclick=()=>withButton(b,'Retrying…',async()=>{await api('integrations/retry',{deliveryId:b.dataset.retryDelivery});await reload();status('Delivery queued for retry');refocus('#deliveries-title');}));
  container.querySelectorAll('[data-discard-delivery]').forEach(b=>b.onclick=()=>{const d=getData()?.deliveries?.find(x=>x.id===b.dataset.discardDelivery);if(!d)return;
    confirmAction({title:'Discard this delivery?',body:`${eventLabel(d.eventType)} will not be sent${d.state==='quarantined'?' or replayed':''}. This cannot be undone.`,confirmLabel:'Discard delivery',trigger:b,restore:()=>document.querySelector('[data-discard-delivery]')||document.querySelector('#deliveries-title'),run:async()=>{await api('integrations/retry',{deliveryId:d.id,action:'discard'});await reload();status('Delivery discarded');}});});
}

const dialogHeader=(kind,title,sub,closeLabel)=>`<div class="booking-detail-head integration-dialog-head">${kindMark(kind,'md')}<div class="integration-dialog-title"><h2 id="integration-dialog-title">${esc(title)}</h2>${sub?`<p>${esc(sub)}</p>`:''}</div><button type="button" class="icon-button" data-close aria-label="${esc(closeLabel)}">${CLOSE}</button></div>`;
export function showIntegrationEditor({configure,getData,reload,status,sendTest,existing,trigger,initialKind,step:startStep}){
  const kind=existing?.kind||(KINDS[initialKind]?initialKind:'slack'),k=KINDS[kind];
  let created=null,step=startStep||'form',initial='',replacing=false;
  const restore=()=>document.querySelector(created?`[data-edit-integration="${CSS.escape(created)}"]`:existing?`[data-edit-integration="${CSS.escape(existing.id)}"]`:`[data-add-integration][data-kind="${kind}"]`)||document.querySelector('[data-add-integration]')||document.querySelector('h1');
  const labels={form:existing?`Edit ${existing.name}`:`Connect ${k.label}`,remove:`Remove ${existing?.name}`,rotate:`Rotate signing secret for ${existing?.name}`};
  const {dialog,state,dismiss}=createDialog({label:labels[step]||labels.form,className:'booking-dialog integration-dialog',trigger,restore});
  const catalog=eventCatalog(getData()),groups=eventGroups(catalog);
  let selectedEvents=new Set(existing?.events||DEFAULT_EVENTS.filter(e=>catalog.some(c=>c.id===e))),guestDetails=!!existing?.includeGuestDetails,eventsOpen=false;
  const urlField=()=>`<div class="integration-url" id="integration-url-field" ${existing&&!replacing?'hidden':''}>
      <label class="field-label" for="integration-url">${existing?'New URL':esc(k.url)}</label>
      <input id="integration-url" name="url" type="url" inputmode="url" autocomplete="off" spellcheck="false" ${existing?'':'required aria-required="true"'} placeholder="${esc(k.placeholder)}" aria-describedby="integration-url-error${k.help?' integration-url-hint':''}">
      <p class="field-error" id="integration-url-error"></p>
      ${k.help?`<p class="hint" id="integration-url-hint"><a href="${esc(k.help)}" target="_blank" rel="noopener noreferrer">${esc(k.helpLabel)}</a></p>`:''}
    </div>`;
  function formMarkup(){
    const destination=existing?`<div class="integration-field"><span class="field-label" id="integration-destination-label">Sends to</span><div class="integration-destination"><span>${esc(kind==='webhook'&&existing.destinationLabel?existing.destinationLabel:`Saved ${k.label} webhook`)}</span><button type="button" class="quiet-button" data-replace-url aria-expanded="${replacing}" aria-controls="integration-url-field">${replacing?'Keep current URL':'Replace URL'}</button></div>${urlField()}</div>`:`<div class="integration-field">${urlField()}</div>`;
    const chosen=[...selectedEvents];
    const events=`<details class="integration-events"${eventsOpen?' open':''}><summary><span class="integration-events-label">Send when</span><span class="integration-events-value" data-events-summary>${esc(eventSummary(chosen,catalog))}</span><span class="integration-events-change" aria-hidden="true"><span class="when-closed">Change</span><span class="when-open">Done</span></span></summary><fieldset class="integration-event-groups" aria-describedby="integration-events-error"><legend class="sr-only">Events to send</legend>${groups.map((g,gi)=>`<div class="integration-event-group" role="group" aria-labelledby="integration-event-group-${gi}"><p id="integration-event-group-${gi}">${esc(g.label)}</p>${g.events.map(e=>`<label class="inline-check"><input type="checkbox" name="events" value="${esc(e.id)}" ${selectedEvents.has(e.id)?'checked':''}>${esc(e.label)}</label>`).join('')}</div>`).join('')}</fieldset><p class="field-error" id="integration-events-error"></p></details>`;
    const data=`<div class="integration-guest"><label class="inline-check"><input type="checkbox" name="includeGuestDetails" ${guestDetails?'checked':''}>Include guest name and email</label></div>`;
    const secret=existing?.kind==='webhook'?`<div class="integration-secret-row"><span><strong>Signing secret</strong></span><button type="button" class="secondary compact-button" data-rotate>Rotate…</button></div>`:'';
    return `${dialogHeader(kind,existing?existing.name:`Connect ${k.label}`,existing?`${k.label}${existing.enabled?'':' · Off'}`:'',existing?`Close edit ${existing.name}`:`Close connect ${k.label}`)}<form class="workspace-form integration-form" novalidate><div class="booking-detail-body">${destination}
      <div class="integration-field"><label class="field-label" for="integration-name">Name</label><input id="integration-name" name="name" required aria-required="true" maxlength="80" value="${esc(existing?existing.name:k.label)}" autocomplete="off" aria-describedby="integration-name-error"><p class="field-error" id="integration-name-error"></p></div>
      ${events}${data}${secret}<p class="error integration-error" role="alert" id="integration-error"></p></div><footer class="booking-detail-footer">${existing?'<button type="button" class="danger-quiet integration-remove" data-remove>Remove…</button>':''}<button type="button" class="secondary" data-cancel>Cancel</button><button type="submit" class="primary">${existing?'Save changes':'Connect'}</button></footer></form>`;
  }
  const read=()=>{const f=dialog.querySelector('form');return {kind,name:f.elements.name.value,url:f.elements.url.value,events:[...f.querySelectorAll('[name=events]:checked')].map(i=>i.value),includeGuestDetails:f.elements.includeGuestDetails.checked,enabled:existing?existing.enabled:true};};
  const snapshot=()=>JSON.stringify(read());
  state.isDirty=()=>step==='form'&&!!dialog.querySelector('form')&&snapshot()!==initial;
  function drawForm(focus){dialog.setAttribute('aria-label',labels.form);dialog.innerHTML=formMarkup();bindForm();if(!initial)initial=snapshot();if(focus)dialog.querySelector(focus)?.focus();}
  function bindForm(){
    const form=dialog.querySelector('form'),general=dialog.querySelector('#integration-error');
    dialog.querySelector('[data-close]').onclick=dismiss;dialog.querySelector('[data-cancel]').onclick=dismiss;
    const clear=target=>{const field=target?.closest?.('.integration-field,.integration-events');field?.querySelectorAll('.field-error').forEach(p=>p.textContent='');field?.querySelectorAll('[aria-invalid]').forEach(i=>i.removeAttribute('aria-invalid'));general.textContent='';};
    form.addEventListener('input',e=>clear(e.target));form.addEventListener('change',e=>clear(e.target));
    const replace=dialog.querySelector('[data-replace-url]');if(replace)replace.onclick=()=>{const kept=read();replacing=!replacing;selectedEvents=new Set(kept.events);guestDetails=kept.includeGuestDetails;dialog.innerHTML=formMarkup();bindForm();dialog.querySelector('form').elements.name.value=kept.name;dialog.querySelector(replacing?'#integration-url':'[data-replace-url]').focus();};
    const picker=dialog.querySelector('details.integration-events'),summary=dialog.querySelector('[data-events-summary]');
    picker.addEventListener('toggle',()=>{eventsOpen=picker.open;});
    picker.addEventListener('change',()=>{summary.textContent=eventSummary(read().events,catalog);});
    const remove=dialog.querySelector('[data-remove]');if(remove)remove.onclick=()=>{step='remove';drawConfirm('remove');};
    const rotate=dialog.querySelector('[data-rotate]');if(rotate)rotate.onclick=()=>{step='rotate';drawConfirm('rotate');};
    const show=({field,message})=>{
      const input=field==='events'?form.querySelector('[name=events]'):form.elements[field],slot=dialog.querySelector(`#integration-${field}-error`);
      if(field==='events')dialog.querySelector('details.integration-events').open=true;
      if(!slot||!input||input.closest('[hidden]')){general.textContent=message;return;}
      slot.textContent=message;if(field!=='events')input.setAttribute('aria-invalid','true');input.focus();
    };
    form.onsubmit=async e=>{e.preventDefault();if(state.working)return;
      dialog.querySelectorAll('.field-error').forEach(p=>p.textContent='');form.querySelectorAll('[aria-invalid]').forEach(i=>i.removeAttribute('aria-invalid'));general.textContent='';
      const body=integrationPayload(read(),existing),invalid=validateIntegration(body,{requireUrl:!existing||replacing,webhookHosts:webhookHostsReady(getData())});
      if(invalid)return show(invalid);
      state.working=true;const submit=form.querySelector('[type=submit]'),label=submit.textContent;submit.disabled=true;submit.textContent=existing?'Saving…':'Connecting…';
      try{const result=await configure(body);form.elements.url.value='';state.working=false;created=existing?null:result?.integration?.id||null;await reload();
        const secret=result?.signingSecret||result?.secret,name=result?.integration?.name||body.name;status(existing?'Changes saved':`${name} connected`);
        if(secret){step='secret';drawSecret(secret,name,false);}else if(created&&sendTest){step='connected';drawConnected(created,name);}else{state.isDirty=()=>false;dialog.close();}}
      catch(err){state.working=false;submit.disabled=false;submit.textContent=label;
        if(err.code==='integration_conflict'){await reload();const latest=getData()?.integrations?.find(i=>i.id===existing?.id);if(latest){existing.revision=latest.revision;existing.enabled=latest.enabled;}general.textContent='This integration changed elsewhere. Your edits are still here. Save again to apply them.';submit.focus();}
        else if(err.code==='webhook_host_not_approved')show({field:'url',message:err.message||'This webhook host needs operator approval.'});
        else{general.textContent=err.message||'The integration could not be saved.';submit.focus();}}};
  }
  function drawConfirm(action){
    const removing=action==='remove',direct=!!startStep;dialog.classList.add('is-confirm');dialog.setAttribute('aria-label',labels[action]);
    dialog.innerHTML=`${dialogHeader(kind,removing?`Remove ${existing.name}?`:'Rotate signing secret?',removing?k.label:existing.name,`Close ${removing?'remove':'rotate'} ${existing.name}`)}<div class="booking-detail-body"><p class="integration-confirm">${removing?`${esc(existing.name)} stops receiving booking updates.`:'The current secret stops working right away.'}</p><p class="error" role="alert"></p></div><footer class="booking-detail-footer"><button type="button" class="secondary" data-back>${direct?'Cancel':'Back'}</button><button type="button" class="danger-button" data-confirm>${removing?'Remove integration':'Rotate secret'}</button></footer>`;
    dialog.querySelector('[data-close]').onclick=()=>{if(!state.working)dialog.close();};
    dialog.querySelector('[data-back]').onclick=()=>{if(direct)return dialog.close();step='form';dialog.classList.remove('is-confirm');drawForm(removing?'[data-remove]':'[data-rotate]');};
    const go=dialog.querySelector('[data-confirm]'),label=go.textContent;go.onclick=async()=>{if(state.working)return;state.working=true;go.disabled=true;go.textContent=removing?'Removing…':'Rotating…';
      try{const result=await configure({action,id:existing.id});state.working=false;await reload();
        if(removing){status(`${existing.name} removed`);dialog.close();requestAnimationFrame(()=>(document.querySelector('[data-edit-integration]')||document.querySelector('[data-add-integration]'))?.focus());}
        else{const secret=result?.signingSecret||result?.secret;status('Signing secret rotated');if(secret){step='secret';drawSecret(secret,existing.name,true);}else dialog.close();}}
      catch(e){state.working=false;go.disabled=false;go.textContent=label;dialog.querySelector('[role=alert]').textContent=e.message||'That did not work. Try again.';go.focus();}};
    dialog.querySelector('[data-back]').focus();
  }
  // The moment something is connected: a clear success, then the one useful next step.
  const successHead=(title,sub,check=true)=>`<button type="button" class="icon-button integration-done-close" data-close aria-label="Close">${CLOSE}</button><div class="integration-done"><span class="integration-done-mark">${kindMark(kind,'xl')}${check?`<span class="integration-done-check">${ICONS.check}</span>`:''}</span><h2>${esc(title)}</h2>${sub?`<p>${esc(sub)}</p>`:''}</div>`;
  // Slack and Discord: test while the person still has the channel open.
  function drawConnected(id,name){
    state.isDirty=()=>false;dialog.classList.add('is-confirm','is-success');dialog.setAttribute('aria-label',`${name} is connected`);
    dialog.innerHTML=`<div class="booking-detail-body integration-done-body">${successHead(`${name} is connected`,'')}<div class="integration-test" data-state="idle"><span class="integration-test-icon">${ICONS.send}</span><span class="integration-test-text"><strong>Test message</strong><span role="status" data-test-result></span></span><button type="button" class="secondary compact-button" data-send-test>Send test</button></div></div><footer class="booking-detail-footer"><button type="button" class="primary" data-done>Done</button></footer>`;
    const card=dialog.querySelector('.integration-test'),glyph=card.querySelector('.integration-test-icon'),result=dialog.querySelector('[data-test-result]'),send=dialog.querySelector('[data-send-test]');
    const show=(text,tone)=>{result.textContent=text;card.dataset.state=tone;glyph.innerHTML={sending:ICONS.spinner,ok:ICONS.check,failed:ICONS.cross,retry:ICONS.clock,pending:ICONS.clock}[tone]||ICONS.send;};
    dialog.querySelector('[data-close]').onclick=()=>dialog.close();dialog.querySelector('[data-done]').onclick=()=>dialog.close();
    // Only the request itself holds the dialog open; waiting for the result never blocks Escape or Done.
    let busy=false;
    send.onclick=async()=>{if(busy)return;busy=true;send.disabled=true;show('Sending…','sending');
      try{
        state.working=true;let queued;try{queued=await sendTest(id);}finally{state.working=false;}
        if(!queued?.deliveryId||queued.state==='failed'&&(!queued.errorCode||queued.errorCode==='queue_capacity'))return show('Could not be queued. Try again in a moment.','failed');
        const outcome=d=>{
          if(d?.state==='delivered'){show('Delivered. Check the channel.','ok');return true;}
          if(d?.state==='failed'){show(`Not delivered: ${errorLabel(d.errorCode)||'the destination refused it'}`,'failed');return true;}
          if(d?.state==='retry'){show(`Not delivered yet: ${errorLabel(d.errorCode)||'retrying'}`,'retry');return true;}
          return false;
        };
        await reload();if(outcome(queued))return;
        // An older Worker, or a destination cooling down after rate limiting, sends on its next alarm.
        for(let n=0;n<12&&dialog.open;n++){
          await new Promise(r=>setTimeout(r,2000));if(!dialog.open)return;await reload();
          if(outcome(getData()?.deliveries?.find(x=>x.id===queued.deliveryId)))return;
        }
        if(dialog.open)show('Still sending. The result will appear under Recent deliveries.','pending');
      }catch(e){show(e.message||'The test message could not be sent.','failed');}
      finally{busy=false;if(send.isConnected){send.disabled=false;send.textContent='Send again';}}};
    send.focus();
  }
  function drawSecret(secret,name,rotated){
    let shown=false;dialog.setAttribute('aria-label','Signing secret');dialog.classList.remove('is-confirm');dialog.classList.add('is-success');
    const draw=()=>{dialog.innerHTML=`<div class="booking-detail-body integration-done-body integration-secret">${successHead(rotated?'New signing secret':`${name} is connected`,rotated?name:'',!rotated)}<div class="integration-field"><label class="field-label" for="integration-secret">Signing secret <span class="optional-label">Shown only once</span></label><div class="copy-field"><input id="integration-secret" readonly spellcheck="false" autocomplete="off" type="${shown?'text':'password'}" value="${esc(secret)}"><button type="button" class="secondary compact-button" data-reveal aria-pressed="${shown}">${shown?'Hide':'Reveal'}</button><button type="button" class="secondary compact-button" data-copy>Copy</button></div><p class="hint integration-secret-header">Header: <code>x-scheduling-signature</code></p><p class="hint" role="status" data-copy-status></p></div></div><footer class="booking-detail-footer"><button type="button" class="primary" data-done>Done</button></footer>`;
      dialog.querySelector('[data-close]').onclick=()=>dialog.close();dialog.querySelector('[data-done]').onclick=()=>dialog.close();
      dialog.querySelector('[data-reveal]').onclick=()=>{shown=!shown;draw();dialog.querySelector('[data-reveal]').focus();};
      // Updated in place: copyText selects the revealed field when the clipboard is blocked.
      dialog.querySelector('[data-copy]').onclick=async e=>{const field=dialog.querySelector('#integration-secret');const ok=await copyText(secret,shown?field:null);e.target.textContent=ok?'Copied':'Copy';dialog.querySelector('[data-copy-status]').textContent=ok?'Secret copied':'Copy blocked by the browser. Reveal and copy it manually.';};};
    draw();state.isDirty=()=>false;dialog.addEventListener('close',()=>{secret='';},{once:true});dialog.querySelector('[data-copy]').focus();
  }
  if(step==='remove'||step==='rotate'){dialog.showModal();drawConfirm(step);return;}
  drawForm();dialog.showModal();
  dialog.querySelector(existing?'#integration-name':'#integration-url')?.focus();
}
