// Link access: expiry and one-booking-only links. Host authoring, owner status and the guest's closed view.
// The Worker stays authoritative; everything here is display or form reading.
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export const LINK_CLOSED_CODES=['link_expired','link_used'];
const MAX_DATE=8.64e15;
/** A stored expiry: null or a nonnegative safe epoch ms Date can represent. Anything else reads as null. */
export const validExpiry=v=>Number.isSafeInteger(v)&&v>=0&&v<=MAX_DATE?v:null;
/** Guest API error closed by link admission (HTTP 410). */
export const isLinkClosed=error=>LINK_CLOSED_CODES.includes(error?.code);
const browserZone=()=>{try{return Intl.DateTimeFormat().resolvedOptions().timeZone||'UTC';}catch{return 'UTC';}};

// ---- Owner state ----
/** Read-only usage for one link from settings.linkAccess; unknown or malformed means unused. */
export function accessFor(settings,id){const a=settings?.linkAccess?.[id];return {used:a?.used===true};}
/** Effective state from the saved (or draft) link and its usage. Expiry wins over use; used only counts while single-use is on. */
export function linkState(type,access,now=Date.now()){
 const at=validExpiry(type?.expiresAt);
 if(at!==null&&now>=at)return 'expired';
 if(type?.singleUse===true&&access?.used===true)return 'used';
 return 'open';
}
/** Link-list label. A paused link stays Paused; a published but closed link never reads as Active. */
export function linkStateLabel(type,access,now=Date.now()){
 if(!type?.published)return {label:'Paused',live:false,state:'paused'};
 const state=linkState(type,access,now);
 return state==='open'?{label:'Active',live:true,state}:{label:state==='expired'?'Expired':'Used',live:false,state};
}
/** Owner preview is local layout only: admission settings never reach the projection or block example times. */
export function previewDraft(draft){const {expiresAt,singleUse,linkAccess,...rest}=draft||{};return {...rest,expiresAt:null,singleUse:false};}

// ---- Time zone helpers (datetime-local <-> epoch in an explicit zone) ----
function parts(ms,zone){
 const p=Object.fromEntries(new Intl.DateTimeFormat('en-US',{timeZone:zone,hourCycle:'h23',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit'}).formatToParts(ms).map(x=>[x.type,x.value]));
 return {y:Number(p.year),mo:Number(p.month),d:Number(p.day),h:Number(p.hour)%24,mi:Number(p.minute),s:Number(p.second)};
}
const offsetAt=(ms,zone)=>{const p=parts(ms,zone);return Date.UTC(p.y,p.mo-1,p.d,p.h,p.mi,p.s)-Math.floor(ms/1000)*1000;};
const pad=(n,w=2)=>String(n).padStart(w,'0');
/** "YYYY-MM-DDTHH:MM" in zone, or '' when a datetime-local input cannot show it. Seconds are not shown. */
export function epochToLocalInput(ms,zone=browserZone()){
 if(validExpiry(ms)===null)return '';
 try{const p=parts(ms,zone);if(p.y<1||p.y>9999)return '';return `${pad(p.y,4)}-${pad(p.mo)}-${pad(p.d)}T${pad(p.h)}:${pad(p.mi)}`;}catch{return '';}
}
/** Epoch ms for a wall time in zone. Nonexistent spring-forward times are rejected; repeated times use the earlier instant. */
export function localInputToEpoch(value,zone=browserZone()){
 const m=/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(String(value||''));if(!m)return null;
 const [y,mo,d,h,mi,s]=m.slice(1).map(v=>Number(v||0));if(mo<1||mo>12||d<1||d>31||h>23||mi>59||s>59)return null;
 const guess=Date.UTC(y,mo-1,d,h,mi,s);if(new Date(guess).getUTCDate()!==d)return null;
 try{const offsets=new Set([-86400000,0,86400000].map(delta=>offsetAt(guess+delta,zone)));const matches=[...offsets].map(offset=>guess-offset).filter(t=>{const p=parts(t,zone);return p.y===y&&p.mo===mo&&p.d===d&&p.h===h&&p.mi===mi&&p.s===s;}).sort((a,b)=>a-b);return matches.length?validExpiry(matches[0]):null;}catch{return null;}
}
/** "Europe/Oslo · GMT+1" at the given instant. */
export function zoneLabel(zone=browserZone(),ms=Date.now()){
 let off='';try{off=new Intl.DateTimeFormat('en-GB',{timeZone:zone,timeZoneName:'shortOffset'}).formatToParts(ms).find(p=>p.type==='timeZoneName')?.value||'';}catch{}
 return `${String(zone).replaceAll('_',' ')}${off?` · ${off.replace(/^GMT$/,'GMT+0')}`:''}`;
}
/** Short expiry, e.g. "4 Dec, 09:00" (year added when not this year). */
export function expiryText(ms,zone=browserZone(),now=Date.now()){
 try{const year=parts(ms,zone).y!==parts(now,zone).y;return new Intl.DateTimeFormat('en-GB',{timeZone:zone,day:'numeric',month:'short',...(year?{year:'numeric'}:{}),hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(ms).replace(' at ',', ');}
 catch{return new Date(ms).toISOString().slice(0,16).replace('T',' ')+' UTC';}
}

// ---- Host editor ----
/** Collapsed summary: "Open", "One booking", "Until 4 Dec, 09:00", "Expired", "Used". */
export function linkAccessSummary(type,access,zone=browserZone(),now=Date.now()){
 const state=linkState(type,access,now);if(state==='expired')return 'Expired';if(state==='used')return 'Used';
 const at=validExpiry(type?.expiresAt),out=[];if(type?.singleUse===true)out.push('One booking');if(at!==null)out.push(`Until ${expiryText(at,zone,now)}`);
 return out.join(' · ')||'Open';
}
function noteText(singleUse,access){return singleUse?(access?.used?'Already used. Closed to new bookings.':'Closes after the first booking request.'):'';}
/** Compact "Link access" disclosure for Booking rules. Opens itself only when something is configured. */
export function linkAccessMarkup(type,{access={used:false},zone=browserZone(),now=Date.now()}={}){
 const at=validExpiry(type?.expiresAt),single=type?.singleUse===true,initial=at===null?'':epochToLocalInput(at,zone),open=single||at!==null;
 return `<details class="link-access" data-link-access data-zone="${esc(zone)}" data-used="${access?.used===true}" ${open?'open':''}><summary>Link access<small data-link-access-summary>${esc(linkAccessSummary(type,access,zone,now))}</small></summary><div class="link-access-body">`
  +`<label class="inline-check link-access-once"><input type="checkbox" name="singleUse" ${single?'checked':''}>One booking only</label>`
  +`<div class="link-access-expiry"><label for="edit-expiry-mode">Expires</label><div class="link-access-row"><select id="edit-expiry-mode" data-expiry-mode><option value="never" ${at===null?'selected':''}>Never</option><option value="date" ${at!==null?'selected':''}>On a date</option></select>`
  +`<span class="link-access-when" data-expiry-when ${at===null?'hidden':''}><input type="datetime-local" id="edit-expires-at" data-expires-at aria-label="Expiry date and time" aria-describedby="link-expiry-zone" value="${esc(initial)}" data-initial="${esc(initial)}" data-saved="${at===null?'':at}"><span class="link-access-zone" id="link-expiry-zone">${esc(zoneLabel(zone,at??now))}</span></span></div></div>`
  +`<p class="link-access-note" data-link-access-note>${esc(noteText(single,access))}</p><p class="link-access-error" data-link-access-error role="alert"></p></div></details>`;
}
/** Reads {expiresAt,singleUse}. Returns {} without the editor so stored values are kept. An unchanged saved expiry keeps its exact epoch. */
export function readLinkAccess(form,{now=Date.now()}={}){
 const editor=form.querySelector('[data-link-access]');if(!editor)return {};
 const zone=editor.dataset.zone||browserZone(),singleUse=!!editor.querySelector('[name=singleUse]')?.checked;
 if(editor.querySelector('[data-expiry-mode]').value!=='date')return {expiresAt:null,singleUse};
 const input=editor.querySelector('[data-expires-at]'),saved=input.dataset.saved,fail=text=>{editor.open=true;const el=editor.querySelector('[data-link-access-error]');if(el)el.textContent=text;throw Object.assign(Error(text),{field:'expiresAt'});};
 if(saved!==''&&saved!=null&&input.value===input.dataset.initial){const kept=validExpiry(Number(saved));if(kept!==null)return {expiresAt:kept,singleUse};}
 if(!input.value)fail('Choose when this link expires.');
 const at=localInputToEpoch(input.value,zone);if(at===null)fail('Choose a valid expiry time.');
 if(at<=now)fail('Choose a future expiry time.');
 return {expiresAt:at,singleUse};
}
/** Shows the date only for "On a date", keeps the note and summary current. Native events reach dirty tracking. */
export function bindLinkAccess(form){
 const editor=form.querySelector('[data-link-access]');if(!editor)return;
 const mode=editor.querySelector('[data-expiry-mode]'),when=editor.querySelector('[data-expiry-when]'),input=editor.querySelector('[data-expires-at]'),once=editor.querySelector('[name=singleUse]'),zone=editor.dataset.zone||browserZone(),access={used:editor.dataset.used==='true'};
 const sync=()=>{
  when.hidden=mode.value!=='date';editor.querySelector('[data-link-access-note]').textContent=noteText(once.checked,access);
  let expiresAt=null;if(mode.value==='date'){const kept=input.value===input.dataset.initial&&input.dataset.saved!==''?validExpiry(Number(input.dataset.saved)):null;expiresAt=kept??localInputToEpoch(input.value,zone);}
  editor.querySelector('[data-link-access-summary]').textContent=mode.value==='date'&&expiresAt===null?'Choose a date':linkAccessSummary({singleUse:once.checked,expiresAt},access,zone);
  if(expiresAt!==null)editor.querySelector('.link-access-zone').textContent=zoneLabel(zone,expiresAt);
 };
 const clear=()=>{editor.querySelector('[data-link-access-error]').textContent='';};
 mode.addEventListener('change',()=>{clear();sync();if(mode.value==='date')input.focus();});
 input.addEventListener('input',()=>{clear();sync();});input.addEventListener('change',()=>{clear();sync();});
 once.addEventListener('change',sync);sync();
}

// ---- Guest ----
/** Minimal, actionable closed view. No times or form. `uncertain` means an earlier request with this key may have been accepted. */
export function closedLinkMarkup(code,{host='',uncertain=false}={}){
 const used=code==='link_used',who=String(host||'').trim();
 return `<section class="success link-closed" data-link-closed="${used?'used':'expired'}"><h1 tabindex="-1">${used?'This link has been used':'This link has expired'}</h1><p>${esc(who?`Ask ${who} for a new link.`:'Ask the organizer for a new link.')}</p>${uncertain?'<p class="link-closed-check">If you already sent a request, check your email.</p>':''}</section>`;
}
