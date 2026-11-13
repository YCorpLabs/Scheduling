import {HttpError} from './http.js';
import {base64url,randomToken,sha256,timingSafeEqual} from './crypto.js';
import {assertLifecycleActive,lifecycleSnapshot,lifecycleStore,reserveLifecycle,armLifecycleReservation,beginReservedLifecycle,cancelLifecycleReservation,ackLifecycle} from './lifecycle.js';
import {discoverAccountDeletion,purgeAccountData} from './account-cleanup.js';
import {discoverAccountDependencies,detachAccountDependencies} from './account-dependencies.js';

const HOST=/^h_[A-Za-z0-9_-]{24}$/,TTL=10*60000,encoder=new TextEncoder();
const error=(status,message,code)=>Object.assign(new HttpError(status,message),{code});
const checked=value=>{if(value?.error)throw error(value.status||503,value.error,value.code||'deletion_unavailable');return value;};
const rpc=async(env,id,method,data)=>checked(await lifecycleStore(env,id)[method](id,data));
const changed=()=>error(409,'Your account changed. Review deletion again.','deletion_changed');
const strict=(data,keys)=>{if(!data||typeof data!=='object'||Array.isArray(data)||Object.keys(data).some(k=>!keys.includes(k)))throw error(400,'Choose a valid deletion request.','invalid_deletion');};
function principal(user){if(!user||!HOST.test(user.hostId||'')||typeof user.email!=='string')throw error(401,'Sign in to continue.','unauthenticated');return user;}
function operationHost(operationId){const m=/^(h_[A-Za-z0-9_-]{24})\.([A-Za-z0-9_-]{32})$/.exec(operationId||'');if(!m)throw error(404,'Deletion status is unavailable.','deletion_not_found');return m[1];}
export function oneMonthAfter(at){const d=new Date(at),year=d.getUTCFullYear(),month=d.getUTCMonth(),day=d.getUTCDate(),end=new Date(Date.UTC(year,month+2,0)).getUTCDate();d.setUTCDate(1);d.setUTCMonth(month+1);d.setUTCDate(Math.min(day,end));return d.getTime();}
async function sign(env,text){if(typeof env.TOKEN_ENCRYPTION_KEY!=='string')throw error(503,'Deletion is unavailable.','deletion_unavailable');const key=await crypto.subtle.importKey('raw',encoder.encode('account-deletion-confirm:v1:'+env.TOKEN_ENCRYPTION_KEY),{name:'HMAC',hash:'SHA-256'},false,['sign']);return base64url(await crypto.subtle.sign('HMAC',key,encoder.encode(text)));}
async function encode(env,payload){const data=base64url(encoder.encode(JSON.stringify(payload)));return data+'.'+await sign(env,data);}
async function decode(env,token){
 if(typeof token!=='string'||token.length>5000)throw changed();const parts=token.split('.');if(parts.length!==2||!await timingSafeEqual(parts[1],await sign(env,parts[0])))throw changed();
 let value;try{value=JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(parts[0].replace(/-/g,'+').replace(/_/g,'/')),c=>c.charCodeAt(0))));}catch{throw changed();}
 if(value?.schema!==1||!HOST.test(value.hostId)||operationHost(value.operationId)!==value.hostId||!Number.isSafeInteger(value.expiresAt)||!Number.isSafeInteger(value.revision)||!Number.isSafeInteger(value.generation)||typeof value.manifestHash!=='string'||typeof value.receiptHash!=='string'||typeof value.nonce!=='string')throw changed();return value;
}
const block=(code,label,count)=>({code,label,...(count?{count}:{})});
async function discover(env,user){
 const state=await assertLifecycleActive(env,user.hostId,0),host=env.LIVE_HOSTS.getByName(user.hostId),impact=checked(await host.lifecycleImpact());
 const cleanup=await discoverAccountDeletion(env,user.hostId),dependencies=await discoverAccountDependencies(env,user);
 const blockers=[...(cleanup.blockers||[]),...(dependencies.blockers||[])];
 const b=impact.blockers||{};
 if(b.futureBookings)blockers.push(block('future_bookings','Cancel or complete your upcoming bookings first.',b.futureBookings));
 if(b.unresolvedBookings||b.replacements||b.calendarLeases)blockers.push(block('pending_bookings','Resolve your pending bookings first.',(b.unresolvedBookings||0)+(b.replacements||0)+(b.calendarLeases||0)));
 if(impact.needsReview||b.outboundCalls||b.uncertainEmails||b.uncertainIntegrations)blockers.push(block('pending_external_work','Booking activity needs to finish or be reviewed.'));
 if(Object.keys(state.admissions).length||(state.unknownOverflowCount??0)>0)blockers.push(block('pending_account_work','Account activity needs to finish or be reviewed.'));
 const manifestHash=await sha256(JSON.stringify({revision:impact.revision,cleanup:cleanup.digestInput,dependencies:dependencies.digestInput}));
 return {state,impact,blockers,manifestHash,manifest:{cleanup:cleanup.manifest,dependencies:dependencies.manifest,actor:{hostId:user.hostId,email:user.email}}};
}
export async function prepareAccountDeletion(env,user,data={}){
 principal(user);strict(data,[]);const found=await discover(env,user),operationId=user.hostId+'.'+randomToken(24),receipt=randomToken(),now=Date.now();
 const payload={schema:1,hostId:user.hostId,identityHash:await sha256(user.email.toLowerCase()),operationId,receiptHash:await sha256(receipt),nonce:randomToken(24),revision:found.impact.revision,generation:found.state.generation,manifestHash:found.manifestHash,expiresAt:now+TTL};
 return {operationId,receipt,confirmationToken:await encode(env,payload),expiresAt:payload.expiresAt,blockers:found.blockers,canDelete:found.blockers.length===0,impact:{...(found.impact.counts||{})}};
}
function status(state,operationId){
 const d=state.deletion;if(!d||(d.publicOperationId||d.operationId)!==operationId)return {operationId,state:'not_started',localDataDeleted:false,providerRevocation:'not_requested',needsReview:false};
 let phase=state.state==='deleted'?'deleted':state.state==='active'?(['cancelled','expired'].includes(state.reservation?.status)?'not_started':'prepared'):state.state==='needs_review'||d.stage==='needs_review'?'needs_review':'fencing';
 return {operationId,state:phase,localDataDeleted:phase==='deleted',providerRevocation:'not_requested',needsReview:phase==='needs_review',requestedAt:d.requestedAt,deleteBy:d.deleteBy,...(d.completedAt?{completedAt:d.completedAt}:{}),...(d.code?{code:d.code}:{})};
}
async function cancelBeforeBegin(env,id,binding){
 const outcome=await cancelLifecycleReservation(env,id,{...binding,reason:'cancelled'});
 if(outcome.reservation?.status==='begun')return false;
 try{await env.LIVE_HOSTS.getByName(id).lifecycleReservationStatus({...Object.fromEntries(Object.entries(binding).filter(([k])=>k!=='targets')),expectedRevision:binding.targets[0].revision});}catch{/* Authoritative cancellation is durable; ordinary admission also reconciles. */}return true;
}
async function executeConfirm(env,id,state){
 const d=state.deletion,binding=d.binding,host=env.LIVE_HOSTS.getByName(id);
 if(state.state==='active'){
  if(Date.now()>=binding.notAfter){await cancelBeforeBegin(env,id,binding);return status(await lifecycleSnapshot(env,id),d.publicOperationId||d.operationId);}
  try{
   const fresh=await discover(env,d.manifest.actor);if(fresh.blockers.length||fresh.manifestHash!==binding.manifestHash)throw changed();
   const {targets,...hostBinding}=binding;const r=checked(await host.lifecycleReserve({...hostBinding,expectedRevision:targets[0].revision}));
   if(!r.reserved&&!r.fenced)throw changed();await armLifecycleReservation(env,id,binding);await beginReservedLifecycle(env,id,binding);
  }catch(e){if(await cancelBeforeBegin(env,id,binding))throw e;}
 }
 return resumeAccountDeletion(env,id);
}
export async function confirmAccountDeletion(env,user,data){
 principal(user);strict(data,['confirmationToken']);const payload=await decode(env,data.confirmationToken);
 if(payload.hostId!==user.hostId||payload.identityHash!==await sha256(user.email.toLowerCase()))throw error(403,'This confirmation belongs to another account.','deletion_changed');
 const existing=await lifecycleSnapshot(env,user.hostId);
 if(existing.deletion?.publicOperationId===payload.operationId)return executeConfirm(env,user.hostId,existing);
 if(payload.expiresAt<=Date.now())throw error(409,'This confirmation expired. Review deletion again.','deletion_expired');
 const found=await discover(env,user);if(found.blockers.length||found.manifestHash!==payload.manifestHash||found.state.generation!==payload.generation)throw changed();
 const binding={coordinatorId:user.hostId,operationId:payload.nonce,nonce:payload.nonce,actorId:user.hostId,actorGeneration:payload.generation,expectedGeneration:payload.generation,manifestHash:payload.manifestHash,notAfter:payload.expiresAt,targets:[{kind:'host',id:user.hostId,revision:payload.revision}]};
 // Public receipt IDs contain a locator; the coordinator operation remains an opaque nonce.
 const jobOperationId=payload.operationId;
 await reserveLifecycle(env,user.hostId,binding);
 try{await rpc(env,user.hostId,'accountDeletionAttach',{operationId:binding.operationId,publicOperationId:jobOperationId,expectedGeneration:payload.generation,receiptHash:payload.receiptHash,manifest:found.manifest,binding,requestedAt:Date.now(),deleteBy:oneMonthAfter(Date.now())});await env.AUTH.getByName('host-registry').register(user.hostId);}
 catch(e){await cancelBeforeBegin(env,user.hostId,binding);throw e;}
 return executeConfirm(env,user.hostId,await lifecycleSnapshot(env,user.hostId));
}
export async function resumeAccountDeletion(env,hostId){
 let state=await lifecycleSnapshot(env,hostId),d=state.deletion;if(!d||state.state==='deleted')return d?status(state,d.publicOperationId||d.operationId):null;
 if(state.state==='active'){if(['cancelled','expired'].includes(state.reservation?.status))return status(state,d.publicOperationId||d.operationId);return executeConfirm(env,hostId,state);}
 const request={operationId:state.operationId,generation:state.generation},publicId=d.publicOperationId||d.operationId;
 try{
  if(state.state==='needs_review'||Object.keys(state.admissions).length||(state.unknownOverflowCount??0)>0){await rpc(env,hostId,'accountDeletionUpdate',{...request,stage:'needs_review',code:'pending_account_work'});return status(await lifecycleSnapshot(env,hostId),publicId);}
  const host=env.LIVE_HOSTS.getByName(hostId),fence=checked(await host.lifecycleFence({...request,expectedRevision:d.binding.targets[0].revision}));
  if(fence.needsReview){await rpc(env,hostId,'accountDeletionUpdate',{...request,stage:'needs_review',code:'pending_external_work'});return status(await lifecycleSnapshot(env,hostId),publicId);}
  await ackLifecycle(env,hostId,{...request,ledgerId:hostId,epoch:fence.epoch});state=await lifecycleSnapshot(env,hostId);
  if(state.state!=='fenced')return status(state,publicId);
  const drain=checked(await host.lifecycleDrain(request));if(!drain.drained){await rpc(env,hostId,'accountDeletionUpdate',{...request,stage:drain.needsReview?'needs_review':'fencing',code:'pending_external_work'});return status(await lifecycleSnapshot(env,hostId),publicId);}
  const detached=await detachAccountDependencies(env,hostId,{...request,manifest:d.manifest.dependencies});if(!detached.done){await rpc(env,hostId,'accountDeletionUpdate',{...request,stage:detached.needsReview?'needs_review':'fencing',code:detached.code||'pending_memberships'});return status(await lifecycleSnapshot(env,hostId),publicId);}
  await rpc(env,hostId,'accountDeletionUpdate',{...request,stage:'purging'});
  const purged=checked(await host.lifecyclePurge(request));if(!purged.purged){await rpc(env,hostId,'accountDeletionUpdate',{...request,stage:purged.needsReview?'needs_review':'fencing',code:'pending_external_work'});return status(await lifecycleSnapshot(env,hostId),publicId);}
  const cleanup=await purgeAccountData(env,hostId,{...request,manifest:d.manifest.cleanup});if(!cleanup.done){await rpc(env,hostId,'accountDeletionUpdate',{...request,stage:cleanup.needsReview?'needs_review':'fencing',code:cleanup.code||'pending_cleanup'});return status(await lifecycleSnapshot(env,hostId),publicId);}
  const complete=await rpc(env,hostId,'accountDeletionComplete',request);return status(complete,publicId);
 }catch{
  try{await rpc(env,hostId,'accountDeletionUpdate',{...request,stage:'fencing',code:'cleanup_retry'});}catch{}
  return status(await lifecycleSnapshot(env,hostId),publicId);
 }
}
export async function accountDeletionStatus(env,data){
 strict(data,['operationId','receipt']);const hostId=operationHost(data.operationId);if(typeof data.receipt!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(data.receipt))throw error(404,'Deletion status is unavailable.','deletion_not_found');
 const state=await lifecycleSnapshot(env,hostId),d=state.deletion;
 if(!d)return {operationId:data.operationId,state:'not_started',localDataDeleted:false,providerRevocation:'not_requested',needsReview:false};
 if((d.publicOperationId||d.operationId)!==data.operationId||!await timingSafeEqual(d.receiptHash,await sha256(data.receipt)))throw error(404,'Deletion status is unavailable.','deletion_not_found');
 return state.state==='deleted'?status(state,data.operationId):await resumeAccountDeletion(env,hostId);
}
