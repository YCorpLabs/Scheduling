// Owner-only operational status for one hosted scheduling ledger.
//
// Every value here is an aggregate, a bounded reference list, or a fixed code.
// Never add guest names/emails/answers, management tokens or token recovery,
// OAuth material, encrypted payloads, provider responses or raw error text.
const MIN=60000;
export const OPERATIONS_LIST_LIMIT=20;
export const OPERATIONS_JOB_SCAN_LIMIT=500;
export const OPERATIONS_THRESHOLDS=Object.freeze({
  pendingMs:10*MIN,
  cancellingMs:10*MIN,
  retryingMs:60*MIN,
  syncOverdueMs:60*MIN,
  // The cron watchdog runs every five minutes for 20 hosts per tick.
  maintenanceMs:20*MIN
});
// Outcomes are the operator's assertion after reviewing provider activity. They
// are recorded as such and are never evidence that a provider delivered mail.
export const DELIVERY_RESOLUTIONS=Object.freeze({delivered:'operator_asserted_delivered',not_delivered:'operator_asserted_not_sent',release:'operator_released_after_restore'});
const issueText={
  pending_stale:['warning','Bookings have waited longer than expected for calendar confirmation.','Check calendar authorization, then run repair. Guests keep their hold while pending.'],
  cancelling_stale:['warning','Cancellations have not yet been removed from the calendar.','Check calendar authorization, then run repair. Do not delete the event by hand unless the runbook says so.'],
  calendar_authorization:['critical','A calendar connection needs to be reconnected.','Reconnect the Google calendar in Settings, then run repair.'],
  booking_failed:['info','Bookings failed calendar synchronization recently.','Open each listed booking; the guest may need a new time.'],
  confirmed_sync_overdue:['warning','Confirmed bookings have not been re-checked against the calendar on schedule.','Check calendar authorization and provider status; reminders for these bookings stay paused.'],
  delivery_review:['critical','Emails are parked because their delivery outcome could not be confirmed.','Reconcile each parked email with provider activity before resolving it. Never resend under a new key.'],
  delivery_retrying:['warning','Emails have been retrying for longer than an hour.','Check email provider status and sender configuration.'],
  alarm_missing:['critical','Outstanding work has no scheduled maintenance alarm.','Run repair. If it recurs, follow the watchdog section of the operations runbook.'],
  maintenance_stale:['warning','Maintenance has not completed recently while work is outstanding.','Run repair and check Worker logs for booking_maintenance_failed.'],
  restore_quarantine:['critical','Emails were quarantined after a storage restore.','For each email, check provider activity since the restore point, then resolve it or release an unattempted one.'],
  maintenance_interrupted:['warning','The last maintenance run started but never recorded completion.','Run repair. Repeated interruptions usually mean a provider call is hanging; check Worker logs.'],
  delivery_overdue:['warning','Emails are overdue and have not been attempted.','Check sender configuration and TOKEN_ENCRYPTION_KEY; a key mismatch prevents preparing messages.'],
  maintenance_failed:['critical','The most recent maintenance run failed.','Check Worker logs for booking_maintenance_failed and run repair.'],
  outbound_paused:['warning','Calendar changes, email sends and guest booking changes are paused for maintenance.','Finish the maintenance or restore procedure, reconcile provider activity, then resume from the operations runbook.'],
  restore_detected:['critical','Host storage is older than its maintenance fence, so a restore or rollback happened.','Queued emails were quarantined and outbound work stays paused. Follow \'After any restore\' in the operations runbook.'],
  integration_delivery_failed:['warning','Integration deliveries need attention.','Open Integrations to review failed deliveries.'],
  integration_restore_quarantine:['critical','Integration deliveries were quarantined after a restore.','Discard restored integration deliveries before resuming.'],
  integration_delivery_overdue:['warning','Integration deliveries are overdue.','Check the destination and delivery history in Integrations.'],
  job_scan_truncated:['info','Only part of the email queue was classified.','Counts by status are partial; parked totals remain exact.']
};
function issue(code,count){const [severity,message,action]=issueText[code];return {code,severity,count,message,action};}
const age=(now,at)=>Number.isFinite(at)?Math.max(0,now-at):null;

const SINCE="COALESCE(json_extract(body,'$.statusChangedAt'),json_extract(body,'$.createdAt'))";
const AUTH_ERROR="json_extract(body,'$.lastError')='Calendar authorization needs attention.'";
// Aggregates run inside SQLite; JavaScript only ever sees bounded samples.
function bookingPhase(ledger,status,now,threshold){
  const cutoff=now-threshold;
  const a=ledger.rows(`SELECT COUNT(*) AS n,MIN(${SINCE}) AS oldest,
      COALESCE(SUM(json_extract(body,'$.statusChangedAt') IS NULL),0) AS estimated,
      COALESCE(SUM(COALESCE(json_extract(body,'$.leaseUntil'),0)>?),0) AS inFlight,
      COALESCE(SUM(${SINCE}<?),0) AS stale,COALESCE(SUM(${AUTH_ERROR}),0) AS authorization
    FROM live_bookings WHERE status=?`,now,cutoff,status)[0];
  const stale=a.stale?ledger.rows(`SELECT id FROM live_bookings WHERE status=? AND ${SINCE}<? ORDER BY ${SINCE},id LIMIT ?`,status,cutoff,OPERATIONS_LIST_LIMIT):[];
  return {summary:{count:a.n,oldestAgeMs:a.n?age(now,a.oldest):null,
    // Records written before transition timestamps use their creation time.
    ageEstimated:a.estimated>0,inFlight:a.inFlight,stale:a.stale,authorization:a.authorization},stale};
}
function maintenanceRun(meta,now){
  if(!meta)return null;
  // A run marked running whose start is older than the threshold was evicted,
  // crashed or exceeded its budget; it is never reported as a completed run.
  const state=meta.running?(now-meta.startedAt>OPERATIONS_THRESHOLDS.maintenanceMs?'interrupted':'running'):meta.ok===false?'failed':'completed';
  return {state,startedAt:meta.startedAt??null,
    ...(state==='completed'||state==='failed'?{finishedAt:meta.finishedAt??null,durationMs:meta.durationMs??null}:{}),
    ...(state==='failed'?{code:meta.code}:{}),
    ...(meta.running&&meta.previous?{previous:{state:meta.previous.ok===false?'failed':'completed',finishedAt:meta.previous.finishedAt??null}}:{})};
}

export async function operationalStatus(ledger,{now=Date.now(),alarm=null,bookmark=null,fence=null}={}){
  const t=OPERATIONS_THRESHOLDS,issues=[],attention=[];let attentionTruncated=false;
  const note=(rows,status,code,total)=>{for(const r of rows){if(attention.length>=OPERATIONS_LIST_LIMIT){attentionTruncated=true;return;}attention.push({bookingId:r.id,status,code});}if(total>rows.length)attentionTruncated=true;};
  const pending=bookingPhase(ledger,'pending',now,t.pendingMs),cancelling=bookingPhase(ledger,'cancelling',now,t.cancellingMs);
  note(pending.stale,'pending','pending_stale',pending.summary.stale);
  note(cancelling.stale,'cancelling','cancelling_stale',cancelling.summary.stale);
  if(pending.summary.stale)issues.push(issue('pending_stale',pending.summary.stale));
  if(cancelling.summary.stale)issues.push(issue('cancelling_stale',cancelling.summary.stale));
  const awaitingApproval=ledger.rows("SELECT COUNT(*) AS n FROM live_bookings WHERE status='awaiting_approval'")[0].n;

  const failedSince=now-7*86400000;
  const failed=ledger.rows(`SELECT COUNT(*) AS n,COALESCE(SUM(${AUTH_ERROR}),0) AS authorization FROM live_bookings WHERE status='failed' AND end>=?`,failedSince)[0];
  if(failed.n){note(ledger.rows(`SELECT id FROM live_bookings WHERE status='failed' AND end>=? ORDER BY ${SINCE} DESC,id LIMIT ?`,failedSince,OPERATIONS_LIST_LIMIT),'failed','booking_failed',failed.n);issues.push(issue('booking_failed',failed.n));}

  const confirmedWhere="status='confirmed' AND json_extract(body,'$.replacementKey') IS NULL AND end>=?",syncAfter="COALESCE(json_extract(body,'$.syncAfter'),0)",overdueCutoff=now-t.syncOverdueMs;
  const confirmed=ledger.rows(`SELECT COUNT(*) AS n,COALESCE(SUM(json_extract(body,'$.calendarSyncStatus')='pending'),0) AS pending,
      COALESCE(SUM(${syncAfter}>0 AND ${syncAfter}<?),0) AS overdue,MIN(CASE WHEN ${syncAfter}>0 AND ${syncAfter}<? THEN ${syncAfter} END) AS oldestOverdue,
      COALESCE(SUM(${AUTH_ERROR}),0) AS authorization FROM live_bookings WHERE ${confirmedWhere}`,overdueCutoff,overdueCutoff,now)[0];
  if(confirmed.overdue){note(ledger.rows(`SELECT id FROM live_bookings WHERE ${confirmedWhere} AND ${syncAfter}>0 AND ${syncAfter}<? ORDER BY ${syncAfter},id LIMIT ?`,now,overdueCutoff,OPERATIONS_LIST_LIMIT),'confirmed','confirmed_sync_overdue',confirmed.overdue);issues.push(issue('confirmed_sync_overdue',confirmed.overdue));}
  const authorizationBookings=pending.summary.authorization+cancelling.summary.authorization+confirmed.authorization;

  // Accounts are bounded by the owner's connected Google calendars.
  const accounts=ledger.accounts();
  const accountSummary={connected:accounts.filter(a=>a.connected).length,disconnected:accounts.filter(a=>!a.connected).length,coolingDown:accounts.filter(a=>a.syncCooldownUntil>now).length,reconnectNeeded:accounts.filter(a=>a.connected&&a.reconnectRequired).length};
  if(authorizationBookings||accountSummary.reconnectNeeded||accountSummary.disconnected&&(pending.summary.count||cancelling.summary.count))issues.push(issue('calendar_authorization',authorizationBookings||accountSummary.reconnectNeeded||accountSummary.disconnected));

  const jobTotal=ledger.rows('SELECT COUNT(*) AS n FROM live_jobs')[0].n;
  const parkedTotal=ledger.rows("SELECT COUNT(*) AS n FROM live_jobs WHERE json_extract(body,'$.requiresAttention')=1")[0].n;
  // Parked jobs first so the review list is complete even when the scan is truncated.
  const jobs=ledger.rows(`SELECT body FROM live_jobs ORDER BY COALESCE(json_extract(body,'$.requiresAttention'),0) DESC,due,id LIMIT ?`,OPERATIONS_JOB_SCAN_LIMIT).map(r=>JSON.parse(r.body));
  const byStatus={scheduled:0,sending:0,retrying:0,waiting_for_calendar:0,needs_review:0,cancelled:0,skipped:0},review=[],bookings=new Map();
  let longRetry=0,overdueSends=0,oldestOverdue=null,oldestReview=null,maxAttempts=0;
  for(const j of jobs){
    if(!bookings.has(j.bookingId))bookings.set(j.bookingId,ledger.booking(j.bookingId));
    const b=bookings.get(j.bookingId),status=ledger.notificationStatus(j,b);
    byStatus[status]=(byStatus[status]??0)+1;maxAttempts=Math.max(maxAttempts,j.attempts||0);
    if(status==='retrying'&&age(now,j.firstAttemptAt)>t.retryingMs)longRetry++;
    if(['scheduled','retrying'].includes(status)){const due=ledger.notificationDue(j,b);if(Number.isFinite(due)&&due<now){oldestOverdue=Math.max(oldestOverdue??0,now-due);if(now-due>t.retryingMs/2)overdueSends++;}}
    if(status==='needs_review'){
      oldestReview=Math.max(oldestReview??0,age(now,j.firstAttemptAt??j.updatedAt)??0);
      if(review.length<OPERATIONS_LIST_LIMIT){
        const view=ledger.notificationView(j,b,status);
        review.push({jobId:j.id,bookingId:j.bookingId,kind:view?.kind??'unknown',recipientRole:view?.recipientRole??null,reason:view?.reason??'delivery_unknown',
          provider:['cloudflare','resend'].includes(j.provider)?j.provider:null,attempts:j.attempts||0,firstAttemptAt:j.firstAttemptAt??null,updatedAt:j.updatedAt??null,
          bookingStatus:b?.status??'removed',releasable:j.restoreQuarantine===true&&!j.firstAttemptAt&&!j.deliveryInFlight,resolvable:!(j.leaseUntil>now)&&Number.isSafeInteger(j.updatedAt)});
      }
    }
  }
  const reviewCount=Math.max(byStatus.needs_review,parkedTotal);
  if(reviewCount)issues.push(issue('delivery_review',reviewCount));
  const quarantined=ledger.rows("SELECT COUNT(*) AS n FROM live_jobs WHERE json_extract(body,'$.restoreQuarantine')=1")[0].n;
  if(quarantined)issues.push(issue('restore_quarantine',quarantined));
  if(longRetry)issues.push(issue('delivery_retrying',longRetry));
  if(overdueSends)issues.push(issue('delivery_overdue',overdueSends));
  if(jobTotal>jobs.length)issues.push(issue('job_scan_truncated',jobTotal-jobs.length));

  const lastAlarm=maintenanceRun(ledger.meta('operations:lastAlarm'),now),lastWatchdog=ledger.meta('operations:lastWatchdog');
  const recentMaintenance=Math.max(lastAlarm?.state==='completed'?lastAlarm.finishedAt??0:0,lastAlarm?.previous?.state==='completed'?lastAlarm.previous.finishedAt??0:0);
  const integrations=ledger.integrations?.healthSummary(now)||{queued:0,failed:0,quarantined:0,inFlight:0,overdue:0,oldestOverdueMs:null};
  if(integrations.failed)issues.push(issue('integration_delivery_failed',integrations.failed));
  if(integrations.quarantined)issues.push(issue('integration_restore_quarantine',integrations.quarantined));
  if(integrations.overdue)issues.push(issue('integration_delivery_overdue',integrations.overdue));
  const activeWork=pending.summary.count+cancelling.summary.count+(jobTotal-parkedTotal)+integrations.queued;
  const paused=fence?.frozen===true;
  if(paused)issues.push(issue('outbound_paused',1));
  if(paused&&fence.reason==='restore_detected')issues.push(issue('restore_detected',1));
  if(lastAlarm?.state==='failed')issues.push(issue('maintenance_failed',1));
  if(lastAlarm?.state==='interrupted')issues.push(issue('maintenance_interrupted',1));
  // Confirmed bookings and terminal retention also keep alarms, but missing
  // alarms matter most for work that changes calendar or email state.
  // A frozen host intentionally runs no maintenance and holds no alarm.
  if(paused){}
  else if(alarm==null&&activeWork>0&&lastAlarm?.state!=='running'&&now-recentMaintenance>2*MIN)issues.push(issue('alarm_missing',1));
  else if(activeWork+confirmed.n>0&&recentMaintenance&&now-recentMaintenance>t.maintenanceMs)issues.push(issue('maintenance_stale',1));

  const rank={critical:0,warning:1,info:2};issues.sort((a,b)=>rank[a.severity]-rank[b.severity]||a.code.localeCompare(b.code));
  return {
    schemaVersion:1,generatedAt:now,healthy:!issues.some(i=>i.severity!=='info'),thresholds:t,issues,
    bookings:{awaitingApproval,pending:pending.summary,cancelling:cancelling.summary,failedLast7Days:{count:failed.n,authorization:failed.authorization}},
    calendarSync:{tracked:confirmed.n,pending:confirmed.pending,overdue:confirmed.overdue,oldestOverdueMs:confirmed.overdue?now-confirmed.oldestOverdue:null,authorization:authorizationBookings},
    accounts:accountSummary,integrations,
    deliveries:{queued:jobTotal,scanned:jobs.length,truncated:jobTotal>jobs.length,byStatus,maxAttempts,oldestOverdueMs:oldestOverdue,
      review:{count:reviewCount,oldestAgeMs:oldestReview,items:review,truncated:reviewCount>review.length}},
    // Maintenance fence: no calendar writes, email sends or guest changes while frozen.
    outbound:fence?{frozen:fence.frozen,epoch:fence.epoch,reason:fence.reason,changedAt:fence.changedAt,inFlight:fence.inFlight,lastRestoreDetected:fence.lastRestoreDetected??null}:null,
    maintenance:{nextAlarmAt:alarm,lastAlarm,lastRestoreQuarantine:ledger.meta('operations:lastRestoreQuarantine'),lastWatchdogAt:lastWatchdog?.at??null,lastRepairAt:ledger.meta('operations:lastRepair')?.at??null},
    // Local workerd returns an all-zero placeholder; it is not a restore point.
    storage:{bookmark:typeof bookmark==='string'&&/[1-9a-f]/i.test(bookmark)?bookmark:null},
    attention,attentionTruncated
  };
}

// Records an operator's reconciliation outcome. It never re-sends, re-queues
// or edits the frozen payload: an undelivered message is followed up manually.
export function resolveParkedDelivery(ledger,data,now=Date.now()){
  const fail=(error,status=400)=>({error,status});
  if(!data||typeof data!=='object'||Object.keys(data).some(k=>!['jobId','outcome','expectedUpdatedAt'].includes(k)))return fail('Choose a parked email and its reconciled outcome.');
  const {jobId,outcome,expectedUpdatedAt}=data;
  if(typeof jobId!=='string'||jobId.length<1||jobId.length>200||!Object.hasOwn(DELIVERY_RESOLUTIONS,outcome)||!Number.isSafeInteger(expectedUpdatedAt))return fail('Choose a parked email and its reconciled outcome.');
  let result;
  ledger.ctx.storage.transactionSync(()=>{
    const row=ledger.rows('SELECT body FROM live_jobs WHERE id=?',jobId)[0];
    if(!row){result=fail('This email is no longer parked.',404);return;}
    const j=JSON.parse(row.body),b=ledger.booking(j.bookingId);
    if(ledger.notificationStatus(j,b)!=='needs_review'){result=fail('Only emails that need review can be resolved.',409);return;}
    if(j.leaseUntil>now){result=fail('This email is being processed. Refresh and try again.',409);return;}
    if((j.updatedAt??null)!==expectedUpdatedAt){result=fail('This email changed since it was reviewed. Refresh and review it again.',409);return;}
    if(outcome==='release'){
      // Only a restore-quarantined job never attempted in this restored state may
      // be released, and it keeps its original idempotency key and frozen payload.
      if(!j.restoreQuarantine||j.firstAttemptAt||j.deliveryInFlight){result=fail('Only unattempted emails quarantined after a restore can be released.',409);return;}
      for(const key of ['restoreQuarantine','requiresAttention','error'])delete j[key];
      j.updatedAt=now;j.releasedAfterRestoreAt=now;
      ledger.sql.exec('UPDATE live_jobs SET due=?,body=? WHERE id=?',now,JSON.stringify(j),j.id);
      result={ok:true,jobId:j.id,outcome,resolution:DELIVERY_RESOLUTIONS.release,evidence:'operator_assertion',kind:j.kind,provider:j.provider??null};return;
    }
    const delivered=outcome==='delivered',view=ledger.notificationView({...j,updatedAt:now},b,delivered?'sent':'cancelled');
    if(view){
      if(delivered)view.sentAt=j.firstAttemptAt??now;
      view.resolution=DELIVERY_RESOLUTIONS[outcome];view.resolutionEvidence='operator_assertion';view.resolvedAt=now;
      ledger.sql.exec('INSERT OR REPLACE INTO live_notification_receipts VALUES (?,?,?,?)',j.id,j.bookingId,now,JSON.stringify(view));
    }
    if(delivered&&j.kind==='follow_up'&&b)ledger.sql.exec("UPDATE live_bookings SET body=json_set(body,'$.followUpSentAt',?) WHERE id=?",j.firstAttemptAt??now,b.id);
    ledger.sql.exec('DELETE FROM live_jobs WHERE id=?',j.id);
    result={ok:true,jobId:j.id,outcome,resolution:DELIVERY_RESOLUTIONS[outcome],evidence:'operator_assertion',kind:view?.kind??'unknown',provider:j.provider??null};
  });
  if(result.ok){ledger.pruneNotificationReceipts();console.log(JSON.stringify({event:'booking_delivery_resolved',kind:result.kind,outcome,provider:['cloudflare','resend'].includes(result.provider)?result.provider:'unknown'}));delete result.provider;}
  return result;
}
