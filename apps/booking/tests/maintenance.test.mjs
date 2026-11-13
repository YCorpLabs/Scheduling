import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync,backup} from 'node:sqlite';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {BookingLedger} from '../src/ledger.js';
import {FENCE_META} from '../src/maintenance.js';
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
// Mirrors AuthStore get/compareAndSwap. It lives outside the host database, as
// the AUTH namespace does, so restoring host storage cannot roll it back.
function fenceStore(){
  const store={body:null,failWrites:false,writes:0,
    async get(){return store.body?structuredClone(store.body):null;},
    async compareAndSwap(expected,body){if(store.failWrites)throw Error('AUTH unavailable');if((store.body?.version??null)!==expected)return false;store.body=structuredClone(body);store.writes++;return true;}};
  return store;
}
// External calendar and mail state: a restore cannot roll these back.
function providers(){
  const events=new Map(),effects={created:0,deleted:0,patched:0,reads:0},sent=[];
  const google={refreshTokens:async()=>({access_token:'access',expires_at:Date.now()+3600000}),listCalendars:async()=>[{id:'primary',accessRole:'owner'}],freeBusy:async()=>{effects.reads++;return [];},
    getEvent:async(_,{eventId})=>{effects.reads++;return events.get(eventId)??null;},
    createEvent:async(_,{eventId,event})=>{effects.created++;const result={...event,id:eventId,etag:'etag',status:'confirmed'};events.set(eventId,result);return result;},
    patchEvent:async()=>{effects.patched++;return {};},
    deleteEvent:async(_,{eventId})=>{effects.deleted++;events.delete(eventId);}};
  const notify=async(_env,payload)=>{sent.push(payload.idempotencyKey);return {id:'ok'};};
  return {events,effects,sent,google,notify};
}
function ledgerFor(db,p,store){
  const {storage,state}=storageFor(db);
  const ledger=new BookingLedger({storage},{TOKEN_ENCRYPTION_KEY:KEY,PUBLIC_ORIGIN:'https://example.test',RESEND_API_KEY:'test',MAIL_FROM:'host@example.test'},{google:p.google,sendNotification:p.notify,fenceStore:store});
  return {ledger,state};
}
async function setup(){
  const db=new DatabaseSync(':memory:'),p=providers(),store=fenceStore();const {ledger,state}=ledgerFor(db,p,store);
  ledger.init({id:'host',name:'Host',email:'owner@example.test'});
  await ledger.connect({accountId:'a',email:'host@example.test',tokens:{access_token:'access',refresh_token:'refresh-secret',expires_at:Date.now()+3600000}});
  await ledger.configureCalendars({accounts:[{id:'a',destinationCalendarId:'primary',conflictCalendarIds:['primary']}]});
  ledger.saveSettings({meetingTypes:[{...config,id:'intro',slug:'intro',published:true,accountId:'a',calendarId:'primary'}]});
  return {db,ledger,state,store,...p,p};
}
let sequence=0;
async function book(ledger,offsetHours=0){
  // Whole-hour starts keep the 30-minute fixture inside a UTC day even near midnight.
  const start=Math.ceil((Date.now()+3600000)/3600000)*3600000+(offsetHours+(sequence++%40))*3600000;
  return ledger.reserve('intro',{start,...GUEST,idempotencyKey:'maintenance-key-'+String(sequence).padStart(6,'0'),intakeRevision:await intakeRevision(ledger.type('intro'))});
}
const jobs=ledger=>ledger.rows('SELECT body FROM live_jobs').map(r=>JSON.parse(r.body));
const epoch=async ledger=>(await ledger.operationalStatus()).outbound.epoch;
function quiet(){const saved={log:console.log,warn:console.warn,error:console.error},lines=[];for(const k of Object.keys(saved))console[k]=(...a)=>lines.push(a.join(' '));return {lines,restore(){Object.assign(console,saved);}};}
async function silently(fn){const logs=quiet();try{return await fn();}finally{logs.restore();}}

test('a frozen host makes no calendar write or email send from any entry point',async()=>{
  const {ledger,state,effects,sent,store}=await setup();
  const confirmed=await book(ledger);
  const queued=jobs(ledger);assert.ok(queued.length>0,'drill needs a queued confirmation email');
  const created=effects.created;
  const frozen=await silently(()=>ledger.setMaintenance({action:'freeze',expectedEpoch:0}));
  assert.equal(frozen.ok,true);assert.equal(frozen.maintenance.frozen,true);assert.equal(frozen.maintenance.epoch,1);
  assert.equal(store.body.epoch,1);assert.equal(store.body.frozen,true);

  // Alarm, watchdog and manual repair.
  await ledger.alarm();assert.ok(ledger.meta('operations:lastFrozenAlarm'),'the alarm itself skips maintenance');assert.equal(ledger.meta('operations:lastAlarm'),null);
  assert.equal((await ledger.runMaintenance('watchdog')).frozen,true);
  const repair=await ledger.runMaintenance('manual');assert.equal(repair.status,503);assert.equal(repair.code,'maintenance_frozen');
  // Guest and owner changes that would reach Google or queue mail.
  const later=await book(ledger,2);assert.equal(later.status,503);assert.equal(later.code,'maintenance_frozen');
  assert.equal((await ledger.cancel(confirmed.booking.id,confirmed.managementToken)).code,'maintenance_frozen');
  assert.equal((await ledger.reschedule(confirmed.booking.id,confirmed.managementToken,confirmed.booking.start+3600000,'maintenance-move-key-0001')).code,'maintenance_frozen');
  assert.equal((await ledger.decideBooking(confirmed.booking.id,{action:'approve',expectedVersion:1,key:'maintenance-decision-0001'})).code,'maintenance_frozen');
  assert.equal((await ledger.availability('intro')).code,'maintenance_frozen','guests are not offered bookable slots');
  assert.ok(Array.isArray((await ledger.availability('intro',{preview:true})).slots),'owner preview still reads free/busy');
  assert.equal((await ledger.manage(confirmed.booking.id,confirmed.managementToken)).booking.status,'confirmed','guest can still view the booking');
  // Direct provider calls fail closed, including unknown future write functions.
  await assert.rejects(()=>ledger.google.createEvent({}, {}),e=>e.code==='maintenance_frozen');
  await assert.rejects(()=>ledger.google.patchEvent({}, {}),e=>e.code==='maintenance_frozen');
  await assert.rejects(async()=>ledger.notify(ledger.env,{}),e=>e.code==='maintenance_frozen'&&e.deliveryUnknown===false);
  await ledger.processJob(queued[0]);

  assert.equal(effects.created,created);assert.equal(effects.deleted,0);assert.equal(effects.patched,0);
  assert.deepEqual(sent,[],'no email leaves a frozen host');
  for(const j of jobs(ledger)){assert.equal(j.firstAttemptAt,undefined,'a frozen host never records a send attempt');assert.ok(!(j.leaseUntil>Date.now()));}
  const status=await ledger.operationalStatus();
  assert.ok(status.issues.some(i=>i.code==='outbound_paused'));assert.ok(!status.issues.some(i=>i.code==='alarm_missing'),'no alarm is expected while frozen');
  assert.equal(status.outbound.frozen,true);assert.deepEqual(status.outbound.inFlight,{calendar:0,deliveries:0});
  const text=JSON.stringify(status);for(const secret of [GUEST.name,GUEST.email,confirmed.managementToken,'refresh-secret'])assert.ok(!text.includes(secret));

  // Resume requires the reviewed epoch, schedules work and sends exactly once.
  assert.equal((await ledger.setMaintenance({action:'resume',expectedEpoch:0})).status,409);
  state.alarm=null;
  const resumed=await silently(()=>ledger.setMaintenance({action:'resume',expectedEpoch:1}));
  assert.equal(resumed.ok,true);assert.equal(resumed.maintenance.frozen,false);assert.equal(store.body.epoch,2);assert.ok(state.alarm,'resuming schedules maintenance');
  await ledger.alarm();await ledger.alarm();
  assert.deepEqual(sent,queued.map(j=>j.id));
  assert.equal((await ledger.operationalStatus()).issues.some(i=>i.code==='outbound_paused'),false);
});

test('freeze and resume validate input and are idempotent for the reviewed state',async()=>{
  const {ledger}=await setup();
  for(const bad of [null,{},{action:'freeze'},{action:'pause',expectedEpoch:0},{action:'freeze',expectedEpoch:'0'},{action:'freeze',expectedEpoch:0,extra:1}])
    assert.equal((await ledger.setMaintenance(bad)).status,400);
  await silently(()=>ledger.setMaintenance({action:'freeze',expectedEpoch:0}));
  const again=await ledger.setMaintenance({action:'freeze',expectedEpoch:1});assert.equal(again.ok,true);assert.equal(again.changed,false);assert.equal(again.maintenance.epoch,1);
  assert.equal((await ledger.setMaintenance({action:'freeze',expectedEpoch:0})).code,'maintenance_fence_conflict');
});

test('a host without a reachable fence refuses transitions and cannot start unchecked',async()=>{
  const db=new DatabaseSync(':memory:'),p=providers();
  const {ledger}=ledgerFor(db,p,null);ledger.init({id:'host',name:'Host',email:'owner@example.test'});
  const result=await ledger.setMaintenance({action:'freeze',expectedEpoch:0});assert.equal(result.status,503);assert.equal(result.code,'maintenance_fence_unavailable');
  await assert.rejects(()=>ledger.syncMaintenanceFence(),e=>e.code==='maintenance_fence_unavailable');
  // An object that was never initialized has nothing to protect and makes no AUTH call.
  const {ledger:blank}=ledgerFor(new DatabaseSync(':memory:'),p,null);
  assert.deepEqual(await blank.syncMaintenanceFence(),{checked:false});
});

test('an interrupted transition fails closed and the authoritative fence catches up without quarantine',async()=>{
  const {ledger,store,sent}=await setup();await book(ledger);
  store.failWrites=true;
  const result=await silently(()=>ledger.setMaintenance({action:'freeze',expectedEpoch:0}));
  assert.equal(result.status,503);
  assert.equal(ledger.maintenanceFrozen(),true,'host copy is written first, so it is already frozen');
  await ledger.alarm();assert.deepEqual(sent,[]);
  store.failWrites=false;
  const synced=await ledger.syncMaintenanceFence();assert.equal(synced.restoreDetected,false);
  assert.equal(store.body.epoch,1);assert.equal(store.body.frozen,true);
  assert.equal(jobs(ledger).filter(j=>j.restoreQuarantine).length,0,'a host ahead of the fence is not a restore');
});

test('restored storage older than the fence quarantines queued email and stays frozen until reconciled',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'booking-fence-'));
  try{
    const {db,ledger,store,sent,effects,p}=await setup();
    const first=await book(ledger);const second=await book(ledger,3);
    const queued=jobs(ledger).map(j=>j.id).sort();assert.equal(queued.length,2);
    // Recorded restore point: both emails queued, nothing sent yet.
    await backup(db,join(dir,'snapshot.sqlite'));
    // After the restore point the live host sends one email, then is frozen.
    await ledger.processJob(jobs(ledger).find(j=>j.bookingId===first.booking.id));
    assert.equal(sent.length,1);
    await silently(()=>ledger.setMaintenance({action:'freeze',expectedEpoch:0}));

    // Restore: a fresh object on the snapshot, with the same external fence.
    const restoredDb=new DatabaseSync(join(dir,'snapshot.sqlite'));const {ledger:restored}=ledgerFor(restoredDb,p,store);
    assert.equal(restored.maintenanceFrozen(),false,'the restored storage predates the freeze');
    const detected=await silently(()=>restored.syncMaintenanceFence());
    assert.equal(detected.restoreDetected,true);assert.equal(detected.quarantined,2);
    assert.equal(restored.maintenanceFrozen(),true);assert.equal(store.body.epoch,2);assert.equal(store.body.frozen,true);
    const created=effects.created;
    await restored.alarm();await restored.runMaintenance('watchdog');
    assert.equal(sent.length,1,'nothing is replayed after a detected restore');assert.equal(effects.created,created);

    const status=await restored.operationalStatus();
    for(const code of ['restore_detected','restore_quarantine','delivery_review','outbound_paused'])assert.ok(status.issues.some(i=>i.code===code),code);
    assert.equal(status.outbound.lastRestoreDetected.quarantined,2);assert.equal(status.outbound.reason,'restore_detected');
    assert.ok(!JSON.stringify(status).includes(GUEST.email));

    // Resume is refused until every quarantined email is reconciled.
    const blocked=await restored.setMaintenance({action:'resume',expectedEpoch:2});assert.equal(blocked.status,409);assert.equal(blocked.code,'restore_quarantine');
    const items=status.deliveries.review.items;
    const already=items.find(i=>i.jobId===sent[0]),unsent=items.find(i=>i.jobId!==sent[0]);
    assert.equal(already.releasable,true,'the restored state cannot know this email was sent');
    // The operator checks provider activity: one was delivered, one never left.
    assert.equal((await silently(()=>restored.resolveParkedDelivery({jobId:already.jobId,outcome:'delivered',expectedUpdatedAt:already.updatedAt}))).ok,true);
    assert.equal((await silently(()=>restored.resolveParkedDelivery({jobId:unsent.jobId,outcome:'release',expectedUpdatedAt:unsent.updatedAt}))).ok,true);
    await restored.alarm();assert.equal(sent.length,1,'release while frozen still sends nothing');
    const resumed=await silently(()=>restored.setMaintenance({action:'resume',expectedEpoch:2}));assert.equal(resumed.ok,true);
    await restored.alarm();await restored.alarm();
    assert.deepEqual(sent.slice().sort(),queued,'each email reaches the provider exactly once under its original key');
    assert.equal((await restored.manage(second.booking.id,second.managementToken)).booking.id,second.booking.id);
    restoredDb.close();
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test('a restore to a point after the freeze needs no quarantine, and older points are always detected',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'booking-fence-'));
  try{
    const {db,ledger,store,p}=await setup();await book(ledger);
    await backup(db,join(dir,'before.sqlite'));
    // Freeze, resume and freeze again: the snapshot is now two transitions behind.
    await silently(async()=>{await ledger.setMaintenance({action:'freeze',expectedEpoch:0});await ledger.setMaintenance({action:'resume',expectedEpoch:1});await ledger.alarm();await ledger.setMaintenance({action:'freeze',expectedEpoch:2});});
    await backup(db,join(dir,'frozen.sqlite'));
    const {ledger:frozenCopy}=ledgerFor(new DatabaseSync(join(dir,'frozen.sqlite')),p,store);
    const same=await frozenCopy.syncMaintenanceFence();assert.equal(same.restoreDetected,false,'nothing could be sent after a frozen restore point');
    assert.equal(frozenCopy.maintenanceFrozen(),true);
    const {ledger:older}=ledgerFor(new DatabaseSync(join(dir,'before.sqlite')),p,store);
    const detected=await silently(()=>older.syncMaintenanceFence());assert.equal(detected.restoreDetected,true);
    assert.equal(older.meta(FENCE_META).reason,'restore_detected');assert.equal(store.body.epoch,4);
  }finally{rmSync(dir,{recursive:true,force:true});}
});

function deferred(){let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};}
async function freezeAcross(ledger,resume=false){
  const current=ledger.maintenanceEpoch();
  const frozen=await silently(()=>ledger.setMaintenance({action:'freeze',expectedEpoch:current}));assert.equal(frozen.ok,true);
  if(resume){const resumed=await silently(()=>ledger.setMaintenance({action:'resume',expectedEpoch:current+1}));assert.equal(resumed.ok,true);}
}

test('resume stays locally frozen during publication and after an AUTH write failure',async()=>{
  const {ledger,store,sent,effects}=await setup();await book(ledger);await freezeAcross(ledger);
  const entered=deferred(),release=deferred(),original=store.compareAndSwap;
  store.compareAndSwap=async(expected,body)=>{if(body.frozen)return original(expected,body);entered.resolve();await release.promise;throw Error('AUTH unavailable');};
  const pending=silently(()=>ledger.setMaintenance({action:'resume',expectedEpoch:1}));await entered.promise;
  assert.equal(ledger.maintenanceFrozen(),true,'publication must not open the local gate');
  await ledger.alarm();assert.deepEqual(sent,[]);assert.equal(effects.created,1);
  release.resolve();const result=await pending;
  assert.equal(result.status,503);assert.equal(ledger.maintenanceFrozen(),true);assert.equal(store.body.frozen,true);assert.equal(store.body.epoch,1);
  store.compareAndSwap=original;
  assert.equal((await silently(()=>ledger.setMaintenance({action:'resume',expectedEpoch:1}))).ok,true);
});

test('an acknowledged resume interrupted before local commit quarantines on startup',async()=>{
  const {ledger,store}=await setup();await book(ledger);await freezeAcross(ledger);
  const original=ledger.putOperationalMeta.bind(ledger);
  ledger.putOperationalMeta=(key,value)=>{if(key===FENCE_META&&!value.frozen)throw Error('interrupted local commit');return original(key,value);};
  const result=await silently(()=>ledger.setMaintenance({action:'resume',expectedEpoch:1}));
  assert.equal(result.status,503);assert.equal(store.body.epoch,2);assert.equal(store.body.frozen,false);assert.equal(ledger.maintenanceFrozen(),true);
  ledger.putOperationalMeta=original;
  const recovered=await silently(()=>ledger.syncMaintenanceFence());
  assert.equal(recovered.restoreDetected,true);assert.equal(ledger.maintenanceFrozen(),true);assert.equal(store.body.epoch,3);
  assert.ok(jobs(ledger).every(job=>job.restoreQuarantine));
});

test('startup never republishes an unverified legacy local resume',async()=>{
  const {ledger,store}=await setup();await book(ledger);await freezeAcross(ledger);
  ledger.putOperationalMeta(FENCE_META,{epoch:2,frozen:false,changedAt:Date.now(),reason:null});
  const recovered=await silently(()=>ledger.syncMaintenanceFence());
  assert.equal(recovered.restoreDetected,true);assert.equal(ledger.maintenanceFrozen(),true);assert.equal(store.body.frozen,true);assert.equal(store.body.epoch,3);
  assert.ok(jobs(ledger).every(job=>job.restoreQuarantine));
});

test('startup rejects a fence that advances while an interrupted freeze is being republished',async()=>{
  const {ledger,store}=await setup();await freezeAcross(ledger);
  ledger.putOperationalMeta(FENCE_META,{epoch:2,frozen:true,changedAt:Date.now(),reason:'operator'});
  const original=store.get;let reads=0;
  store.get=async()=>{if(++reads===2)store.body={...store.body,epoch:3,frozen:true,version:3};return original();};
  await assert.rejects(()=>ledger.syncMaintenanceFence(),error=>error.code==='maintenance_fence_conflict');
  assert.equal(ledger.maintenanceFrozen(),true);assert.equal(store.body.epoch,3);
});

test('booking admission refuses an intervening freeze, including freeze followed by resume',async()=>{
  for(const resume of [false,true]){
    const {ledger,p,effects}=await setup();
    ledger.saveSettings({meetingTypes:[{...ledger.type('intro'),requiresApproval:true}]});
    const entered=deferred(),release=deferred();
    p.google.freeBusy=async()=>{entered.resolve();await release.promise;return [];};
    const pending=book(ledger);await entered.promise;await freezeAcross(ledger,resume);release.resolve();
    const result=await pending;
    assert.equal(result.code,'maintenance_frozen');assert.equal(ledger.rows('SELECT COUNT(*) AS n FROM live_bookings')[0].n,0);assert.equal(effects.created,0);
  }
});

test('cancel and reschedule refuse an intervening maintenance epoch after guest authorization',async()=>{
  for(const action of ['cancel','reschedule'])for(const resume of [false,true]){
    const {ledger,effects}=await setup(),confirmed=await book(ledger);
    const original=ledger.authorize.bind(ledger),entered=deferred(),release=deferred();
    ledger.authorize=async(...args)=>{const result=await original(...args);entered.resolve();await release.promise;return result;};
    const pending=action==='cancel'?ledger.cancel(confirmed.booking.id,confirmed.managementToken):ledger.reschedule(confirmed.booking.id,confirmed.managementToken,confirmed.booking.start+3600000,'maintenance-race-move-0001');
    await entered.promise;await freezeAcross(ledger,resume);release.resolve();
    assert.equal((await pending).code,'maintenance_frozen');assert.equal(ledger.booking(confirmed.booking.id).status,'confirmed');
    assert.equal(ledger.booking(confirmed.booking.id).replacementKey,undefined);assert.equal(effects.deleted,0);
    assert.equal(ledger.rows('SELECT COUNT(*) AS n FROM live_bookings')[0].n,1);
  }
});

test('approval refuses an intervening maintenance epoch after provider availability',async()=>{
  for(const resume of [false,true]){
    const {ledger,p,effects}=await setup();ledger.saveSettings({meetingTypes:[{...ledger.type('intro'),requiresApproval:true}]});
    const requested=await book(ledger),entered=deferred(),release=deferred();
    p.google.freeBusy=async()=>{entered.resolve();await release.promise;return [];};
    const pending=ledger.decideBooking(requested.booking.id,{action:'approve',expectedVersion:1,key:'maintenance-approval-race-0001'});
    await entered.promise;await freezeAcross(ledger,resume);release.resolve();
    assert.equal((await pending).code,'maintenance_frozen');assert.equal(ledger.booking(requested.booking.id).status,'awaiting_approval');assert.equal(effects.created,0);
  }
});

test('a freeze during email preparation records no send attempt and sends nothing',async()=>{
  const {ledger,sent}=await setup();await book(ledger);const job=jobs(ledger)[0];
  const original=crypto.subtle.decrypt,entered=deferred(),release=deferred();let once=false;
  crypto.subtle.decrypt=async function(...args){if(!once){once=true;entered.resolve();await release.promise;}return original.apply(this,args);};
  try{
    const pending=ledger.processJob(job);await entered.promise;await freezeAcross(ledger);release.resolve();await pending;
  }finally{release.resolve();crypto.subtle.decrypt=original;}
  assert.deepEqual(sent,[]);const current=jobs(ledger).find(item=>item.id===job.id);
  assert.equal(current.firstAttemptAt,undefined);assert.equal(current.attempts,0);assert.equal(current.leaseUntil,0);
});

test('calendar reconciliation does not start a write after an intervening freeze and resume',async()=>{
  const {ledger,p,events,effects}=await setup(),confirmed=await book(ledger),booking=ledger.booking(confirmed.booking.id);
  booking.status='pending';booking.leaseUntil=0;delete booking.attempted;ledger.putBooking(booking);events.delete(booking.eventId);
  const entered=deferred(),release=deferred();p.google.getEvent=async()=>{entered.resolve();await release.promise;return null;};
  const before=effects.created,pending=ledger.reconcile(booking.id);await entered.promise;await freezeAcross(ledger,true);release.resolve();await pending;
  assert.equal(effects.created,before);assert.equal(ledger.booking(booking.id).status,'pending');assert.equal(ledger.booking(booking.id).attempted,undefined);
});

test('either direction of a same-epoch fence mismatch remains frozen at a fresh epoch',async()=>{
  for(const remoteFrozen of [true,false]){
    const {ledger,store}=await setup();await freezeAcross(ledger);
    store.body={...store.body,frozen:remoteFrozen};
    ledger.putOperationalMeta(FENCE_META,{epoch:1,frozen:!remoteFrozen,changedAt:Date.now(),reason:null});
    const result=await ledger.syncMaintenanceFence();
    assert.equal(result.checked,true);assert.equal(ledger.maintenanceFrozen(),true);assert.equal(store.body.frozen,true);assert.equal(store.body.epoch,2);
  }
});

test('a conflicting authoritative resume publication never opens the local gate',async()=>{
  const {ledger,store}=await setup();await freezeAcross(ledger);
  const original=store.compareAndSwap;let advanced=false;
  store.compareAndSwap=async(expected,body)=>{
    if(!body.frozen&&!advanced){advanced=true;store.body={...store.body,epoch:body.epoch,frozen:true,version:store.body.version+1};return false;}
    return original(expected,body);
  };
  const result=await silently(()=>ledger.setMaintenance({action:'resume',expectedEpoch:1}));
  assert.equal(result.status,409);assert.equal(ledger.maintenanceFrozen(),true);assert.equal(store.body.frozen,true);
});

test('guest availability refuses a maintenance epoch that changes during its provider read',async()=>{
  for(const resume of [false,true]){
    const {ledger,p}=await setup(),entered=deferred(),release=deferred();
    p.google.freeBusy=async()=>{entered.resolve();await release.promise;return [];};
    const pending=ledger.availability('intro');await entered.promise;await freezeAcross(ledger,resume);release.resolve();
    const result=await pending;assert.equal(result.code,'maintenance_frozen');assert.equal(result.slots,undefined);
  }
});

test('same-epoch frozen restore parks a Cloudflare send accepted after the snapshot',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'booking-frozen-inflight-'));
  try{
    const {db,ledger,store,p,sent}=await setup();await book(ledger);
    ledger.env.NOTIFICATION_PROVIDER='cloudflare';ledger.env.EMAIL={send:async()=>({messageId:'unused'})};
    const entered=deferred(),release=deferred();
    // The external call starts before freeze; its acceptance cannot be rolled
    // back with host storage and can arrive after the frozen snapshot.
    ledger.notify=async(_env,payload)=>{entered.resolve();await release.promise;sent.push(payload.idempotencyKey);return {id:'accepted-later'};};
    const pending=ledger.processJob(jobs(ledger)[0]);await entered.promise;await freezeAcross(ledger);
    const attempted=jobs(ledger)[0];assert.equal(attempted.provider,'cloudflare');assert.equal(attempted.deliveryInFlight,true);assert.ok(attempted.firstAttemptAt);
    await backup(db,join(dir,'frozen.sqlite'));
    const restoredDb=new DatabaseSync(join(dir,'frozen.sqlite')),{ledger:restored}=ledgerFor(restoredDb,p,store);
    const checked=await restored.syncMaintenanceFence();assert.equal(checked.restoreDetected,false);assert.equal(restored.maintenanceFrozen(),true);
    release.resolve();await pending;assert.deepEqual(sent,[attempted.id]);
    // Expired leases are not evidence of non-delivery. The persisted attempt
    // must still prevent an opaque binding replay after resume.
    const restoredJob=jobs(restored)[0];restoredJob.leaseUntil=0;
    restored.sql.exec('UPDATE live_jobs SET due=?,body=? WHERE id=?',Date.now()-1,JSON.stringify(restoredJob),restoredJob.id);
    assert.equal((await silently(()=>restored.setMaintenance({action:'resume',expectedEpoch:1}))).ok,true);
    await restored.alarm();await restored.alarm();
    assert.deepEqual(sent,[attempted.id],'no replay of an in-flight non-idempotent Cloudflare send');
    const parked=jobs(restored)[0];assert.equal(parked.requiresAttention,true);assert.equal(parked.deliveryInFlight,true);
    assert.equal((await restored.operationalStatus()).deliveries.review.items.length,1);
    restoredDb.close();
  }finally{rmSync(dir,{recursive:true,force:true});}
});
