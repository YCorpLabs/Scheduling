import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync,backup} from 'node:sqlite';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {BookingLedger} from '../src/ledger.js';
import {DEFAULT} from '../public/policy.js';
import {beginLifecycle,ackLifecycle,lifecycleSnapshot} from '../src/lifecycle.js';
import {activeHostCall,hostLifecycleImpact,fenceHostLifecycle,drainHostLifecycle,purgeHostLifecycle,localLifecycle,lifecycleEffect} from '../src/host-lifecycle.js';
const HOST='h_abcdefghijklmnopqrstuvwx',OP='deletion_operation_123456',KEY=Buffer.alloc(32,7).toString('base64');
const stores=()=>{const map=new Map();return {getByName(name){if(!map.has(name)){let body=null;map.set(name,{get:async()=>structuredClone(body),compareAndSwap:async(expected,next)=>{if((body?.version??null)!==expected)return false;body=structuredClone(next);return true;},put:async next=>{body=structuredClone(next);},reset:()=>{body=null;}});}return map.get(name);}};};
function open(db=new DatabaseSync(':memory:'),AUTH=stores()){
 const alarms={value:null},storage={sql:{exec(q,...args){const rows=db.prepare(q).all(...args);return {toArray:()=>rows};}},setAlarm:async at=>{alarms.value=at;},deleteAlarm:async()=>{alarms.value=null;},transactionSync(fn){db.exec('BEGIN');try{const result=fn();db.exec('COMMIT');return result;}catch(e){db.exec('ROLLBACK');throw e;}}};
 const env={AUTH,TOKEN_ENCRYPTION_KEY:KEY,PUBLIC_ORIGIN:'https://test.invalid'},calls=[];
 const google={freeBusy:async()=>[],listCalendars:async()=>[{id:'primary',accessRole:'owner'}],getEvent:async()=>null,createEvent:async()=>{calls.push('create');return {id:'event'};}};
 const ledger=new BookingLedger({storage},env,{google,sendNotification:async()=>{calls.push('email');return {id:'sent'};}});
 if(!ledger.hostId())ledger.init({id:HOST,name:'Private Name',email:'private@example.test'});
 return {db,AUTH,env,ledger,storage,alarms,calls};
}
function seedBooking(f,{id='booking_123456789',status='confirmed',start=Date.now()-7200000,end=Date.now()-3600000,...extra}={}){const b={id,requestKey:'key_'+id,name:'Private Guest',email:'guest@example.test',title:'Private title',start,end,status,version:1,leaseUntil:0,config:{...DEFAULT,reminder:false,followUpMinutes:0},accountId:'a',...extra};f.ledger.sql.exec('INSERT INTO live_bookings VALUES(?,?,?,?,?,?)',b.id,b.requestKey,b.start,b.end,b.status,JSON.stringify(b));return b;}
async function fence(f,expectedRevision=hostLifecycleImpact(f.ledger).revision){await beginLifecycle(f.env,HOST,{operationId:OP,expectedGeneration:0,ledgerIds:[HOST]});return fenceHostLifecycle(f.ledger,{operationId:OP,generation:1,expectedRevision});}
async function ack(f,epoch){return ackLifecycle(f.env,HOST,{operationId:OP,generation:1,ledgerId:HOST,epoch});}
const operation={operationId:OP,generation:1};

test('legacy active hosts keep ordinary local and outbound behavior',async()=>{
 const f=open();assert.equal((await activeHostCall(f.ledger,()=>f.ledger.settings())).profile.name,'Private Name');
 await f.ledger.google.createEvent('token',{bookingId:'b'});await f.ledger.notify(f.env,{idempotencyKey:'mail'});
 assert.deepEqual(f.calls,['create','email']);assert.equal(hostLifecycleImpact(f.ledger).blockers.outboundCalls,0);
});

test('a reviewed host fence binds operation and generation and cannot be resumed',async()=>{
 const f=open(),revision=hostLifecycleImpact(f.ledger).revision;await assert.rejects(()=>fenceHostLifecycle(f.ledger,operation),{code:'lifecycle_conflict'});
 const result=await fence(f,revision);assert.equal(result.fenced,true);assert.equal(result.stale,false);assert.ok(result.epoch>0);
 assert.equal((await fenceHostLifecycle(f.ledger,{...operation,expectedRevision:revision})).epoch,result.epoch);
 assert.equal(f.ledger.setMaintenance({action:'resume',expectedEpoch:result.epoch}).code,'lifecycle_fenced');
 assert.throws(()=>f.ledger.putMeta('meetingTypes',[]),{code:'lifecycle_fenced'});assert.throws(()=>f.ledger.init({id:HOST,name:'Resurrect'}),{code:'lifecycle_fenced'});
 await assert.rejects(()=>activeHostCall(f.ledger,()=>f.ledger.settings()),{code:'lifecycle_fenced'});
 await assert.rejects(()=>f.ledger.google.createEvent('token',{}));assert.equal(f.calls.length,0);
 await assert.rejects(()=>purgeHostLifecycle(f.ledger,{operationId:'wrong_operation_123',generation:1}),{code:'lifecycle_conflict'});
});

test('future and unresolved accepted bookings block purge without provider cancellation',async()=>{
 for(const status of ['confirmed','pending','cancelling','awaiting_approval']){
  const f=open();seedBooking(f,{status,start:Date.now()+3600000,end:Date.now()+7200000});const result=await fence(f);await ack(f,result.epoch);
  const drain=await drainHostLifecycle(f.ledger,operation);assert.equal(drain.drained,false);assert.ok(drain.impact.blockers.futureBookings+drain.impact.blockers.unresolvedBookings>0);
  assert.equal((await purgeHostLifecycle(f.ledger,operation)).purged,false);assert.equal(f.ledger.rows('SELECT COUNT(*) AS n FROM live_bookings')[0].n,1);assert.equal(f.calls.length,0);
 }
});

test('a safe host purges private rows only after all target acknowledgements, with an idempotent terminal marker',async()=>{
 const f=open();seedBooking(f);f.ledger.putAccount({id:'a',email:'secret@example.test',grant:'PRIVATE-GRANT'});f.ledger.sql.exec('INSERT INTO live_jobs VALUES(?,?,?)','queued',Date.now()+1000,JSON.stringify({id:'queued',kind:'follow_up'}));
 const result=await fence(f);await assert.rejects(()=>purgeHostLifecycle(f.ledger,operation),{code:'lifecycle_conflict'});await ack(f,result.epoch);
 assert.equal((await drainHostLifecycle(f.ledger,operation)).drained,true);assert.equal((await purgeHostLifecycle(f.ledger,operation)).localDataDeleted,true);
 for(const table of ['live_accounts','live_bookings','live_jobs','live_integrations','live_integration_deliveries','live_notification_receipts','live_metrics'])assert.equal(f.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n,0,table);
 const rows=f.db.prepare('SELECT body FROM live_meta').all();assert.doesNotMatch(JSON.stringify(rows),/PRIVATE-GRANT|private@example|Private Name|Private Guest/);
 assert.equal(localLifecycle(f.ledger).state,'purged');assert.equal((await purgeHostLifecycle(f.ledger,operation)).purged,true);assert.equal(f.alarms.value,null);
 const restarted=open(f.db,f.AUTH);assert.deepEqual(restarted.db.prepare('SELECT key FROM live_meta ORDER BY key').all().map(r=>r.key),['operations:fence','profile']);
 await f.ledger.wake();assert.equal(f.alarms.value,null);assert.equal((await activeHostCall(f.ledger,()=>f.ledger.alarm(),{quiet:true})).frozen,true);
});

test('an in-flight outbound call blocks draining even after its old lease time, then a known result settles it',async t=>{
 t.mock.timers.enable({apis:['Date'],now:Date.UTC(2030,0,1)});const f=open();let release;const gate=new Promise(r=>release=r);const sending=lifecycleEffect(f.ledger,'email',()=>gate);
 const result=await fence(f);await ack(f,result.epoch);t.mock.timers.tick(3600000);
 let status=await drainHostLifecycle(f.ledger,operation);assert.equal(status.drained,false);assert.equal(status.impact.blockers.outboundCalls,1);assert.equal(status.needsReview,false);
 assert.equal((await purgeHostLifecycle(f.ledger,operation)).purged,false);release({id:'sent'});await sending;
 status=await drainHostLifecycle(f.ledger,operation);assert.equal(status.drained,true);assert.equal((await purgeHostLifecycle(f.ledger,operation)).purged,true);
});

test('an unknown external result survives restart and never becomes drained by timeout',async t=>{
 t.mock.timers.enable({apis:['Date'],now:Date.UTC(2030,0,1)});const f=open();await assert.rejects(()=>lifecycleEffect(f.ledger,'integration',async()=>{throw Error('network timeout');}));
 const result=await fence(f);await ack(f,result.epoch);t.mock.timers.tick(30*86400000);const restarted=open(f.db,f.AUTH);
 const status=await drainHostLifecycle(restarted.ledger,operation);assert.equal(status.needsReview,true);assert.equal(status.drained,false);assert.equal((await purgeHostLifecycle(restarted.ledger,operation)).purged,false);
});

test('a pre-fence asynchronous handler cannot write after the fence or be erased while still running',async()=>{
 const f=open();let release,entered;const gate=new Promise(r=>release=r),ready=new Promise(r=>entered=r);
 const pending=activeHostCall(f.ledger,async()=>{entered();await gate;f.ledger.putAccount({id:'late',grant:'MUST-NOT-RETURN'});});await ready;
 const result=await fence(f);await ack(f,result.epoch);assert.equal((await purgeHostLifecycle(f.ledger,operation)).purged,false);assert.equal(hostLifecycleImpact(f.ledger).blockers.activeHandlers,1);
 release();await assert.rejects(()=>pending,{code:'lifecycle_fenced'});assert.equal(f.ledger.account('late'),null);assert.equal((await purgeHostLifecycle(f.ledger,operation)).purged,true);
});

test('host-only restore re-applies the external deletion fence and an AUTH rollback cannot reopen a local terminal marker',async()=>{
 const f=open(),dir=mkdtempSync(join(tmpdir(),'host-lifecycle-')),file=join(dir,'before.sqlite');
 try{await backup(f.db,file);const result=await fence(f);await ack(f,result.epoch);const restored=open(new DatabaseSync(file),f.AUTH);
  assert.equal((await restored.ledger.syncLifecycleState()).fenced,true);await assert.rejects(()=>activeHostCall(restored.ledger,()=>restored.ledger.settings()),{code:'lifecycle_fenced'});
  f.AUTH.getByName('lifecycle:'+HOST).reset();assert.equal((await restored.ledger.syncLifecycleState()).fenced,true);assert.throws(()=>restored.ledger.putMeta('meetingTypes',[]),{code:'lifecycle_fenced'});
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('stale reviewed impact closes the gate but requires a fresh review before any purge decision',async()=>{
 const f=open(),before=hostLifecycleImpact(f.ledger).revision;seedBooking(f,{status:'pending'});const result=await fence(f,before);assert.equal(result.stale,true);assert.equal(result.impact.blockers.unresolvedBookings,1);assert.equal(localLifecycle(f.ledger).state,'fenced');await ack(f,result.epoch);assert.equal((await purgeHostLifecycle(f.ledger,operation)).needsReview,true);
});

test('member withdrawal preserves the company ledger and accepted bookings without revoking Google',async()=>{
 const f=open(),member='h_zyxwvutsrqponmlkjihgfedc';f.ledger.putAccount({id:'a',email:'member@example.test',grant:'OWNED-GRANT',ownerMemberId:member,connected:true});const b=seedBooking(f,{start:Date.now()+3600000,end:Date.now()+7200000});
 await beginLifecycle(f.env,member,{operationId:OP,expectedGeneration:0,ledgerIds:[]});const result=await f.ledger.withdrawMemberCalendar({id:member,email:'member@example.test'},'a');
 assert.equal(result.withdrawn,true);assert.equal(f.ledger.booking(b.id).calendarSyncStatus,'needs_review');assert.equal(f.ledger.account('a').grant,undefined);assert.equal(localLifecycle(f.ledger),null);assert.equal(f.calls.length,0);assert.equal((await lifecycleSnapshot(f.env,HOST)).state,'active');
});


test('a request suspended in its first remote guard remains part of the drain and cannot run after acknowledgement',async()=>{
 const f=open(),store=f.AUTH.getByName('lifecycle:'+HOST),get=store.get;let release,entered,ran=false;const gate=new Promise(r=>release=r),ready=new Promise(r=>entered=r);
 store.get=async()=>{store.get=get;const value=await get();entered();await gate;return value;};
 const pending=activeHostCall(f.ledger,()=>{ran=true;f.ledger.putAccount({id:'late'});});await ready;
 const result=await fence(f);await ack(f,result.epoch);assert.equal((await drainHostLifecycle(f.ledger,operation)).impact.blockers.activeHandlers,1);assert.equal((await purgeHostLifecycle(f.ledger,operation)).purged,false);
 release();await assert.rejects(()=>pending,{code:'lifecycle_fenced'});assert.equal(ran,false);assert.equal((await purgeHostLifecycle(f.ledger,operation)).purged,true);
});


test('failed fence publication cannot clear a durable stale-review flag on retry',async()=>{
 const f=open(),reviewed=hostLifecycleImpact(f.ledger).revision;f.ledger.putMeta('changed','after review');await beginLifecycle(f.env,HOST,{operationId:OP,expectedGeneration:0,ledgerIds:[HOST]});let stored=null,failOnce=true;
 f.ledger.fenceStore={get:async()=>stored,compareAndSwap:async(_version,next)=>{if(failOnce){failOnce=false;throw Error('publication failed');}stored=next;return true;}};
 await assert.rejects(fenceHostLifecycle(f.ledger,{...operation,expectedRevision:reviewed}));assert.equal(localLifecycle(f.ledger).reviewRequired,true);
 const result=await fenceHostLifecycle(f.ledger,operation);assert.equal(result.stale,true);await ack(f,result.epoch);assert.equal((await purgeHostLifecycle(f.ledger,operation)).purged,false);assert.equal(localLifecycle(f.ledger).reviewRequired,true);
});
