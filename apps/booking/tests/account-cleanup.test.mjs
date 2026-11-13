import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {indexAccountObject,inspectAccountObjectSync,accountObjectReferences,discoverAccountDeletion,purgeAccountData} from '../src/account-cleanup.js';
import {sha256} from '../src/crypto.js';
const HOST='h_'+'a'.repeat(24),OTHER='h_'+'b'.repeat(24),OP='delete_operation_123456',TOKEN='a'.repeat(43),OBJECT='a'.repeat(64);
function fixture(){
 const values=new Map(),hooks={};
 const target=name=>({
  async get(){return structuredClone(values.get(name)??null);},
  async put(body){await hooks.put?.(name,body);values.set(name,structuredClone(body));},
  async compareAndSwap(version,body){if((values.get(name)?.version??null)!==version)return false;values.set(name,structuredClone(body));return true;},
  async take(){await hooks.take?.(name);values.delete(name);},
  async takeExpired(){await hooks.expire?.(name);return true;},
  async accountCleanupInspect(){return hooks.inspect?.(name)??{owners:[HOST],protected:false};}
 });
 const env={AUTH:{getByName:target,idFromString:id=>id,get:target}};
 values.set('lifecycle:'+HOST,{kind:'lifecycle',hostId:HOST,generation:1,state:'fenced',operationId:OP,version:1,ledgerIds:[HOST],ledgerAcks:{[HOST]:1},admissions:{}});
 values.set('account-cleanup-inventory-epoch',{schema:1,complete:true,scanId:'scan-1',activatedAt:1,completedAt:2});
 values.set('account-cleanup-inventory:'+HOST,{schema:1,hostId:HOST,complete:true,scanId:'scan-1',schemaActivatedAt:1,completedAt:2,objectIds:[OBJECT]});
 return {env,values,hooks};
}
function sqlite(body,expires=1){const db=new DatabaseSync(':memory:');db.exec('CREATE TABLE state(id INTEGER PRIMARY KEY,body TEXT,expires INTEGER);CREATE TABLE hosts(id TEXT,touched INTEGER);');if(body!==null)db.prepare('INSERT INTO state VALUES(1,?,?)').run(JSON.stringify(body),expires);return {sql:{exec(q,...args){return {toArray:()=>db.prepare(q).all(...args)};}}};}

test('inventory projection sees expired physical rows without revealing account contents or capabilities',async()=>{
 const capability='b'.repeat(43),record=sqlite({hostId:HOST,id:'uuid',capability,email:'private@example.test',events:[{at:1,count:2}]});
 const result=inspectAccountObjectSync(record);assert.deepEqual(result.owners,[HOST]);assert.equal(result.expiresAt,1);assert.equal(result.type,'tracking');assert(!JSON.stringify(result).includes(capability));assert(!JSON.stringify(result).includes('private@example'));
 assert.deepEqual(await accountObjectReferences(record),['mail-pixel:'+await sha256(capability)]);
});
test('workspaces, lifecycle and cleanup receipts are protected from account-wide object deletion',()=>{
 const company=inspectAccountObjectSync(sqlite({id:OTHER,members:[{id:HOST,email:'private@example.test'}]}));assert.equal(company.protected,true);assert.equal(company.workspaceId,OTHER);assert.deepEqual(company.owners,[HOST]);
 assert.equal(inspectAccountObjectSync(sqlite({kind:'lifecycle',hostId:HOST})).protected,true);assert.equal(inspectAccountObjectSync(sqlite({kind:'account-cleanup-receipt',hostId:HOST})).protected,true);assert.equal(inspectAccountObjectSync(sqlite({schema:1,hostId:HOST,scanId:'scan-1',objectIds:[]})).protected,true);
});
test('new dynamic objects are indexed before caller storage and expiry references remain until physical acknowledgement',async()=>{
 const f=fixture(),name='session:'+TOKEN;await indexAccountObject(f.env,HOST,name,10);assert.equal(f.values.get('account-cleanup-index:'+HOST).entries[0].name,name);
 f.hooks.expire=()=>{throw Error('unknown expiry');};await assert.rejects(indexAccountObject(f.env,HOST,'desktop-token:'+TOKEN,Date.now()+10000));assert.equal(f.values.get('account-cleanup-index:'+HOST).entries[0].name,name);
 f.hooks.expire=()=>{};await indexAccountObject(f.env,HOST,'desktop-token:'+TOKEN,Date.now()+10000);assert.deepEqual(f.values.get('account-cleanup-index:'+HOST).entries.map(e=>e.name),['desktop-token:'+TOKEN]);
});
test('deletion discovery requires a complete matching inventory epoch and has a stable digest',async()=>{
 const f=fixture();f.values.set('browser-sessions:'+HOST,{sessions:[{tokenHash:TOKEN}]});f.values.set('desktop-sessions:'+HOST,{sessions:[{tokenHash:'b'.repeat(43)}]});
 const a=await discoverAccountDeletion(f.env,HOST),b=await discoverAccountDeletion(f.env,HOST);assert.deepEqual(a.digestInput,b.digestInput);assert.deepEqual(a.blockers,[]);assert(a.manifest.names.includes('session:'+TOKEN));assert.deepEqual(a.manifest.objectIds,[OBJECT]);
 f.values.get('account-cleanup-inventory-epoch').scanId='scan-2';assert.equal((await discoverAccountDeletion(f.env,HOST)).blockers[0].code,'legacy_inventory_required');
});
test('purge refuses active or undrained accounts and protects shared or operator-only objects',async()=>{
 const f=fixture(),manifest=(await discoverAccountDeletion(f.env,HOST)).manifest,data={operationId:OP,generation:1,manifest};
 f.values.get('lifecycle:'+HOST).state='active';await assert.rejects(purgeAccountData(f.env,HOST,data),{code:'account_cleanup_not_drained'});f.values.get('lifecycle:'+HOST).state='fenced';
 f.hooks.inspect=()=>({owners:[HOST,OTHER],protected:false});assert.equal((await purgeAccountData(f.env,HOST,data)).code,'account_cleanup_shared');
 f.hooks.inspect=()=>({owners:[HOST],protected:true});assert.equal((await purgeAccountData(f.env,HOST,data)).code,'account_cleanup_protected');
});
test('cleanup completion survives a lost discovery-delete response without declaring premature success',async()=>{
 const f=fixture(),manifest=(await discoverAccountDeletion(f.env,HOST)).manifest,data={operationId:OP,generation:1,manifest};f.values.set(OBJECT,{private:'secret'});f.values.set('identity:'+HOST,{email:'private@example.test'});
 let once=true;f.hooks.take=name=>{if(name==='account-cleanup-inventory:'+HOST&&once){once=false;f.values.delete(name);throw Error('response lost');}};
 await assert.rejects(purgeAccountData(f.env,HOST,data),/response lost/);assert.equal(f.values.get('account-cleanup-receipt:'+HOST).stage,'data_purged');assert(!f.values.has(OBJECT));assert(!f.values.has('identity:'+HOST));
 assert.equal((await purgeAccountData(f.env,HOST,data)).done,true);assert.equal((await purgeAccountData(f.env,HOST,data)).done,true);assert.equal(f.values.get('account-cleanup-receipt:'+HOST).stage,'done');assert.equal(f.values.get('lifecycle:'+HOST).state,'fenced');
});
test('bounded cleanup resumes from durable progress and never accepts a different operation receipt',async()=>{
 const f=fixture();const names=Array.from({length:65},(_,n)=>'session:'+String(n).padStart(43,'a'));f.values.set('account-cleanup-index:'+HOST,{version:1,entries:names.map(name=>({name,expiresAt:Date.now()+10000}))});for(const name of names)f.values.set(name,{private:'secret'});
 const manifest=(await discoverAccountDeletion(f.env,HOST)).manifest,data={operationId:OP,generation:1,manifest};assert.equal((await purgeAccountData(f.env,HOST,data)).done,false);assert.equal((await purgeAccountData(f.env,HOST,data)).done,true);assert(names.every(n=>!f.values.has(n)));
 const receipt=f.values.get('account-cleanup-receipt:'+HOST);receipt.operationId='different_operation_123';assert.equal((await purgeAccountData(f.env,HOST,data)).code,'account_cleanup_changed');
});

test('company calendar OAuth state belongs to the initiating member, never the target company',()=>{
 const r=inspectAccountObjectSync(sqlite({binding:TOKEN,verifier:TOKEN,hostId:OTHER,initiatorHostId:HOST,ownerMember:{id:HOST}}));assert.deepEqual(r.owners,[HOST]);
});
test('accounts absent from an exhaustive known-host baseline use only post-rollout indexed data',async()=>{
 const f=fixture();f.values.delete('account-cleanup-inventory:'+HOST);assert.equal((await discoverAccountDeletion(f.env,HOST)).blockers.length,1);
 f.values.get('account-cleanup-inventory-epoch').knownHostIds=[OTHER];const d=await discoverAccountDeletion(f.env,HOST);assert.equal(d.blockers.length,0);assert.equal(d.manifest.inventory.fresh,true);assert.deepEqual(d.manifest.objectIds,[]);
 assert.equal((await purgeAccountData(f.env,HOST,{operationId:OP,generation:1,manifest:d.manifest})).done,true);
 const known=fixture();known.values.delete('account-cleanup-inventory:'+HOST);known.values.get('account-cleanup-inventory-epoch').knownHostIds=[HOST];assert.equal((await discoverAccountDeletion(known.env,HOST)).blockers[0].code,'legacy_inventory_required');
});

test('inventory does not classify unknown private or malformed bodies as anonymous bookkeeping',()=>{
 const make=body=>({sql:{exec(query){return {toArray:()=>query.includes('COUNT')?[{n:0}]:[{body:typeof body==='string'?body:JSON.stringify(body),expires:Date.now()+10000}]};}}});
 assert.equal(inspectAccountObjectSync(make({privateEmail:'secret@example.test',token:'private'})).type,'unknown');
 assert.equal(inspectAccountObjectSync(make('{broken')).type,'malformed');
 assert.equal(inspectAccountObjectSync(make({binding:'hash',verifier:'secret',flow:'identity',hostId:null,privateEmail:'secret@example.test'})).type,'unknown');
 assert.equal(inspectAccountObjectSync(make({binding:'b'.repeat(43),verifier:'v'.repeat(43),hostId:null})).type,'oauth');
 assert.equal(inspectAccountObjectSync(make({binding:'hash',verifier:'secret',hostId:'unrecognized-account'})).type,'unknown');
 assert.equal(inspectAccountObjectSync(make({binding:{private:'data'},verifier:'v'.repeat(43),hostId:null})).type,'unknown');
 assert.equal(inspectAccountObjectSync(make({count:2})).type,'anonymous-rate');
});
