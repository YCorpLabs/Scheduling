// Guest change cutoffs: host authoring and guest copy. change-policy.js and the Worker stay authoritative.
import {normalizeChangeNotices,changePolicyForStart,changeWindowOpen} from './change-policy.js';
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export const NOTICE_PRESETS=[0,60,120,240,720,1440,2880,10080];
export const MAX_NOTICE=43200;
export const REASON_MAX=500;
const UNITS=[[1,'minutes'],[60,'hours'],[1440,'days']];
const plural=(n,word)=>`${n} ${word}${n===1?'':'s'}`;
/** Compact length, e.g. "90 minutes", "12 hours", "2 days", "1 week". */
export function noticeLabel(minutes){
 if(minutes%10080===0)return plural(minutes/10080,'week');
 if(minutes%1440===0)return plural(minutes/1440,'day');
 if(minutes%60===0)return plural(minutes/60,'hour');
 return minutes>60?`${Math.floor(minutes/60)} hr ${minutes%60} min`:plural(minutes,'minute');
}
const safeNotice=v=>Number.isInteger(v)&&v>=0&&v<=MAX_NOTICE?v:0;
/** Public notice pair without throwing; malformed values mean no extra cutoff for display only. */
export function noticePair(source){return {cancellationNoticeMinutes:safeNotice(source?.cancellationNoticeMinutes),rescheduleNoticeMinutes:safeNotice(source?.rescheduleNoticeMinutes)};}
const bestUnit=m=>m>0&&m%1440===0?1440:m>0&&m%60===0?60:1;

// ---- Host editor ----
const FIELDS=[['cancellationNoticeMinutes','Cancel','cancel'],['rescheduleNoticeMinutes','Reschedule','reschedule']];
function noticeRow(name,label,key,value){
 const current=safeNotice(value),values=[...new Set([...NOTICE_PRESETS,current])].sort((a,b)=>a-b),unit=bestUnit(current);
 return `<div class="change-rule" data-change-rule="${key}"><label for="edit-${name}">${label}</label><select id="edit-${name}" name="${name}">${values.map(v=>`<option value="${v}" ${v===current?'selected':''}>${v===0?'Anytime':esc(noticeLabel(v))+' before'}</option>`).join('')}<option value="custom">Custom…</option></select><div class="change-custom" data-change-custom hidden><input type="number" inputmode="numeric" step="1" aria-label="${label} cutoff amount" data-change-amount value="${current?current/unit:''}"><select aria-label="${label} cutoff unit" data-change-unit>${UNITS.map(([n,l])=>`<option value="${n}" ${n===unit?'selected':''}>${l}</option>`).join('')}</select><span aria-hidden="true">before</span></div></div>`;
}
/** "Guest changes" group for the Booking rules tab. Zero adds no cutoff to the existing booking status rules. */
export function changeRulesMarkup(t){
 return `<fieldset class="change-rules" data-change-rules><legend>Guest changes</legend><div class="change-rule-grid">${FIELDS.map(([name,label,key])=>noticeRow(name,label,key,t?.[name])).join('')}</div><p class="change-error" data-change-error role="status"></p></fieldset>`;
}
const intValue=raw=>/^\d+$/.test(String(raw??'').trim())?Number(String(raw).trim()):NaN;
/** Reads the notice pair. Returns {} when the editor is absent so stored values are kept. */
export function readChangeNotices(form){
 const editor=form.querySelector('[data-change-rules]');if(!editor)return {};const out={};
 for(const [name,label] of FIELDS){
  const select=form.elements[name],row=select.closest('[data-change-rule]');
  if(select.value==='custom'){const amount=intValue(row.querySelector('[data-change-amount]').value),unit=Number(row.querySelector('[data-change-unit]').value);if(!Number.isInteger(amount)||amount<1)throw Error(`Enter a ${label.toLowerCase()} cutoff as a whole number.`);out[name]=amount*unit;if(out[name]>MAX_NOTICE)throw Error('Guest change cutoffs can be up to 30 days.');}
  else out[name]=Number(select.value);
 }
 return normalizeChangeNotices(out);
}
/** Reveals the custom amount for "Custom…". Native change/input events reach the form's dirty tracking. */
export function bindChangeRules(form){
 const editor=form.querySelector('[data-change-rules]');if(!editor)return;
 editor.querySelectorAll('[data-change-rule]').forEach(row=>{const select=row.querySelector('select[name]'),custom=row.querySelector('[data-change-custom]');const sync=focus=>{custom.hidden=select.value!=='custom';custom.querySelectorAll('input,select').forEach(c=>c.disabled=custom.hidden);if(!custom.hidden&&focus)row.querySelector('[data-change-amount]').focus();};select.addEventListener('change',()=>{editor.querySelector('[data-change-error]').textContent='';sync(true);});sync(false);});
}
/** Short link-list summary, empty when no extra cutoff applies. */
export function changeRulesSummary(t){const {cancellationNoticeMinutes:c,rescheduleNoticeMinutes:r}=noticePair(t);if(!c&&!r)return '';return c===r?`Changes ${noticeLabel(c)} ahead`:[c?`Cancel ${noticeLabel(c)} ahead`:'',r?`Reschedule ${noticeLabel(r)} ahead`:''].filter(Boolean).join(' · ');}

// ---- Guest ----
/** Deadline in the guest's zone with its offset, e.g. "Thu 4 Dec, 09:00 GMT+1". */
export function deadlineText(ms,zone,hour12=false){
 try{return new Intl.DateTimeFormat('en-GB',{timeZone:zone,weekday:'short',day:'numeric',month:'short',hour:'numeric',minute:'2-digit',hour12,timeZoneName:'shortOffset'}).format(ms).replace(' at ',', ').replace(/GMT[+-]0$/,'GMT');}
 catch{return new Date(ms).toISOString().slice(0,16).replace('T',' ')+' UTC';}
}
/** A cleaned booking.changePolicy, or null (legacy rows have no extra cutoff). */
export function bookingPolicy(booking){const p=booking?.changePolicy;if(!p||typeof p!=='object')return null;const ok=v=>v===null||Number.isSafeInteger(v);return ok(p.cancelUntil)&&ok(p.rescheduleUntil)?{...noticePair(p),cancelUntil:p.cancelUntil,rescheduleUntil:p.rescheduleUntil}:null;}
/** Policy a start would receive from a notice pair (public config or an accepted snapshot). */
export function policyFor(notices,start){try{return changePolicyForStart(noticePair(notices),start);}catch{return null;}}
/** One concise line, or '' when no cutoff applies. Used before confirmation and on receipts. */
export function changeNoteText(policy,zone,hour12=false,now=Date.now()){
 if(!policy)return '';const c=policy.cancelUntil,r=policy.rescheduleUntil;if(c===null&&r===null)return '';
 const closedC=c!==null&&!changeWindowOpen(policy,'cancel',now),closedR=r!==null&&!changeWindowOpen(policy,'reschedule',now);
 if(closedC&&closedR)return 'This time can’t be changed online.';
 if(c!==null&&c===r)return `Cancel or reschedule by ${deadlineText(c,zone,hour12)}.`;
 return [closedC?'Can’t be cancelled online.':c!==null?`Cancel by ${deadlineText(c,zone,hour12)}.`:'',closedR?'Can’t be rescheduled online.':r!==null?`Reschedule by ${deadlineText(r,zone,hour12)}.`:''].filter(Boolean).join(' ');
}
export function changeNoteMarkup(policy,zone,hour12=false,now=Date.now()){const text=changeNoteText(policy,zone,hour12,now);return text?`<p class="change-note" data-change-note>${esc(text)}</p>`:'';}
/** Guest management state. Unconfirmed requests can always be withdrawn; cutoffs apply to confirmed bookings. */
export function manageChangeState(booking,now=Date.now()){
 const policy=bookingPolicy(booking),confirmed=booking?.status==='confirmed',future=booking?.end>now;
 const open=kind=>!policy||changeWindowOpen(policy,kind,now);
 const cancel=future&&(['pending','awaiting_approval'].includes(booking?.status)||confirmed&&open('cancel')),reschedule=future&&confirmed&&open('reschedule');
 const closed=future&&confirmed?[!open('cancel')&&'cancel',!open('reschedule')&&'reschedule'].filter(Boolean):[];
 const deadlines=policy?[policy.cancelUntil,policy.rescheduleUntil].filter(v=>v!==null&&v>now):[];
 return {policy,cancel,reschedule,closed,nextDeadline:deadlines.length?Math.min(...deadlines):null};
}
/** Honest copy once guest changes have closed. */
export function closedText(state,zone,hour12=false){
 if(!state.closed.length)return '';const p=state.policy,both=state.closed.length===2,kind=state.closed[0];
 const at=both?Math.max(p.cancelUntil,p.rescheduleUntil):kind==='cancel'?p.cancelUntil:p.rescheduleUntil;
 return `${both?'Online changes':kind==='cancel'?'Online cancellation':'Online rescheduling'} closed ${deadlineText(at,zone,hour12)}. Reply to your invitation to reach the organizer.`;
}
/** Trimmed optional reason, or undefined. */
export function cleanReason(value){const text=String(value??'').trim();return text?text.slice(0,REASON_MAX):undefined;}
export const isChangeWindowClosed=error=>error?.code==='change_window_closed';
