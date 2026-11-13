import {projectPreviewState} from '/share-ui.js';
import {teamSlots,guestTeamMarkup,guestHostChoices} from '/team-guest.js';
import {approvalNotice} from '/approval-ui.js';
import {normalizeQuestions,validateIntake,intakeRevision} from '/intake.js';
import {savedIntakeMarkup} from '/intake-ui.js';
import {conferenceMarkup} from '/conference-ui.js';
import { DEFAULT, dateKey, validZone } from '/policy.js';
import {DEFAULT_BRAND,normalizeBrand,brandLabel,brandMark,legalLinksMarkup,organizationMarkup} from '/brand.js';
import {guestDurations,guestDurationMarkup,durationLabel} from '/durations-ui.js';
import {policyFor,bookingPolicy,changeNoteMarkup,manageChangeState,closedText,isChangeWindowClosed} from '/change-policy-ui.js';
import {isLinkClosed,closedLinkMarkup} from '/link-access-ui.js';
const app=document.querySelector('#app');
const params=new URLSearchParams(location.search);
const admin=['/','/studio'].includes(location.pathname);
const preview=params.has('preview');
const ownerPreview=location.pathname==='/book'&&params.get('preview')==='owner';
const embedded=params.has('embed');
let allAvailable=[],selectedTeamHostId='';
let config={...DEFAULT}, available=[], selectedDate='', selectedSlot=null, booking=null, draft={name:'',email:'',answer:'',answers:{},additionalGuests:[]};
let zone=Intl.DateTimeFormat().resolvedOptions().timeZone || DEFAULT.zone;
let hour12=false, month=new Date(), tab='Meeting', busy=false, error='', width='desktop';
let requestKey=crypto.randomUUID();
// A new-booking request ended without a definitive answer (network/server error); it may have been accepted.
let uncertainAttempt=false,configLoaded=false;
let dirty=false;
let previewPolicyKey='';
let visitRecorded=false,suggestedTimeUnavailable=false;
let service={mode:'local'}, managementToken='', originalBooking=null;
// Guest-selected length. Pending loads never show the previous length's times; stale replies are dropped by sequence.
let durationPending=null,durationBefore=null,durationSeq=0,chosenDuration=null,previewWaiter=null;
const publicRoute=location.pathname.match(/^\/b\/(h_[A-Za-z0-9_-]{24})\/([a-z0-9][a-z0-9-]{0,63})$/);
const managementRoute=location.pathname.match(/^\/manage\/(h_[A-Za-z0-9_-]{24})\/([-a-zA-Z0-9_]{16,80})$/);
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmt=(ms,options)=>new Intl.DateTimeFormat('en-GB',{timeZone:zone,...options}).format(ms);
const time=ms=>fmt(ms,{hour:'numeric',minute:'2-digit',hour12});
const shortDate=ms=>fmt(ms,{weekday:'short',day:'numeric',month:'short'});
const longDate=ms=>fmt(ms,{weekday:'long',day:'numeric',month:'long'});
// GMT offset of a zone at a given instant, e.g. "GMT+1". Cached per zone and instant; some clock changes occur within a UTC hour.
const offsetCache=new Map();
const offset=(z,ms=Date.now())=>{const key=z+'|'+ms;if(!offsetCache.has(key)){let label='';try{label=new Intl.DateTimeFormat('en-GB',{timeZone:z,timeZoneName:'shortOffset'}).formatToParts(ms).find(p=>p.type==='timeZoneName')?.value.replace(/^GMT[+-]0$/,'GMT')||'';}catch{}if(offsetCache.size>=4096)offsetCache.delete(offsetCache.keys().next().value);offsetCache.set(key,label);}return offsetCache.get(key);};
const zoneLabel=(z,ms)=>`${z.replaceAll('_',' ')}${offset(z,ms)?` (${offset(z,ms)})`:''}`;
let lastSlotStart=null,statusTimer=null,statusAttempts=0;
const announce=text=>{document.querySelector('#announcement').textContent=text;};
const icon=name=>`<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">${({clock:'<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',video:'<rect x="3" y="5" width="12" height="14" rx="3"/><path d="m15 10 6-3v10l-6-3"/>',globe:'<circle cx="12" cy="12" r="9"/><ellipse cx="12" cy="12" rx="4" ry="9"/><path d="M3 12h18"/>',left:'<path d="m14 6-6 6 6 6"/>',right:'<path d="m10 6 6 6-6 6"/>',mail:'<rect x="3" y="5" width="18" height="14" rx="3"/><path d="m4 7 8 6 8-6"/>'})[name]}</svg>`;
const mark='<span class="mark" aria-hidden="true">✉</span>';
let serviceBrand=DEFAULT_BRAND;
const wordmark=()=>`<a class="wordmark" href="/">${mark} ${esc(brandLabel(serviceBrand))}<span class="muted"> / Bookings</span></a>`;
function theme(){document.documentElement.dataset.theme=config.theme;document.documentElement.dataset.accent=config.accent;}
async function api(path,data){
  if(ownerPreview)throw Error('Bookings are disabled in Preview.');
  let endpoint='/api/'+path;
  if(service.mode==='live'&&publicRoute) {
    endpoint='/api/public/'+publicRoute[1]+'/'+publicRoute[2]+'/'+path;
    // Reschedule reads the accepted length through the guest's own capability, never current public length choices.
    if(path==='availability'&&!data&&originalBooking){endpoint='/api/manage/'+publicRoute[1]+'/'+originalBooking.id;data={action:'availability',token:managementToken};}
    else if(path==='book'&&originalBooking){endpoint='/api/manage/'+publicRoute[1]+'/'+originalBooking.id;data={action:'reschedule',token:managementToken,start:data.start,key:data.key};}
  } else if(service.mode==='live'&&preview&&path==='availability')endpoint='/api/live/availability?type='+encodeURIComponent(params.get('type')||'intro');
  const length=durationPending??chosenDuration;if(path==='availability'&&!data&&!originalBooking&&length!=null)endpoint+=(endpoint.includes('?')?'&':'?')+'duration='+length;
  const response=await fetch(endpoint,data?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)}:{});
  const result=await response.json(); if(!response.ok)throw Object.assign(Error(result.error||'Could not connect. Please try again.'),{status:response.status,code:result.code});return result;
}
function replaceSlots(slots){allAvailable=slots||[];available=teamSlots(allAvailable,config.team,selectedTeamHostId,originalBooking);}
function chooseHost(id){if(durationPending!==null)return;if(!config.team?.hosts.some(h=>h.id===id)&&id!=='')return;captureDraft();selectedTeamHostId=id;selectedSlot=null;selectedDate='';error='';requestKey=crypto.randomUUID();replaceSlots(allAvailable);pickFirstDate();guest('host');(document.querySelector('#guest-team-host')||document.querySelector('[data-choose-host]'))?.focus();}
function dates(){return [...new Set(available.map(s=>dateKey(s.start,zone)))];}
function pickFirstDate(){const keys=dates(); if(!keys.includes(selectedDate))selectedDate=keys[0]||'';if(selectedDate){const[y,m]=selectedDate.split('-').map(Number);month=new Date(y,m-1,1);}}
// Motion changes presentation only. Reduced-motion always wins over host/embed preferences.
function applyGuestMotion(){const override=params.get('motion'),choice=['smooth','none'].includes(override)?override:(config.motion||'smooth');document.documentElement.dataset.motion=choice==='smooth'&&!matchMedia('(prefers-reduced-motion: reduce)').matches?'smooth':'none';}
function animateGuest(change){
  if(!change||document.documentElement.dataset.motion!=='smooth')return;
  const selector=change==='date'||change==='format'?'.time-list':change==='month'||change==='zone'||change==='duration'?'.date-grid,.time-list':'.guest-form,.calendar-pane,.time-pane,.success';
  app.querySelectorAll(selector).forEach(node=>node.animate?.([{opacity:.35,transform:`translateY(${change==='back'?-4:4}px)`},{opacity:1,transform:'translateY(0)'}],{duration:160,easing:'cubic-bezier(.2,.7,.3,1)'}));
}
function durationMeta(){
  const choice=!originalBooking&&!selectedSlot&&!booking?guestDurationMarkup(config,{selected:durationPending??config.duration,busy:durationPending!==null}):'';
  if(choice)return `<div class="guest-durations-item">${icon('clock')}${choice}</div>`;
  const accepted=originalBooking&&Number.isSafeInteger(originalBooking.end-originalBooking.start)?(originalBooking.end-originalBooking.start)/60000:config.duration;
  return `<span>${icon('clock')}${accepted} minutes</span>`;
}
function focusDuration(n){document.getElementById('guest-duration-'+n)?.focus();}
function restoreDuration(){const before=durationBefore;durationPending=null;durationBefore=null;if(!before)return;config=before.config;replaceSlots(before.slots);selectedDate=before.date;}
function requestPreviewDuration(duration,request){return new Promise((resolve,reject)=>{previewWaiter={request,resolve,reject};parent.postMessage({type:'email-booking:owner-duration',duration,request},location.origin);setTimeout(()=>{if(previewWaiter?.request===request){previewWaiter=null;reject(Error('Preview could not load.'));}},10000);});}
function chooseDuration(value){
  const n=Number(value);
  if(originalBooking||booking||selectedSlot||!guestDurations(config).includes(n)||n===(durationPending??config.duration))return;
  if(durationPending===null)durationBefore={config,slots:allAvailable,date:selectedDate};
  if(n===durationBefore.config.duration){durationSeq++;previewWaiter=null;restoreDuration();guest('duration');focusDuration(n);return;}
  const seq=++durationSeq;durationPending=n;error='';suggestedTimeUnavailable=false;allAvailable=[];available=[];
  guest();focusDuration(n);announce(`Loading ${durationLabel(n)} times.`);
  (ownerPreview?requestPreviewDuration(n,seq):api('availability')).then(state=>{
    if(seq!==durationSeq)return;
    if(state?.config?.duration!==n||!guestDurations(state.config).includes(n))throw Error('Unexpected meeting length.');
    const date=durationBefore.date,hosts=state.config.team?.hosts.map(h=>h.id)||[];
    durationPending=null;durationBefore=null;chosenDuration=n;config=state.config;
    if(selectedTeamHostId&&!hosts.includes(selectedTeamHostId))selectedTeamHostId='';
    lastSlotStart=null;requestKey=crypto.randomUUID();replaceSlots(state.slots);selectedDate=date;pickFirstDate();
    guest('duration');focusDuration(n);announce(`${durationLabel(n)}. ${dates().length?dates().length+' days with available times.':'No available times.'}`);
  }).catch(err=>{if(seq!==durationSeq)return;if(!ownerPreview&&!originalBooking&&isLinkClosed(err)){showClosedLink(err.code);return;}restoreDuration();error=`Times for ${durationLabel(n)} could not load. Try again.`;guest();focusDuration(config.duration);});
}
function intro(){return `<aside class="host-intro${config.bannerImage?' has-banner':''}">${config.bannerImage?`<img class="host-banner" src="${esc(config.bannerImage)}" alt="">`:''}<div class="avatar${config.avatarImage?' has-image':''}" aria-hidden="true">${config.avatarImage?`<img src="${esc(config.avatarImage)}" alt="">`:esc(config.host.split(' ').map(w=>w[0]).slice(0,2).join(''))}</div><p class="host-name">${esc(config.host)}<span class="company">${esc(config.company)}</span></p><h1>${esc(config.title)}</h1><p class="intro-description">${esc(config.description)}</p><div class="meeting-meta">${durationMeta()}<span>${icon('video')}${esc(config.locationType==='google_meet'?'Google Meet':config.location)}</span></div>${config.team||originalBooking?.assignedHosts?.length?guestTeamMarkup(config.team,selectedTeamHostId,originalBooking):''}${selectedSlot?`<div class="slot-summary"><strong>${esc(shortDate(selectedSlot.start))}</strong><br>${esc(time(selectedSlot.start))} – ${esc(time(selectedSlot.end))}<small>${esc(zoneLabel(zone,selectedSlot.start))}</small></div>`:''}</aside>`;}
function calendar(){if(config.team?.mode==='choose'&&!selectedTeamHostId&&!originalBooking)return guestHostChoices(config.team);
  const y=month.getFullYear(),m=month.getMonth(),total=new Date(y,m+1,0).getDate(),offset=(new Date(y,m,1).getDay()+6)%7;
  const keys=new Set(dates()),today=dateKey(Date.now(),zone);
  let cells='<span></span>'.repeat(offset);
  for(let day=1;day<=total;day++){
    const key=`${y}-${String(m+1).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
    const enabled=keys.has(key);
    cells+=`<button class="date-cell ${enabled?'available':''} ${key===selectedDate?'selected':''} ${key===today?'today':''}" data-date="${key}" ${enabled?'':'disabled'} aria-pressed="${key===selectedDate}" aria-label="${esc(new Date(y,m,day).toLocaleDateString('en-GB',{weekday:'long',day:'numeric',month:'long'}))}${enabled?'':', unavailable'}">${day}</button>`;
  }
  let zones=[zone,config.zone,'UTC','Europe/London','Europe/Oslo','America/New_York','America/Los_Angeles','Asia/Kolkata','Asia/Singapore','Australia/Sydney',...Intl.supportedValuesOf('timeZone')];
  zones=[...new Set(zones)];
  // Offsets follow the chosen day so labels stay correct across clock changes.
  const reference=available.find(s=>dateKey(s.start,zone)===selectedDate)?.start??Date.now();
  const bounds=[...keys].sort(),current=`${y}-${String(m+1).padStart(2,'0')}`;
  return `<section class="calendar-pane" aria-label="Choose a date"><h2>Select a time</h2><p class="section-caption">Choose a date, then an available time.</p><div class="month-nav"><span class="month-name">${month.toLocaleDateString('en-GB',{month:'long',year:'numeric'})}</span><div class="row"><button class="arrow" data-month="-1" aria-label="Previous month" ${!bounds.length||current<=bounds[0].slice(0,7)?'disabled':''}>${icon('left')}</button><button class="arrow" data-month="1" aria-label="Next month" ${!bounds.length||current>=bounds.at(-1).slice(0,7)?'disabled':''}>${icon('right')}</button></div></div><div class="weekdays" aria-hidden="true">${['Mon','Tue','Wed','Thu','Fri','Sat','Sun'].map(d=>`<span>${d}</span>`).join('')}</div><div class="date-grid" role="group" aria-label="Available dates">${cells}</div><div class="timezone"><label for="timezone"><span class="sr-only">Your timezone</span>${icon('globe')}</label><select id="timezone" aria-label="Your timezone">${zones.map(z=>`<option ${z===zone?'selected':''} value="${esc(z)}">${esc(zoneLabel(z,reference))}</option>`).join('')}</select></div></section>`;
}
function times(){if(config.team?.mode==='choose'&&!selectedTeamHostId&&!originalBooking)return '';
  const list=available.filter(s=>dateKey(s.start,zone)===selectedDate);
  const loading=durationPending!==null,label=loading?'Loading times':list[0]?fmt(list[0].start,{weekday:'short',day:'numeric',month:'short'}):'No available times';
  const first=list.length?offset(zone,list[0].start):'',last=list.length?offset(zone,list.at(-1).start):'';
  const shift=first!==last?`<p class="tz-note" role="note">Clocks change on this day. Times after the change are ${esc(last)}.</p>`:first&&first!==offset(zone)?`<p class="tz-note" role="note">Times on this day are ${esc(first)}, after the clock change.</p>`:'';
  return `<section class="time-pane" aria-label="Choose a time"><div class="time-header"><h3 class="time-heading">${esc(label)}</h3><div class="time-toolbar"><small>${list.length} times</small><div class="format" aria-label="Time format"><button data-format="24" class="${!hour12?'active':''}" aria-pressed="${!hour12}">24h</button><button data-format="12" class="${hour12?'active':''}" aria-pressed="${hour12}">12h</button></div></div></div>${shift}<div class="time-list">${list.map(s=>`<button class="slot${s.start===lastSlotStart?' chosen':''}" data-slot="${s.start}"${s.start===lastSlotStart?' aria-current="true"':''}>${esc(time(s.start))}</button>`).join('')||(loading?'<p class="time-loading" role="status">Loading times…</p>':'<p class="time-empty">No times on this day. Choose another date.</p>')}</div></section>`;
}
function guest(change=''){
  theme();applyGuestMotion();document.body.classList.toggle('embed-mode',embedded);
  if(['date','month','format','zone'].includes(change)&&app.querySelector('.booking:not(.details)')){
    if(change!=='format')app.querySelector('.calendar-pane').outerHTML=calendar();
    const timePane=app.querySelector('.time-pane');if(timePane)timePane.outerHTML=times();
    bindGuest();animateGuest(change);notifySize();return;
  }
  app.innerHTML=`${embedded?'':`<header class="guest-top row between">${wordmark()}<a class="text-button" href="/studio">Edit booking page ↗</a></header>`}<main class="guest-stage" id="main">${suggestedTimeUnavailable&&!selectedSlot&&!booking?'<p class="suggested-time-note" role="status">That suggested time is no longer available. Choose another time.</p>':''}${!booking&&!selectedSlot&&error?`<p class="guest-availability-error error" id="availability-error" role="alert" tabindex="-1">${esc(error)}</p>`:''}${booking?success():selectedSlot?details():`<div class="booking${durationPending!==null?' is-loading':''}" aria-busy="${durationPending!==null}">${intro()}${calendar()}${times()}</div>`}</main><footer class="guest-bottom"><a href="/studio" target="_blank" rel="noopener" aria-label="Set up your booking page">${icon('mail')} ${esc(brandLabel(serviceBrand))}</a>${legalLinksMarkup(serviceBrand)}</footer>`;
  bindGuest();animateGuest(change);notifySize();
}
function guestQuestionMarkup(q){const id='guest-question-'+q.id,value=config.questions==null?draft.answer:draft.answers[q.id],required=q.required?'required':'',optional=q.required?'':' <span class="optional">(optional)</span>';if(q.type==='checkbox')return `<label class="guest-check" for="${esc(id)}"><input id="${esc(id)}" data-answer-id="${esc(q.id)}" type="checkbox" ${value===true?'checked':''} ${required}><span>${esc(q.label)}${optional}</span></label>`;const control=q.type==='textarea'?`<textarea id="${esc(id)}" data-answer-id="${esc(q.id)}" maxlength="2000" ${required}>${esc(value||'')}</textarea>`:q.type==='select'?`<select id="${esc(id)}" data-answer-id="${esc(q.id)}" ${required}><option value="">Choose an option</option>${q.options.map(choice=>`<option value="${esc(choice)}" ${choice===value?'selected':''}>${esc(choice)}</option>`).join('')}</select>`:`<input id="${esc(id)}" data-answer-id="${esc(q.id)}" maxlength="500" value="${esc(value||'')}" ${required}>`;return `<div><label for="${esc(id)}">${esc(q.label)}${optional}</label>${control}</div>`;}
function guestExtrasMarkup(){const emails=draft.additionalGuests||[];if(!config.extraGuestsLimit&&!emails.length)return '';return `<div class="guest-extras"><div id="additional-guests">${emails.map((email,i)=>`<div class="additional-guest"><label for="guest-extra-${i}">Guest ${i+1} email</label><div class="row"><input id="guest-extra-${i}" data-extra-guest type="email" required autocomplete="email" maxlength="254" value="${esc(email)}"><button type="button" class="icon-button" data-remove-guest="${i}" aria-label="Remove guest ${i+1}">×</button></div></div>`).join('')}</div>${emails.length<config.extraGuestsLimit?'<button class="text-button" type="button" id="add-guest">+ Add a guest</button>':''}${emails.length?'<p class="hint">Guests receive the invitation and your answers.</p>':''}</div>`;}
function focusChosenSlot(){(document.querySelector('.slot.chosen')||document.querySelector('.slot'))?.focus();}
function needsApproval(){return !!(config.requiresApproval||originalBooking?.requiresApproval);}
function details(){return `<div class="booking details">${intro()}<section class="guest-form"><button class="text-button" id="back">← Choose another time</button><h2>${originalBooking?(needsApproval()?'Request a new time':'Confirm your new time'):'Your details'}</h2><form id="booking-form" class="stack"><div><label for="guest-name">Your name</label><input id="guest-name" name="name" autocomplete="name" placeholder="Alex Morgan" required maxlength="120" value="${esc(draft.name)}" ${originalBooking?'readonly':''}></div><div><label for="guest-email">Email address</label><input id="guest-email" name="email" type="email" autocomplete="email" placeholder="alex@example.com" required maxlength="254" value="${esc(draft.email)}" ${originalBooking?'readonly':''}></div>${originalBooking?`<dl class="booking-detail-list guest-saved-intake">${savedIntakeMarkup(originalBooking)}</dl>`:normalizeQuestions(config).map(guestQuestionMarkup).join('')+guestExtrasMarkup()}${needsApproval()?`<p class="approval-before-booking">Host approval required. The time is held until ${esc(fmt(Math.min(Date.now()+(originalBooking?.approvalExpiryMinutes||config.approvalExpiryMinutes||1440)*60000,selectedSlot.start),{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit',hour12:false}))} ${esc(zone)}.</p>`:''}${changeNoteMarkup(policyFor(originalBooking?bookingPolicy(originalBooking):config,selectedSlot.start),zone,hour12)}${serviceBrand.privacyUrl?`<p class="booking-privacy"><a class="legal-link" href="${esc(serviceBrand.privacyUrl)}" target="_blank" rel="noopener">Privacy</a></p>`:''}<div id="form-error" class="error" role="alert" tabindex="-1">${esc(error)}</div><button class="primary" ${busy||ownerPreview||service.mode==='live'&&preview?'disabled':''}>${ownerPreview?'Preview':busy?'Confirming…':service.mode==='live'?(originalBooking?(needsApproval()?'Request new time':'Confirm new time'):config.requiresApproval?'Request booking':'Confirm booking'):'Reserve demo time'} <span aria-hidden="true">↗</span></button></form></section></div>`;}
function success(){if(service.mode==='live')return liveSuccess();return `<section class="success"><div class="success-icon" aria-hidden="true">✓</div><p class="eyebrow">Demo reservation</p><h1>Demo time reserved</h1><p>You’ve tried the booking flow. No real meeting was created and no invitation was sent.</p><div class="slot-summary"><strong>${esc(config.title)}</strong><br>${esc(longDate(booking.start))}<br>${esc(time(booking.start))} – ${esc(time(booking.end))}<small>${esc(zone)}</small></div><div class="row"><button class="secondary" id="cancel-demo">Release demo time</button><button class="text-button" id="restart">Back to calendar</button></div><p class="error" role="alert">${esc(error)}</p></section>`;}
function liveSuccess(){
  const confirmed=booking.status==='confirmed',awaiting=booking.status==='awaiting_approval',failed=['failed','rejected','expired'].includes(booking.status),token=booking.token||managementToken;
  const url=`/manage/${publicRoute[1]}/${booking.id}#${encodeURIComponent(token)}`;
  return `<section class="success"><div class="success-icon" aria-hidden="true">${confirmed?'✓':failed?'×':'◷'}</div><h1>${confirmed?'You’re booked':awaiting?'Request sent':failed?'This time was not booked':'Confirming your booking'}</h1><div class="slot-summary"><strong>${esc(config.title)}</strong><br>${esc(longDate(booking.start))}<br>${esc(time(booking.start))} – ${esc(time(booking.end))}<small>${esc(zone)}</small>${booking.assignedHosts?.length?`<p class="guest-hosts">With ${esc(booking.assignedHosts.map(h=>h.name).join(', '))}</p>`:''}</div>${approvalNotice(booking)}${confirmed||awaiting?changeNoteMarkup(bookingPolicy(booking),zone,hour12):''}${awaiting?'':confirmed?'<p>A calendar invitation will arrive by email.</p>'+conferenceMarkup(booking):failed?'<p>Please choose another time.</p>':'<p>Your time is held while your calendar invitation is prepared.</p>'}<div class="row" style="margin-top:24px"><a class="secondary" href="${esc(url)}">Manage booking</a>${failed?'<button class="text-button" id="restart">Choose another time</button>':''}${liveSettling(booking)?'<button class="text-button" id="refresh-status">Refresh status</button>':''}</div>${statusError?`<p class="muted" role="status">${esc(statusError)}</p>`:''}</section>`;
}
// Booking and Meet creation finish after the response; re-read the booking
// with the guest's own management capability for a short, bounded period.
// New-booking admission closed (expired or used). No times or form; the draft and idempotency key stay untouched.
function showClosedLink(code){clearTimeout(statusTimer);durationPending=null;durationBefore=null;previewWaiter=null;selectedSlot=null;allAvailable=[];available=[];theme();applyGuestMotion();document.body.classList.toggle('embed-mode',embedded);app.innerHTML=`${embedded?'':`<header class="guest-top row between">${wordmark()}</header>`}<main class="guest-stage" id="main">${closedLinkMarkup(code,{host:configLoaded?config.host:'',uncertain:uncertainAttempt})}</main>`;app.querySelector('.link-closed h1')?.focus();announce(app.querySelector('.link-closed h1')?.textContent||'');notifySize();}
function rescheduleClosed(text){const back=`/manage/${publicRoute[1]}/${originalBooking.id}#${encodeURIComponent(managementToken)}`;theme();app.innerHTML=`<main class="guest-stage" id="main"><section class="success"><h1>Online rescheduling closed</h1><p class="change-closed" data-change-closed>${esc(text)}</p><div class="row" style="margin-top:24px"><a class="secondary" href="${esc(back)}">Back to booking</a></div></section></main>`;app.querySelector('.success a')?.focus();}
function liveSettling(b){return !!b&&(b.status==='pending'||b.status==='confirmed'&&b.conferenceStatus==='pending');}
let statusError='';
async function refreshLiveStatus(){
  if(!booking||!publicRoute)return;const current=booking,token=booking.token||managementToken;
  try{const response=await fetch('/api/manage/'+publicRoute[1]+'/'+current.id,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'view',token})});const result=await response.json();if(!response.ok)throw Error(result.error||'Status could not refresh.');
    if(booking!==current)return;const before=current.status+'|'+current.conferenceStatus,hadError=!!statusError;booking={...result.booking,token};statusError='';
    if(before!==booking.status+'|'+booking.conferenceStatus||hadError){const focused=document.activeElement?.id;guest();if(focused)document.getElementById(focused)?.focus();if(!liveSettling(booking))(document.querySelector('.success .conference-state a')||document.querySelector('.success a'))?.focus();announce(booking.status==='confirmed'?(booking.conferenceStatus==='ready'?'Booking confirmed. Google Meet link ready.':booking.conferenceStatus==='failed'?'Booking confirmed. Meet link needs attention.':'Booking confirmed.'):booking.status==='pending'?'Still confirming.':'Booking status: '+booking.status);}
  }catch(err){if(booking!==current)return;statusError='Status could not refresh. Your booking has been kept.';guest();}
}
function scheduleLiveStatus(){clearTimeout(statusTimer);if(service.mode!=='live'||!liveSettling(booking)||statusAttempts>=8||document.hidden)return;statusTimer=setTimeout(async()=>{statusAttempts++;await refreshLiveStatus();scheduleLiveStatus();},Math.min(4000*2**Math.floor(statusAttempts/3),15000));}
function captureDraft(){const f=document.querySelector('#booking-form');if(f){const d=new FormData(f),answers=Object.fromEntries([...f.querySelectorAll('[data-answer-id]')].map(input=>[input.dataset.answerId,input.type==='checkbox'?input.checked:input.value]));draft={...draft,name:String(d.get('name')||''),email:String(d.get('email')||''),answer:config.questions==null?String(answers.legacy||''):'',answers:config.questions==null?{}:answers,additionalGuests:originalBooking?draft.additionalGuests:[...f.querySelectorAll('[data-extra-guest]')].map(input=>input.value)};}}
function bindGuest(){
  document.querySelectorAll('[data-choose-host]').forEach(b=>b.onclick=()=>chooseHost(b.dataset.chooseHost));const hostPicker=document.querySelector('#guest-team-host');if(hostPicker)hostPicker.onchange=()=>chooseHost(hostPicker.value);
  document.querySelectorAll('[name=guest-duration]').forEach(r=>r.onchange=()=>chooseDuration(r.value));
  document.querySelectorAll('[data-month]').forEach(b=>b.onclick=()=>{month=new Date(month.getFullYear(),month.getMonth()+Number(b.dataset.month),1);guest('month');document.querySelector(`[data-month="${b.dataset.month}"]`)?.focus();});
  document.querySelectorAll('[data-date]').forEach(b=>b.onclick=()=>{selectedDate=b.dataset.date;guest('date');document.querySelector(`[data-date="${selectedDate}"]`)?.focus();if(innerWidth<=470)document.querySelector('.time-pane').scrollIntoView({block:'start',behavior:document.documentElement.dataset.motion==='smooth'?'smooth':'instant'});announce(`${document.querySelector('.time-heading').textContent}, ${document.querySelectorAll('.slot').length} available times`);});
  document.querySelectorAll('[data-slot]').forEach(b=>b.onclick=()=>{selectedSlot=available.find(s=>s.start===Number(b.dataset.slot));lastSlotStart=selectedSlot?.start??null;error='';requestKey=crypto.randomUUID();guest('forward');document.querySelector('#guest-name').focus();});
  document.querySelectorAll('[data-format]').forEach(b=>b.onclick=()=>{hour12=b.dataset.format==='12';guest('format');document.querySelector(`[data-format="${b.dataset.format}"]`)?.focus();});
  const tz=document.querySelector('#timezone');if(tz)tz.onchange=()=>{zone=tz.value;pickFirstDate();guest('zone');document.querySelector('#timezone').focus();};
  const back=document.querySelector('#back');if(back)back.onclick=()=>{captureDraft();selectedSlot=null;error='';guest('back');focusChosenSlot();};
  const addGuest=document.querySelector('#add-guest');if(addGuest)addGuest.onclick=()=>{captureDraft();draft.additionalGuests.push('');guest();document.querySelector('[data-extra-guest]:last-of-type')?.focus();const fields=document.querySelectorAll('[data-extra-guest]');fields[fields.length-1]?.focus();};document.querySelectorAll('[data-remove-guest]').forEach(button=>button.onclick=()=>{captureDraft();draft.additionalGuests.splice(Number(button.dataset.removeGuest),1);guest();(document.querySelector('#add-guest')||document.querySelector('#guest-name'))?.focus();});
  const form=document.querySelector('#booking-form');if(form)form.onsubmit=async e=>{
    e.preventDefault();if(busy||ownerPreview||service.mode==='live'&&preview)return;captureDraft();try{if(!originalBooking)validateIntake(config,draft);}catch(err){error=err.message;guest();document.querySelector('#form-error')?.focus();return;}busy=true;error='';guest();
    try{const result=await api('book',{start:selectedSlot.start,key:requestKey,idempotencyKey:requestKey,...draft,...(!originalBooking&&config.team?{teamRevision:config.team.revision,...(config.team.mode==='choose'?{teamHostId:selectedTeamHostId}:{})}:{}),...(!originalBooking&&service.mode==='live'?{duration:config.duration}:{}),intakeRevision:await intakeRevision(config),timeZone:zone,source:['email','website'].includes(params.get('source'))?params.get('source'):'direct'});booking=result.booking?{...result.booking,token:result.managementToken}:result;selectedSlot=null;available=available.filter(s=>s.start!==booking.start);guest();document.querySelector(service.mode==='live'?'.success a':'#cancel-demo')?.focus();announce(service.mode==='live'?(booking.status==='confirmed'?'Booking confirmed.':booking.status==='pending'?'Confirming your booking.':'Booking status: '+booking.status):'Demo time reserved.');statusAttempts=0;statusError='';scheduleLiveStatus();}
    catch(err){const reviewedConfig=config,reviewedTeam=JSON.stringify(config.team),reviewedDuration=config.duration;error=err.message;
      if(!originalBooking&&isLinkClosed(err)){showClosedLink(err.code);return;}if(!originalBooking&&(!err.status||err.status>=500))uncertainAttempt=true;
      if(originalBooking&&isChangeWindowClosed(err)){const change=manageChangeState(originalBooking);error=change.closed.includes('reschedule')?closedText({...change,closed:['reschedule']},zone,hour12):err.message;guest();document.querySelector('#form-error')?.focus();return;}let closedDuringRefresh=null;const reloadTimes=()=>api('availability').catch(refreshError=>{if(!originalBooking&&isLinkClosed(refreshError))closedDuringRefresh=refreshError;return null;});let state=await reloadTimes();if(closedDuringRefresh){showClosedLink(closedDuringRefresh.code);return;}
      // A removed guest length: fall back to the link default and ask for a new time rather than booking a different length.
      if(!state&&!originalBooking&&chosenDuration!=null&&[400,409].includes(err.status)){chosenDuration=null;state=await reloadTimes();if(closedDuringRefresh){showClosedLink(closedDuringRefresh.code);return;}}
      if(!originalBooking&&state?.config?.duration!==reviewedDuration&&![400,409].includes(err.status))state=null;
      if(err.code==='idempotency_conflict')state=null;
      if(state){replaceSlots(state.slots);
      if(!originalBooking&&[400,409].includes(err.status)&&state.config&&state.config.duration!==reviewedDuration){config=state.config;chosenDuration=null;selectedSlot=null;requestKey=crypto.randomUUID();error='That meeting length is no longer offered. Choose a length and time again.';}
      // Only a definitive validation rejection can adopt a changed questionnaire.
      // A timeout or server error may have accepted the original request.
      if(!originalBooking&&(err.status===400||err.status===409&&(JSON.stringify(state.config?.team)!==reviewedTeam||state.config?.duration!==reviewedDuration))&&state.config&&await intakeRevision(reviewedConfig)!==await intakeRevision(state.config)){
        const previous=normalizeQuestions(reviewedConfig),next=normalizeQuestions(state.config),oldAnswers=reviewedConfig.questions==null?{legacy:draft.answer}:draft.answers,answers={};
        for(const question of next){const before=previous.find(q=>q.id===question.id),value=oldAnswers[question.id];if(before?.type===question.type&&value!==undefined&&(question.type!=='select'||question.options.includes(value)))answers[question.id]=value;}
        draft={...draft,answers:state.config.questions==null?{}:answers,answer:state.config.questions==null?String(answers.legacy||''):''};
        config=state.config;error='Booking form changed. Review your answers and guests.';
      }
      if(!originalBooking&&[400,409].includes(err.status)&&state.config&&JSON.stringify(state.config.team)!==reviewedTeam){config=state.config;selectedSlot=null;selectedTeamHostId='';requestKey=crypto.randomUUID();error=config.team?.mode==='choose'?'Hosts changed. Choose a host and time again.':'Hosts changed. Choose a time again.';}replaceSlots(state.slots);if(!selectedSlot)pickFirstDate();
    }guest();(document.querySelector('#form-error')||document.querySelector('#availability-error'))?.focus();}
    finally{busy=false;const button=document.querySelector('#booking-form .primary');if(button){button.disabled=false;button.textContent=service.mode==='live'?(originalBooking?(needsApproval()?'Request new time':'Confirm new time'):config.requiresApproval?'Request booking':'Confirm booking'):'Reserve demo time ↗';}}
  };
  const cancel=document.querySelector('#cancel-demo');if(cancel)cancel.onclick=async()=>{cancel.disabled=true;try{await api('cancel',{id:booking.id,token:booking.token});booking=null;selectedSlot=null;const state=await api('availability');replaceSlots(state.slots);pickFirstDate();guest();announce('Demo reservation released.');}catch(err){error=err.message;guest();}};
  const restart=document.querySelector('#restart');if(restart)restart.onclick=async()=>{clearTimeout(statusTimer);booking=null;selectedSlot=null;statusError='';if(service.mode==='live'&&publicRoute&&!originalBooking&&!preview){restart.disabled=true;try{const state=await api('availability');config=state.config;replaceSlots(state.slots);pickFirstDate();}catch(err){if(isLinkClosed(err)){showClosedLink(err.code);return;}}}guest();};
  const refreshStatus=document.querySelector('#refresh-status');if(refreshStatus)refreshStatus.onclick=async()=>{refreshStatus.disabled=true;refreshStatus.textContent='Refreshing…';await refreshLiveStatus();const again=document.querySelector('#refresh-status');if(again){again.disabled=false;again.textContent='Refresh status';again.focus();}statusAttempts=0;scheduleLiveStatus();};
}
const input=(key,label,type='text',extra='')=>`<div class="field"><label for="${key}">${label}</label><input id="${key}" data-setting="${key}" type="${type}" value="${esc(config[key])}" ${extra}></div>`;
const select=(key,label,options)=>`<div class="field"><label for="${key}">${label}</label><select id="${key}" data-setting="${key}">${options.map(([v,t])=>`<option value="${esc(v)}" ${config[key]===v?'selected':''}>${esc(t)}</option>`).join('')}</select></div>`;
function editorBody(){
  if(tab==='Meeting')return `<div class="stack">${input('title','What are we meeting about?','text','maxlength="160"')}${input('host','Your name','text','maxlength="160"')}${input('company','Company or workspace','text','maxlength="160"')}<div><label for="description">A short introduction</label><textarea data-setting="description" id="description" maxlength="600">${esc(config.description)}</textarea></div><div class="two-col">${select('duration','Duration',[[15,'15 minutes'],[30,'30 minutes'],[45,'45 minutes'],[60,'1 hour']])}${input('location','Where','text','maxlength="160"')}</div><div class="callout"><strong>Calendar connection comes next</strong><br>This preview uses sample availability. Live calendar authorization, invitations and reminders are not connected yet.</div></div>`;
  if(tab==='Availability')return `<div class="stack"><div><label>Available on</label><div class="day-toggle">${[1,2,3,4,5,6,0].map((d,i)=>`<button data-day="${d}" aria-pressed="${config.days.includes(d)}" aria-label="${['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'][i]}">${['M','T','W','T','F','S','S'][i]}</button>`).join('')}</div></div><div class="two-col">${select('startHour','From',Array.from({length:24},(_,h)=>[h,`${String(h).padStart(2,'0')}:00`]))}${select('endHour','Until',Array.from({length:24},(_,h)=>[h+1,`${String(h+1).padStart(2,'0')}:00`]))}</div>${select('zone','Working-hours timezone',[...new Set([config.zone,...Intl.supportedValuesOf('timeZone')])].map(z=>[z,z.replaceAll('_',' ')]))}<div class="two-col">${select('buffer','Between meetings',[[0,'No buffer'],[15,'15 minutes'],[30,'30 minutes'],[60,'1 hour']])}${select('notice','Minimum notice',[[0,'No notice'],[60,'1 hour'],[120,'2 hours'],[1440,'24 hours']])}</div>${select('horizon','Guests can book ahead',[[7,'1 week'],[14,'2 weeks'],[28,'4 weeks'],[60,'60 days']])}<div class="callout"><strong>Your hours stay in ${esc(config.zone)}.</strong><br>Guests see times in their timezone. The preview includes a sample lunch break from 12:00 to 13:00.</div></div>`;
  if(tab==='Questions')return `<div class="stack"><div><h3>Booking questions</h3><p class="hint">Name and email are always included. Ask only what you need before the meeting.</p></div>${input('question','Preparation question','text','maxlength="160" placeholder="Leave blank for no extra question"')}<div class="setting-line"><label for="required">Make the answer required</label><input id="required" data-setting="required" type="checkbox" ${config.required?'checked':''}></div><div class="divider"></div><h3>Messages around the meeting</h3><div class="timeline"><div class="timeline-item">When booked<small>Calendar invitation and confirmation</small></div><div class="timeline-item"><div class="setting-line"><label for="reminder">24 hours before</label><input id="reminder" type="checkbox" data-setting="reminder" ${config.reminder?'checked':''}></div><small>One short reminder</small></div></div><p class="callout">Reminder preference is saved for the design preview. Sending is not connected in this build.</p></div>`;
  return `<div class="stack"><div><label>Accent</label><div class="swatches">${[['clay','#986951'],['iris','#796292'],['sage','#567866'],['graphite','#555b60']].map(([a,c])=>`<button class="swatch" style="--swatch:${c}" data-accent="${a}" aria-label="${a}" aria-pressed="${config.accent===a}"></button>`).join('')}</div></div>${select('theme','Appearance',[['light','Light'],['dark','Dark']])}${select('motion','Transitions',[['smooth','Smooth'],['none','Instant']])}<div class="callout"><strong>Page appearance</strong><br>The host and meeting lead the page. Embeds inherit your chosen theme; your website keeps its own styling.</div></div>`;
}
function studio(){
  theme();document.body.classList.remove('embed-mode');
  app.innerHTML=`<div class="admin-layout"><aside class="admin-rail">${wordmark()}<a href="/studio" class="rail-item active"><span class="rail-symbol" aria-hidden="true">◷</span>Booking pages</a><a href="/site" class="rail-item"><span class="rail-symbol" aria-hidden="true">↗</span>Website example</a><div class="rail-bottom">LOCAL PREVIEW<br>One shared booking experience.<br>No live calendar connected.</div></aside><main class="admin-main" id="main"><header class="admin-header row between"><div><p class="eyebrow">Booking page</p><h1>Meeting settings</h1><p>Set availability and choose what guests see.</p></div><div class="row"><span class="pill">Demo workspace</span><a class="secondary" href="/book" target="_blank" rel="noopener">Open page ↗</a></div></header><div class="host-workspace"><section class="editor" aria-label="Booking page settings"><div class="tabs" role="tablist">${['Meeting','Availability','Questions','Style'].map(t=>`<button role="tab" tabindex="${tab===t?0:-1}" aria-selected="${tab===t}" class="${tab===t?'active':''}" data-tab="${t}">${t}</button>`).join('')}</div><div class="editor-body" role="tabpanel">${editorBody()}</div><footer class="editor-footer"><span class="save-status" role="status">${dirty?'Unsaved changes':'Saved in your local workspace'}</span><button id="save" class="primary">Save changes</button></footer></section><section class="preview-area"><div class="preview-label row between"><p class="eyebrow">Guest preview</p><div class="preview-controls"><button class="${width==='desktop'?'active':''}" data-width="desktop">Desktop</button><button class="${width==='mobile'?'active':''}" data-width="mobile">Mobile</button></div></div><div class="preview-shell" style="${width==='mobile'?'max-width:390px;margin:auto;':''}"><div class="browser-top"><span class="browser-dot"></span><span class="browser-dot"></span><span class="browser-dot"></span><span class="browser-address">Your booking page · interactive preview</span></div><iframe id="preview" title="Interactive guest booking preview" src="/book?embed=1&preview=1"></iframe></div><div class="share-card"><div class="row between"><div><h3>Add to your website</h3><p>Inline on a page, or behind your “Book a meeting” button.</p></div><a class="text-button" href="/site" target="_blank" rel="noopener">Try both ↗</a></div><code id="embed-code"></code><button class="text-button" id="copy">Copy embed code</button></div></section></div></main></div>`;
  document.querySelector('#embed-code').textContent=`<div data-email-booking="${location.origin}/book"></div>\n<script src="${location.origin}/embed.js" defer><\/script>`;
  document.querySelectorAll('[data-tab]').forEach(b=>{b.onclick=()=>{captureSettings();tab=b.dataset.tab;studio();document.querySelector(`[data-tab="${tab}"]`).focus();};b.onkeydown=e=>{const names=['Meeting','Availability','Questions','Style'];if(['ArrowLeft','ArrowRight','Home','End'].includes(e.key)){e.preventDefault();const i=e.key==='Home'?0:e.key==='End'?3:(names.indexOf(tab)+(e.key==='ArrowLeft'?3:1))%4;document.querySelector(`[data-tab="${names[i]}"]`).click();}};});
  document.querySelectorAll('[data-setting]').forEach(el=>{el.oninput=()=>{captureSettings();dirty=true;document.querySelector('.save-status').textContent='Unsaved changes';theme();pushPreview();};});
  document.querySelectorAll('[data-day]').forEach(b=>b.onclick=()=>{const d=Number(b.dataset.day);config.days=config.days.includes(d)?config.days.filter(x=>x!==d):[...config.days,d];dirty=true;studio();});
  document.querySelectorAll('[data-accent]').forEach(b=>b.onclick=()=>{config.accent=b.dataset.accent;dirty=true;studio();});
  document.querySelectorAll('[data-width]').forEach(b=>b.onclick=()=>{captureSettings();width=b.dataset.width;studio();});
  document.querySelector('#preview').onload=pushPreview;
  document.querySelector('#copy').onclick=async()=>{try{await navigator.clipboard.writeText(document.querySelector('#embed-code').textContent);document.querySelector('#copy').textContent='Copied ✓';}catch{document.querySelector('#copy').textContent='Select the code above to copy';}};
  document.querySelector('#save').onclick=async()=>{captureSettings();const b=document.querySelector('#save');b.disabled=true;b.textContent='Saving…';try{const state=await api('settings',config);config=state.config;replaceSlots(state.slots);dirty=false;document.querySelector('.save-status').textContent='Saved · guest page updated';pushPreview();}catch(err){document.querySelector('.save-status').textContent=err.message;}finally{b.disabled=false;b.textContent='Save changes';}};
}
function captureSettings(){document.querySelectorAll('[data-setting]').forEach(el=>{const k=el.dataset.setting;config[k]=el.type==='checkbox'?el.checked:['duration','startHour','endHour','buffer','notice','horizon'].includes(k)?Number(el.value):el.value;});}
function pushPreview(){document.querySelector('#preview')?.contentWindow.postMessage({type:'email-booking:preview',config},location.origin);}
function notifySize(){if(embedded)requestAnimationFrame(()=>parent.postMessage({type:'email-booking:resize',height:document.documentElement.scrollHeight},'*'));}
window.addEventListener('message',async e=>{
  if(ownerPreview){
    if(e.origin!==location.origin||e.source!==parent||parent===window)return;
    if(e.data?.type==='email-booking:owner-preview-error'){if(previewWaiter&&e.data.request===previewWaiter.request){const waiter=previewWaiter;previewWaiter=null;waiter.reject(Error('Preview could not load.'));}return;}
    if(e.data?.type!=='email-booking:owner-preview')return;
    // A reply to this frame's own length request keeps the guest's draft and host; any other reply is stale.
    if(e.data.request!==undefined){if(!previewWaiter||e.data.request!==previewWaiter.request)return;const waiter=previewWaiter;previewWaiter=null;try{waiter.resolve(projectPreviewState(e.data.state));}catch(err){waiter.reject(err);}return;}
    previewWaiter=null;durationSeq++;durationPending=null;durationBefore=null;chosenDuration=null;
    try{const state=projectPreviewState(e.data.state);config=state.config;selectedTeamHostId='';selectedSlot=null;booking=null;draft={name:'',email:'',answer:'',answers:{},additionalGuests:[]};zone=config.zone;replaceSlots(state.slots);pickFirstDate();guest();}
    catch{app.innerHTML='<main class="loading" role="alert">Preview could not load.</main>';}
    return;
  }
  if(admin && e.origin===location.origin && e.source===document.querySelector('#preview')?.contentWindow && e.data?.type==='email-booking:ready'){pushPreview();return;}
  if(!preview || e.origin!==location.origin || e.source!==parent || e.data?.type!=='email-booking:preview')return;
  config=e.data.config;
  // The preview uses identical policy and local reservations, never fake live coverage.
  if(!validZone(config.zone))return;
  const policyKey=JSON.stringify([config.days,config.startHour,config.endHour,config.zone,config.duration,config.notice,config.horizon,config.buffer]);
  if(policyKey!==previewPolicyKey){const {slots}=await import('/policy.js');available=slots(config,Date.now());previewPolicyKey=policyKey;pickFirstDate();}
  selectedSlot=null;booking=null;guest();
});
function signInScreen({setup=false,entry=false}={}){
 const product=serviceBrand.productName,legal=legalLinksMarkup(serviceBrand);document.title=product;const skip=document.querySelector('.skip');if(skip)skip.textContent='Skip to content';
 const google='<svg viewBox="0 0 48 48" width="20" height="20" aria-hidden="true"><path fill="#4285f4" d="M43.61 24.46c0-1.36-.12-2.66-.35-3.92H24v7.43h11a9.4 9.4 0 0 1-4.08 6.17v5h6.61c3.87-3.56 6.08-8.81 6.08-14.68Z"/><path fill="#34a853" d="M24 44c5.51 0 10.13-1.83 13.51-4.96l-6.61-5c-1.83 1.23-4.18 1.96-6.9 1.96-5.32 0-9.83-3.59-11.44-8.43H5.73v5.18A20.4 20.4 0 0 0 24 44Z"/><path fill="#fbbc05" d="M12.56 27.57a12.25 12.25 0 0 1 0-7.14v-5.18H5.73a20.4 20.4 0 0 0 0 17.5l6.83-5.18Z"/><path fill="#ea4335" d="M24 12c3 0 5.69 1.03 7.81 3.05l5.86-5.86C34.13 5.89 29.51 4 24 4A20.4 20.4 0 0 0 5.73 15.25l6.83 5.18C14.17 15.59 18.68 12 24 12Z"/></svg>';
 return `<div class="sign-in-screen"><header class="sign-in-header">${organizationMarkup(serviceBrand)}</header><main class="sign-in-main" id="main"><div class="sign-in-content"><span class="sign-in-mark" aria-hidden="true">${esc(brandMark(serviceBrand))}</span><h1>${esc(product)}</h1>${setup?'<p class="sign-in-status" role="status">Calendar connection is being set up.</p>':`<a class="sign-in-action" tabindex="0" href="${entry?'/studio':'/auth/google'}">${entry?'':google}<span>${entry?'Open '+esc(product):'Continue with Google'}</span><svg class="sign-in-arrow" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M5 12h14m-6-6 6 6-6 6"/></svg></a>`}</div></main>${legal?`<footer class="sign-in-footer">${legal}</footer>`:''}</div>`;
}
document.addEventListener('keydown',e=>{
  if(admin)return;
  if(ownerPreview&&e.key==='Escape'&&!selectedSlot){e.preventDefault();parent.postMessage({type:'email-booking:preview-close'},location.origin);return;}
  if(e.key==='Escape' && selectedSlot && !document.querySelector('dialog[open]')){e.preventDefault();captureDraft();selectedSlot=null;error='';guest('back');focusChosenSlot();return;}
  if(e.target.matches('input,textarea,select'))return;
  const list=e.target.closest('.date-grid,.time-list');
  if(list && ['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(e.key)){
    const buttons=[...list.querySelectorAll('button:not(:disabled)')],index=buttons.indexOf(e.target);let delta=['ArrowLeft','ArrowUp'].includes(e.key)?-1:1;
    if(list.classList.contains('date-grid') && ['ArrowUp','ArrowDown'].includes(e.key))delta*=7;
    e.preventDefault();buttons[Math.max(0,Math.min(buttons.length-1,index+delta))]?.focus();
  }
});
async function boot(){
  if(ownerPreview){document.title='Preview · '+DEFAULT_BRAND.productName;service={mode:'live'};app.innerHTML='<main class="loading" id="main" role="status">Preview</main>';if(parent!==window)parent.postMessage({type:'email-booking:owner-ready'},location.origin);return;}
  if(admin&&(await import('/account-deletion-ui.js')).resumeAccountDeletion({root:app}))return;
  app.innerHTML='<main class="loading" id="main">Loading availability…</main>';
  try{
    // Studio invitations: move the fragment token into this tab's session before sign-in can drop it.
    if(admin&&location.hash.startsWith('#invite=')){const invite=await import('/workspace-ui.js');invite.stashInviteToken(invite.captureInviteToken());}
    service=await (await fetch('/api/bootstrap')).json();
    serviceBrand=normalizeBrand(service.brand);document.title='Book a conversation · '+brandLabel(serviceBrand);
    if(service.mode!=='local'&&admin){
      if(service.mode==='live'&&service.authenticated){await (await import('/host-ui.js')).hostUI(service);return;}
      app.innerHTML=signInScreen({setup:service.mode==='setup'});return;
    }
    if(service.mode==='live'&&managementRoute){await (await import('/manage-ui.js')).manageUI({hostId:managementRoute[1],id:managementRoute[2],token:location.hash.slice(1)});return;}
    if(service.mode==='live'&&publicRoute&&params.get('reschedule')){
      managementToken=location.hash.slice(1);const response=await fetch('/api/manage/'+publicRoute[1]+'/'+params.get('reschedule'),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'view',token:managementToken})});const result=await response.json();if(!response.ok)throw Error(result.error);originalBooking=result.booking;draft={name:originalBooking.name,email:originalBooking.email,answer:originalBooking.answer||'',answers:originalBooking.answers||{},additionalGuests:originalBooking.additionalGuests||[]};zone=originalBooking.timeZone||zone;
      const change=manageChangeState(originalBooking);if(originalBooking.status==='confirmed'&&change.closed.includes('reschedule')){rescheduleClosed(closedText({...change,closed:['reschedule']},zone,hour12));return;}
    }
    if(service.mode!=='local'&&!publicRoute&&!preview){app.innerHTML=signInScreen({entry:true});return;}
    let state;try{state=await api('availability');}catch(err){if(originalBooking&&isChangeWindowClosed(err)){rescheduleClosed(err.message);return;}if(!originalBooking&&isLinkClosed(err)){showClosedLink(err.code);return;}throw err;}config=state.config;configLoaded=true;replaceSlots(state.slots);pickFirstDate();
    if(service.mode==='live'&&publicRoute&&!preview&&params.has('start')){const start=Number(params.get('start'));selectedSlot=Number.isSafeInteger(start)?available.find(slot=>slot.start===start)||null:null;suggestedTimeUnavailable=!selectedSlot&&!(config.team?.mode==='choose'&&!selectedTeamHostId);}
    if(location.pathname==='/site'){theme();app.innerHTML=`<main class="website-demo" id="main"><header>${wordmark()}<button class="secondary" data-email-booking="${location.origin}/book">Book a demo ↗</button></header><section class="hero"><p class="eyebrow">Website booking example</p><h1>See the product.<br>Ask your questions.</h1><p>Book a 30-minute demo with our team. Choose a time below or use the booking button.</p><button class="primary" data-email-booking="${location.origin}/book">Book a demo ↗</button></section><p class="eyebrow" style="margin-bottom:20px">Or book right here</p><div data-email-booking="${location.origin}/book"></div></main>`;const script=document.createElement('script');script.src='/embed.js';document.body.append(script);return;}
    admin?studio():guest();
    if(service.mode==='live'&&publicRoute&&!preview&&!originalBooking&&!visitRecorded){visitRecorded=true;const source=['email','website'].includes(params.get('source'))?params.get('source'):'direct';void api('visit',{source}).catch(()=>{});}
    if(preview)parent.postMessage({type:'email-booking:ready'},location.origin);
  }catch(err){app.innerHTML=`<main class="loading"><h2>Couldn’t open the booking page.</h2><p>${esc(err.message)}</p><button class="secondary" id="retry">Try again</button></main>`;document.querySelector('#retry').onclick=boot;}
}
matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change',()=>{if(admin)return;applyGuestMotion();if(document.documentElement.dataset.motion==='none')app.getAnimations({subtree:true}).forEach(animation=>animation.cancel());});
document.addEventListener('visibilitychange',()=>{if(!document.hidden)scheduleLiveStatus();});
window.addEventListener('beforeunload',e=>{if(admin&&dirty){e.preventDefault();e.returnValue='';}});
boot();
