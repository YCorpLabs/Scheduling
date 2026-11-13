// Owner status view for GET /api/live/operations. The response holds only
// counts, ages, fixed codes and booking/job IDs; keep it that way here.
// Recording a parked email outcome never sends. Release after restore and
// freeze/resume stay runbook-only because they can change outbound behavior.
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const n=v=>Number.isSafeInteger(v)&&v>=0?v:0;
export const REPAIRABLE=new Set(['pending_stale','cancelling_stale','alarm_missing','maintenance_failed','maintenance_interrupted','maintenance_stale','confirmed_sync_overdue','calendar_authorization']);
const severityLabel={critical:'Critical',warning:'Warning',info:'Info'};
const kinds={confirmed:'Booking confirmation',cancelled:'Cancellation',reminder:'Meeting reminder',follow_up:'Follow-up',approval_requested_guest:'Request received',approval_requested_host:'New booking request',rejected:'Request declined',expired:'Request expired'};
const reasons={delivery_unknown:'Outcome unknown',timeout:'Provider timed out',configuration:'Email setup rejected it',superseded:'Booking changed after the attempt',expired_attempt:'Sending window passed',restored:'Quarantined after restore'};
const pauseReasons={operator:'Paused by you',restore_detected:'Restore detected',fence_mismatch:'Fence mismatch',fence_unavailable:'Fence unavailable'};
const attentionLabels={pending_stale:'Waiting for calendar',cancelling_stale:'Cancellation not synced',booking_failed:'Calendar sync failed',confirmed_sync_overdue:'Re-check overdue'};
const runLabels={completed:'Completed',failed:'Failed',running:'Running',interrupted:'Interrupted'};
export function formatAge(ms){if(!Number.isFinite(ms)||ms<0)return '';const m=Math.round(ms/60000);if(m<1)return 'under a minute';if(m<60)return m+' min';const h=Math.round(m/60);if(h<48)return h+' h';return Math.round(h/24)+' d';}
export function canRepair(status){return !!status&&status.outbound?.frozen!==true&&(status.issues||[]).some(i=>REPAIRABLE.has(i.code));}
export function attentionCount(status){return (status?.issues||[]).filter(i=>i.severity!=='info').length;}

export function operationsMarkup(status,{loading=false,error='',formatTime=ms=>new Date(ms).toLocaleString()}={}){
  if(!status)return `<p class="ops-empty" role="${error?'alert':'status'}">${esc(error||(loading?'Checking status…':'Status unavailable. Refresh to try again.'))}</p>`;
  const when=ms=>Number.isFinite(ms)?formatTime(ms):'Never';
  const issues=Array.isArray(status.issues)?status.issues:[],needs=attentionCount(status),b=status.bookings||{},sync=status.calendarSync||{},acc=status.accounts||{},del=status.deliveries||{},review=del.review||{},items=Array.isArray(review.items)?review.items:[],attention=Array.isArray(status.attention)?status.attention:[],out=status.outbound,m=status.maintenance||{};
  const summary=`<div class="ops-summary ${needs?'ops-attention':'ops-clear'}"><span class="ops-dot" aria-hidden="true"></span><div><strong>${needs?`${needs} ${needs===1?'issue needs':'issues need'} attention`:'Nothing needs attention'}</strong><small>Checked ${esc(when(status.generatedAt))}</small></div>${canRepair(status)?`<button class="secondary compact-button" id="ops-repair" ${loading?'disabled':''}>Run maintenance</button>`:''}</div>`;
  const inflight=n(out?.inFlight?.calendar)+n(out?.inFlight?.deliveries)+n(out?.inFlight?.integrations);
  const paused=out?.frozen?`<div class="ops-paused" role="status"><strong>Paused for maintenance</strong><p>Guests cannot book, change or cancel. Calendar changes and emails are held.</p><small>${esc(pauseReasons[out.reason]||'Paused')}${Number.isFinite(out.changedAt)?` · since ${esc(when(out.changedAt))}`:''}${inflight?` · ${inflight} provider ${inflight===1?'call':'calls'} in flight`:''}</small></div>`:'';
  const issueList=issues.length?`<ul class="ops-issues" aria-label="Issues">${issues.map(i=>`<li class="ops-issue sev-${esc(i.severity)}"><span class="ops-severity">${esc(severityLabel[i.severity]||'Info')}</span><div><strong>${esc(i.message)}</strong><p>${esc(i.action)}</p></div><span class="ops-count" aria-label="${n(i.count)} affected">${n(i.count)}</span></li>`).join('')}</ul>`:'';
  const card=(label,value,detail='')=>`<article class="ops-card"><h3>${label}</h3><strong>${value}</strong>${detail?`<p>${detail}</p>`:''}</article>`;
  const age=ms=>ms==null?'':`Oldest ${esc(formatAge(ms))}`;
  const cards=`<div class="ops-cards">${card('Requests to approve',n(b.awaitingApproval))}${card('Confirming',n(b.pending?.count),age(b.pending?.oldestAgeMs))}${card('Cancelling',n(b.cancelling?.count),age(b.cancelling?.oldestAgeMs))}${card('Failed, last 7 days',n(b.failedLast7Days?.count))}${card('Calendar re-checks',`${n(sync.overdue)}<span>/${n(sync.tracked)}</span>`,'Overdue of upcoming')}${card('Calendars',`${n(acc.connected)}<span> connected</span>`,n(acc.disconnected)?`${n(acc.disconnected)} disconnected`:n(acc.coolingDown)?`${n(acc.coolingDown)} cooling down`:'')}${card('Emails queued',n(del.queued),del.truncated?'Counts are partial':'')}${card('Emails to review',n(review.count),age(review.oldestAgeMs))}</div>`;
  const reviewPanel=items.length?`<section class="ops-panel" aria-labelledby="ops-review-title"><h2 id="ops-review-title">Emails to review</h2><p class="ops-caption">Check provider activity, then record what happened. Nothing is resent.</p><ul class="ops-list">${items.map((it,i)=>`<li><div><strong>${esc(kinds[it.kind]||'Booking email')}</strong><small>${it.recipientRole==='host'?'To you':'To the person who booked'} · ${esc(reasons[it.reason]||'Outcome unknown')}${it.provider?` · ${esc(it.provider==='cloudflare'?'Cloudflare':'Resend')}`:''}</small><small>${Number.isFinite(it.firstAttemptAt)?`First attempt ${esc(when(it.firstAttemptAt))}`:'Not attempted'} · ${n(it.attempts)} ${n(it.attempts)===1?'attempt':'attempts'}</small></div><div class="row"><button class="quiet-button" data-ops-booking="${esc(it.bookingId)}">Open booking</button><button class="secondary compact-button" data-ops-resolve="${i}" ${it.resolvable?'':'disabled'}>${it.resolvable?'Record outcome':'Processing'}</button></div></li>`).join('')}</ul>${review.truncated?`<p class="ops-caption">Showing ${items.length} of ${n(review.count)}.</p>`:''}</section>`:'';
  const attentionPanel=attention.length?`<section class="ops-panel" aria-labelledby="ops-attention-title"><h2 id="ops-attention-title">Bookings to check</h2><ul class="ops-list">${attention.map(a=>`<li><div><strong>${esc(attentionLabels[a.code]||'Needs attention')}</strong></div><button class="quiet-button" data-ops-booking="${esc(a.bookingId)}">Open booking</button></li>`).join('')}</ul>${status.attentionTruncated?'<p class="ops-caption">More bookings need attention than shown.</p>':''}</section>`:'';
  const run=m.lastAlarm;
  const maint=`<details class="ops-panel ops-maintenance"><summary>Maintenance</summary><dl class="ops-facts"><dt>Last run</dt><dd>${run?`${esc(runLabels[run.state]||run.state)} · ${esc(when(run.finishedAt??run.startedAt))}`:'Never'}</dd><dt>Next run</dt><dd>${out?.frozen?'Paused':esc(Number.isFinite(m.nextAlarmAt)?when(m.nextAlarmAt):'Not scheduled')}</dd><dt>Watchdog</dt><dd>${esc(when(m.lastWatchdogAt))}</dd><dt>Manual run</dt><dd>${esc(when(m.lastRepairAt))}</dd></dl></details>`;
  return `<section class="ops-workspace" aria-label="Service status">${error?`<p class="error" role="alert">${esc(error)}</p>`:''}${summary}${paused}${issueList}${cards}${reviewPanel}${attentionPanel}${maint}</section>`;
}

// Records an operator assertion for one parked email. The server re-checks the
// job is still parked, unleased and unchanged (expectedUpdatedAt).
export function showResolveDialog(item,{api,formatTime,trigger,onDone}){
  const dialog=document.createElement('dialog');dialog.className='unsaved-dialog ops-dialog';dialog.setAttribute('aria-labelledby','ops-resolve-title');
  const first=Number.isFinite(item.firstAttemptAt)?formatTime(item.firstAttemptAt):'unknown time';
  dialog.innerHTML=`<form method="dialog"><h2 id="ops-resolve-title">Record email outcome</h2><p>${esc(kinds[item.kind]||'Booking email')} · first attempt ${esc(first)}${item.provider?` · ${esc(item.provider==='cloudflare'?'Cloudflare':'Resend')}`:''}</p><fieldset class="ops-choices"><legend class="sr-only">Outcome</legend><label><input type="radio" name="outcome" value="delivered"><span><strong>Provider accepted it</strong><small>Marks it delivered.</small></span></label><label><input type="radio" name="outcome" value="not_delivered"><span><strong>No provider record</strong><small>Marks it not sent. Contact the guest yourself if needed.</small></span></label></fieldset><label class="ops-confirm"><input type="checkbox" name="checked"><span>I checked provider activity for this send.</span></label><p class="error" role="alert"></p><div class="row"><button type="button" class="secondary" data-keep>Cancel</button><button class="primary" data-submit disabled>Record outcome</button></div></form>`;
  document.body.append(dialog);let working=false;
  const form=dialog.querySelector('form'),submit=dialog.querySelector('[data-submit]'),alert=dialog.querySelector('[role=alert]');
  const sync=()=>{submit.disabled=working||!form.outcome.value||!form.checked.checked;};
  form.addEventListener('change',sync);
  dialog.addEventListener('cancel',e=>{if(working)e.preventDefault();});
  dialog.addEventListener('close',()=>{dialog.remove();if(trigger?.isConnected)trigger.focus();});
  dialog.querySelector('[data-keep]').onclick=()=>{if(!working)dialog.close();};
  form.onsubmit=async e=>{e.preventDefault();if(working||submit.disabled)return;working=true;sync();submit.textContent='Recording…';alert.textContent='';
    try{await api('operations/deliveries/resolve',{jobId:item.jobId,outcome:form.outcome.value,expectedUpdatedAt:item.updatedAt});working=false;dialog.close();await onDone?.(form.outcome.value==='delivered'?'Marked delivered':'Marked not sent');}
    catch(err){working=false;submit.textContent='Record outcome';alert.textContent=err.message||'Could not record the outcome.';
      // A changed, leased or removed job must be reviewed again from fresh status.
      if(err.status===409||err.status===404){form.querySelectorAll('input').forEach(i=>i.disabled=true);submit.hidden=true;dialog.querySelector('[data-keep]').textContent='Close';await onDone?.(null);}else sync();}
  };
  dialog.showModal();dialog.querySelector('input[name=outcome]').focus();
  return dialog;
}
