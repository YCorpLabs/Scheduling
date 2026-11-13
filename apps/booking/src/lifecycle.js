// Internal lifecycle foundations only. No public deletion/revocation endpoint or completion promise.
import {HttpError} from './http.js';
import {randomToken} from './crypto.js';
const STATES=new Set(['active','fencing','fenced','needs_review','deleted']);
const MAX_ADMISSIONS=50,MAX_TARGETS=240;
const validHost=id=>typeof id==='string'&&id.length>0&&id.length<=100&&!/[\x00-\x20]/.test(id);
const conflict=()=>Object.assign(new HttpError(409,'Account lifecycle changed.'),{code:'lifecycle_changed'});
const fenced=()=>Object.assign(new HttpError(403,'This account is unavailable.'),{code:'lifecycle_fenced'});
export const lifecycleStore=(env,id)=>{if(!validHost(id)||!env?.AUTH)throw Object.assign(new HttpError(503,'Account state is unavailable.'),{code:'lifecycle_unavailable'});return env.AUTH.getByName('lifecycle:'+id);};
export function lifecycleRecord(value,hostId){
 if(value==null)return {kind:'lifecycle',hostId,generation:0,state:'active',operationId:null,version:0,ledgerIds:[],ledgerAcks:{},admissions:{}};
 if(value.kind!=='lifecycle'||value.hostId!==hostId||!Number.isSafeInteger(value.generation)||value.generation<0||!Number.isSafeInteger(value.version)||value.version<1||!STATES.has(value.state)||!Array.isArray(value.ledgerIds)||!value.ledgerAcks||!value.admissions||value.unknownOverflowCount!==undefined&&(!Number.isSafeInteger(value.unknownOverflowCount)||value.unknownOverflowCount<0))throw Object.assign(new HttpError(503,'Account state is unavailable.'),{code:'lifecycle_unavailable'});
 if(value.reservation!==undefined&&value.reservation!==null&&(typeof value.reservation!=='object'||Array.isArray(value.reservation)))throw Object.assign(new HttpError(503,'Account state is unavailable.'),{code:'lifecycle_unavailable'});
 if(value.reservationHistory!==undefined&&!Array.isArray(value.reservationHistory))throw Object.assign(new HttpError(503,'Account state is unavailable.'),{code:'lifecycle_unavailable'});
 for(const r of [...(value.reservation?[value.reservation]:[]),...(value.reservationHistory??[])]){try{
  binding(r,hostId,{targets:false});if(!['reserving','armed','cancelled','expired','begun'].includes(r.status)||!Array.isArray(r.targets)||!r.proofs||Array.isArray(r.proofs))throw Error();
  if(r.targets.length)binding(r,hostId);else if(!['cancelled','expired'].includes(r.status))throw Error();
  for(const [key,p] of Object.entries(r.proofs)){const t=r.targets.find(t=>t.kind+':'+t.id===key);if(!t||!token(p.proofNonce)||p.revision!==t.revision||!Number.isSafeInteger(p.notAfter)||p.notAfter<1||p.notAfter>r.notAfter)throw Error();}
 }catch{throw Object.assign(new HttpError(503,'Account state is unavailable.'),{code:'lifecycle_unavailable'});}}
 if(value.reservationHistory!==undefined&&(!Array.isArray(value.reservationHistory)||value.reservationHistory.length>RESERVATION_LIMIT))throw Object.assign(new HttpError(503,'Account state is unavailable.'),{code:'lifecycle_unavailable'});
 return value;
}
export const recordGeneration=value=>value===undefined?0:Number.isSafeInteger(value)&&value>=0?value:-1;
export async function lifecycleSnapshot(env,id){return lifecycleRecord(await lifecycleStore(env,id).get(),id);}
export async function assertLifecycleActive(env,id,expectedGeneration=0){const state=await lifecycleSnapshot(env,id);if(state.state!=='active')throw fenced();if(state.generation!==expectedGeneration)throw conflict();return state;}
export async function lifecycleActive(env,id,generation=0){try{return await assertLifecycleActive(env,id,generation);}catch(error){if(['lifecycle_fenced','lifecycle_changed'].includes(error.code))return null;throw error;}}
// Expiry only reclassifies uncertainty; it never proves that a remote write failed.
function rememberUnknown(state,id){const entry=state.admissions[id];if(!entry||entry.unknown)return;if(Object.values(state.admissions).filter(a=>a.unknown).length>=MAX_ADMISSIONS){delete state.admissions[id];state.unknownOverflowCount=Math.min(Number.MAX_SAFE_INTEGER,(state.unknownOverflowCount??0)+1);}else entry.unknown=true;}
function recoverStaleAdmissions(state){for(const [id,entry] of Object.entries(state.admissions))if(!entry.unknown&&Number.isSafeInteger(entry.startedAt)&&Date.now()-entry.startedAt>=5*60000)rememberUnknown(state,id);}
async function update(store,id,change){
 for(let attempt=0;attempt<12;attempt++){const raw=await store.get(),current=lifecycleRecord(raw,id),draft=structuredClone(current);recoverStaleAdmissions(draft);const result=change(draft,current);draft.version=current.version+1;
  if(await store.compareAndSwap(raw?.version??null,draft,Number.MAX_SAFE_INTEGER-Date.now()))return result===undefined?draft:result(draft);
 }throw conflict();
}
function settle(state){if(state.state==='active'||state.state==='deleted')return;if(state.reason||(state.unknownOverflowCount??0)>0||Object.values(state.admissions).some(a=>a.unknown)){state.state='needs_review';return;}state.state=Object.keys(state.admissions).length===0&&state.ledgerIds.every(id=>state.ledgerAcks[id])?'fenced':'fencing';}
export async function beginLifecycleStore(store,id,data){
 if(!data||typeof data.operationId!=='string'||!/^[A-Za-z0-9_-]{16,150}$/.test(data.operationId)||!Number.isSafeInteger(data.expectedGeneration)||!Array.isArray(data.ledgerIds)||data.ledgerIds.length>MAX_TARGETS||data.ledgerIds.some(id=>!validHost(id)))throw new HttpError(400,'Choose a valid lifecycle operation.');
 return update(store,id,(state)=>{if(state.operationId===data.operationId&&state.generation===data.expectedGeneration+1){if(JSON.stringify([...state.ledgerIds].sort())!==JSON.stringify([...new Set(data.ledgerIds)].sort()))throw conflict();return;}if(state.state!=='active'||state.generation!==data.expectedGeneration||hasLifecycleReservation(state))throw conflict();state.generation++;state.operationId=data.operationId;state.state='fencing';state.startedAt=Date.now();state.ledgerIds=[...new Set(data.ledgerIds)];state.ledgerAcks={};if(Object.values(state.admissions).some(a=>['workspace_create','workspace_accept','workspace_member','oauth_callback','oauth_calendar'].includes(a.kind)))state.reason='authority_changed';settle(state);});
}
export const beginLifecycle=(env,id,data)=>beginLifecycleStore(lifecycleStore(env,id),id,data);
function operation(state,data){if(!data||state.state==='active'||state.state==='deleted'||state.operationId!==data.operationId||state.generation!==data.generation)throw conflict();}
export async function ackLifecycleStore(store,id,data){return update(store,id,state=>{operation(state,data);if(!state.ledgerIds.includes(data.ledgerId)||!Number.isSafeInteger(data.epoch)||data.epoch<1)throw conflict();if(state.ledgerAcks[data.ledgerId]&&state.ledgerAcks[data.ledgerId]!==data.epoch)throw conflict();state.ledgerAcks[data.ledgerId]=data.epoch;settle(state);});}
export const ackLifecycle=(env,id,data)=>ackLifecycleStore(lifecycleStore(env,id),id,data);
export async function stepLifecycleStore(store,id,data){return update(store,id,state=>{operation(state,data);if(data.step!=='needs_review'||!['unknown_effect','legacy_discovery','storage_failure','authority_changed'].includes(data.reason))throw new HttpError(400,'Choose a valid lifecycle review state.');state.reason=data.reason;settle(state);});}
export const stepLifecycle=(env,id,data)=>stepLifecycleStore(lifecycleStore(env,id),id,data);
export function safeLifecycleStatus(state){return {generation:state.generation,state:state.state,operationId:state.operationId,pendingAuthWrites:Math.min(Number.MAX_SAFE_INTEGER,Object.keys(state.admissions).length+(state.unknownOverflowCount??0)),ledgerCount:state.ledgerIds.length,fencedLedgers:Object.keys(state.ledgerAcks).length,unknownAuthWrites:Math.min(Number.MAX_SAFE_INTEGER,Object.values(state.admissions).filter(a=>a.unknown).length+(state.unknownOverflowCount??0)),needsReview:state.state==='needs_review'||(state.unknownOverflowCount??0)>0||Object.values(state.admissions).some(a=>a.unknown),localDataDeleted:false,providerRevocation:'not_requested'};}
async function admit(env,id,kind,generation){const admissionId=randomToken(16);const state=await update(lifecycleStore(env,id),id,state=>{if(state.state!=='active')throw fenced();if(hasLifecycleReservation(state))throw reserved();if(state.generation!==generation)throw conflict();if(Object.values(state.admissions).filter(a=>!a.unknown).length>=MAX_ADMISSIONS)throw new HttpError(429,'Account changes are busy. Try again.');state.admissions[admissionId]={generation,kind,startedAt:Date.now()};});return {admissionId,generation:state.generation};}
async function finish(env,id,admission,{commit=false,unknown=false}={}){
 return update(lifecycleStore(env,id),id,state=>{const entry=state.admissions[admission.admissionId];if(!entry||entry.generation!==admission.generation)throw conflict();
  if(commit&&(state.state!=='active'||state.generation!==admission.generation))return ()=>({committed:false});
  if(unknown)rememberUnknown(state,admission.admissionId);else delete state.admissions[admission.admissionId];settle(state);return ()=>({committed:true});
 });
}
/** A durable in-flight admission prevents the coordinator claiming cross-object writes drained.
 * Cleanup must return true only when all partial writes are settled; otherwise review remains required. */
export async function withLifecycleAdmission(env,id,kind,work,{generation=0,cleanup}={}){
 const admission=await admit(env,id,kind,generation);let pendingWrites=0;
 try{const result=await work({generation,markWrite:()=>{pendingWrites++;},ackWrite:()=>{pendingWrites=Math.max(0,pendingWrites-1);},write:async mutation=>{await assertLifecycleWritable(env,id,generation);pendingWrites++;const value=await mutation();pendingWrites--;return value;},assertActive:()=>assertLifecycleActive(env,id,generation)});const finished=await finish(env,id,admission,{commit:true});if(!finished.committed)throw fenced();return result;}
 catch(error){let settled=pendingWrites===0;if(pendingWrites>0&&typeof cleanup==='function')try{settled=await cleanup(error)===true;}catch{}try{await finish(env,id,admission,{unknown:!settled});}catch{}throw error;}
}

// Phase 2: internal reversible reservations. Every *Sync function is called only
// inside AuthStore's synchronous RPC turn, never as a read/await/CAS sequence.
const RESERVATION_LIMIT=64,RESERVATION_MS=15*60000;
const token=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{16,150}$/.test(value);
const reserved=()=>Object.assign(new HttpError(409,'Account changes are reserved. Try again after cancelling the operation.'),{code:'lifecycle_reserved'});
const reservationError=(code='lifecycle_reservation_changed')=>Object.assign(new HttpError(409,'Lifecycle confirmation changed. Prepare it again.'),{code});
export const hasLifecycleReservation=state=>['reserving','armed'].includes(state?.reservation?.status);
export async function assertLifecycleWritable(env,id,generation=0){const state=await assertLifecycleActive(env,id,generation);if(hasLifecycleReservation(state))throw reserved();return state;}
function binding(data,id,{targets=true}={}){
 if(!data||!token(data.operationId)||!token(data.nonce)||!validHost(data.actorId)||!Number.isSafeInteger(data.actorGeneration)||data.actorGeneration<0||!Number.isSafeInteger(data.expectedGeneration)||data.expectedGeneration<0||typeof data.manifestHash!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(data.manifestHash)||!Number.isSafeInteger(data.notAfter)||data.notAfter<1)throw new HttpError(400,'Choose a valid confirmation reservation.');
 const out={coordinatorId:id,operationId:data.operationId,nonce:data.nonce,actorId:data.actorId,actorGeneration:data.actorGeneration,expectedGeneration:data.expectedGeneration,manifestHash:data.manifestHash,notAfter:data.notAfter};
 if(targets){if(!Array.isArray(data.targets)||data.targets.length<1||data.targets.length>2)throw new HttpError(400,'Choose valid confirmation targets.');out.targets=data.targets.map(t=>{if(!t||!['host','ownership'].includes(t.kind)||t.id!==id||!Number.isSafeInteger(t.revision)||t.revision<0)throw new HttpError(400,'Choose valid confirmation targets.');return {kind:t.kind,id:t.id,revision:t.revision};}).sort((a,b)=>a.kind.localeCompare(b.kind));if(out.targets.filter(t=>t.kind==='host').length!==1||new Set(out.targets.map(t=>t.kind)).size!==out.targets.length)throw new HttpError(400,'Choose valid confirmation targets.');}
 return out;
}
const sameBinding=(a,b)=>['coordinatorId','operationId','nonce','actorId','actorGeneration','expectedGeneration','manifestHash','notAfter'].every(k=>a[k]===b[k])&&(!b.targets||JSON.stringify(a.targets)===JSON.stringify(b.targets));
function findReservation(state,data){const found=state.reservation?.operationId===data.operationId?state.reservation:state.reservationHistory?.find(r=>r.operationId===data.operationId);if(found&&(found.nonce!==data.nonce||found.manifestHash!==data.manifestHash))throw reservationError();return found;}
function selected(state,reservation){return {...structuredClone(state),reservation:reservation?structuredClone(reservation):null,readAt:Date.now()};}
function persistSync(store,state){state.version++;store.put(state,Number.MAX_SAFE_INTEGER-Date.now());}
function history(state,r){state.reservationHistory??=[];if(!state.reservationHistory.some(x=>x.operationId===r.operationId)){const pendingSlot=hasLifecycleReservation(state)&&state.reservation.operationId!==r.operationId?1:0;if(state.reservationHistory.length+pendingSlot>=RESERVATION_LIMIT)throw reservationError('lifecycle_reservation_capacity');state.reservationHistory.push(structuredClone(r));}}
function deadline(r){return Math.min(r.notAfter,...Object.values(r.proofs||{}).map(p=>p.notAfter));}
function terminal(state,r,status){r.status=status;r.settledAt=Date.now();history(state,r);}
function exact(state,id,data){const b=binding(data,id,{targets:data?.targets!==undefined}),r=findReservation(state,b);if(!r||!sameBinding(r,b))throw reservationError();return r;}
function liveReservation(state,r){if(state.state!=='active'||state.generation!==r.expectedGeneration||!['reserving','armed'].includes(r.status))throw reservationError();}
function validateProofs(state,r){liveReservation(state,r);if(Date.now()>=deadline(r))throw reservationError('lifecycle_reservation_expired');if(Object.keys(state.admissions).length||(state.unknownOverflowCount??0)>0)throw reservationError('lifecycle_reservation_busy');if(r.targets.some(t=>!r.proofs[t.kind+':'+t.id]))throw reservationError('lifecycle_proofs_missing');}
export function reserveLifecycleSync(store,id,data){
 const b=binding(data,id),state=structuredClone(lifecycleRecord(store.get(),id)),old=findReservation(state,b);
 if(old){if(!sameBinding(old,b))throw reservationError();if(['reserving','armed'].includes(old.status))liveReservation(state,old);return selected(state,old);}
 if(state.state!=='active'||state.generation!==b.expectedGeneration||hasLifecycleReservation(state))throw reservationError();
 if(Date.now()>=b.notAfter||b.notAfter>Date.now()+RESERVATION_MS)throw reservationError('lifecycle_reservation_expired');
 if((state.reservationHistory?.length??0)>=RESERVATION_LIMIT)throw reservationError('lifecycle_reservation_capacity');
 if(Object.keys(state.admissions).length||(state.unknownOverflowCount??0)>0)throw reservationError('lifecycle_reservation_busy');
 state.reservation={...b,status:'reserving',createdAt:Date.now(),proofs:{}};persistSync(store,state);return selected(state,state.reservation);
}
export function readLifecycleReservationSync(store,id,data){const state=lifecycleRecord(store.get(),id);if(!data||!token(data.operationId)||!token(data.nonce)||typeof data.manifestHash!=='string')throw new HttpError(400,'Choose a confirmation reservation.');return selected(state,findReservation(state,data));}
export function registerLifecycleProofSync(store,id,data){
 const state=structuredClone(lifecycleRecord(store.get(),id)),r=findReservation(state,data);if(!r)throw reservationError();liveReservation(state,r);
 if(Date.now()>=deadline(r))throw reservationError('lifecycle_reservation_expired');
 const t=r.targets.find(t=>t.kind===data.kind&&t.id===data.id),key=data.kind+':'+data.id;
 if(!t||!token(data.proofNonce)||data.revision!==t.revision||!Number.isSafeInteger(data.notAfter)||data.notAfter>r.notAfter||Date.now()>=data.notAfter)throw reservationError();
 const proof={proofNonce:data.proofNonce,revision:data.revision,notAfter:data.notAfter};
 if(r.proofs[key]){if(JSON.stringify(r.proofs[key])!==JSON.stringify(proof))throw reservationError();return selected(state,r);}
 if(r.status!=='reserving')throw reservationError();r.proofs[key]=proof;persistSync(store,state);return selected(state,r);
}
export function armLifecycleReservationSync(store,id,data){const state=structuredClone(lifecycleRecord(store.get(),id)),r=exact(state,id,data);if(r.status==='begun')return selected(state,r);validateProofs(state,r);if(r.status!=='armed'){r.status='armed';persistSync(store,state);}return selected(state,r);}
export function beginReservedLifecycleSync(store,id,data){
 const state=structuredClone(lifecycleRecord(store.get(),id)),r=exact(state,id,data);if(r.status==='begun')return selected(state,r);
 validateProofs(state,r);if(r.status!=='armed')throw reservationError();
 terminal(state,r,'begun');state.generation++;state.operationId=r.operationId;state.startedAt=Date.now();state.state='fencing';state.ledgerIds=[id];state.ledgerAcks={};settle(state);persistSync(store,state);return selected(state,r);
}
export function cancelLifecycleReservationSync(store,id,data){
 const b=binding(data,id,{targets:false}),state=structuredClone(lifecycleRecord(store.get(),id));if(!['cancelled','expired'].includes(data.reason))throw new HttpError(400,'Choose cancellation or expiry.');let r=findReservation(state,b);
 if(r&&!sameBinding(r,b))throw reservationError();if(r&&['begun','cancelled','expired'].includes(r.status))return selected(state,r);
 if(r)liveReservation(state,r);
 if(!r){if(state.state!=='active'||state.generation!==b.expectedGeneration)throw reservationError();r={...b,status:'reserving',proofs:{},targets:[]};}
 if(data.reason==='expired'&&Date.now()<deadline(r))throw reservationError('lifecycle_reservation_not_expired');
 terminal(state,r,data.reason);if(state.reservation?.operationId===r.operationId)state.reservation=r;persistSync(store,state);return selected(state,r);
}
const rpcResult=value=>{if(value?.error)throw Object.assign(new HttpError(value.status||503,value.error),{code:value.code});return value;};
const reservationRPC=async(env,id,method,data)=>rpcResult(await lifecycleStore(env,id)[method](id,data));
export const reserveLifecycle=(env,id,data)=>reservationRPC(env,id,'lifecycleReserve',data);
export const registerLifecycleProof=(env,id,data)=>reservationRPC(env,id,'lifecycleRegisterProof',data);
export const readLifecycleReservation=(env,id,data)=>reservationRPC(env,id,'lifecycleReservationRead',data);
export const armLifecycleReservation=(env,id,data)=>reservationRPC(env,id,'lifecycleArm',data);
export const beginReservedLifecycle=(env,id,data)=>reservationRPC(env,id,'lifecycleBeginReserved',data);
export const cancelLifecycleReservation=(env,id,data)=>reservationRPC(env,id,'lifecycleCancelReservation',data);

// Account deletion job metadata lives with its authoritative lifecycle fence.
// These synchronous RPC transitions never accept a client-supplied completion claim.
export function attachAccountDeletionSync(store,id,data){
 const state=structuredClone(lifecycleRecord(store.get(),id)),r=state.reservation;
 if(!data||!token(data.operationId)||typeof data.publicOperationId!=='string'||!data.publicOperationId.startsWith(id+'.')||typeof data.receiptHash!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(data.receiptHash)||!Number.isSafeInteger(data.requestedAt)||!Number.isSafeInteger(data.deleteBy)||data.deleteBy<=data.requestedAt||!data.manifest||JSON.stringify(data.manifest).length>750000)throw new HttpError(400,'Choose a valid account deletion.');
 if(state.deletion?.operationId===data.operationId){if(state.deletion.receiptHash!==data.receiptHash)throw conflict();return state;}
 if(state.state!=='active'||state.generation!==data.expectedGeneration||!r||r.operationId!==data.operationId||!['reserving','armed'].includes(r.status)||!sameBinding(r,binding(data.binding,id)))throw conflict();
 state.deletion={operationId:data.operationId,publicOperationId:data.publicOperationId,receiptHash:data.receiptHash,requestedAt:data.requestedAt,deleteBy:data.deleteBy,manifest:structuredClone(data.manifest),binding:structuredClone(data.binding),stage:'confirming'};
 persistSync(store,state);return state;
}
export function updateAccountDeletionSync(store,id,data){
 const state=structuredClone(lifecycleRecord(store.get(),id));operation(state,data);
 if(state.deletion?.operationId!==data.operationId||!['fencing','purging','needs_review'].includes(data.stage)||data.code!==undefined&&!/^[a-z_]{1,60}$/.test(data.code))throw conflict();
 if(state.state==='deleted')return state;
 state.deletion.stage=data.stage;if(data.code)state.deletion.code=data.code;else delete state.deletion.code;
 if(data.stage==='needs_review')state.deletion.needsReview=true;
 persistSync(store,state);return state;
}
export function completeAccountDeletionSync(store,id,data){
 const state=structuredClone(lifecycleRecord(store.get(),id));operation(state,data);
 if(state.deletion?.operationId!==data.operationId)throw conflict();if(state.state==='deleted')return state;
 if(state.state!=='fenced'||state.reason||Object.keys(state.admissions).length||(state.unknownOverflowCount??0)>0||!state.ledgerIds.every(target=>state.ledgerAcks[target])||state.deletion.stage!=='purging')throw conflict();
 const d=state.deletion;state.state='deleted';state.deletion={operationId:d.operationId,publicOperationId:d.publicOperationId,receiptHash:d.receiptHash,requestedAt:d.requestedAt,deleteBy:d.deleteBy,completedAt:Date.now(),stage:'deleted'};
 delete state.reservation;delete state.reservationHistory;persistSync(store,state);return state;
}
