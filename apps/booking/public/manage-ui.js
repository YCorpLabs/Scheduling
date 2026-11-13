import {approvalNotice} from '/approval-ui.js';
import {savedIntakeMarkup} from '/intake-ui.js';
import {conferenceMarkup} from '/conference-ui.js';
import {manageChangeState,changeNoteMarkup,closedText,cleanReason,isChangeWindowClosed,REASON_MAX} from '/change-policy-ui.js';
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
// setTimeout clamps above ~24.8 days; re-render at the next guest cutoff so a stale open page stays honest.
const MAX_TIMER=2**31-1;
export async function manageUI({hostId,id,token}) {
  const root=document.querySelector('#app');let booking,message='',confirmCancel=false,working=false,pollTimer,deadlineTimer,pollAttempts=0,generation=0,reasonDraft='',uncertainCancel=false,refused=new Set();
  async function call(action,extra={}){const response=await fetch(`/api/manage/${hostId}/${id}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action,token,...extra})});const result=await response.json();if(!response.ok)throw Object.assign(Error(result.error),{status:response.status,code:result.code});return result.booking;}
  async function refreshView(){if(working||confirmCancel)return;const current=++generation;let value;try{value=await call('view');}catch(error){if(current!==generation)return;throw error;}if(current!==generation)return;booking=value;message='';render();}
  function scheduleRefresh(){clearTimeout(pollTimer);if(pollAttempts>=6||working||confirmCancel||document.hidden||!(['pending','cancelling','awaiting_approval'].includes(booking?.status)||booking?.status==='confirmed'&&booking?.conferenceStatus==='pending'))return;pollTimer=setTimeout(async()=>{if(document.hidden)return;pollAttempts++;try{await refreshView();}catch{message='Status could not refresh. Your booking has been kept.';render();}},10000);}
  function scheduleDeadline(state){clearTimeout(deadlineTimer);if(state.nextDeadline===null)return;deadlineTimer=setTimeout(()=>{if(working)return;if(confirmCancel&&patchConfirm())return;const focused=document.activeElement?.id;render();if(focused)document.getElementById(focused)?.focus();},Math.min(MAX_TIMER,Math.max(0,state.nextDeadline-Date.now())+50));}
  function captureReason(){const field=document.querySelector('#cancel-reason');if(field)reasonDraft=field.value;}
  const zoneOf=()=>booking.timeZone||Intl.DateTimeFormat().resolvedOptions().timeZone;
  function currentState(){
    const state=manageChangeState(booking);
    // The Worker refused a change this page still thought open (clock skew or a late cutoff): trust the server.
    for(const kind of refused){state[kind]=false;if(!state.closed.includes(kind)&&state.policy?.[kind==='cancel'?'cancelUntil':'rescheduleUntil']!=null&&booking.status==='confirmed')state.closed.push(kind);}
    return state;
  }
  // Deadlines only for actions still open; each closed action is described on its own, never as a blanket closure.
  function noteHtml(state){if(booking.status!=='confirmed'||!(booking.end>Date.now())||!state.policy)return '';const p={...state.policy,cancelUntil:state.closed.includes('cancel')?null:state.policy.cancelUntil,rescheduleUntil:state.closed.includes('reschedule')?null:state.policy.rescheduleUntil};return changeNoteMarkup(p,zoneOf()).replace('class="change-note"','class="change-note manage-change-note"');}
  const closedHtml=state=>state.closed.length?`<p class="change-closed" data-change-closed>${esc(closedText(state,zoneOf()))}</p>`:'';
  /** Applies a closed cutoff to the open confirmation without replacing the reason field (text, caret and focus survive). */
  function patchConfirm(){
    const form=document.querySelector('#cancel-form');if(!form)return false;const state=currentState(),section=form.closest('.success');
    const swap=(selector,html,anchor)=>{const node=section.querySelector(selector);if(node)node.outerHTML=html||'';else if(html)anchor.insertAdjacentHTML('afterend',html);};
    swap('[data-change-closed]',closedHtml(state),section.querySelector('#cancel-form+.row')||form);
    swap('.manage-change-note',noteHtml(state),section.querySelector('.guest-saved-intake'));
    if(!state.cancel||uncertainCancel){if(!state.cancel)form.querySelector('#cancel')?.remove();const terminal=booking.status==='cancelled';if(terminal)section.querySelector('h1').textContent='Booking cancelled';form.querySelector('strong').textContent=terminal?'Booking cancelled.':uncertainCancel?'Cancellation not confirmed.':'Not cancelled.';form.querySelector('.cancel-reason-label .optional').textContent=uncertainCancel?'(confirmation pending)':'(not sent)';const keep=form.querySelector('#keep');keep.textContent=uncertainCancel?'Check booking':'Done';keep.className='secondary';}
    scheduleDeadline(state);return true;
  }
  function setBusy(on){const form=document.querySelector('#cancel-form');if(!form)return;const field=form.querySelector('#cancel-reason'),button=form.querySelector('#cancel');field.readOnly=on;form.setAttribute('aria-busy',String(on));form.querySelectorAll('button').forEach(b=>b.disabled=on);if(button)button.textContent=on?'Cancelling…':['pending','awaiting_approval'].includes(booking.status)?'Yes, withdraw':'Yes, cancel';}
  function render(){
    const date=ms=>new Date(ms).toLocaleString([], {dateStyle:'full',timeStyle:'short',timeZone:booking.timeZone||undefined});
    const state=currentState();
    // A cutoff passing mid-confirmation keeps the form and the typed reason, without a cancel button.
    const blocked=confirmCancel&&!state.cancel;
    const withdraw=['pending','awaiting_approval'].includes(booking.status);
    const actions=state.cancel||state.reschedule?`<div class="row" style="margin-top:24px">${confirmCancel?'':`${state.reschedule?`<a class="secondary" href="/b/${hostId}/${encodeURIComponent(booking.meetingTypeSlug)}?reschedule=${id}#${encodeURIComponent(token)}">Change time</a>`:''}${state.cancel?`<button class="text-button" id="ask-cancel">${withdraw?'Withdraw request':'Cancel booking'}</button>`:''}`}</div>`:'';
    const confirm=confirmCancel?`<form class="cancel-confirm" id="cancel-form"><p><strong>${blocked?'Not cancelled.':withdraw?'Withdraw this request?':'Cancel this booking?'}</strong></p><div><label for="cancel-reason" class="cancel-reason-label">Reason <span class="optional">(${blocked?'not sent':'optional'})</span></label><textarea id="cancel-reason" maxlength="${REASON_MAX}" ${working?'disabled':''}>${esc(reasonDraft)}</textarea></div><div class="row">${blocked?'':`<button class="primary" id="cancel" ${working?'disabled':''}>${working?'Cancelling…':withdraw?'Yes, withdraw':'Yes, cancel'}</button>`}<button type="button" class="${blocked?'secondary':'text-button'}" id="keep" ${working?'disabled':''}>${blocked?'Done':withdraw?'Keep request':'Keep booking'}</button></div></form>`:'';
    const note=noteHtml(state),closed=closedHtml(state);
    root.innerHTML=`<main class="guest-stage"><section class="success"><h1>${booking.status==='cancelled'?'Booking cancelled':esc(booking.title)}</h1><div class="slot-summary"><strong>${esc(date(booking.start))}</strong><small>${esc(booking.timeZone)}</small><p>${esc(booking.location)}</p></div>${approvalNotice(booking)}${booking.status==='confirmed'?conferenceMarkup(booking):''}${booking.calendarSyncStatus==='pending'?'<p class="muted" role="status">Calendar updates are delayed. These are the last saved details.</p>':booking.calendarChange==='updated'?'<p class="muted">Updated in Google Calendar</p>':booking.calendarChange==='cancelled'?'<p class="muted">Cancelled in Google Calendar</p>':''}<p>${esc(booking.name)} · ${esc(booking.email)}</p><dl class="booking-detail-list guest-saved-intake">${savedIntakeMarkup(booking)}</dl>${booking.cancellationReason?`<p class="cancel-reason-readback" data-cancel-reason-readback>Reason: ${esc(booking.cancellationReason)}</p>`:''}${note}<p role="status" id="manage-status" style="margin-top:16px">${esc(message||({pending:'Confirming your booking…',cancelling:'Cancelling your booking…',failed:'This time could not be booked. Please choose another.'}[booking.status]||''))}</p>${confirm}${actions}${closed}${['rejected','expired','failed'].includes(booking.status)?`<a class="secondary" href="/b/${hostId}/${encodeURIComponent(booking.meetingTypeSlug)}">Choose another time</a>`:''}${(['pending','cancelling','awaiting_approval'].includes(booking.status)||booking.status==='confirmed'&&booking.conferenceStatus==='pending')?'<button class="secondary" id="refresh" style="margin-top:20px">Refresh status</button>':''}</section></main>`;
    const ask=document.querySelector('#ask-cancel');if(ask)ask.onclick=()=>{if(!manageChangeState(booking).cancel){render();return;}generation++;clearTimeout(pollTimer);confirmCancel=true;render();document.querySelector('#cancel-reason').focus();};
    const keep=document.querySelector('#keep');if(keep)keep.onclick=async()=>{captureReason();if(uncertainCancel){if(working)return;working=true;setBusy(true);keep.textContent='Checking…';try{booking=await call('view');uncertainCancel=false;confirmCancel=false;message='';render();const heading=root.querySelector('h1');if(heading){heading.tabIndex=-1;heading.focus();}}catch(err){message=err.message;const status=document.querySelector('#manage-status');if(status)status.textContent=message;setBusy(false);document.querySelector('#cancel-reason')?.focus();}finally{working=false;if(confirmCancel)patchConfirm();scheduleRefresh();}return;}confirmCancel=false;render();(document.querySelector('#ask-cancel')||document.querySelector('.success a.secondary')||document.querySelector('.success h1'))?.focus();};
    const field=document.querySelector('#cancel-reason');if(field)field.oninput=()=>{reasonDraft=field.value;};
    const form=document.querySelector('#cancel-form');if(form)form.onsubmit=async e=>{e.preventDefault();if(working)return;captureReason();
      // Re-check locally; the Worker's final check stays authoritative.
      if(!currentState().cancel){patchConfirm();document.querySelector('#keep')?.focus();return;}
      const reason=cleanReason(reasonDraft);working=true;generation++;clearTimeout(pollTimer);setBusy(true);
      const say=text=>{message=text;const status=document.querySelector('#manage-status');if(status)status.textContent=text;};
      try{booking=await call('cancel',reason?{reason}:{});uncertainCancel=false;message='';confirmCancel=false;reasonDraft='';working=false;render();}
      catch(err){working=false;setBusy(false);
        // Late refusal: the reason field stays in place with its text, caret and focus; only the affected controls change.
        if(isChangeWindowClosed(err)){uncertainCancel=false;refused.add('cancel');try{booking=await call('view');}catch{}say(currentState().closed.includes('cancel')?'':err.message);patchConfirm();const field=document.querySelector('#cancel-reason');if(document.activeElement!==field)field?.focus();}
        else{uncertainCancel=true;say(err.message);document.querySelector('#cancel')?.focus();}
      }finally{working=false;if(confirmCancel){const focused=document.activeElement;patchConfirm();if(focused&&!focused.isConnected)document.querySelector('#cancel-reason')?.focus();}scheduleRefresh();}};
    const refresh=document.querySelector('#refresh');if(refresh)refresh.onclick=async()=>{try{await refreshView();}catch(e){message=e.message;render();}};
    scheduleDeadline(state);scheduleRefresh();
  }
  document.addEventListener('visibilitychange',()=>{if(!document.hidden){scheduleRefresh();if(booking&&!working&&!confirmCancel)render();}});
  try{booking=await call('view');render();}catch(e){root.innerHTML=`<main class="sign-in-card"><h1>Booking link unavailable</h1><p>${esc(e.message)}</p></main>`;}
}
