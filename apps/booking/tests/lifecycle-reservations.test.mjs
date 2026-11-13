import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import * as lifecycle from '../src/lifecycle.js';
import {reserveWorkspaceOwnershipSync,releaseWorkspaceOwnershipSync,reserveWorkspaceOwnership,releaseWorkspaceOwnership,changeMember,inviteMember,workspaceAccess} from '../src/workspaces.js';
import {randomToken,sha256} from '../src/crypto.js';
const {reserveLifecycle,readLifecycleReservation,registerLifecycleProof,armLifecycleReservation,beginReservedLifecycle,cancelLifecycleReservation,withLifecycleAdmission,lifecycleSnapshot}=lifecycle;
const host='h_'+'a'.repeat(24),member='h_'+'b'.repeat(24),company='h_'+'c'.repeat(24),manifestHash='m'.repeat(43);
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
function fixture(){
 const records=new Map(),hooks={};
 const auth={getByName(name){const raw={get:()=>structuredClone(records.get(name)??null),put:value=>records.set(name,structuredClone(value))};return {
 async get(){await hooks.get?.(name);return raw.get();},async put(value){raw.put(value);},async getWithExpiry(){return raw.get()?{body:raw.get(),expiresAt:Date.now()+600000}:null;},
 async compareAndSwap(version,value){await hooks.cas?.(name,value);if((raw.get()?.version??null)!==version)return false;raw.put(value);return true;},async register(){},
 ...Object.fromEntries(Object.entries({lifecycleReserve:'reserveLifecycleSync',lifecycleReservationRead:'readLifecycleReservationSync',lifecycleRegisterProof:'registerLifecycleProofSync',lifecycleArm:'armLifecycleReservationSync',lifecycleBeginReserved:'beginReservedLifecycleSync',lifecycleCancelReservation:'cancelLifecycleReservationSync'}).map(([method,fn])=>[method,async(id,data)=>{await hooks.rpc?.(method);try{return lifecycle[fn](raw,id,data);}catch(e){return {error:e.message,status:e.status,code:e.code};}}])),
 async workspaceOwnershipReserve(id,data){return reserveWorkspaceOwnershipSync(raw,id,data);},async workspaceOwnershipRelease(id,data){return releaseWorkspaceOwnershipSync(raw,id,data);}
 };}};
 const env={AUTH:auth,LIVE_HOSTS:{getByName(){return {async fenceMemberCalendar(){return 1;}}}}};
 const binding=(id=host,extra={})=>({operationId:randomToken(16),nonce:randomToken(16),actorId:id,actorGeneration:0,expectedGeneration:0,manifestHash,notAfter:Date.now()+60000,targets:[{kind:'host',id,revision:0}],...extra});
 const prove=async(b,id=host)=>registerLifecycleProof(env,id,{operationId:b.operationId,nonce:b.nonce,manifestHash:b.manifestHash,kind:'host',id,proofNonce:'resource-proof-nonce',revision:0,notAfter:b.notAfter});
 return {env,records,hooks,binding,prove};
}
const code=expected=>e=>e.code===expected;

test('Reserve closes writes but reads remain active; exact replay cannot renew or change manifest',async()=>{
 const f=fixture(),b=f.binding(),r=await reserveLifecycle(f.env,host,b);assert.equal(r.reservation.status,'reserving');assert.equal(r.generation,0);assert.equal((await lifecycle.assertLifecycleActive(f.env,host)).state,'active');
 await assert.rejects(withLifecycleAdmission(f.env,host,'new_mutation',async()=>1),code('lifecycle_reserved'));
 assert.deepEqual((await reserveLifecycle(f.env,host,b)).reservation,r.reservation);
 for(const change of [{notAfter:b.notAfter+1},{actorId:member},{manifestHash:'n'.repeat(43)},{nonce:randomToken(16)},{targets:[{kind:'host',id:host,revision:1}]}])await assert.rejects(reserveLifecycle(f.env,host,{...b,...change}));
});
test('all proofs and earliest deadlines are validated inside final synchronous Begin turn',async()=>{
 const f=fixture(),b=f.binding();await reserveLifecycle(f.env,host,b);await assert.rejects(armLifecycleReservation(f.env,host,b),code('lifecycle_proofs_missing'));await f.prove(b);await armLifecycleReservation(f.env,host,b);
 const original=Date.now;try{f.hooks.rpc=async method=>{if(method==='lifecycleBeginReserved')Date.now=()=>b.notAfter;};await assert.rejects(beginReservedLifecycle(f.env,host,b),code('lifecycle_reservation_expired'));assert.equal((await lifecycleSnapshot(f.env,host)).generation,0);}finally{Date.now=original;}
 const expired=await cancelLifecycleReservation(f.env,host,{...b,reason:'cancelled'});assert.equal(expired.reservation.status,'cancelled');
});
test('proof nonce, revision, target and deadline cannot be replaced after registration',async()=>{
 const f=fixture(),b=f.binding();await reserveLifecycle(f.env,host,b);const p={operationId:b.operationId,nonce:b.nonce,manifestHash:b.manifestHash,kind:'host',id:host,proofNonce:'resource-proof-nonce',revision:0,notAfter:b.notAfter-1000};await registerLifecycleProof(f.env,host,p);await registerLifecycleProof(f.env,host,p);
 for(const patch of [{proofNonce:'another-proof-nonce'},{revision:1},{id:member},{notAfter:b.notAfter}])await assert.rejects(registerLifecycleProof(f.env,host,{...p,...patch}));
 const original=Date.now;try{Date.now=()=>p.notAfter;await assert.rejects(armLifecycleReservation(f.env,host,b),code('lifecycle_reservation_expired'));assert.equal((await cancelLifecycleReservation(f.env,host,{...b,reason:'expired'})).reservation.status,'expired');}finally{Date.now=original;}
});
test('Begin versus Cancel has exactly one winner and begun replay survives deadline/lost response',async()=>{
 for(const cancelFirst of [false,true]){const f=fixture(),b=f.binding();await reserveLifecycle(f.env,host,b);await f.prove(b);await armLifecycleReservation(f.env,host,b);
  const requests=cancelFirst?[()=>cancelLifecycleReservation(f.env,host,{...b,reason:'cancelled'}),()=>beginReservedLifecycle(f.env,host,b)]:[()=>beginReservedLifecycle(f.env,host,b),()=>cancelLifecycleReservation(f.env,host,{...b,reason:'cancelled'})];const results=await Promise.allSettled(requests.map(fn=>fn()));
  if(cancelFirst){assert.equal(results[0].value.reservation.status,'cancelled');assert.equal(results[1].status,'rejected');assert.equal((await lifecycleSnapshot(f.env,host)).generation,0);}else{assert.equal(results[0].value.reservation.status,'begun');assert.equal(results[1].value.reservation.status,'begun');const original=Date.now;try{Date.now=()=>b.notAfter+60000;assert.equal((await beginReservedLifecycle(f.env,host,b)).reservation.status,'begun');}finally{Date.now=original;}}
 }
});
test('unknown cancellation and expiration tombstones prevent delayed reserve and survive newer operations',async()=>{
 const f=fixture(),b=f.binding();await cancelLifecycleReservation(f.env,host,{...b,reason:'cancelled'});await assert.rejects(reserveLifecycle(f.env,host,b));const newer=f.binding();await reserveLifecycle(f.env,host,newer);assert.equal((await readLifecycleReservation(f.env,host,b)).reservation.status,'cancelled');
 const other=fixture(),e=other.binding();await assert.rejects(cancelLifecycleReservation(other.env,host,{...e,reason:'expired'}),code('lifecycle_reservation_not_expired'));const original=Date.now;try{Date.now=()=>e.notAfter;await cancelLifecycleReservation(other.env,host,{...e,reason:'expired'});await assert.rejects(reserveLifecycle(other.env,host,e));}finally{Date.now=original;}
});
test('capacity fails closed without evicting cancellation or consuming active reservation terminal slot',async()=>{
 const f=fixture();for(let i=0;i<63;i++)await cancelLifecycleReservation(f.env,host,{...f.binding(),reason:'cancelled'});const b=f.binding();await reserveLifecycle(f.env,host,b);await assert.rejects(cancelLifecycleReservation(f.env,host,{...f.binding(),reason:'cancelled'}),code('lifecycle_reservation_capacity'));assert.equal((await cancelLifecycleReservation(f.env,host,{...b,reason:'cancelled'})).reservation.status,'cancelled');await assert.rejects(reserveLifecycle(f.env,host,f.binding()),code('lifecycle_reservation_capacity'));
});
test('Reserve refuses pending OAuth/calendar admissions before recording a reservation',async()=>{
 for(const kind of ['oauth_calendar','workspace_receive_authority']){const f=fixture(),entered=deferred(),release=deferred(),b=f.binding();const work=withLifecycleAdmission(f.env,host,kind,async()=>{entered.resolve();await release.promise;return 1;});await entered.promise;
 await assert.rejects(reserveLifecycle(f.env,host,b),code('lifecycle_reservation_busy'));assert.equal((await lifecycleSnapshot(f.env,host)).reservation,undefined);release.resolve();await work;assert.equal((await reserveLifecycle(f.env,host,b)).reservation.status,'reserving');}
});
test('unknown writes prevent Reserve and generation/foreign-host bindings cannot be used',async()=>{
 const f=fixture();await assert.rejects(withLifecycleAdmission(f.env,host,'unknown',async({write})=>write(async()=>{throw Error('lost');})));await assert.rejects(reserveLifecycle(f.env,host,f.binding()),code('lifecycle_reservation_busy'));
 const clean=fixture();await assert.rejects(reserveLifecycle(clean.env,host,clean.binding(host,{expectedGeneration:1})));await assert.rejects(reserveLifecycle(clean.env,host,clean.binding(host,{targets:[{kind:'host',id:member,revision:0}]})));
});
function seedCompany(f){f.records.set('workspace:'+company,{id:company,name:'Fixture',version:1,registryRegistered:true,members:[{id:host,email:'owner@example.test',role:'owner',joinedAt:1},{id:member,email:'member@example.test',role:'member',joinedAt:2}],invitations:[]});}
test('ownership CAS proof blocks authority changes but permits harmless metadata and requires terminal release',async()=>{
 const f=fixture();seedCompany(f);const b=f.binding(company,{actorId:host,coordinatorId:company,targets:[{kind:'host',id:company,revision:0},{kind:'ownership',id:company,revision:1}]});await reserveLifecycle(f.env,company,b);
 const proof=await reserveWorkspaceOwnership(f.env,{hostId:host},company,{...b,revision:1});assert.ok(proof.proofNonce);assert.deepEqual(await reserveWorkspaceOwnership(f.env,{hostId:host},company,{...b,revision:1}),proof);
 await assert.rejects(releaseWorkspaceOwnership(f.env,company,{...b,proofNonce:proof.proofNonce}));
 await assert.rejects(inviteMember(f.env,{hostId:host,email:'owner@example.test'},company,{email:'guest@example.test'},'https://fixture.test'),code('lifecycle_reserved'));
 // Authoritative local guard also blocks a stale actor whose lifecycle target is not this company.
 const current=f.records.get('workspace:'+company);f.records.set('workspace:'+company,{...current,version:current.version+1,registryRegistered:false});
 await f.prove(b,company);await armLifecycleReservation(f.env,company,b);await cancelLifecycleReservation(f.env,company,{...b,reason:'cancelled'});
 await assert.rejects(releaseWorkspaceOwnership(f.env,company,{...b,proofNonce:'wrong-resource-nonce'}));assert.equal((await releaseWorkspaceOwnership(f.env,company,{...b,proofNonce:proof.proofNonce})).released,true);assert.equal(f.records.get('workspace:'+company).lifecycleReservation,undefined);
});
test('receiving transfer/admin grant needs target identity admission, including an already-inflight transfer',async()=>{
 for(const data of [{action:'transfer',memberId:member},{action:'role',role:'admin',memberId:member}]){const f=fixture();seedCompany(f);await reserveLifecycle(f.env,member,f.binding(member));await assert.rejects(changeMember(f.env,{hostId:host,email:'owner@example.test'},company,data),code('lifecycle_reserved'));assert.equal(f.records.get('workspace:'+company).members[1].role,'member');}
 const f=fixture();seedCompany(f);const entered=deferred(),release=deferred();f.hooks.cas=async(name,body)=>{if(name==='workspace:'+company&&body.members[1].role==='owner'){entered.resolve();await release.promise;}};const transfer=changeMember(f.env,{hostId:host,email:'owner@example.test'},company,{action:'transfer',memberId:member});await entered.promise;await assert.rejects(reserveLifecycle(f.env,member,f.binding(member)),code('lifecycle_reservation_busy'));assert.equal((await lifecycleSnapshot(f.env,member)).reservation,undefined);release.resolve();await transfer;assert.equal(f.records.get('workspace:'+company).members[1].role,'owner');
});
test('reserved session remains authenticated when lastSeen is due, including a reservation racing touch admission',async()=>{
 const authUrl=new URL('../src/auth.js',import.meta.url),source=(await readFile(authUrl,'utf8')).replace("import { DurableObject } from 'cloudflare:workers';",'class DurableObject {}').replace(/from '(\.\.?\/[^']+)'/g,(_all,path)=>`from '${new URL(path,authUrl).href}'`),{session}=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
 for(const race of [false,true]){const f=fixture(),secret=randomToken(),hash=await sha256(secret),id=await sha256('email-browser-session-id:'+hash);f.records.set('session:'+hash,{hostId:host,email:'owner@example.test',sessionVersion:1,id,accountGeneration:0});f.records.set('browser-sessions:'+host,{version:1,sessions:[{id,tokenHash:hash,lastSeenAt:Date.now()-600000,expiresAt:Date.now()+600000,accountGeneration:0}]});
  if(!race)await reserveLifecycle(f.env,host,f.binding());else{let fired=false;f.hooks.cas=async(name)=>{if(!fired&&name==='lifecycle:'+host){fired=true;await reserveLifecycle(f.env,host,f.binding());}};}
  const user=await session(new Request('https://fixture.test/',{headers:{Cookie:'email_booking_session='+secret}}),f.env);assert.equal(user.hostId,host);assert.equal(f.records.get('browser-sessions:'+host).sessions[0].lastSeenAt<Date.now()-300000,true);
 }
});
