import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {BookingLedger} from '../src/ledger.js';
import * as lifecycle from '../src/lifecycle.js';
import {hostLifecycleImpact,reserveHostLifecycle,reconcileHostReservation,fenceHostLifecycle,drainHostLifecycle,purgeHostLifecycle,localLifecycle} from '../src/host-lifecycle.js';
import {prepareAccountDeletion,confirmAccountDeletion,accountDeletionStatus,resumeAccountDeletion,oneMonthAfter} from '../src/account-deletion.js';
const HOST='h_abcdefghijklmnopqrstuvwx',EMAIL='owner@example.test',KEY=Buffer.alloc(32,7).toString('base64');
function fixture(){
 const records=new Map(),hooks={},AUTH={getByName(name){const raw={get:()=>structuredClone(records.get(name)??null),put:body=>records.set(name,structuredClone(body))};return {
 get:raw.get,put:raw.put,register:()=>{},take:()=>{const value=raw.get();records.delete(name);return value;},list:()=>[],
 compareAndSwap:(version,next)=>{if((raw.get()?.version??null)!==version)return false;raw.put(next);return true;},
 ...Object.fromEntries(Object.entries({lifecycleReserve:'reserveLifecycleSync',lifecycleRegisterProof:'registerLifecycleProofSync',lifecycleReservationRead:'readLifecycleReservationSync',lifecycleArm:'armLifecycleReservationSync',lifecycleBeginReserved:'beginReservedLifecycleSync',lifecycleCancelReservation:'cancelLifecycleReservationSync',accountDeletionAttach:'attachAccountDeletionSync',accountDeletionUpdate:'updateAccountDeletionSync',accountDeletionComplete:'completeAccountDeletionSync'}).map(([method,fn])=>[method,(id,data)=>{hooks.rpc?.(method);return lifecycle[fn](raw,id,data);}]))
 };}},db=new DatabaseSync(':memory:'),storage={sql:{exec(q,...args){const rows=db.prepare(q).all(...args);return {toArray:()=>rows};}},transactionSync(fn){db.exec('BEGIN');try{const value=fn();db.exec('COMMIT');return value;}catch(e){db.exec('ROLLBACK');throw e;}},setAlarm:async()=>{},deleteAlarm:async()=>{}},env={AUTH,TOKEN_ENCRYPTION_KEY:KEY,PUBLIC_ORIGIN:'https://fixture.invalid'};
 const ledger=new BookingLedger({storage},env,{google:{},sendNotification:()=>{throw Error('No provider calls');}});ledger.init({id:HOST,name:'Owner',email:EMAIL});
 const host={lifecycleImpact:()=>hostLifecycleImpact(ledger),lifecycleReserve:data=>reserveHostLifecycle(ledger,data),lifecycleReservationStatus:data=>reconcileHostReservation(ledger,data),lifecycleFence:data=>fenceHostLifecycle(ledger,data),lifecycleDrain:data=>drainHostLifecycle(ledger,data),lifecyclePurge:data=>purgeHostLifecycle(ledger,data)};env.LIVE_HOSTS={getByName:id=>{assert.equal(id,HOST);return host;}};
 const now=Date.now();records.set('account-cleanup-inventory-epoch',{schema:1,complete:true,scanId:'scan',activatedAt:now,completedAt:now});records.set('account-cleanup-inventory:'+HOST,{schema:1,hostId:HOST,complete:true,scanId:'scan',schemaActivatedAt:now,objectIds:[]});records.set('identity:'+HOST,{hostId:HOST,email:EMAIL});
 return {env,records,hooks,ledger,host,user:{hostId:HOST,email:EMAIL}};
}
test('prepare is reversible, receipt exists before Confirm, completion erases active data',async()=>{
 const f=fixture(),p=await prepareAccountDeletion(f.env,f.user,{});assert.equal(p.canDelete,true);assert.equal((await lifecycle.lifecycleSnapshot(f.env,HOST)).state,'active');assert.equal((await accountDeletionStatus(f.env,{operationId:p.operationId,receipt:p.receipt})).state,'not_started');
 const result=await confirmAccountDeletion(f.env,f.user,{confirmationToken:p.confirmationToken});assert.equal(result.state,'deleted');assert.equal(result.operationId,p.operationId);assert.equal(result.localDataDeleted,true);assert.equal(result.providerRevocation,'not_requested');assert.ok(result.deleteBy>result.requestedAt);assert.equal(f.records.has('identity:'+HOST),false);assert.equal(f.ledger.accounts().length,0);assert.equal(localLifecycle(f.ledger).state,'purged');
 const state=await lifecycle.lifecycleSnapshot(f.env,HOST);assert.equal(state.state,'deleted');assert.equal(state.deletion.manifest,undefined);assert.equal(state.deletion.binding,undefined);assert.equal(JSON.stringify(state).includes(EMAIL),false);assert.equal((await accountDeletionStatus(f.env,{operationId:p.operationId,receipt:p.receipt})).state,'deleted');await assert.rejects(lifecycle.assertLifecycleActive(f.env,HOST),{code:'lifecycle_fenced'});
});
test('future bookings, pending external writes and missing inventory cannot begin deletion',async()=>{
 for(const kind of ['future','unknown','inventory']){const f=fixture();if(kind==='future')f.ledger.sql.exec('INSERT INTO live_bookings VALUES(?,?,?,?,?,?)','b','k',Date.now()+1000,Date.now()+2000,'confirmed',JSON.stringify({id:'b'}));if(kind==='unknown')f.ledger.lifecycleSQL.exec('INSERT INTO live_lifecycle_effects VALUES(?,?,?,?,?)','effect','calendar',null,Date.now(),'unknown');if(kind==='inventory')f.records.delete('account-cleanup-inventory:'+HOST);
 const p=await prepareAccountDeletion(f.env,f.user);assert.equal(p.canDelete,false);await assert.rejects(confirmAccountDeletion(f.env,f.user,{confirmationToken:p.confirmationToken}));assert.equal((await lifecycle.lifecycleSnapshot(f.env,HOST)).state,'active');assert.equal(localLifecycle(f.ledger),null);}
});
test('stale or tampered confirmation cannot fence, unknown fields are refused',async()=>{
 const f=fixture(),p=await prepareAccountDeletion(f.env,f.user);await assert.rejects(confirmAccountDeletion(f.env,f.user,{confirmationToken:p.confirmationToken+'x'}));await assert.rejects(confirmAccountDeletion(f.env,{...f.user,hostId:'h_zzzzzzzzzzzzzzzzzzzzzzzz'},{confirmationToken:p.confirmationToken}));await assert.rejects(prepareAccountDeletion(f.env,f.user,{target:HOST}));f.ledger.putMeta('changed',true);await assert.rejects(confirmAccountDeletion(f.env,f.user,{confirmationToken:p.confirmationToken}),{code:'deletion_changed'});assert.equal((await lifecycle.lifecycleSnapshot(f.env,HOST)).state,'active');
});
test('receipt survives lost accepted response and rejects foreign readers',async()=>{
 const f=fixture(),p=await prepareAccountDeletion(f.env,f.user),original=f.host.lifecycleFence;let fail=true;f.host.lifecycleFence=async data=>{if(fail){fail=false;throw Error('temporary storage outage');}return original(data);};
 const first=await confirmAccountDeletion(f.env,f.user,{confirmationToken:p.confirmationToken});assert.equal(first.state,'fencing');assert.equal(first.localDataDeleted,false);await assert.rejects(accountDeletionStatus(f.env,{operationId:p.operationId,receipt:'x'.repeat(43)}),{code:'deletion_not_found'});assert.equal((await accountDeletionStatus(f.env,{operationId:p.operationId,receipt:p.receipt})).state,'deleted');assert.equal((await resumeAccountDeletion(f.env,HOST)).state,'deleted');
});
test('one month deadline clamps end-of-month and preserves clock time',()=>{
 assert.equal(new Date(oneMonthAfter(Date.UTC(2030,0,31,12,34))).toISOString(),'2030-02-28T12:34:00.000Z');assert.equal(new Date(oneMonthAfter(Date.UTC(2032,0,31))).toISOString(),'2032-02-29T00:00:00.000Z');
});
