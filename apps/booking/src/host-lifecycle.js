import * as lifecycle from './lifecycle.js';
const {lifecycleSnapshot}=lifecycle;
import {FENCE_META} from './maintenance.js';

export const HOST_LIFECYCLE_TABLE='live_lifecycle_state';
const READS=new Set(['refreshTokens','listCalendars','freeBusy','getEvent','conferenceDetails','assertManagedEvent']);
const phases=new Set(['fencing','fenced','needs_review']);
const fail=(message='This booking profile is closed.',status=403,code='lifecycle_fenced')=>Object.assign(Error(message),{status,code});
const conflict=()=>fail('Deletion state changed. Review it again.',409,'lifecycle_conflict');
const raw=(ledger,q,...args)=>ledger.lifecycleSQL.exec(q,...args).toArray();
export function localLifecycle(ledger){return JSON.parse(raw(ledger,'SELECT body FROM live_lifecycle_state WHERE id=1')[0]?.body??'null');}
export function localReservation(ledger){return JSON.parse(raw(ledger,'SELECT body FROM live_lifecycle_reservation WHERE id=1')[0]?.body??'null');}
const putReservation=(ledger,value)=>ledger.lifecycleSQL.exec('INSERT OR REPLACE INTO live_lifecycle_reservation VALUES(1,?)',JSON.stringify(value));
const reservationError=()=>fail('Deletion confirmation is being checked. Try again shortly.',409,'lifecycle_reserved');
export const lifecycleDenial=ledger=>{const error=localLifecycle(ledger)?fail():reservationError();return {error:error.message,status:error.status,code:error.code};};
export const lifecycleBlocked=ledger=>!!localLifecycle(ledger)||!!localReservation(ledger);
const putLocal=(ledger,value)=>ledger.lifecycleSQL.exec('INSERT OR REPLACE INTO live_lifecycle_state VALUES(1,?)',JSON.stringify(value));
export const lifecycleClosed=ledger=>!!localLifecycle(ledger);
export function installHostLifecycle(ledger){
 const sql=ledger.sql;ledger.lifecycleSQL=sql;ledger.lifecycleCalls=0;ledger.lifecycleMutations=0;ledger.lifecycleEffects=new Set();
 sql.exec('CREATE TABLE IF NOT EXISTS live_lifecycle_state (id INTEGER PRIMARY KEY CHECK(id=1),body TEXT NOT NULL)');
 sql.exec('CREATE TABLE IF NOT EXISTS live_lifecycle_reservation (id INTEGER PRIMARY KEY CHECK(id=1),body TEXT NOT NULL)');
 sql.exec('CREATE TABLE IF NOT EXISTS live_lifecycle_releases (operation_id TEXT PRIMARY KEY,body TEXT NOT NULL)');
 sql.exec('CREATE TABLE IF NOT EXISTS live_lifecycle_effects (id TEXT PRIMARY KEY,kind TEXT NOT NULL,resource TEXT,started_at INTEGER NOT NULL,state TEXT NOT NULL)');
 sql.exec('CREATE TABLE IF NOT EXISTS live_lifecycle_revision (id INTEGER PRIMARY KEY CHECK(id=1),version INTEGER NOT NULL)');
 sql.exec('INSERT OR IGNORE INTO live_lifecycle_revision VALUES(1,0)');
 // A persisted call left by a terminated isolate is not proof of failure, even after its old lease expires.
 sql.exec("UPDATE live_lifecycle_effects SET state='unknown' WHERE state='started'");
 ledger.sql={exec(q,...args){if(ledger.lifecycleEnforce&&lifecycleBlocked(ledger)&&!/^\s*(SELECT|EXPLAIN)\b/i.test(q))throw localLifecycle(ledger)?fail():reservationError();return sql.exec(q,...args);}};
}
export function installLifecycleRevision(ledger){
 for(const table of ['live_meta','live_accounts','live_bookings','live_jobs','live_notification_receipts','live_integrations','live_integration_deliveries','live_lifecycle_effects'])for(const action of ['INSERT','UPDATE','DELETE'])ledger.lifecycleSQL.exec(`CREATE TRIGGER IF NOT EXISTS lifecycle_${table}_${action.toLowerCase()} AFTER ${action} ON ${table} BEGIN UPDATE live_lifecycle_revision SET version=version+1 WHERE id=1; END`);
 ledger.lifecycleEnforce=true;
}
export async function lifecycleEffect(ledger,kind,run,{resource=null}={}){
 if(lifecycleBlocked(ledger))throw localLifecycle(ledger)?fail():reservationError();
 const id=crypto.randomUUID();ledger.lifecycleSQL.exec('INSERT INTO live_lifecycle_effects VALUES(?,?,?,?,?)',id,kind,typeof resource==='string'?resource.slice(0,100):null,Date.now(),'started');ledger.lifecycleEffects.add(id);
 try{const result=await run();ledger.lifecycleSQL.exec('DELETE FROM live_lifecycle_effects WHERE id=?',id);return result;}
 catch(error){
  if(error?.deliveryUnknown===false||kind==='calendar'&&error?.retryable===false&&[400,401,403,404,422].includes(error.status))ledger.lifecycleSQL.exec('DELETE FROM live_lifecycle_effects WHERE id=?',id);
  else ledger.lifecycleSQL.exec("UPDATE live_lifecycle_effects SET state='unknown' WHERE id=?",id);
  throw error;
 }finally{ledger.lifecycleEffects.delete(id);}
}
export function lifecycleCalendar(ledger,provider){return new Proxy(provider,{get(target,key){const fn=Reflect.get(target,key);if(typeof fn!=='function'||READS.has(key))return fn;return (...args)=>lifecycleEffect(ledger,'calendar',()=>fn.apply(target,args),{resource:args[1]?.bookingId});}});}
export function lifecycleNotify(ledger,send){return (...args)=>lifecycleEffect(ledger,'email',()=>send(...args),{resource:args[1]?.idempotencyKey});}
export function lifecycleFetch(ledger,fetcher){return (url,options)=>String(options?.method??'GET').toUpperCase()==='POST'?lifecycleEffect(ledger,'integration',()=>fetcher(url,options),{resource:options?.headers?.['x-scheduling-event-id']}):fetcher(url,options);}
export async function syncHostLifecycle(ledger,hostId=ledger.hostId()||localLifecycle(ledger)?.hostId){
 if(!hostId)return {checked:false,fenced:false};
 if(localLifecycle(ledger))return {checked:true,fenced:true};
 if(localReservation(ledger)){
  const result=await reconcileHostReservation(ledger);
  if(result.fenced)return {checked:true,fenced:true};
  if(result.reserved)return {checked:true,fenced:false,reserved:true};
 }
 const remote=await lifecycleSnapshot(ledger.env,hostId);if(localLifecycle(ledger))return {checked:true,fenced:true};
 const reservation=remote.reservation;
 // A terminal coordinator proof without its local release receipt may be a host-only restore.
 // Reconcile it before admitting writes; normal releases retain the receipt across ordinary edits.
 for(const candidate of [reservation,...[...(remote.reservationHistory??[])].reverse()]){
  const proof=candidate?.proofs?.['host:'+hostId];if(!proof)continue;
  const receipt=JSON.parse(raw(ledger,'SELECT body FROM live_lifecycle_releases WHERE operation_id=?',candidate.operationId)[0]?.body??'null');
  if(receipt&&sameReservation(receipt,candidate)&&receipt.proofNonce===proof.proofNonce)continue;
  recoverReservation(ledger,{...remote,reservation:candidate},hostId);const result=await reconcileHostReservation(ledger);
  if(result.fenced||result.reserved)return {checked:true,fenced:result.fenced===true,reserved:result.reserved===true,reservationPending:result.reserved===true};
 }
 if(remote.state!=='active'){
  if(!Number.isSafeInteger(remote.generation)||remote.generation<1||typeof remote.operationId!=='string')throw fail('Deletion state is unavailable.',503,'lifecycle_unavailable');
  putLocal(ledger,{hostId,generation:remote.generation,operationId:remote.operationId,fencedAt:Date.now(),state:'fenced',maintenancePublished:false});return {checked:true,fenced:true};
 }
 if(remote.generation!==0)throw fail('Account generation changed.',409,'lifecycle_changed');
 return {checked:true,fenced:false,reservationPending:!!reservation&&['reserving','armed'].includes(reservation.status)};
}
export async function activeHostCall(ledger,run,{hostId,quiet=false,readOnly=false}={}){
 ledger.lifecycleCalls++;let mutating=false;
 try{
  const first=await syncHostLifecycle(ledger,hostId);if(first.fenced)throw fail();
  if(!readOnly&&(first.reserved||first.reservationPending||localReservation(ledger)))throw reservationError();
  if(!readOnly){ledger.lifecycleMutations++;mutating=true;}
  const result=await run();const last=await syncHostLifecycle(ledger,hostId);if(last.fenced)throw fail();
  if(!readOnly&&last.reserved)throw reservationError();return result;
 }catch(error){if(quiet&&['lifecycle_fenced','lifecycle_reserved'].includes(error.code))return {ok:true,frozen:true};throw error;}
 finally{ledger.lifecycleCalls--;if(mutating)ledger.lifecycleMutations--;}
}

export function hostLifecycleImpact(ledger,now=Date.now()){
 const count=(table,where='1',...args)=>raw(ledger,`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`,...args)[0].n;
 const counts={links:(ledger.meta('meetingTypes')??[]).length,calendars:count('live_accounts'),bookings:count('live_bookings'),queuedEmails:count('live_jobs'),queuedIntegrations:count('live_integration_deliveries',"state IN ('queued','retry','in_flight','quarantined')")};
 const blockers={
  futureBookings:count('live_bookings',"status='confirmed' AND end>?",now),
  unresolvedBookings:count('live_bookings',"status IN ('pending','awaiting_approval','cancelling')"),
  replacements:count('live_bookings',"COALESCE(json_extract(body,'$.replacementKey'),'')!='' OR (COALESCE(json_extract(body,'$.successorId'),'')!='' AND status IN ('confirmed','pending','cancelling'))"),
  calendarLeases:count('live_bookings',"COALESCE(json_extract(body,'$.leaseUntil'),0)>0 OR COALESCE(json_extract(body,'$.syncLeaseUntil'),0)>0"),
  uncertainEmails:count('live_jobs',"COALESCE(json_extract(body,'$.firstAttemptAt'),0)>0 OR json_extract(body,'$.deliveryInFlight')=1 OR (json_extract(body,'$.requiresAttention')=1 AND COALESCE(json_extract(body,'$.attempts'),0)>0)"),
  uncertainIntegrations:count('live_integration_deliveries',"state='in_flight' OR (COALESCE(json_extract(body,'$.attempts'),0)>0 AND state IN ('retry','quarantined')) OR (state='failed' AND json_extract(body,'$.errorCode') IN ('delivery_unavailable','provider_unavailable'))"),
  outboundCalls:count('live_lifecycle_effects'),activeHandlers:ledger.lifecycleCalls||0,activeMutations:ledger.lifecycleMutations||0
 };
 const unknownEffects=count('live_lifecycle_effects',"state='unknown'")+Math.max(0,count('live_lifecycle_effects',"state='started'")-ledger.lifecycleEffects.size),local=localLifecycle(ledger);
 return {revision:raw(ledger,'SELECT version FROM live_lifecycle_revision WHERE id=1')[0]?.version??0,counts,blockers,needsReview:unknownEffects>0||blockers.uncertainEmails>0||blockers.uncertainIntegrations>0,localFence:local?{generation:local.generation,operationId:local.operationId,purged:local.state==='purged'}:null};
}
function request(data){if(!data||Object.keys(data).some(k=>!['operationId','generation','expectedRevision'].includes(k))||typeof data.operationId!=='string'||data.operationId.length<16||data.operationId.length>100||!Number.isSafeInteger(data.generation)||data.generation<1||data.expectedRevision!==undefined&&!Number.isSafeInteger(data.expectedRevision))throw fail('Choose a reviewed deletion operation.',400,'invalid_lifecycle');return data;}
async function authority(ledger,data,{mustBeFenced=false}={}){
 request(data);const hostId=ledger.hostId()||localLifecycle(ledger)?.hostId;if(!hostId)throw conflict();
 const remote=await lifecycleSnapshot(ledger.env,hostId);
 if(remote.operationId!==data.operationId||remote.generation!==data.generation||!phases.has(remote.state)||mustBeFenced&&remote.state!=='fenced')throw conflict();
 const local=localLifecycle(ledger);if(local&&(local.operationId!==data.operationId||local.generation!==data.generation))throw conflict();return {remote,hostId,local};
}
export async function fenceHostLifecycle(ledger,data){
 await syncHostLifecycle(ledger);const {hostId,local}=await authority(ledger,data),before=hostLifecycleImpact(ledger),stale=local?.reviewRequired===true||(!local?.maintenancePublished&&!local?.reservationProof&&data.expectedRevision!==undefined&&before.revision!==data.expectedRevision);
 if(!local)putLocal(ledger,{hostId,operationId:data.operationId,generation:data.generation,state:'fenced',fencedAt:Date.now(),maintenancePublished:false,reviewRequired:stale});
 else if(stale&&!local.reviewRequired)putLocal(ledger,{...local,reviewRequired:true});
 const store=ledger.maintenanceStore();if(!store)throw fail('Deletion fence is unavailable.',503,'lifecycle_unavailable');
 let epoch;
 for(let attempt=0;attempt<8;attempt++){
  const current=await store.get(),old=ledger.meta(FENCE_META),saved=localLifecycle(ledger);
  if(saved.maintenancePublished&&current?.frozen&&current.epoch===saved.epoch){epoch=saved.epoch;break;}
  epoch=Math.max(old?.epoch??0,current?.epoch??0,saved.epoch??0)+1;
  const value={epoch,frozen:true,reason:'lifecycle',changedAt:Date.now(),version:(current?.version??0)+1};
  ledger.lifecycleSQL.exec('INSERT INTO live_meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET body=excluded.body',FENCE_META,JSON.stringify(value));
  if(await store.compareAndSwap(current?.version??null,value,10*365*86400000)){putLocal(ledger,{...saved,epoch,maintenancePublished:true,reviewRequired:stale||saved.reviewRequired===true});break;}
  if(attempt===7)throw conflict();
 }
 await ledger.ctx.storage.deleteAlarm?.();await authority(ledger,data);
 const impact=hostLifecycleImpact(ledger);return {fenced:true,operationId:data.operationId,generation:data.generation,epoch,stale,readyForPurge:!stale&&Object.values(impact.blockers).every(n=>n===0),needsReview:stale||impact.needsReview,impact};
}
export async function drainHostLifecycle(ledger,data){
 const {local}=await authority(ledger,data);if(!local?.maintenancePublished)throw conflict();const impact=hostLifecycleImpact(ledger),drained=!local.reviewRequired&&Object.values(impact.blockers).every(n=>n===0);
 return {drained,needsReview:local.reviewRequired===true||impact.needsReview,operationId:data.operationId,generation:data.generation,impact};
}
export async function purgeHostLifecycle(ledger,data){
 const {local,hostId}=await authority(ledger,data,{mustBeFenced:true});if(!local?.maintenancePublished)throw conflict();
 if(local.state==='purged')return {purged:true,localDataDeleted:true,operationId:data.operationId,generation:data.generation};
 const status=await drainHostLifecycle(ledger,data);if(!status.drained)return {...status,purged:false};
 await ledger.ctx.storage.deleteAlarm?.();await authority(ledger,data,{mustBeFenced:true});
 const final=hostLifecycleImpact(ledger);if(Object.values(final.blockers).some(n=>n>0))return {purged:false,drained:false,needsReview:final.needsReview,impact:final};
 ledger.ctx.storage.transactionSync(()=>{
  for(const {name} of raw(ledger,"SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'live_%'"))if(!['live_lifecycle_state','live_lifecycle_revision'].includes(name)&&/^live_[a-z_]+$/.test(name))ledger.lifecycleSQL.exec(`DELETE FROM ${name}`);
  ledger.lifecycleSQL.exec('INSERT INTO live_meta VALUES(?,?)','profile',JSON.stringify({id:hostId}));
  ledger.lifecycleSQL.exec('INSERT INTO live_meta VALUES(?,?)',FENCE_META,JSON.stringify({epoch:local.epoch,frozen:true,reason:'lifecycle',changedAt:local.fencedAt}));
  putLocal(ledger,{...local,state:'purged',purgedAt:Date.now()});
 });ledger.availabilityCache.clear();
 return {purged:true,localDataDeleted:true,operationId:data.operationId,generation:data.generation};
}

const reservationKeys=['coordinatorId','operationId','nonce','actorId','actorGeneration','expectedGeneration','manifestHash','notAfter','expectedRevision','proofNonce'];
const sameFields=['operationId','nonce','actorId','actorGeneration','expectedGeneration','manifestHash','notAfter'];
const token=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{16,150}$/.test(value);
function reservationRequest(ledger,data,{requireRevision=false}={}){
 if(!data||typeof data!=='object'||Array.isArray(data)||Object.keys(data).some(k=>!reservationKeys.includes(k))||data.coordinatorId!==ledger.hostId()||!token(data.operationId)||!token(data.nonce)||typeof data.actorId!=='string'||!data.actorId||data.actorId.length>100||!Number.isSafeInteger(data.actorGeneration)||data.actorGeneration<0||!Number.isSafeInteger(data.expectedGeneration)||data.expectedGeneration<0||typeof data.manifestHash!=='string'||!data.manifestHash||data.manifestHash.length>150||!Number.isSafeInteger(data.notAfter)||data.notAfter<1||requireRevision&&!Number.isSafeInteger(data.expectedRevision)||data.expectedRevision!==undefined&&(!Number.isSafeInteger(data.expectedRevision)||data.expectedRevision<0)||data.proofNonce!==undefined&&!token(data.proofNonce))throw fail('Choose a reviewed host reservation.',400,'invalid_lifecycle');
 return data;
}
function sameReservation(record,binding){return !!record&&sameFields.every(k=>record[k]===binding[k]);}
const proofFor=(snapshot,hostId)=>snapshot.reservation?.proofs?.['host:'+hostId];
function validHostProof(snapshot,lock){const proof=proofFor(snapshot,lock.coordinatorId);return sameReservation(snapshot.reservation,lock)&&proof?.proofNonce===lock.proofNonce&&proof.revision===lock.expectedRevision&&proof.notAfter===lock.notAfter;}
function reservedView(lock,extra={}){return {reserved:true,coordinatorId:lock.coordinatorId,operationId:lock.operationId,nonce:lock.nonce,proofNonce:lock.proofNonce,manifestHash:lock.manifestHash,revision:lock.expectedRevision,notAfter:lock.notAfter,needsReview:lock.reviewRequired===true,...extra};}
function recoverReservation(ledger,snapshot,hostId){
 if(localLifecycle(ledger)||localReservation(ledger))return;
 const r=snapshot.reservation,proof=proofFor(snapshot,hostId),target=r?.targets?.find(t=>t.kind==='host'&&t.id===hostId);
 if(!r||!proof||!target||!token(r.nonce)||!token(proof.proofNonce)||!Number.isSafeInteger(proof.revision)||proof.revision!==target.revision||proof.notAfter!==r.notAfter)throw conflict();
 const lock={coordinatorId:hostId,...Object.fromEntries(sameFields.map(k=>[k,r[k]])),expectedRevision:proof.revision,proofNonce:proof.proofNonce,reviewRequired:hostLifecycleImpact(ledger).revision!==proof.revision,recovered:true};
 reservationRequest(ledger,Object.fromEntries(reservationKeys.filter(k=>lock[k]!==undefined).map(k=>[k,lock[k]])),{requireRevision:true});putReservation(ledger,lock);
}
function promoteReservation(ledger,snapshot,lock){
 if(snapshot.operationId!==lock.operationId||snapshot.generation!==lock.expectedGeneration+1||snapshot.state==='active')throw conflict();
 const proven=snapshot.reservation?.status==='begun'&&validHostProof(snapshot,lock);
 putLocal(ledger,{hostId:lock.coordinatorId,operationId:lock.operationId,generation:snapshot.generation,state:'fenced',fencedAt:Date.now(),maintenancePublished:false,reviewRequired:lock.reviewRequired===true||!proven,reservationProof:proven?{nonce:lock.nonce,proofNonce:lock.proofNonce,manifestHash:lock.manifestHash,revision:lock.expectedRevision,notAfter:lock.notAfter}:null});
 ledger.lifecycleSQL.exec('DELETE FROM live_lifecycle_reservation WHERE id=1');
 return {reserved:false,fenced:true,begun:true,operationId:lock.operationId,generation:snapshot.generation,needsReview:lock.reviewRequired===true||!proven};
}
async function readReservation(ledger,lock){return lifecycle.readLifecycleReservation(ledger.env,lock.coordinatorId,{operationId:lock.operationId,nonce:lock.nonce,manifestHash:lock.manifestHash});}
function cancelBinding(lock,reason){return {...Object.fromEntries(sameFields.map(k=>[k,lock[k]])),reason};}
function matchingLocal(ledger,lock){const current=localReservation(ledger);return current&&sameReservation(current,lock)&&current.proofNonce===lock.proofNonce?current:null;}
export async function reconcileHostReservation(ledger,data){
 let lock=localReservation(ledger);
 // A missing local row can be a host-only restore, never evidence of release.
 // Recover coordinator proofs/history just as ordinary admission does.
 let recovered;
 if(!lock&&!localLifecycle(ledger)){recovered=await syncHostLifecycle(ledger);lock=localReservation(ledger);}
 if(data){reservationRequest(ledger,data);if(lock&&(!sameReservation(lock,data)||data.proofNonce!==undefined&&data.proofNonce!==lock.proofNonce||data.expectedRevision!==undefined&&data.expectedRevision!==lock.expectedRevision))throw conflict();}
 if(!lock){
  const local=localLifecycle(ledger);if(local&&data&&local.operationId!==data.operationId)throw conflict();
  if(data){
   const snapshot=await readReservation(ledger,data),remote=snapshot.reservation,proof=proofFor(snapshot,data.coordinatorId);
   if(remote&&(!sameReservation(remote,data)||data.proofNonce!==undefined&&proof?.proofNonce!==data.proofNonce||data.expectedRevision!==undefined&&proof&&proof.revision!==data.expectedRevision))throw conflict();
   if(local)return {reserved:false,fenced:true,released:false};
   if(!remote)return {reserved:false,fenced:false,released:false,unknown:true};
   return {reserved:['reserving','armed'].includes(remote.status),fenced:false,released:['cancelled','expired'].includes(remote.status),terminal:['cancelled','expired'].includes(remote.status)?remote.status:undefined};
  }
  return {reserved:recovered?.reservationPending===true,fenced:!!local,released:false,unknown:!local};
 }
 let snapshot=await readReservation(ledger,lock);
 if(!matchingLocal(ledger,lock)){const local=localLifecycle(ledger);if(local?.operationId===lock.operationId&&local.generation===lock.expectedGeneration+1)return {reserved:false,fenced:true,begun:true};throw conflict();}
 if(snapshot.state!=='active')return promoteReservation(ledger,snapshot,lock);
 if(snapshot.generation!==lock.expectedGeneration)throw conflict();
 let remote=snapshot.reservation;
 if(remote&&!sameReservation(remote,lock))throw conflict();
 if(remote&&['reserving','armed'].includes(remote.status)&&((snapshot.readAt??0)>=lock.notAfter||Date.now()>=lock.notAfter)){
  // Only the coordinator may decide that its deadline passed. A local clock is merely a reason to ask.
  try{await lifecycle.cancelLifecycleReservation(ledger.env,lock.coordinatorId,cancelBinding(lock,'expired'));}catch{}
  snapshot=await readReservation(ledger,lock);
  if(!matchingLocal(ledger,lock)){const local=localLifecycle(ledger);if(local?.operationId===lock.operationId)return {reserved:false,fenced:true,begun:true};throw conflict();}
  if(snapshot.state!=='active')return promoteReservation(ledger,snapshot,lock);
  remote=snapshot.reservation;
 }
 if(snapshot.generation!==lock.expectedGeneration||remote&&!sameReservation(remote,lock))throw conflict();
 if(remote&&['cancelled','expired'].includes(remote.status)){
  // A recovered, changed source needs reviewed PITR recovery; cancelling deletion is not a restore acceptance.
  if(lock.reviewRequired)return reservedView(lock,{released:false,terminal:remote.status,needsReview:true});
  ledger.ctx.storage.transactionSync(()=>{ledger.lifecycleSQL.exec('INSERT OR REPLACE INTO live_lifecycle_releases VALUES(?,?)',lock.operationId,JSON.stringify({...Object.fromEntries(sameFields.map(k=>[k,lock[k]])),proofNonce:lock.proofNonce}));ledger.lifecycleSQL.exec('DELETE FROM live_lifecycle_reservation WHERE id=1');});ledger.availabilityCache.clear();
  await ledger.wake();return {reserved:false,released:true,terminal:remote.status,operationId:lock.operationId};
 }
 return reservedView(lock,{released:false,proofRegistered:validHostProof(snapshot,lock),unknown:!remote});
}
export async function reserveHostLifecycle(ledger,data){
 reservationRequest(ledger,data,{requireRevision:true});if(localLifecycle(ledger))throw fail();
 const old=localReservation(ledger);
 if(old){
  if(!sameReservation(old,data)||old.expectedRevision!==data.expectedRevision||data.proofNonce!==undefined&&data.proofNonce!==old.proofNonce)throw conflict();
  const reconciled=await reconcileHostReservation(ledger,data);if(reconciled.fenced)return reconciled;if(!reconciled.reserved)throw conflict();
 }
 const snapshot=await lifecycle.readLifecycleReservation(ledger.env,data.coordinatorId,{operationId:data.operationId,nonce:data.nonce,manifestHash:data.manifestHash}),r=snapshot.reservation;
 if(snapshot.state!=='active'||snapshot.generation!==data.expectedGeneration||!sameReservation(r,data)||!['reserving','armed'].includes(r.status)||snapshot.readAt>=data.notAfter)throw conflict();
 const target=r.targets?.find(t=>t.kind==='host'&&t.id===ledger.hostId());if(!target||target.revision!==data.expectedRevision)throw conflict();
 if(localLifecycle(ledger))throw fail();let lock=localReservation(ledger);
 if(lock){if(!sameReservation(lock,data)||lock.expectedRevision!==data.expectedRevision)throw conflict();}
 else{
  const impact=hostLifecycleImpact(ledger);
  if(impact.revision!==data.expectedRevision||Object.entries(impact.blockers).some(([key,value])=>key!=='activeHandlers'&&value>0))throw conflict();
  // No await separates the final source/handler checks from the reversible SQL lock.
  lock={...Object.fromEntries(reservationKeys.filter(k=>k!=='proofNonce').map(k=>[k,data[k]])),proofNonce:crypto.randomUUID(),reviewRequired:false};putReservation(ledger,lock);ledger.availabilityCache.clear();
 }
 try{await lifecycle.registerLifecycleProof(ledger.env,lock.coordinatorId,{operationId:lock.operationId,nonce:lock.nonce,manifestHash:lock.manifestHash,kind:'host',id:lock.coordinatorId,proofNonce:lock.proofNonce,revision:lock.expectedRevision,notAfter:lock.notAfter});}
 catch(error){const reconciled=await reconcileHostReservation(ledger,data).catch(()=>null);if(reconciled?.fenced)return reconciled;if(reconciled?.released)throw conflict();throw error;}
 const reconciled=await reconcileHostReservation(ledger,data);if(reconciled.fenced)return reconciled;if(!reconciled.reserved||!reconciled.proofRegistered)throw conflict();return reconciled;
}
export async function releaseHostReservation(ledger,data){
 reservationRequest(ledger,data);const lock=localReservation(ledger);
 if(lock&&(!data.proofNonce||lock.proofNonce!==data.proofNonce||!sameReservation(lock,data)))throw conflict();
 return reconcileHostReservation(ledger,data);
}
