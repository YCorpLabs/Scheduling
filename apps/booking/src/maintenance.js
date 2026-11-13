// Fail-closed maintenance fence for one hosted scheduling ledger.
//
// While frozen, the ledger performs no calendar writes and sends no email from
// any entry point (requests, alarms, manual repair or the cron watchdog), and
// guests cannot book, reschedule, cancel or see bookable slots. Reads that do
// not change provider state (token refresh, free/busy, event GET) still work.
//
// The authoritative fence lives outside the host object (in AUTH), so it
// survives a restore of the host's own storage. Freeze closes the host gate
// first; resume commits the authoritative epoch before opening the host gate.
// An authoritative epoch newer than the host's own means rollback or an
// interrupted resume. Either way, on the next start the host
// quarantines every queued email and stays frozen until an owner resumes it.
export const FENCE_META='operations:fence';
export const RESTORE_DETECTED_META='operations:lastRestoreDetected';
export const MAINTENANCE_MESSAGE='Scheduling is paused for maintenance. Please try again later.';
const FENCE_TTL=10*365*86400000;
// Provider functions that never change calendar state. Anything else, including
// functions added later, is blocked while frozen.
const CALENDAR_READS=new Set(['refreshTokens','listCalendars','freeBusy','getEvent','conferenceDetails','assertManagedEvent']);

export function maintenanceError(kind){return Object.assign(Error(`Outbound ${kind} is paused for maintenance.`),{code:'maintenance_frozen',retryable:true,deliveryUnknown:false});}
export const maintenanceRefusal=()=>({error:MAINTENANCE_MESSAGE,status:503,code:'maintenance_frozen'});
export function fenceStore(env,hostId){return hostId&&env?.AUTH?env.AUTH.getByName('operations-fence:'+hostId):null;}

export function localFence(ledger){
  const f=ledger.meta(FENCE_META);
  return {epoch:Number.isSafeInteger(f?.epoch)&&f.epoch>0?f.epoch:0,frozen:f?.frozen===true,reason:typeof f?.reason==='string'?f.reason:null,changedAt:Number.isSafeInteger(f?.changedAt)?f.changedAt:null};
}

// Last line of defence: provider calls that change external state throw before
// leaving the Worker. Primary gates sit earlier, before any attempt is recorded.
export function guardCalendar(provider,isFrozen){
  return new Proxy(provider,{get(target,key){
    const value=Reflect.get(target,key);
    if(typeof value!=='function'||CALENDAR_READS.has(key))return value;
    return function(...args){if(isFrozen())return Promise.reject(maintenanceError('calendar change'));return value.apply(target,args);};
  }});
}
export function guardNotify(send,isFrozen){return (...args)=>isFrozen()?Promise.reject(maintenanceError('email')):send(...args);}

function validRemote(remote){return remote&&Number.isSafeInteger(remote.epoch)&&remote.epoch>0?remote:null;}
const fenceConflict=()=>Object.assign(Error('Maintenance state changed. Refresh and try again.'),{status:409,code:'maintenance_fence_conflict'});
async function publish(store,fence){
  for(let attempt=0;attempt<8;attempt++){
    const current=await store.get();
    // Never move the authoritative fence backwards.
    if(validRemote(current)&&(current.epoch>fence.epoch||current.epoch===fence.epoch&&current.frozen!==fence.frozen))throw fenceConflict();
    const body={epoch:fence.epoch,frozen:fence.frozen,reason:fence.reason,changedAt:fence.changedAt,version:(current?.version??0)+1};
    if(await store.compareAndSwap(current?.version??null,body,FENCE_TTL))return true;
  }
  throw fenceConflict();
}

// Runs before any handler or alarm on a freshly started host object.
export async function syncMaintenanceFence(ledger,store,now=Date.now()){
  if(!ledger.hostId())return {checked:false};
  if(!store)throw Object.assign(Error('Maintenance fence is unavailable.'),{code:'maintenance_fence_unavailable'});
  const remote=validRemote(await store.get()),local=localFence(ledger);
  const unsafeLocalResume=local.epoch>0&&!local.frozen&&(!remote||local.epoch>remote.epoch);
  if((remote&&remote.epoch>local.epoch)||unsafeLocalResume){
    // Older releases could persist a local resume before AUTH acknowledged it.
    // Never republish that unverified open gate; reconcile its queued mail too.
    const next={epoch:Math.max(local.epoch,remote?.epoch??0)+1,frozen:true,reason:'restore_detected',changedAt:now};let count=0;
    ledger.ctx.storage.transactionSync(()=>{
      count=ledger.quarantineQueuedDeliveries(now);
      ledger.putOperationalMeta(FENCE_META,next);
      ledger.putOperationalMeta(RESTORE_DETECTED_META,{at:now,storageEpoch:local.epoch,fenceEpoch:remote?.epoch??0,quarantined:count,quarantinedIntegrations:ledger.integrations?.quarantinedCount()||0});
    });
    console.warn(JSON.stringify({event:'booking_restore_detected',quarantined:count,quarantinedIntegrations:ledger.integrations?.quarantinedCount()||0}));
    await publish(store,next);
    return {checked:true,restoreDetected:true,quarantined:count};
  }
  if(remote&&remote.epoch===local.epoch&&remote.frozen!==local.frozen){
    // Inconsistent copies: fail closed rather than guess which one is right.
    const next={epoch:local.epoch+1,frozen:true,reason:'fence_mismatch',changedAt:now};
    ledger.putOperationalMeta(FENCE_META,next);await publish(store,next);
    return {checked:true,restoreDetected:false};
  }
  if(local.epoch>0&&(!remote||remote.epoch<local.epoch||remote.frozen!==local.frozen))await publish(store,local);
  return {checked:true,restoreDetected:false};
}

export function maintenanceView(ledger,now=Date.now()){
  const fence=localFence(ledger);
  const inFlight={
    calendar:ledger.rows("SELECT COUNT(*) AS n FROM live_bookings WHERE COALESCE(json_extract(body,'$.leaseUntil'),0)>? OR COALESCE(json_extract(body,'$.syncLeaseUntil'),0)>?",now,now)[0].n,
    deliveries:ledger.rows("SELECT COUNT(*) AS n FROM live_jobs WHERE COALESCE(json_extract(body,'$.leaseUntil'),0)>?",now)[0].n
  };
  const integrationCalls=ledger.integrations?.healthSummary(now).inFlight||0;if(integrationCalls)inFlight.integrations=integrationCalls;
  return {frozen:fence.frozen,epoch:fence.epoch,reason:fence.reason,changedAt:fence.changedAt,inFlight,lastRestoreDetected:ledger.meta(RESTORE_DETECTED_META)};
}

// Owner action. `expectedEpoch` is the epoch the owner reviewed, so a stale
// page cannot undo a newer freeze or a detected restore.
export async function setMaintenance(ledger,store,data,now=Date.now()){
  // RPC does not carry custom error fields, so failures are returned as values.
  try{return await transition(ledger,store,data,now);}
  catch(error){
    const local=localFence(ledger);
    if(!local.frozen)ledger.putOperationalMeta(FENCE_META,{epoch:local.epoch+1,frozen:true,reason:'fence_unavailable',changedAt:now});
    if(error?.code==='maintenance_fence_conflict')return {error:'Maintenance state changed. Refresh and review it again.',status:409,code:error.code};
    console.error(JSON.stringify({event:'booking_maintenance_fence_failed'}));
    return {error:'Maintenance state is temporarily unavailable. Try again.',status:503,code:'maintenance_fence_unavailable'};
  }
}
async function transition(ledger,store,data,now){
  const fail=(error,status=400,code)=>({error,status,...(code?{code}:{})});
  if(!data||typeof data!=='object'||Object.keys(data).some(k=>!['action','expectedEpoch'].includes(k))||!['freeze','resume'].includes(data.action)||!Number.isSafeInteger(data.expectedEpoch))return fail('Choose freeze or resume and the reviewed maintenance state.');
  if(!ledger.hostId())return fail('Host not found.',404);
  if(!store)return fail('Maintenance fence is unavailable.',503,'maintenance_fence_unavailable');
  await syncMaintenanceFence(ledger,store,now);
  const local=localFence(ledger);
  if(data.expectedEpoch!==local.epoch)return fail('Maintenance state changed. Refresh and review it again.',409,'maintenance_fence_conflict');
  const frozen=data.action==='freeze';
  if(local.frozen===frozen)return {ok:true,changed:false,maintenance:maintenanceView(ledger,now)};
  if(!frozen){
    if(ledger.integrations?.quarantinedCount())return fail('Discard restored integration deliveries before resuming.',409,'integration_restore_quarantine');
    const quarantined=ledger.rows("SELECT COUNT(*) AS n FROM live_jobs WHERE json_extract(body,'$.restoreQuarantine')=1")[0].n;
    if(quarantined)return fail('Resolve or release every email quarantined after the restore before resuming.',409,'restore_quarantine');
  }
  const remote=validRemote(await store.get());
  if(remote&&remote.epoch>local.epoch)throw fenceConflict();
  const next={epoch:Math.max(local.epoch,remote?.epoch??0)+1,frozen,reason:frozen?'operator':null,changedAt:now};
  // Never open the local gate until AUTH has acknowledged the newer epoch.
  // A crash after publishing resume leaves AUTH ahead; startup quarantines and
  // freezes conservatively. Failed publication leaves the old host gate closed.
  if(frozen)ledger.putOperationalMeta(FENCE_META,next);
  await publish(store,next);
  if(!frozen)ledger.putOperationalMeta(FENCE_META,next);
  console.log(JSON.stringify({event:'booking_maintenance_fence',frozen}));
  if(!frozen)await ledger.wake();
  return {ok:true,changed:true,maintenance:maintenanceView(ledger,now)};
}
