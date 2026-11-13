import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync,backup} from 'node:sqlite';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {BookingLedger} from '../src/ledger.js';
import {OPERATIONS_LIST_LIMIT,OPERATIONS_THRESHOLDS} from '../src/operations.js';
import {DEFAULT} from '../public/policy.js';
import {intakeRevision} from '../public/intake.js';

const KEY=Buffer.alloc(32,7).toString('base64');
const config={...DEFAULT,zone:'UTC',notice:0,horizon:5,startHour:0,endHour:24,days:[0,1,2,3,4,5,6],buffer:0,reminder:false};
const GUEST={name:'Private Guest Name',email:'private.guest@example.test'};
function storageFor(db){
  const state={alarm:null};
  return {state,storage:{
    sql:{exec(query,...args){const rows=db.prepare(query).all(...args);return {toArray:()=>rows};}},
    setAlarm:async at=>{state.alarm=at;},getAlarm:async()=>state.alarm,
    transactionSync(callback){db.exec('BEGIN');try{const result=callback();db.exec('COMMIT');return result;}catch(error){db.exec('ROLLBACK');throw error;}}
  }};
}
// External calendar state lives outside SQLite so restores cannot roll it back.
function calendar(){
  const events=new Map(),effects={created:0,deleted:0};
  return {events,effects,provider:{refreshTokens:async()=>({access_token:'access',expires_at:Date.now()+3600000}),listCalendars:async()=>[{id:'primary',accessRole:'owner'}],freeBusy:async()=>[],
    getEvent:async(_,{eventId})=>events.get(eventId)??null,
    createEvent:async(_,{eventId,event})=>{effects.created++;const result={...event,id:eventId,etag:'etag'};events.set(eventId,result);return result;},
    deleteEvent:async(_,{eventId})=>{effects.deleted++;events.delete(eventId);}}};
}
function ledgerFor(db,provider,{env={},notify=async()=>({id:'sent'})}={}){
  const {storage,state}=storageFor(db);
  const ledger=new BookingLedger({storage},{TOKEN_ENCRYPTION_KEY:KEY,PUBLIC_ORIGIN:'https://example.test',RESEND_API_KEY:'test',MAIL_FROM:'host@example.test',...env},{google:provider,sendNotification:notify});
  return {ledger,state};
}
async function setup(options={}){
  const db=new DatabaseSync(':memory:'),cal=calendar();const {ledger,state}=ledgerFor(db,cal.provider,options);
  ledger.init({id:'host',name:'Host',email:'owner@example.test'});
  await ledger.connect({accountId:'a',email:'host@example.test',tokens:{access_token:'access',refresh_token:'refresh-secret',expires_at:Date.now()+3600000}});
  await ledger.configureCalendars({accounts:[{id:'a',destinationCalendarId:'primary',conflictCalendarIds:['primary']}]});
  ledger.saveSettings({meetingTypes:[{...config,id:'intro',slug:'intro',published:true,accountId:'a',calendarId:'primary'}]});
  return {db,ledger,state,...cal};
}
let sequence=0;
async function book(ledger,offsetHours=0){
  // Whole-hour starts keep the 30-minute fixture inside a UTC day even near midnight.
  const start=Math.ceil((Date.now()+3600000)/3600000)*3600000+(offsetHours+(sequence++%40))*3600000;
  return ledger.reserve('intro',{start,...GUEST,idempotencyKey:'operations-key-'+String(sequence).padStart(6,'0'),intakeRevision:await intakeRevision(ledger.type('intro'))});
}
async function at(time,fn){const now=Date.now;Date.now=()=>time;try{return await fn();}finally{Date.now=now;}}
function assertPrivate(value,privateValues){
  const text=JSON.stringify(value);
  for(const secret of [GUEST.name,GUEST.email,'refresh-secret','tokenRecovery','payloadCiphertext','tokenHash','/manage/',...privateValues])assert.ok(!text.includes(secret),'status leaked '+secret);
}
const jobs=ledger=>ledger.rows('SELECT body FROM live_jobs').map(r=>JSON.parse(r.body));
function captureLogs(){
  const lines=[],saved={log:console.log,warn:console.warn,error:console.error};
  for(const level of Object.keys(saved))console[level]=(...args)=>lines.push(args.join(' '));
  return {lines,restore(){Object.assign(console,saved);}};
}

test('a healthy ledger reports bounded aggregate status without guest data',async()=>{
  const {ledger}=await setup(),booked=await book(ledger);await ledger.alarm();
  const status=await ledger.operationalStatus();
  assert.equal(status.schemaVersion,1);assert.equal(status.healthy,true,JSON.stringify(status.issues));
  assert.equal(status.calendarSync.tracked,1);assert.equal(status.accounts.connected,1);
  assert.equal(status.maintenance.lastAlarm.state,'completed');assert.equal(status.storage.bookmark,null);
  assertPrivate(status,[booked.managementToken]);
});

test('stale pending and cancelling bookings are aged from their transition and listed by reference only',async()=>{
  const {ledger,provider}=await setup();
  provider.createEvent=async()=>{throw Object.assign(Error('timeout'),{retryable:true});};
  const pending=await book(ledger);assert.equal(pending.booking.status,'pending');
  provider.createEvent=calendar().provider.createEvent;
  const later=Date.now()+OPERATIONS_THRESHOLDS.pendingMs+60000;
  const status=await at(later,()=>ledger.operationalStatus());
  assert.equal(status.bookings.pending.count,1);assert.equal(status.bookings.pending.stale,1);assert.equal(status.bookings.pending.ageEstimated,false);
  assert.ok(status.bookings.pending.oldestAgeMs>=OPERATIONS_THRESHOLDS.pendingMs);
  assert.deepEqual(status.attention,[{bookingId:pending.booking.id,status:'pending',code:'pending_stale'}]);
  assert.ok(status.issues.some(i=>i.code==='pending_stale'));assert.equal(status.healthy,false);
  assertPrivate(status,[pending.managementToken]);
  // A record from before transition timestamps falls back to creation time.
  const b=ledger.booking(pending.booking.id);delete b.statusChangedAt;ledger.sql.exec('UPDATE live_bookings SET body=? WHERE id=?',JSON.stringify(b),b.id);
  assert.equal((await at(later,()=>ledger.operationalStatus())).bookings.pending.ageEstimated,true);
});

test('cancellations blocked on calendar authorization surface as critical and keep the guest record private',async()=>{
  const {ledger,provider}=await setup(),booked=await book(ledger);
  provider.deleteEvent=async()=>{throw Object.assign(Error('denied'),{status:401,code:'authorization'});};
  provider.refreshTokens=async()=>{throw Object.assign(Error('invalid_grant'),{status:400,code:'invalid_grant',retryable:false});};
  ledger.putAccount({...ledger.account('a'),tokens:{...ledger.account('a').tokens,expires_at:0}});
  const cancelled=await ledger.cancel(booked.booking.id,booked.managementToken);assert.equal(cancelled.booking.status,'cancelling');
  const status=await at(Date.now()+OPERATIONS_THRESHOLDS.cancellingMs+60000,()=>ledger.operationalStatus());
  assert.equal(status.bookings.cancelling.count,1);assert.equal(status.bookings.cancelling.stale,1);
  assert.ok(status.attention.some(a=>a.code==='cancelling_stale'&&a.bookingId===booked.booking.id));
  assert.equal(status.calendarSync.authorization,1);assert.equal(status.issues[0].code,'calendar_authorization');assert.equal(status.issues[0].severity,'critical');
  assertPrivate(status,[booked.managementToken]);
});

test('attention samples are bounded while counts stay exact',async()=>{
  const {ledger}=await setup(),base=ledger.booking((await book(ledger)).booking.id),old=Date.now()-3600000;
  for(let i=0;i<OPERATIONS_LIST_LIMIT+15;i++)ledger.sql.exec('INSERT INTO live_bookings VALUES (?,?,?,?,?,?)','p'+i,'rk'+i,base.start,base.end,'pending',JSON.stringify({...base,id:'p'+i,requestKey:'rk'+i,status:'pending',statusChangedAt:old}));
  const status=await ledger.operationalStatus();
  assert.equal(status.bookings.pending.count,OPERATIONS_LIST_LIMIT+15);assert.equal(status.bookings.pending.stale,OPERATIONS_LIST_LIMIT+15);
  assert.equal(status.attention.length,OPERATIONS_LIST_LIMIT);assert.equal(status.attentionTruncated,true);
});

test('an unknown send parks for review, logs codes only and is never replayed by maintenance',async()=>{
  const sent=[],{ledger}=await setup({notify:async(_env,payload)=>{sent.push(payload);throw Object.assign(Error('provider body with private.guest@example.test'),{retryable:false,deliveryUnknown:true});}});
  const logs=captureLogs();let booked;
  try{booked=await book(ledger);await ledger.alarm();await ledger.alarm();}finally{logs.restore();}
  assert.equal(sent.length,1);
  const parkedLog=logs.lines.find(l=>l.includes('booking_delivery_parked'));assert.ok(parkedLog);
  assert.deepEqual(JSON.parse(parkedLog),{event:'booking_delivery_parked',kind:'confirmed',reason:'delivery_unknown',provider:'resend'});
  for(const line of logs.lines)assertPrivate(line,[booked.booking.id,booked.managementToken,'provider body']);
  const status=await ledger.operationalStatus();
  assert.equal(status.deliveries.review.count,1);assert.equal(status.deliveries.byStatus.needs_review,1);
  const [item]=status.deliveries.review.items;
  assert.equal(item.kind,'confirmed');assert.equal(item.reason,'delivery_unknown');assert.equal(item.provider,'resend');assert.equal(item.attempts,1);assert.equal(item.resolvable,true);
  assert.equal(status.issues[0].code,'delivery_review');assert.equal(status.issues[0].severity,'critical');
  assertPrivate(status,[booked.managementToken,'provider body']);
});

test('operator resolution is guarded, records an assertion, deletes the job and never sends',async()=>{
  const sent=[];let fail=true;
  const {ledger}=await setup({notify:async(_env,payload)=>{sent.push(payload);if(fail)throw Object.assign(Error('timeout'),{retryable:false,deliveryUnknown:true});return {id:'ok'};}});
  const booked=await book(ledger);await ledger.alarm();fail=false;
  const parked=jobs(ledger).find(j=>j.requiresAttention);assert.ok(parked);
  assert.equal(ledger.resolveParkedDelivery({jobId:parked.id,outcome:'resend'}).status,400);
  assert.equal(ledger.resolveParkedDelivery({jobId:parked.id,outcome:'delivered',expectedUpdatedAt:parked.updatedAt,payload:'x'}).status,400);
  assert.equal(ledger.resolveParkedDelivery({jobId:parked.id,outcome:'delivered',expectedUpdatedAt:parked.updatedAt-1}).status,409);
  assert.equal(ledger.resolveParkedDelivery({jobId:'missing:1:confirmed',outcome:'delivered',expectedUpdatedAt:1}).status,404);
  ledger.sql.exec('UPDATE live_jobs SET body=? WHERE id=?',JSON.stringify({...parked,leaseUntil:Date.now()+30000}),parked.id);
  assert.equal(ledger.resolveParkedDelivery({jobId:parked.id,outcome:'delivered',expectedUpdatedAt:parked.updatedAt}).status,409);
  ledger.sql.exec('UPDATE live_jobs SET body=? WHERE id=?',JSON.stringify(parked),parked.id);
  const logs=captureLogs();let resolved;
  try{resolved=ledger.resolveParkedDelivery({jobId:parked.id,outcome:'not_delivered',expectedUpdatedAt:parked.updatedAt});}finally{logs.restore();}
  assert.equal(resolved.ok,true);assert.equal(resolved.resolution,'operator_asserted_not_sent');assert.equal(resolved.evidence,'operator_assertion');
  assert.deepEqual(JSON.parse(logs.lines.find(l=>l.includes('booking_delivery_resolved'))),{event:'booking_delivery_resolved',kind:'confirmed',outcome:'not_delivered',provider:'resend'});
  assert.equal(jobs(ledger).some(j=>j.id===parked.id),false);
  const receipt=(await ledger.hostBooking(booked.booking.id)).booking.notifications.find(n=>n.id===parked.id);
  assert.equal(receipt.status,'cancelled');assert.equal(receipt.resolution,'operator_asserted_not_sent');assert.equal(receipt.resolutionEvidence,'operator_assertion');
  await ledger.alarm();await ledger.alarm();
  assert.equal(sent.filter(p=>p.idempotencyKey===parked.id).length,1,'resolution must never re-send the parked message');
  assert.equal(ledger.resolveParkedDelivery({jobId:parked.id,outcome:'delivered',expectedUpdatedAt:parked.updatedAt}).status,404);
  assert.equal((await ledger.operationalStatus()).deliveries.review.count,0);
});

test('a scheduled email that is not parked cannot be resolved',async()=>{
  const {ledger}=await setup({notify:async()=>{throw Object.assign(Error('rate limited'),{retryable:true});}});
  await book(ledger);const queued=jobs(ledger)[0];
  assert.equal(ledger.resolveParkedDelivery({jobId:queued.id,outcome:'delivered',expectedUpdatedAt:queued.updatedAt}).status,409);
});

test('delivered follow-up resolution records the attempt time and never re-queues',async()=>{
  const {ledger}=await setup();const booked=await book(ledger),b=ledger.booking(booked.booking.id);
  const job={id:`${b.id}:${b.version}:follow_up`,bookingId:b.id,version:b.version,kind:'follow_up',dueAt:b.end,updatedAt:Date.now(),attempts:1,firstAttemptAt:Date.now()-1000,provider:'resend',requiresAttention:true,error:'Delivery requires review'};
  ledger.sql.exec('DELETE FROM live_jobs');ledger.sql.exec('INSERT INTO live_jobs VALUES (?,?,?)',job.id,Date.now()+365*86400000,JSON.stringify(job));
  const resolved=ledger.resolveParkedDelivery({jobId:job.id,outcome:'delivered',expectedUpdatedAt:job.updatedAt});
  assert.equal(resolved.resolution,'operator_asserted_delivered');assert.equal(ledger.booking(b.id).followUpSentAt,job.firstAttemptAt);
  const receipt=(await ledger.hostBooking(b.id)).booking.notifications.find(n=>n.id===job.id);
  assert.equal(receipt.status,'sent');assert.equal(receipt.sentAt,job.firstAttemptAt);assert.equal(receipt.resolutionEvidence,'operator_assertion');
});

test('maintenance evidence distinguishes completed, failed, running and interrupted runs',async()=>{
  const {ledger}=await setup();await ledger.runMaintenance('watchdog');
  let status=await ledger.operationalStatus();
  assert.ok(status.maintenance.lastWatchdogAt);assert.equal(status.maintenance.lastAlarm.state,'completed');
  const expire=ledger.expireApprovals;ledger.expireApprovals=()=>{throw Object.assign(Error('private.guest@example.test'),{code:'storage_failure'});};
  const logs=captureLogs();
  try{await assert.rejects(()=>ledger.alarm());}finally{logs.restore();ledger.expireApprovals=expire;}
  assert.deepEqual(JSON.parse(logs.lines.find(l=>l.includes('booking_maintenance_failed'))),{event:'booking_maintenance_failed',code:'storage_failure'});
  status=await ledger.operationalStatus();
  assert.equal(status.maintenance.lastAlarm.state,'failed');assert.ok(status.issues.some(i=>i.code==='maintenance_failed'));
  // A run that recorded its start but never finished (eviction/crash).
  const startedAt=Date.now();ledger.putOperationalMeta('operations:lastAlarm',{startedAt,running:true,previous:{ok:true,finishedAt:startedAt-1000}});
  status=await ledger.operationalStatus();
  assert.equal(status.maintenance.lastAlarm.state,'running');assert.equal(status.maintenance.lastAlarm.finishedAt,undefined);assert.equal(status.maintenance.lastAlarm.ok,undefined);
  status=await at(startedAt+OPERATIONS_THRESHOLDS.maintenanceMs+1000,()=>ledger.operationalStatus());
  assert.equal(status.maintenance.lastAlarm.state,'interrupted');assert.ok(status.issues.some(i=>i.code==='maintenance_interrupted'));
});

test('outstanding work without an alarm is reported as alarm_missing',async()=>{
  const {ledger,state,provider}=await setup();
  provider.createEvent=async()=>{throw Object.assign(Error('timeout'),{retryable:true});};
  await book(ledger);state.alarm=null;
  const status=await at(Date.now()+5*60000,()=>ledger.operationalStatus());
  assert.ok(status.issues.some(i=>i.code==='alarm_missing'),JSON.stringify(status.issues));
});

test('status and parked evidence survive a restart on the same storage',async()=>{
  const {db,ledger,provider}=await setup({notify:async()=>{throw Object.assign(Error('timeout'),{retryable:false,deliveryUnknown:true});}});
  await book(ledger);await ledger.alarm();const before=await ledger.operationalStatus();
  const {ledger:restarted}=ledgerFor(db,provider,{notify:async()=>assert.fail('restart must not replay a parked send')});
  await restarted.alarm();const after=await restarted.operationalStatus();
  assert.deepEqual(after.deliveries.review.items.map(i=>i.jobId),before.deliveries.review.items.map(i=>i.jobId));
  assert.equal(after.maintenance.lastAlarm.state,'completed');
});

test('restore drill: a file-level SQLite copy restores into a fresh ledger without duplicate calendar inserts or sends',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'booking-restore-'));
  try{
    let unknownSend=true;const sent=[];
    const notify=async(_env,payload)=>{sent.push(payload.idempotencyKey);if(unknownSend)throw Object.assign(Error('timeout'),{retryable:false,deliveryUnknown:true});return {id:'ok'};};
    const {db,ledger,provider,effects,events}=await setup({notify});
    const confirmed=await book(ledger);await ledger.alarm();
    // Calendar insert reaches Google but the response is lost: pending outcome.
    const create=provider.createEvent;provider.createEvent=async(...args)=>{await create(...args);throw Object.assign(Error('timeout'),{retryable:true});};
    const pending=await book(ledger,1);assert.equal(pending.booking.status,'pending');provider.createEvent=create;
    const beforeBackup=await ledger.operationalStatus();
    assert.equal(beforeBackup.deliveries.review.count,1);assert.equal(beforeBackup.bookings.pending.count,1);
    await backup(db,join(dir,'snapshot.sqlite'));
    // Disaster: storage lost after the snapshot.
    for(const table of ['live_bookings','live_jobs','live_accounts','live_meta'])db.exec('DELETE FROM '+table);
    assert.equal((await ledger.operationalStatus()).calendarSync.tracked,0);
    // Restore into a new isolate with the same TOKEN_ENCRYPTION_KEY.
    const restoredDb=new DatabaseSync(join(dir,'snapshot.sqlite'));unknownSend=false;
    const {ledger:restored}=ledgerFor(restoredDb,provider,{notify});
    const created=effects.created,parkedSends=sent.length;
    await restored.alarm();await restored.alarm();
    assert.equal(restored.booking(pending.booking.id).status,'confirmed','pending outcome reconciles by deterministic GET');
    assert.equal(effects.created,created,'restore must not insert a second calendar event');assert.equal(events.size,2);
    const parked=jobs(restored).filter(j=>j.requiresAttention);
    assert.equal(parked.length,1,'parked delivery evidence survives restore');
    assert.equal(sent.filter(key=>key===parked[0].id).length,1,'restored maintenance never replays the parked send');
    assert.ok(sent.length>=parkedSends);
    assert.equal((await restored.manage(confirmed.booking.id,confirmed.managementToken)).booking.id,confirmed.booking.id,'guest capability survives restore');
    const status=await restored.operationalStatus();
    assert.equal(status.deliveries.review.count,1);assert.equal(status.bookings.pending.count,0);
    assertPrivate(status,[confirmed.managementToken,pending.managementToken]);
    // A restore with the wrong key cannot prepare new messages; it must show as overdue, not silently healthy.
    const wrongDb=new DatabaseSync(join(dir,'snapshot.sqlite'));
    const {ledger:wrongKey}=ledgerFor(wrongDb,provider,{env:{TOKEN_ENCRYPTION_KEY:Buffer.alloc(32,9).toString('base64')},notify});
    const cb=wrongKey.booking(confirmed.booking.id),reminderId=`${cb.id}:${cb.version}:reminder:30`;
    wrongDb.prepare('INSERT INTO live_jobs VALUES (?,?,?)').run(reminderId,0,JSON.stringify({id:reminderId,bookingId:cb.id,version:cb.version,kind:'reminder',minutesBefore:30,dueAt:Date.now()-1000,updatedAt:Date.now(),attempts:0}));
    const unparked=jobs(wrongKey).filter(j=>!j.requiresAttention).map(j=>j.id),sentBefore=sent.length;
    const logs=captureLogs();try{await wrongKey.alarm();}finally{logs.restore();}
    assert.equal(jobs(wrongKey).find(j=>j.id===reminderId)?.firstAttemptAt,undefined,'undecryptable job never reaches the provider');
    assert.equal(sent.length,sentBefore,'a mismatched key must not send');
    assert.ok(unparked.length,'drill needs an unparked job to exercise key mismatch');
    {
      const late=await at(Date.now()+OPERATIONS_THRESHOLDS.retryingMs,()=>wrongKey.operationalStatus());
      assert.ok(late.issues.some(i=>i.code==='delivery_overdue'),JSON.stringify(late.issues));
    }
    restoredDb.close();wrongDb.close();
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test('restore quarantine parks every queued email; release keeps the original key and attempted jobs cannot be released',async()=>{
  const sent=[];let fail=false;
  const {ledger}=await setup({notify:async(_env,p)=>{sent.push(p.idempotencyKey);if(fail)throw Object.assign(Error('timeout'),{retryable:false,deliveryUnknown:true});return {id:'ok'};}});
  fail=true;const first=await book(ledger);await ledger.alarm();fail=false;
  const second=await book(ledger,3);
  const attempted=jobs(ledger).find(j=>j.bookingId===first.booking.id),queued=jobs(ledger).find(j=>j.bookingId===second.booking.id);
  assert.ok(attempted.firstAttemptAt);assert.equal(queued.firstAttemptAt,undefined);
  const result=ledger.quarantineDeliveriesAfterRestore();assert.equal(result.count,1,'already-parked unknown sends stay as they were');
  await ledger.alarm();assert.equal(sent.filter(k=>k===queued.id).length,0,'quarantined jobs never send');
  const status=await ledger.operationalStatus();
  assert.ok(status.issues.some(i=>i.code==='restore_quarantine'));
  const item=status.deliveries.review.items.find(i=>i.jobId===queued.id);assert.equal(item.reason,'restored');assert.equal(item.releasable,true);
  assert.equal(status.deliveries.review.items.find(i=>i.jobId===attempted.id).releasable,false);
  assert.equal(ledger.resolveParkedDelivery({jobId:attempted.id,outcome:'release',expectedUpdatedAt:attempted.updatedAt}).status,409);
  const released=ledger.resolveParkedDelivery({jobId:queued.id,outcome:'release',expectedUpdatedAt:item.updatedAt});
  assert.equal(released.resolution,'operator_released_after_restore');
  await ledger.alarm();assert.deepEqual(sent.filter(k=>k===queued.id),[queued.id],'released job sends once under its original idempotency key');
  assert.equal(sent.filter(k=>k===attempted.id).length,1);
});
