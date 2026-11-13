import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {BookingLedger} from '../src/ledger.js';
import {discoverAccountDependencies,detachAccountDependencies,memberDeletionImpact,detachDeletedMemberCalendar} from '../src/account-dependencies.js';
const USER='h_abcdefghijklmnopqrstuvwx',COMPANY='h_bcdefghijklmnopqrstuvwxy',OTHER='h_cdefghijklmnopqrstuvwxyz';
function fixture(){
 const records=new Map(),AUTH={getByName(name){return {get:()=>structuredClone(records.get(name)??null),list:()=>name==='host-registry'?[COMPANY]:[],compareAndSwap:(v,b)=>{const old=records.get(name);if((old?.version??null)!==v)return false;records.set(name,structuredClone(b));return true;}};}};
 const db=new DatabaseSync(':memory:'),storage={sql:{exec(q,...args){const rows=db.prepare(q).all(...args);return {toArray:()=>rows};}},transactionSync(fn){db.exec('BEGIN');try{const r=fn();db.exec('COMMIT');return r;}catch(e){db.exec('ROLLBACK');throw e;}}};
 const env={AUTH},ledger=new BookingLedger({storage},env);ledger.init({id:COMPANY,workspaceKind:'company',name:'Acme'});
 env.LIVE_HOSTS={getByName:()=>({accountDeletionDependencies:(id,email)=>memberDeletionImpact(ledger,id,email),detachDeletedMember:data=>detachDeletedMemberCalendar(ledger,data)})};
 records.set('workspace:'+COMPANY,{id:COMPANY,name:'Acme',version:1,members:[{id:USER,email:'me@example.test',role:'member'},{id:OTHER,role:'owner'}],invitations:[{email:'me@example.test'},{email:'other@example.test'}]});
 return {env,ledger,records,db};
}
const user={hostId:USER,email:'me@example.test'};
test('owned profiles and shared calendar grants block before account fencing',async()=>{
 const f=fixture(),record=f.records.get('workspace:'+COMPANY);record.members[0].role='owner';f.ledger.putAccount({id:'mine',email:user.email,ownerMemberId:USER,connected:true,grant:'encrypted'});
 const result=await discoverAccountDependencies(f.env,user);assert.deepEqual(result.blockers.map(b=>b.code),['owned_workspace','shared_calendar']);assert.equal(f.ledger.account('mine').grant,'encrypted');
});
test('withdrawn contribution with an accepted future booking still blocks account deletion',async()=>{
 const f=fixture();f.ledger.putAccount({id:'mine',ownerMemberId:USER,connected:false,consentWithdrawn:true});f.ledger.sql.exec('INSERT INTO live_bookings VALUES(?,?,?,?,?,?)','booking','key',Date.now()+1000,Date.now()+2000,'confirmed',JSON.stringify({id:'booking',accountId:'mine'}));
 assert.equal((await discoverAccountDependencies(f.env,user)).blockers.some(b=>b.code==='workspace_bookings'),true);
});
test('fenced cleanup removes only the deleted members data and leaves company bookings and colleagues intact',async()=>{
 const f=fixture();f.ledger.putAccount({id:'mine',ownerMemberId:USER,connected:false,memberSchedule:{private:true}});f.ledger.putAccount({id:'other',ownerMemberId:OTHER,grant:'colleague-token',connected:true});
 const manifest=(await discoverAccountDependencies(f.env,user)).manifest;
 f.records.set('lifecycle:'+USER,{kind:'lifecycle',hostId:USER,generation:1,state:'fenced',operationId:'operation_123456789',version:1,ledgerIds:[USER],ledgerAcks:{[USER]:1},admissions:{}});
 assert.equal((await detachAccountDependencies(f.env,USER,{operationId:'operation_123456789',generation:1,manifest})).done,true);
 assert.equal(f.ledger.account('mine'),null);assert.equal(f.ledger.account('other').grant,'colleague-token');
 const record=f.records.get('workspace:'+COMPANY);assert.deepEqual(record.members.map(m=>m.id),[OTHER]);assert.deepEqual(record.invitations,[{email:'other@example.test'}]);
 assert.equal((await detachAccountDependencies(f.env,USER,{operationId:'operation_123456789',generation:1,manifest})).done,true);
});
test('unfenced caller cannot detach calendar data or membership',async()=>{
 const f=fixture(),manifest=(await discoverAccountDependencies(f.env,user)).manifest;
 await assert.rejects(detachAccountDependencies(f.env,USER,{operationId:'operation_123456789',generation:1,manifest}),{code:'deletion_dependencies_changed'});
 assert.equal(f.records.get('workspace:'+COMPANY).members.length,2);
});

test('credential-owned grants in another personal profile also block deletion',async()=>{
 const f=fixture();f.records.delete('workspace:'+COMPANY);f.ledger.putAccount({id:'external-owner',email:user.email,credentialOwnerId:USER,connected:true,grant:'privategrant'});
 const result=await discoverAccountDependencies(f.env,user);assert.equal(result.blockers.some(b=>b.code==='shared_calendar'),true);assert.equal(result.manifest.workspaces[0].id,COMPANY);
});
