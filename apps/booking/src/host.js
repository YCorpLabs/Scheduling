import {activeHostCall,hostLifecycleImpact,fenceHostLifecycle,drainHostLifecycle,purgeHostLifecycle,reserveHostLifecycle,reconcileHostReservation,releaseHostReservation} from './host-lifecycle.js';
import { DurableObject } from 'cloudflare:workers';
import { BookingLedger } from './ledger.js';
import {HostedSettings} from './settings.js';
import {notificationConfigured} from './notifications.js';
import {memberDeletionImpact,detachDeletedMemberCalendar} from './account-dependencies.js';
// One object per host owns every meeting type and connected calendar account.
// Only the authenticated router may expose administrative RPCs.
export class LiveBookingHost extends DurableObject {
  constructor(ctx,env){
    super(ctx,env);this.ledger=new BookingLedger(ctx,env);this.hostedSettings=new HostedSettings(this.ledger,ctx.storage,{reminders:notificationConfigured(env)});
    this.fenceChecked=false;this.fenceChain=Promise.resolve();
    // Before any request, alarm or watchdog call: compare this object's storage
    // with the authoritative maintenance fence. Older storage means a restore
    // happened, so queued emails are quarantined and outbound work stays frozen.
    // A failure here rejects the start (fail closed) and is retried on next use.
    ctx.blockConcurrencyWhile(()=>this.checkFence());
  }
  async checkFence(){const lifecycle=await this.ledger.syncLifecycleState();if(lifecycle.fenced||lifecycle.reserved){this.fenceChecked=true;return {checked:true,lifecycleFenced:lifecycle.fenced,reserved:lifecycle.reserved};}const result=await this.ledger.syncMaintenanceFence();if(result.checked)this.fenceChecked=true;return result;}
  serialFence(fn){const run=this.fenceChain.then(fn,fn);this.fenceChain=run.catch(()=>{});return run;}
  init(profile){return this.#active(async()=>{const settings=this.ledger.init(profile);if(!this.fenceChecked)await this.serialFence(()=>this.checkFence());return settings;},{hostId:profile?.id});}
  async #active(run,options){try{return await activeHostCall(this.ledger,run,options);}catch(error){if(['lifecycle_reserved','lifecycle_fenced','lifecycle_changed','lifecycle_conflict','lifecycle_unavailable'].includes(error.code))return {error:error.message,status:error.status??503,code:error.code};throw error;}}
  lifecycleReserve(data){return this.serialFence(()=>reserveHostLifecycle(this.ledger,data));}
  lifecycleReservationStatus(data){return reconcileHostReservation(this.ledger,data);}
  lifecycleReleaseReservation(data){return this.serialFence(()=>releaseHostReservation(this.ledger,data));}
  lifecycleImpact(){return hostLifecycleImpact(this.ledger);}
  accountCleanupIdentity(){return {hostId:this.ledger.hostId()||null};}
  lifecycleFence(data){return this.serialFence(()=>fenceHostLifecycle(this.ledger,data));}
  lifecycleDrain(data){return drainHostLifecycle(this.ledger,data);}
  lifecyclePurge(data){return this.serialFence(()=>purgeHostLifecycle(this.ledger,data));}
  accountDeletionDependencies(memberId,email){return this.#active(()=>memberDeletionImpact(this.ledger,memberId,email),{readOnly:true});}
  detachDeletedMember(data){return this.serialFence(()=>this.#active(()=>detachDeletedMemberCalendar(this.ledger,data)));}
  exportPage(options){return this.#active(async()=>{return this.ledger.exportPage(options);},{readOnly:true});}
  exportContribution(memberId,accountId){return this.#active(async()=>{return this.ledger.exportContribution(memberId,accountId);},{readOnly:true});}
  memberCalendarEpoch(id){return this.#active(async()=>{return this.ledger.memberCalendarEpoch(id);},{readOnly:true});}
  fenceMemberCalendar(id){return this.#active(async()=>{return this.ledger.fenceMemberCalendar(id);});}
  withdrawMemberCalendar(identity,id){return this.#active(async()=>{return this.ledger.withdrawMemberCalendar(identity,id);});}
  memberCalendarReadiness(){return this.#active(async()=>{return this.ledger.memberCalendarReadiness();},{readOnly:true});}
  contributionState(identity,id){return this.#active(async()=>{return this.ledger.contributionState(identity,id);},{readOnly:true});}
  ownCalendarReadiness(member){return this.#active(async()=>{return this.ledger.ownCalendarReadiness(member);},{readOnly:true});}
  ownCalendar(member){return this.#active(async()=>{return this.ledger.ownCalendar(member);});}
  configureOwnCalendar(member,data){return this.#active(async()=>{return this.ledger.configureOwnCalendar(member,data);});}
  disconnectOwnCalendar(member,data){return this.#active(async()=>{return this.ledger.disconnectOwnCalendar(member,data);});}
  connectAccount(grant){return this.#active(async()=>{return this.ledger.connect(grant);});}
  settings(){return this.#active(async()=>{return this.ledger.settings();},{readOnly:true});}
  settingsWithRevision(){return this.#active(async()=>{try{return await this.hostedSettings.read();}catch(error){return settingsError(error);}},{readOnly:true});}
  previewSettings(patch){return this.#active(async()=>{try{return await this.hostedSettings.preview(patch);}catch(error){return settingsError(error);}});}
  applySettings(patch,expectedRevision){return this.#active(async()=>{try{return await this.hostedSettings.apply(patch,expectedRevision);}catch(error){return settingsError(error);}});}
  listCalendars(){return this.#active(async()=>{return this.ledger.listCalendars();});}
  configureCalendars(data){return this.#active(async()=>{return this.ledger.configureCalendars(data);});}
  rescheduleAvailability(id,token,range,authority){return this.#active(async()=>{return this.ledger.rescheduleAvailability(id,token,range,authority);});}
  availability(slug,range){return this.#active(async()=>{return this.ledger.availability(slug,range);});}
  reserve(slug,data){return this.#active(async()=>{return this.ledger.reserve(slug,data);});}
  hostBooking(id){return this.#active(async()=>{return this.ledger.hostBooking(id);});}
  decideBooking(id,data){return this.#active(async()=>{return this.ledger.decideBooking(id,data);});}
  manage(id,token){return this.#active(async()=>{return this.ledger.manage(id,token);});}
  cancel(id,token,reason,authority){return this.#active(async()=>{return this.ledger.cancel(id,token,reason,authority);});}
  reschedule(id,token,start,key,authority){return this.#active(async()=>{return this.ledger.reschedule(id,token,start,key,authority);});}
  analytics(){return this.#active(async()=>{return this.ledger.analytics();});}
  recordVisit(slug,source){return this.#active(async()=>{return this.ledger.recordVisit(slug,source);});}
  listBookings(options){return this.#active(async()=>{await this.ledger.resumeConfirmedSync();return this.ledger.listBookings(options);});}
  disconnect(accountId){return this.#active(async()=>{return this.ledger.disconnect(accountId);});}
  runMaintenance(source){return this.#active(async()=>{return this.ledger.runMaintenance(source==='watchdog'?'watchdog':'manual');},{quiet:source==='watchdog'});}
  operationalStatus(){return this.#active(async()=>{return this.ledger.operationalStatus();});}
  integrationStatus(){return this.#active(async()=>{return this.ledger.integrationStatus();});}
  configureIntegration(data){return this.#active(async()=>{return this.ledger.configureIntegration(data);});}
  testIntegration(data){return this.#active(async()=>{return this.ledger.testIntegration(data);});}
  retryIntegrationDelivery(data){return this.#active(async()=>{return this.ledger.retryIntegrationDelivery(data);});}
  resolveParkedDelivery(data){return this.#active(async()=>{return this.ledger.resolveParkedDelivery(data);});}
  // Owner action: {action:'freeze'|'resume',expectedEpoch}. Serialized so two
  // transitions can never interleave around the authoritative fence write.
  setMaintenance(data){return this.#active(async()=>{return this.serialFence(()=>this.ledger.setMaintenance(data));});}
  // Deliberately not routed: invoked only by a reviewed restore deployment.
  quarantineDeliveriesAfterRestore(){return this.#active(async()=>{return this.ledger.quarantineDeliveriesAfterRestore();});}
  alarm(){return this.#active(async()=>{return this.ledger.alarm();},{quiet:true});}
}

function settingsError(error){if(error.code==='settings_conflict'||error.code==='invalid_settings')return {error:error.message,status:error.code==='settings_conflict'?409:400,code:error.code};return {error:'Settings are temporarily unavailable. Try again.',status:503,code:'settings_unavailable'};}
