import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {encryptTokens} from '../src/crypto.js';
import {DEFAULT} from '../public/policy.js';
import {BookingLedger} from '../src/ledger.js';
import * as lifecycle from '../src/lifecycle.js';
import {activeHostCall,hostLifecycleImpact,reserveHostLifecycle,releaseHostReservation,reconcileHostReservation,localReservation,localLifecycle,fenceHostLifecycle,lifecycleEffect} from '../src/host-lifecycle.js';
const HOST='h_abcdefghijklmnopqrstuvwx',OP='deletion_operation_123456',NONCE='coordinator_nonce_123456',HASH='a'.repeat(43),KEY=Buffer.alloc(32,7).toString('base64');
function stores(){const map=new Map();return {getByName(name){if(!map.has(name)){let body=null;const store={get:()=>structuredClone(body),put:next=>{body=structuredClone(next);},compareAndSwap:(expected,next)=>{if((body?.version??null)!==expected)return false;body=structuredClone(next);return true;}};for(const [rpc,fn] of Object.entries({lifecycleReserve:'reserveLifecycleSync',lifecycleRegisterProof:'registerLifecycleProofSync',lifecycleReservationRead:'readLifecycleReservationSync',lifecycleCancelReservation:'cancelLifecycleReservationSync',lifecycleArm:'armLifecycleReservationSync',lifecycleBeginReserved:'beginReservedLifecycleSync'}))store[rpc]=(id,data)=>lifecycle[fn](store,id,data);map.set(name,store);}return map.get(name);}};}
function open(db=new DatabaseSync(':memory:'),AUTH=stores()){
 const alarms={value:null},storage={sql:{exec(q,...args){const rows=db.prepare(q).all(...args);return {toArray:()=>rows};}},setAlarm:async at=>{alarms.value=at;},deleteAlarm:async()=>{alarms.value=null;},transactionSync(fn){db.exec('BEGIN');try{const result=fn();db.exec('COMMIT');return result;}catch(e){db.exec('ROLLBACK');throw e;}}};
 const env={AUTH,TOKEN_ENCRYPTION_KEY:KEY,PUBLIC_ORIGIN:'https://test.invalid'},calls=[];
 const ledger=new BookingLedger({storage},env,{google:{createEvent:async()=>{calls.push('calendar');return {id:'event'};}},sendNotification:async()=>{calls.push('email');return {id:'sent'};}});if(!ledger.hostId())ledger.init({id:HOST,name:'Name',email:'private@example.test'});return {ledger,db,AUTH,env,calls,alarms};
}
const binding=f=>({coordinatorId:HOST,operationId:OP,nonce:NONCE,actorId:HOST,actorGeneration:0,expectedGeneration:0,manifestHash:HASH,notAfter:Date.now()+60000,expectedRevision:hostLifecycleImpact(f.ledger).revision});
async function prepare(f,data=binding(f)){await lifecycle.reserveLifecycle(f.env,HOST,{...data,targets:[{kind:'host',id:HOST,revision:data.expectedRevision}]});return data;}
async function reserve(f,data){return reserveHostLifecycle(f.ledger,data??await prepare(f));}
const cancel=(f,b,reason='cancelled')=>lifecycle.cancelLifecycleReservation(f.env,HOST,{...b,reason});
const release=(f,b,r)=>releaseHostReservation(f.ledger,{...b,proofNonce:r.proofNonce});
async function begin(f,b){await lifecycle.armLifecycleReservation(f.env,HOST,b);return lifecycle.beginReservedLifecycle(f.env,HOST,b);}

test('reviewed clean reservation is reversible, immutable on replay and blocks only mutating calls',async()=>{
 const f=open(),b=await prepare(f),r=await reserve(f,b);assert.equal(r.proofRegistered,true);assert.equal(localLifecycle(f.ledger),null);assert.equal(hostLifecycleImpact(f.ledger).revision,b.expectedRevision);
 assert.equal((await reserve(f,b)).proofNonce,r.proofNonce);assert.equal((await reserve(f,b)).notAfter,b.notAfter);
 await assert.rejects(activeHostCall(f.ledger,()=>f.ledger.putMeta('edit',true)),{code:'lifecycle_reserved'});assert.equal((await activeHostCall(f.ledger,()=>f.ledger.settings(),{readOnly:true})).profile.name,'Name');assert.throws(()=>f.ledger.putMeta('direct',1),{code:'lifecycle_reserved'});
 await assert.rejects(release(f,{...b,nonce:'different_nonce_123456'},r),{code:'lifecycle_conflict'});await assert.rejects(release(f,b,{proofNonce:'wrong_proof_nonce_123'}),{code:'lifecycle_conflict'});
 assert.equal((await release(f,b,r)).reserved,true);await cancel(f,b);assert.equal((await release(f,b,r)).released,true);assert.equal(localReservation(f.ledger),null);f.ledger.putMeta('edit','works');await assert.rejects(reserve(f,b),{code:'lifecycle_conflict'});
});

test('stale source, future bookings and unresolved outbound effects fail before a local lock',async()=>{
 for(const kind of ['stale','future','pending','unknown']){const f=open(),b=binding(f);if(kind==='stale')f.ledger.putMeta('changed',1);if(['future','pending'].includes(kind)){const status=kind==='future'?'confirmed':'pending';f.ledger.sql.exec('INSERT INTO live_bookings VALUES(?,?,?,?,?,?)','booking','request',Date.now()+1000,Date.now()+2000,status,JSON.stringify({id:'booking',status}));b.expectedRevision=hostLifecycleImpact(f.ledger).revision;}if(kind==='unknown'){await assert.rejects(lifecycleEffect(f.ledger,'email',async()=>{throw Error('unknown');}));b.expectedRevision=hostLifecycleImpact(f.ledger).revision;}await prepare(f,b);await assert.rejects(reserve(f,b),{code:'lifecycle_conflict'});assert.equal(localReservation(f.ledger),null);await cancel(f,b);await activeHostCall(f.ledger,()=>f.ledger.putMeta('usable',true));}
});

test('executing provider handler is never stranded: Reserve refuses before SQL barrier, then acknowledgement commits',async()=>{
 const f=open();let entered,finish;const gate=new Promise(r=>finish=r),ready=new Promise(r=>entered=r);const pending=activeHostCall(f.ledger,async()=>{await lifecycleEffect(f.ledger,'calendar',async()=>{entered();await gate;return {id:'event'};});f.ledger.putMeta('provider-ack','accepted');});await ready;const b=await prepare(f);await assert.rejects(reserve(f,b),{code:'lifecycle_conflict'});assert.equal(localReservation(f.ledger),null);finish();await pending;assert.equal(f.ledger.meta('provider-ack'),'accepted');await cancel(f,b);
});

test('traffic suspended before admission cannot starve Reserve or mutate after the lock',async()=>{
 const f=open(),store=f.AUTH.getByName('lifecycle:'+HOST),original=store.get;let finish;const gate=new Promise(r=>finish=r),pending=[];let reads=0;store.get=async()=>{const snapshot=original();reads++;await gate;return snapshot;};for(let i=0;i<20;i++)pending.push(activeHostCall(f.ledger,()=>f.ledger.putAccount({id:'refresh'+i,token:'must-not-write'})).catch(e=>e));while(reads<20)await Promise.resolve();store.get=original;const b=await prepare(f),r=await reserve(f,b);assert.equal(hostLifecycleImpact(f.ledger).blockers.activeHandlers,20);finish();const results=await Promise.all(pending);assert.ok(results.every(e=>e.code==='lifecycle_reserved'));assert.equal(f.ledger.accounts().length,0);await cancel(f,b);await release(f,b,r);
});

test('local expiry and a stale predeadline coordinator read never unlock SQL without a terminal tombstone',async t=>{
 t.mock.timers.enable({apis:['Date'],now:Date.UTC(2030,0,1)});const f=open(),b=await prepare(f),r=await reserve(f,b),store=f.AUTH.getByName('lifecycle:'+HOST),read=store.lifecycleReservationRead,expire=store.lifecycleCancelReservation;const stale=await read(HOST,b);t.mock.timers.tick(120000);store.lifecycleReservationRead=()=>stale;store.lifecycleCancelReservation=()=>{throw Error('timeout');};assert.equal((await reconcileHostReservation(f.ledger)).reserved,true);assert.throws(()=>f.ledger.putMeta('late',1),{code:'lifecycle_reserved'});store.lifecycleReservationRead=read;store.lifecycleCancelReservation=expire;assert.equal((await reconcileHostReservation(f.ledger)).terminal,'expired');assert.equal(localReservation(f.ledger),null);await assert.rejects(begin(f,b),{code:'lifecycle_reservation_changed'});
});

test('Begin wins once, survives lost response and deadline, and cannot be cancelled or released',async t=>{
 t.mock.timers.enable({apis:['Date'],now:Date.UTC(2030,0,1)});const f=open(),b=await prepare(f),r=await reserve(f,b);await begin(f,b);t.mock.timers.tick(120000);assert.equal((await lifecycle.beginReservedLifecycle(f.env,HOST,b)).reservation.status,'begun');assert.equal((await cancel(f,b)).reservation.status,'begun');assert.equal((await release(f,b,r)).fenced,true);assert.equal(localLifecycle(f.ledger).reviewRequired,false);const result=await fenceHostLifecycle(f.ledger,{operationId:OP,generation:1,expectedRevision:b.expectedRevision});assert.equal(result.stale,false);
});

test('lost proof publication reply reconciles the exact proof without renewing or unlocking',async()=>{
 const f=open(),b=await prepare(f),store=f.AUTH.getByName('lifecycle:'+HOST),register=store.lifecycleRegisterProof;store.lifecycleRegisterProof=(id,data)=>{register(id,data);throw Error('response lost');};await assert.rejects(reserve(f,b));const lock=localReservation(f.ledger);assert.ok(lock.proofNonce);store.lifecycleRegisterProof=register;const r=await reserve(f,b);assert.equal(r.proofNonce,lock.proofNonce);await cancel(f,b);await release(f,b,r);
});

test('host-only restore recovers registered lock, with changed sources requiring explicit recovery review',async()=>{
 for(const changed of [false,true]){const f=open(),b=await prepare(f),r=await reserve(f,b);f.ledger.lifecycleSQL.exec('DELETE FROM live_lifecycle_reservation');if(changed)f.ledger.lifecycleSQL.exec('UPDATE live_lifecycle_revision SET version=version+1');const restored=open(f.db,f.AUTH);await assert.rejects(activeHostCall(restored.ledger,()=>restored.ledger.putMeta('resurrect',1)),{code:'lifecycle_reserved'});assert.equal(localReservation(restored.ledger).proofNonce,r.proofNonce);await cancel(f,b);const status=await release(restored,b,r);assert.equal(status.released,!changed);assert.equal(status.needsReview===true,changed);}
});

test('cancelled old proof cannot release a newer reservation',async()=>{
 const f=open(),b=await prepare(f),r=await reserve(f,b);await cancel(f,b);await release(f,b,r);const second=await prepare(f,{...binding(f),operationId:'second_operation_123456',nonce:'second_nonce_12345678'}),r2=await reserve(f,second);await assert.rejects(release(f,b,r),{code:'lifecycle_conflict'});assert.equal(localReservation(f.ledger).proofNonce,r2.proofNonce);await cancel(f,second);await release(f,second,r2);
});

test('cancellation rearms queued work without changing reviewed source or permanently pausing it',async()=>{
 const f=open();Object.assign(f.env,{RESEND_API_KEY:'fixture',MAIL_FROM:'notify@example.test'});const booking={id:'past_booking_123456',requestKey:'past_request_123456',name:'Guest',email:'guest@example.test',title:'Past meeting',status:'confirmed',version:1,start:Date.now()-7200000,end:Date.now()-3600000,config:{...DEFAULT,reminder:false},tokenRecovery:await encryptTokens({token:'manage_token_123456'},KEY,HOST)};f.ledger.sql.exec('INSERT INTO live_bookings VALUES(?,?,?,?,?,?)',booking.id,booking.requestKey,booking.start,booking.end,booking.status,JSON.stringify(booking));const job={id:'queued',bookingId:booking.id,version:1,kind:'confirmed',attempts:0,dueAt:Date.now()};f.ledger.sql.exec('INSERT INTO live_jobs VALUES(?,?,?)',job.id,job.dueAt,JSON.stringify(job));
 const b=await prepare(f),r=await reserve(f,b);await f.ledger.wake();assert.equal(f.alarms.value,null);await f.ledger.processJob(job);assert.equal(f.calls.length,0);assert.equal(JSON.parse(f.ledger.rows('SELECT body FROM live_jobs')[0].body).firstAttemptAt,undefined);await cancel(f,b);await release(f,b,r);assert.ok(f.alarms.value>0);await activeHostCall(f.ledger,()=>f.ledger.processJob(job));assert.deepEqual(f.calls,['email']);assert.equal(f.ledger.rows('SELECT COUNT(*) AS n FROM live_jobs')[0].n,0);
});

test('terminal coordinator proof without a release receipt recovers a restored lock; normal release receipts allow edits',async()=>{
 const f=open(),b=await prepare(f),r=await reserve(f,b);await cancel(f,b);f.ledger.lifecycleSQL.exec('DELETE FROM live_lifecycle_reservation');f.ledger.lifecycleSQL.exec('UPDATE live_lifecycle_revision SET version=version+1');const restored=open(f.db,f.AUTH);await assert.rejects(activeHostCall(restored.ledger,()=>restored.ledger.putMeta('unsafe',1)),{code:'lifecycle_reserved'});assert.equal(localReservation(restored.ledger).reviewRequired,true);
 const normal=open(),b2=await prepare(normal),r2=await reserve(normal,b2);await cancel(normal,b2);await release(normal,b2,r2);for(let i=0;i<3;i++)await activeHostCall(normal.ledger,()=>normal.ledger.putMeta('normal',i));assert.equal(localReservation(normal.ledger),null);
});

test('maintenance resume suspended before its async publication completes cannot be frozen by Reserve',async()=>{
 const f=open();let entered,finish;const gate=new Promise(r=>finish=r),ready=new Promise(r=>entered=r);const pending=activeHostCall(f.ledger,async()=>{entered();await gate;return f.ledger.setMaintenance({action:'resume',expectedEpoch:0});});await ready;const b=await prepare(f);await assert.rejects(reserve(f,b),{code:'lifecycle_conflict'});finish();await pending;await cancel(f,b);assert.equal(localLifecycle(f.ledger),null);assert.equal(localReservation(f.ledger),null);
});

test('registered proof survives a lost maintenance publication response without false stale review on promotion retry',async()=>{
 const f=open(),b=await prepare(f);await reserve(f,b);await begin(f,b);let stored=null,once=true;f.ledger.fenceStore={get:async()=>stored,compareAndSwap:async(_version,next)=>{stored=next;if(once){once=false;throw Error('publish response lost');}return true;}};
 await assert.rejects(fenceHostLifecycle(f.ledger,{operationId:OP,generation:1,expectedRevision:b.expectedRevision}));assert.equal(localLifecycle(f.ledger).reviewRequired,false);assert.equal((await fenceHostLifecycle(f.ledger,{operationId:OP,generation:1,expectedRevision:b.expectedRevision})).stale,false);
});

test('an expired-token availability path is refused at global reservation admission before OAuth refresh or account writes',async()=>{
 const f=open();let refreshes=0;f.ledger.google.refreshTokens=async()=>{refreshes++;return {access_token:'new',expires_in:3600};};const grant=await encryptTokens({access_token:'old',refresh_token:'refresh',expires_at:Date.now()-1000},KEY,HOST);f.ledger.putAccount({id:'calendar',connected:true,connectionVersion:'version1',grant});const b=await prepare(f);await assert.rejects(activeHostCall(f.ledger,()=>f.ledger.access('calendar')),{code:'lifecycle_reserved'});assert.equal(refreshes,0);assert.equal(f.ledger.account('calendar').grant,grant);assert.equal(localReservation(f.ledger),null);await cancel(f,b);assert.equal(await activeHostCall(f.ledger,()=>f.ledger.access('calendar')),'new');assert.equal(refreshes,1);
});

test('status and release recover missing local authority before reporting a result',async()=>{
 for(const phase of ['armed','begun','cancelled']){
  const f=open(),b=await prepare(f),r=await reserve(f,b);await lifecycle.armLifecycleReservation(f.env,HOST,b);
  if(phase==='begun')await begin(f,b);if(phase==='cancelled')await cancel(f,b);
  f.ledger.lifecycleSQL.exec('DELETE FROM live_lifecycle_reservation');
  await assert.rejects(reconcileHostReservation(f.ledger,{...b,proofNonce:'incorrect_proof_123456'}),{code:'lifecycle_conflict'});
  const status=await release(f,b,r);
  assert.equal(status.released===true,phase==='cancelled');assert.equal(status.fenced===true,phase==='begun');assert.equal(status.reserved===true,phase==='armed');
  if(phase==='armed'){await cancel(f,b);await release(f,b,r);}
  if(phase==='cancelled'){await activeHostCall(f.ledger,()=>f.ledger.putMeta('after-cancel',true));assert.equal((await release(f,b,r)).released,true);}
 }
 const f=open(),b=await prepare(f);assert.equal((await reconcileHostReservation(f.ledger,b)).released,false);
 const store=f.AUTH.getByName('lifecycle:'+HOST),read=store.get;store.get=()=>{throw Error('authority unavailable');};
 await assert.rejects(reconcileHostReservation(f.ledger,b),/authority unavailable/);store.get=read;
});
