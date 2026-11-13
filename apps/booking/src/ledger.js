import {installHostLifecycle,installLifecycleRevision,lifecycleBlocked,lifecycleDenial,lifecycleCalendar,lifecycleNotify,syncHostLifecycle} from './host-lifecycle.js';
import {installExportRevision,ledgerExportPage,ledgerExportContribution} from './export-ledger.js';
import {linkAccessState,linkAdmissionFailure} from '../public/link-access.js';
import {changePolicyForStart,changeWindowOpen} from '../public/change-policy.js';
import {allowedDurations,selectDuration,validDuration} from '../public/durations.js';
import {normalizeTeamScheduling,validateTeamReferences,publicTeam,hostsShareResource} from '../public/team-policy.js';
import {IntegrationOutbox} from './integrations.js';
import {verifiedIdentity} from './identity.js';
import {validateBrandImage} from '../public/branding.js';
import { validateConfig, validZone, policySlots, workingWindowChecker, buffersFor, reminderOffsets, normalizeAvailabilitySchedules, normalizeDefaultAvailabilityScheduleId, resolveAvailabilitySchedule, DEFAULT } from '../public/policy.js';
import { validateIntake, intakeDescription, intakeRevision } from '../public/intake.js';
import { randomToken, sha256, timingSafeEqual, encryptTokens, decryptTokens } from './crypto.js';
import * as google from './google.js';
import { sendNotification, notificationConfigured, prepareNotification } from './notifications.js';
import { bookingNotificationContent } from './notification-content.js';
import { operationalStatus, resolveParkedDelivery } from './operations.js';
import { FENCE_META, guardCalendar, guardNotify, maintenanceRefusal, maintenanceView, syncMaintenanceFence, setMaintenance, fenceStore } from './maintenance.js';
// Accepted moves retain their length even when the host later removes it.
function durationPolicy(type,duration,accepted=false){
 if(!type)return type;
 const selected=accepted?duration:selectDuration(type,duration);if(!validDuration(selected))throw Error('Choose a valid meeting duration.');
 return {...type,duration:selected,durationOptions:accepted&&!allowedDurations(type).includes(selected)?null:type.durationOptions??null};
}
function closedChange(booking,kind,authority){
 if(!booking)return {error:'The original booking has changed.',status:409};
 if(authority?.staff===true||kind==='cancel'&&['pending','awaiting_approval','cancelling','cancelled','rejected','expired'].includes(booking.status))return null;
 return changeWindowOpen(changePolicyForStart(booking.config??{},booking.start),kind)?null:{error:'The time window for this booking change has closed. Contact the organizer.',status:409,code:'change_window_closed'};
}
function cancellationReason(value){if(value===undefined)return '';if(typeof value!=='string'||value.trim().length>500)throw Object.assign(Error('Use a cancellation reason of up to 500 characters.'),{status:400});return value.trim();}
function rememberCancellation(booking,reason){if(booking.status!=='cancelling'&&booking.cancellationIntentAcceptedAt===undefined){booking.cancellationIntentAcceptedAt=Date.now();if(reason)booking.cancellationReason=reason;}}
const MIN=60000;
// Eligibility interval, not a refresh SLA: 100 due events require ~8m15s at
// three reads per alarm / 15s floor even before provider latency.
const SYNC_INTERVAL=5*MIN,SYNC_WINDOW=24*60*MIN,SYNC_BATCH=3;
const quotaKeys=['dailyBookingLimit','weeklyBookingLimit','monthlyBookingLimit','yearlyBookingLimit','dailyBookedMinutesLimit','weeklyBookedMinutesLimit','monthlyBookedMinutesLimit','yearlyBookedMinutesLimit'];
const hasQuota=type=>quotaKeys.some(key=>type[key]);
const QUOTA_RETENTION=400*86400000;
const active = new Set(['awaiting_approval','pending','confirmed','cancelling']);
function validEmail(value){
  if(typeof value!=='string'||value.length>254||/[\u0000-\u0020\u007f]/.test(value))return false;
  const parts=value.split('@');
  return parts.length===2&&parts[0].length<=64&&
    /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/.test(parts[0])&&
    parts[1].includes('.')&&parts[1].split('.').every(label=>/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label));
}
const fail=(error,status=400)=>({error,status});
const reconciliationMessages=new Map([
  ['Calendar authorization needs attention.',{kind:'authorization',message:'Reconnect the Google calendar to resume booking synchronization.'}],
  ['Calendar synchronization is pending.',{kind:'sync',message:'Calendar synchronization is pending. Retry synchronization or check the calendar connection.'}],
  ['The calendar rejected these booking details.',{kind:'sync',message:'The calendar rejected this booking. Check the guest details and choose a new time.'}],
  ['Calendar event needs review.',{kind:'sync',message:'The calendar event could not be safely synchronized. Review its calendar details.'}],
  ['This calendar booking was deleted.',{kind:'sync',message:'The calendar booking was deleted. Choose a new time if the meeting is still needed.'}]
]);
function logReconciliationFailure(code,status){
  console.error(JSON.stringify({event:'booking_reconciliation_failed',code,status:Number.isInteger(status)&&status>=100&&status<=599?status:0}));
}
const policyBuffers=buffersFor;
const overlap=(a,b,buffer=0)=>{const {before,after}=typeof buffer==='number'?{before:buffer,after:buffer}:buffer;return a.start<b.end+Math.max(before,b.after??b.buffer??0)&&a.end+Math.max(after,b.before??b.buffer??0)>b.start;};
const cleanBooking=b=>({changePolicy:changePolicyForStart(b.config??{},b.start),...(typeof b.cancellationReason==='string'&&b.cancellationReason?{cancellationReason:b.cancellationReason}:{}),... (b.teamAssignment?{teamMode:b.teamAssignment.mode,assignedHosts:b.teamAssignment.hosts.map(({id,name})=>({id,name}))}:{}),...Object.fromEntries(['id','status','version','duration','approvalExpiresAt','approvalDecisionAt','rejectionReason','start','end','name','email','answer','intakeVersion','intakeRevision','answers','questionSnapshot','additionalGuests','timeZone','meetingTypeId','meetingTypeSlug','title','location','successorId','replacesId','calendarSyncStatus','calendarEventStatus','calendarTimeZone','calendarSyncedAt','calendarChange','conferenceStatus','meetingUrl'].filter(k=>b[k]!==undefined).map(k=>[k,b[k]])),requiresApproval:b.config?.requiresApproval===true,...(Number.isInteger(b.config?.approvalExpiryMinutes)&&b.config.approvalExpiryMinutes>=15&&b.config.approvalExpiryMinutes<=10080?{approvalExpiryMinutes:b.config.approvalExpiryMinutes}:{})});
export function liveSlots(c,now,busy=[],from=now,to=now+c.horizon*86400000) {
  return policySlots(c,now,from,to).filter(slot=>!busy.some(item=>overlap(slot,item,policyBuffers(c))));
}
// The explicit flag makes omission safe for older clients editing a pinned link.
// A withdrawn contribution may remain referenced by its already-published link.
// This is configuration continuity, never a claim of live assignment eligibility.
export function policyReferenceAccounts(type,accounts,old){
 return accounts.map(account=>{
  if(account.connected||!account.ownerMemberId||!/^h_[A-Za-z0-9_-]{24}$/.test(account.ownerMemberId)||!Number.isFinite(account.ownerJoinedAt)||!old?.published||!type.published)return account;
  const retained=type.teamScheduling?type.teamScheduling.hosts.some(h=>h.accountId===account.id&&old.teamScheduling?.hosts.some(previous=>previous.id===h.id&&previous.accountId===account.id)):!old.teamScheduling&&old.accountId===account.id&&type.accountId===account.id;
  return retained?{...account,connected:true}:account;
 });
}
export function meetingDestination(type,accounts,old){
 accounts=policyReferenceAccounts(type,accounts,old);
 if(type.teamScheduling){const team=normalizeTeamScheduling(type.teamScheduling),host=team.hosts[0],account=accounts.find(a=>a.id===host.accountId),calendarId=host.useDefaultCalendar?account?.destinationCalendarId??'':host.calendarId;if(type.published&&(!account?.connected||!calendarId))throw Error('Choose a connected account and writable calendar for every host.');return {useDefaultCalendar:host.useDefaultCalendar,accountId:host.accountId,calendarId};}
 const useDefaultCalendar=type.useDefaultCalendar===undefined?(old?.useDefaultCalendar??true):type.useDefaultCalendar;
 if(typeof useDefaultCalendar!=='boolean')throw Error('Choose a valid default calendar setting.');
 const accountId=type.accountId??old?.accountId??'',account=accounts.find(a=>a.id===accountId);
 let calendarId=useDefaultCalendar?(account?.destinationCalendarId??''):(type.calendarId??old?.calendarId??'');
 if(typeof accountId!=='string'||accountId.length>1024||typeof calendarId!=='string'||calendarId.length>1024||/[\x00-\x1f\x7f]/.test(accountId+calendarId))throw Error('Choose a valid destination calendar.');
 const unchanged=old?.useDefaultCalendar===false&&old.accountId===accountId&&old.calendarId===calendarId;
 if(accountId&&!account||!accountId&&calendarId)throw Error('Choose a calendar account belonging to this host.');
 if(type.published&&(!account?.connected||!calendarId)||!useDefaultCalendar&&!unchanged&&(!account?.connected||!calendarId))throw Error('Choose a connected account and writable destination calendar.');
 return {useDefaultCalendar,accountId,calendarId};
}
const destinationKey=(accountId,calendarId)=>JSON.stringify([accountId,calendarId]);
export class BookingLedger {
  constructor(ctx,env,dependencies={}) {
    this.ctx=ctx;this.env=env;this.sql=ctx.storage.sql;this.fenceStore=dependencies.fenceStore;installHostLifecycle(this);
    // Every calendar write and email send passes the maintenance fence.
    const frozen=()=>this.maintenanceFrozen();this.google=guardCalendar(lifecycleCalendar(this,dependencies.google??google),frozen);this.notify=guardNotify(lifecycleNotify(this,dependencies.sendNotification??sendNotification),frozen);this.availabilityCache=new Map();
    this.sql.exec('CREATE TABLE IF NOT EXISTS live_meta (key TEXT PRIMARY KEY, body TEXT NOT NULL)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS live_accounts (id TEXT PRIMARY KEY, body TEXT NOT NULL)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS live_bookings (id TEXT PRIMARY KEY, request_key TEXT UNIQUE NOT NULL, start INTEGER NOT NULL, end INTEGER NOT NULL, status TEXT NOT NULL, body TEXT NOT NULL)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS live_quota_history (booking_id TEXT PRIMARY KEY, meeting_type_id TEXT NOT NULL, start INTEGER NOT NULL, end INTEGER NOT NULL)');
    this.sql.exec('CREATE INDEX IF NOT EXISTS live_quota_history_period ON live_quota_history (meeting_type_id,start)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS live_jobs (id TEXT PRIMARY KEY, due INTEGER NOT NULL, body TEXT NOT NULL)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS live_notification_receipts (id TEXT PRIMARY KEY, booking_id TEXT NOT NULL, updated_at INTEGER NOT NULL, body TEXT NOT NULL)');
    this.sql.exec('CREATE INDEX IF NOT EXISTS live_notification_receipts_booking ON live_notification_receipts (booking_id,updated_at)');
    // Existing retained bookings are counted too; records pruned before this rollout cannot be reconstructed.
    if(!this.lifecycleFrozen()&&!this.meta('quotaHistoryStartedAt'))this.putMeta('quotaHistoryStartedAt',Date.now());
    if(!this.lifecycleFrozen()&&!this.meta('notificationHistoryStartedAt'))this.putMeta('notificationHistoryStartedAt',Date.now());
    this.sql.exec('CREATE TABLE IF NOT EXISTS live_metrics (day TEXT NOT NULL, metric TEXT NOT NULL, count INTEGER NOT NULL, PRIMARY KEY(day,metric))');
    this.integrations=new IntegrationOutbox(this,dependencies.integrations);
    installExportRevision(this);installLifecycleRevision(this);
  }
  exportPage(options){return ledgerExportPage(this,options);}
  exportContribution(memberId,accountId){return ledgerExportContribution(this,memberId,accountId);}
  rows(q,...v){return this.sql.exec(q,...v).toArray();}
  meta(k){const r=this.rows('SELECT body FROM live_meta WHERE key=?',k)[0];return r?JSON.parse(r.body):null;}
  putMeta(k,v){this.sql.exec('INSERT INTO live_meta VALUES (?,?) ON CONFLICT(key) DO UPDATE SET body=excluded.body',k,JSON.stringify(v));this.availabilityCache.clear();}
  account(id){const r=this.rows('SELECT body FROM live_accounts WHERE id=?',id)[0];return r?JSON.parse(r.body):null;}
  accounts(){return this.rows('SELECT body FROM live_accounts').map(r=>JSON.parse(r.body));}
  putAccount(a){this.sql.exec('INSERT INTO live_accounts VALUES (?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body',a.id,JSON.stringify(a));}
  booking(id){const r=this.rows('SELECT body FROM live_bookings WHERE id=?',id)[0];return r?JSON.parse(r.body):null;}
  putBooking(b){this.putBookings([b]);}
  putBookings(bookings){
    this.ctx.storage.transactionSync(()=>{
      for(const b of bookings){const previous=this.booking(b.id);
      // A separate durable tombstone survives booking retention and cannot be reset by settings.
      if(!previous&&b.config?.singleUse&&!b.replacesId&&!b.requestReplacesId){const refusal=this.linkAdmission(b.config,b.meetingTypeId);if(refusal)throw Object.assign(Error(refusal.error),refusal);this.putMeta('singleUse:'+b.meetingTypeId,true);}
      // Operations reports pending/cancelling ages from this transition time.
      if(previous?.status!==b.status)b.statusChangedAt=Date.now();
      this.sql.exec('INSERT INTO live_bookings VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET start=excluded.start,end=excluded.end,status=excluded.status,body=excluded.body',b.id,b.requestKey,b.start,b.end,b.status,JSON.stringify(b));
      if(!previous)this.recordMetric('bookingRequests');
      this.integrations.enqueueBooking(b,previous);
      if(b.status==='confirmed'&&(previous?.status!=='confirmed'||previous.version!==b.version))this.queueFollowUp(b);
      if(previous?.status!==b.status){
        this.queueApprovalNotifications(b,previous);
        if(b.status==='confirmed'){this.recordMetric('confirmed');this.recordMetric('confirmed:'+(['email','website'].includes(b.source)?b.source:'direct'));}
        if(b.status==='failed')this.recordMetric('failed');
        if(b.status==='cancelled')this.recordMetric(b.replacementConfirmed?'rescheduled':'cancelled');
      }}
    });
    this.availabilityCache.clear();
  }
  pruneMetrics(now=Date.now()){
    const cutoff=new Date(now-89*86400000).toISOString().slice(0,10);
    this.sql.exec('DELETE FROM live_metrics WHERE day<?',cutoff);
  }
  recordMetric(metric){
    const now=Date.now(),day=new Date(now).toISOString().slice(0,10);
    this.sql.exec('INSERT INTO live_metrics VALUES (?,?,1) ON CONFLICT(day,metric) DO UPDATE SET count=count+1',day,metric);
    if(!this.meta('analyticsStartedAt'))this.putMeta('analyticsStartedAt',now);
    this.pruneMetrics(now);
  }
  recordVisit(slug,source='direct'){
    if(!this.type(slug))return fail('Meeting not found',404);
    // Attribution accepts opaque tags only: no referrer, URL, IP or visitor ID.
    const tag=['email','website'].includes(source)?source:'direct';
    this.recordMetric('visit:'+tag);
    return {ok:true};
  }
  analytics(){
    const now=Date.now();this.pruneMetrics(now);
    const metrics=['bookingRequests','confirmed','cancelled','rescheduled','failed'];
    const series=Array.from({length:30},(_,i)=>({day:new Date(now-(29-i)*86400000).toISOString().slice(0,10),pageViews:0,...Object.fromEntries(metrics.map(k=>[k,0]))}));
    const byDay=new Map(series.map(day=>[day.day,day])),sources={direct:0,email:0,website:0},sourceBookings={direct:0,email:0,website:0};
    for(const row of this.rows('SELECT day,metric,count FROM live_metrics WHERE day>=? ORDER BY day',series[0].day)){
      const day=byDay.get(row.day);if(!day)continue;
      if(row.metric.startsWith('visit:')){const source=row.metric.slice(6);if(source in sources){day.pageViews+=row.count;sources[source]+=row.count;}}
      else if(row.metric.startsWith('confirmed:')){const source=row.metric.slice(10);if(Object.hasOwn(sourceBookings,source))sourceBookings[source]+=row.count;}
      else if(metrics.includes(row.metric))day[row.metric]+=row.count;
    }
    const totals=Object.fromEntries(['pageViews',...metrics].map(key=>[key,series.reduce((sum,day)=>sum+day[key],0)]));
    return {period:{from:series[0].day,to:series.at(-1).day,timeZone:'UTC',days:30},trackingStartedAt:this.meta('analyticsStartedAt'),totals,sources,sourceBookings,series};
  }
  hostId(){return this.meta('profile')?.id;}
  lifecycleFrozen(){return lifecycleBlocked(this);}
  syncLifecycleState(hostId){return syncHostLifecycle(this,hostId);}
  maintenanceFrozen(){return this.lifecycleFrozen()||this.meta(FENCE_META)?.frozen===true;}
  maintenanceEpoch(){return this.meta(FENCE_META)?.epoch??0;}
  maintenanceChanged(epoch){return this.maintenanceFrozen()||this.maintenanceEpoch()!==epoch;}
  maintenanceStore(){return this.fenceStore===undefined?fenceStore(this.env,this.hostId()):this.fenceStore;}
  syncMaintenanceFence(){return syncMaintenanceFence(this,this.maintenanceStore());}
  setMaintenance(data){if(this.lifecycleFrozen())return lifecycleDenial(this);return setMaintenance(this,this.maintenanceStore(),data);}
  init(profile){if(!profile?.id)throw Error('Invalid profile');const old=this.meta('profile');if(old&&old.id!==profile.id)throw Error('Host mismatch');this.putMeta('profile',old?{...old,...(profile.email?{email:profile.email}:{})}:profile);if(!this.meta('meetingTypes'))this.putMeta('meetingTypes',[{...DEFAULT,host:profile.name??'Your name',company:profile.company??'',title:'Introductory meeting',description:'',id:'intro',slug:'intro',published:false}]);return this.settings();}
  linkUsed(id){return this.meta('singleUse:'+id)===true;}
  linkAdmission(type,id=type?.id){return type?linkAdmissionFailure(type,this.linkUsed(id)):fail('Meeting not found',404);}
  settings(){const types=this.meta('meetingTypes')??[];return {linkAccess:Object.fromEntries(types.map(type=>[type.id,linkAccessState(type,this.linkUsed(type.id))])),profile:this.meta('profile'),accounts:this.accounts().map(({grant,...a})=>a),meetingTypes:this.meta('meetingTypes')??[],availabilitySchedules:this.meta('availabilitySchedules')??[],defaultAvailabilityScheduleId:this.meta('defaultAvailabilityScheduleId')??null};}
  saveSettings(patch,{verifiedDestinations=new Set()}={}){
    this.validateMemberDestinations(patch.meetingTypes??this.meta('meetingTypes')??[]);
    // Validate the complete prospective state before any metadata writes. A
    // schedule cannot disappear underneath a linked (even unpublished) meeting.
    const schedules=normalizeAvailabilitySchedules(patch.availabilitySchedules!==undefined?patch.availabilitySchedules:this.meta('availabilitySchedules')??[]);
    const defaultId=normalizeDefaultAvailabilityScheduleId(patch.defaultAvailabilityScheduleId!==undefined?patch.defaultAvailabilityScheduleId:this.meta('defaultAvailabilityScheduleId')??null,schedules);
    const previousTypes=this.meta('meetingTypes')??[];let types=previousTypes;
    if(patch.meetingTypes){if(!Array.isArray(patch.meetingTypes)||patch.meetingTypes.length>20)throw Error('Invalid meeting types');const seen=new Set(),ids=new Set();types=patch.meetingTypes.map(t=>{const prior=types.find(type=>type.id===t.id),c=validateConfig({...t,...(prior&&t.useDefaultSchedule===undefined?{useDefaultSchedule:prior.useDefaultSchedule??false}:{}),...Object.fromEntries(['expiresAt','singleUse','cancellationNoticeMinutes','rescheduleNoticeMinutes','durationOptions','teamScheduling','monthlyBookingLimit','yearlyBookingLimit','monthlyBookedMinutesLimit','yearlyBookedMinutesLimit','dailyBookedMinutesLimit','weeklyBookedMinutesLimit','followUpMinutes','followUpSubject','followUpBody'].filter(key=>prior&&t[key]===undefined).map(key=>[key,prior[key]??DEFAULT[key]])),...(prior&&t.requiresApproval===undefined?{requiresApproval:prior.requiresApproval??false}:{}),...(prior&&t.approvalExpiryMinutes===undefined?{approvalExpiryMinutes:prior.approvalExpiryMinutes??1440}:{})}),id=String(t.id??crypto.randomUUID());if(!id||id.length>100||ids.has(id))throw Error('Use unique meeting identifiers');ids.add(id);if(!/^[a-z0-9][a-z0-9-]{0,63}$/.test(t.slug)||seen.has(t.slug))throw Error('Use unique meeting links');seen.add(t.slug);return {...c,id,slug:t.slug,published:!!t.published,...meetingDestination({...t,teamScheduling:c.teamScheduling},this.accounts(),prior)};});}
    for(const type of types){const prior=(this.meta('meetingTypes')??[]).find(old=>old.id===type.id);if(!type.teamScheduling&&type.useDefaultCalendar===false&&!(prior?.useDefaultCalendar===false&&prior.accountId===type.accountId&&prior.calendarId===type.calendarId)&&!verifiedDestinations.has(destinationKey(type.accountId,type.calendarId)))throw Error('Verify the writable destination calendar before saving.');}
    if(patch.meetingTypes)for(const type of types)for(const host of type.teamScheduling?.hosts??[]){const account=this.account(host.accountId);if(account?.ownerMemberId)continue;if(!type.published&&!account?.connected)continue;const calendarId=host.useDefaultCalendar?account?.destinationCalendarId:host.calendarId;if(!verifiedDestinations.has(destinationKey(host.accountId,calendarId)))throw Error('Verify every team destination calendar before saving.');}
    this.validateConflictCapacity(types);
    for(const type of types){validateTeamReferences(type.teamScheduling,policyReferenceAccounts(type,this.accounts(),previousTypes.find(t=>t.id===type.id)),schedules,{requireConnected:type.published});resolveAvailabilitySchedule(type,schedules,defaultId);if(patch.meetingTypes&&type.published&&(type.teamScheduling||!this.account(type.accountId)?.ownerMemberId||this.account(type.accountId)?.connected))this.destination(type);}
    const branding={};for(const key of ['avatarImage','bannerImage'])if(patch.profile&&Object.hasOwn(patch.profile,key))branding[key]=validateBrandImage(patch.profile[key],key);
    if(patch.profile){const old=this.meta('profile');this.putMeta('profile',{...old,...branding,name:String(patch.profile.name??old?.name??'').slice(0,160),company:String(patch.profile.company??old?.company??'').slice(0,160)});}
    if(patch.availabilitySchedules!==undefined)this.putMeta('availabilitySchedules',schedules);
    if(patch.defaultAvailabilityScheduleId!==undefined)this.putMeta('defaultAvailabilityScheduleId',defaultId);
    if(patch.meetingTypes){this.putMeta('meetingTypes',types);this.availabilityCache.clear();}
    return this.settings();}
  memberCalendarEpoch(id){return this.meta('memberCalendarFence:'+id)??0;}
  fenceMemberCalendar(id){if(typeof id!=='string'||!/^h_[A-Za-z0-9_-]{24}$/.test(id))throw Error('Choose a company member.');const epoch=this.memberCalendarEpoch(id)+1;this.putMeta('memberCalendarFence:'+id,epoch);this.availabilityCache.clear();return epoch;}
  async currentCalendarMember(member){
    if(this.meta('profile')?.workspaceKind!=='company'||member?.workspaceId!==this.hostId())throw Object.assign(Error('Choose a company workspace.'),{status:403});
    const record=await this.env.AUTH.getByName('workspace:'+this.hostId()).get(),current=record?.members?.find(m=>m.id===member.id);
    if(!current||!['owner','admin','member'].includes(current.role)||current.email?.toLowerCase()!==member.email||current.joinedAt!==member.joinedAt)throw Object.assign(Error('Company calendar access changed. Sign in again.'),{status:403});
    return current;
  }
  memberAccountAvailable(account){return !account?.ownerMemberId||account.ownerFenceEpoch===this.memberCalendarEpoch(account.ownerMemberId)&&this.memberEligibility?.get(account.id)===true;}
  async refreshMemberEligibility(){
    const owned=this.accounts().filter(a=>a.ownerMemberId);if(!owned.length)return;
    const record=await this.env.AUTH.getByName('workspace:'+this.hostId()).get(),eligible=new Map();
    for(const account of owned){const member=record?.members?.find(m=>m.id===account.ownerMemberId);eligible.set(account.id,!!member&&['owner','admin','member'].includes(member.role)&&member.email?.toLowerCase()===account.email?.toLowerCase()&&member.joinedAt===account.ownerJoinedAt&&account.ownerFenceEpoch===this.memberCalendarEpoch(account.ownerMemberId));}
    this.memberEligibility=eligible;
  }
  ownAccount(member,accountId){const accounts=this.accounts().filter(a=>a.ownerMemberId===member.id&&a.ownerJoinedAt===member.joinedAt&&a.email?.toLowerCase()===member.email);const account=accountId?accounts.find(a=>a.id===accountId):accounts[0];if(accountId&&!account)throw Object.assign(Error('Choose your own calendar account.'),{status:403});return account;}
  ownCalendarShape(member,account,calendars=[]){
    const schedule=account?.memberSchedule??{zone:DEFAULT.zone,weeklyHours:Object.fromEntries(Array.from({length:7},(_,day)=>[day,day>0&&day<6?[{start:540,end:1020}]:[]])),dateOverrides:{}};
    return {member:{id:member.id,email:member.email},scheduleConfigured:!!account?.memberSchedule,account:account?{id:account.id,email:account.email,connected:account.connected,ownerMemberId:account.ownerMemberId,calendarId:account.destinationCalendarId??'',conflictCalendarIds:account.conflictCalendarIds??[]}:null,calendars,schedule,readiness:!account?'not_connected':account.consentWithdrawn?'withdrawn':account.ownerFenceEpoch!==this.memberCalendarEpoch(member.id)?'reconnect':!account.connected?'reconnect':!account.destinationCalendarId?'choose_calendar':'ready'};
  }
  contributionState(identity,accountId){
    const account=this.account(accountId);if(!account||account.ownerMemberId!==identity.id)throw Object.assign(Error('This calendar contribution is not available.'),{status:404});
    return {connected:account.connected===true,withdrawn:account.consentWithdrawn===true};
  }
  async ownCalendarReadiness(member){
    await this.currentCalendarMember(member);return {readiness:this.ownCalendarShape(member,this.ownAccount(member)).readiness};
  }
  async ownCalendar(member){
    await this.currentCalendarMember(member);const epoch=this.memberCalendarEpoch(member.id),account=this.ownAccount(member),version=account?.connectionVersion;
    let calendars=[];if(account?.connected){const raw=await this.google.listCalendars(await this.access(account.id),{timeoutMs:10000});calendars=(Array.isArray(raw)?raw:raw?.items??[]).filter(c=>!c.deleted).map(({id,summary,accessRole,primary})=>({id,summary,accessRole,primary:primary===true}));}
    await this.currentCalendarMember(member);if(epoch!==this.memberCalendarEpoch(member.id)||account&&this.account(account.id)?.connectionVersion!==version)throw Object.assign(Error('Your calendar changed. Reload it.'),{status:409});
    const latestAccount=this.ownAccount(member),shape=this.ownCalendarShape(member,latestAccount,calendars),preferenceVersion=latestAccount?.preferenceVersion??0,snapshot=JSON.stringify(this.ownCalendarShape(member,latestAccount)),revision=await sha256(JSON.stringify({shape,epoch,version,preferenceVersion}));
    if(epoch!==this.memberCalendarEpoch(member.id)||account&&this.account(account.id)?.connectionVersion!==version||(this.ownAccount(member)?.preferenceVersion??0)!==preferenceVersion||JSON.stringify(this.ownCalendarShape(member,this.ownAccount(member)))!==snapshot)throw Object.assign(Error('Your calendar changed. Reload it.'),{status:409});
    return {...shape,revision};
  }
  async configureOwnCalendar(member,data){
    if(!data||Object.keys(data).some(k=>!['accountId','calendarId','conflictCalendarIds','schedule','expectedRevision'].includes(k)))throw Object.assign(Error('Choose your own calendar settings.'),{status:400});
    const settingsBefore=JSON.stringify(this.settings());const current=await this.ownCalendar(member),epoch=this.memberCalendarEpoch(member.id),account=this.ownAccount(member,data.accountId);
    if(!account||current.revision!==data.expectedRevision)throw Object.assign(Error('Your calendar changed. Reload before saving.'),{status:409});
    if(account.ownerFenceEpoch!==epoch)throw Object.assign(Error('Reconnect your calendar before saving.'),{status:409});
    const calendar=current.calendars.find(c=>c.id===data.calendarId&&['owner','writer'].includes(c.accessRole)),ids=[...new Set([data.calendarId,...(Array.isArray(data.conflictCalendarIds)?data.conflictCalendarIds:[])])];
    if(!calendar||!Array.isArray(data.conflictCalendarIds)||ids.length>50||ids.some(id=>typeof id!=='string'||!current.calendars.some(c=>c.id===id&&['owner','writer','reader','freeBusyReader'].includes(c.accessRole))))throw Object.assign(Error('Choose calendars from your connected account.'),{status:400});
    let memberSchedule=account.memberSchedule;
    if(data.schedule!==undefined){const schedule=data.schedule;if(!schedule||Object.keys(schedule).some(k=>!['zone','weeklyHours','dateOverrides'].includes(k)))throw Object.assign(Error('Choose valid working hours.'),{status:400});const normalized=validateConfig({...DEFAULT,...schedule});memberSchedule=Object.fromEntries(['zone','weeklyHours','dateOverrides'].map(k=>[k,normalized[k]]));}
    const version=account.connectionVersion;await this.currentCalendarMember(member);
    if(epoch!==this.memberCalendarEpoch(member.id)||version!==this.account(account.id)?.connectionVersion||settingsBefore!==JSON.stringify(this.settings()))throw Object.assign(Error('Your calendar changed. Reload before saving.'),{status:409});
    const updated={...this.account(account.id),destinationCalendarId:calendar.id,conflictCalendarIds:ids,preferenceVersion:(account.preferenceVersion??0)+1,...(memberSchedule?{memberSchedule}:{})};
    this.validateConflictCapacity(this.meta('meetingTypes')??[],new Map(this.accounts().map(a=>[a.id,a.id===updated.id?updated:a])));
    this.ctx.storage.transactionSync(()=>{this.putAccount(updated);this.putMeta('meetingTypes',(this.meta('meetingTypes')??[]).map(t=>t.accountId===updated.id&&t.useDefaultCalendar!==false?{...t,calendarId:calendar.id}:t));});
    this.availabilityCache.clear();return this.ownCalendar(member);
  }
  async disconnectOwnCalendar(member,data){
    if(!data||Object.keys(data).some(k=>!['accountId','expectedRevision'].includes(k)))throw Object.assign(Error('Choose your own calendar account.'),{status:400});
    await this.currentCalendarMember(member);const account=this.ownAccount(member,data.accountId);if(!account)throw Object.assign(Error('Choose your own calendar account.'),{status:403});
    return this.withdrawMemberCalendar({id:member.id,email:member.email},account.id);
  }
  withdrawMemberCalendar(identity,accountId){
    const account=this.account(accountId);if(!account||account.ownerMemberId!==identity.id)throw Object.assign(Error('This calendar contribution is not available.'),{status:403});
    const accepted=this.rows("SELECT body FROM live_bookings WHERE status IN ('awaiting_approval','pending','cancelling') OR (status='confirmed' AND end>?)",Date.now()).map(r=>JSON.parse(r.body)).filter(b=>(b.teamAssignment?.hosts??[{accountId:b.accountId}]).some(h=>h.accountId===accountId));
    this.ctx.storage.transactionSync(()=>{this.fenceMemberCalendar(identity.id);const {grant,...retained}=account;this.putAccount({...retained,connected:false,consentWithdrawn:true,connectionVersion:(account.connectionVersion??0)+1});for(const b of accepted){b.calendarSyncStatus='needs_review';b.calendarEventStatus='authorization';this.sql.exec('UPDATE live_bookings SET body=? WHERE id=?',JSON.stringify(b),b.id);}});
    this.availabilityCache.clear();return {withdrawn:true,accountId,readiness:'withdrawn',acceptedBookingsNeedReview:accepted.length};
  }
  async memberCalendarReadiness(){
    const record=await this.env.AUTH.getByName('workspace:'+this.hostId()).get();await this.refreshMemberEligibility();return {members:(record?.members??[]).map(m=>{const account=this.accounts().find(a=>a.ownerMemberId===m.id&&a.ownerJoinedAt===m.joinedAt&&a.email?.toLowerCase()===m.email?.toLowerCase());return {id:m.id,email:m.email,role:m.role,readiness:m.role==='viewer'?'not_hosting':account?.consentWithdrawn?'withdrawn':!account?'not_connected':!account.connected||!this.memberAccountAvailable(account)?'reconnect':!account.destinationCalendarId?'choose_calendar':'ready',...(account?{accountId:account.id}:{})};})};
  }
  memberHoursChecker(account,duration,now=Date.now()){return account?.memberSchedule?workingWindowChecker({...DEFAULT,...account.memberSchedule,notice:0,horizon:60,duration},now):()=>true;}
  memberHoursAllow(account,start,end){return this.memberHoursChecker(account,(end-start)/MIN)(start,end);}
  memberHoursSlots(account,slots){if(!slots.length||!account?.memberSchedule)return slots;const contains=this.memberHoursChecker(account,(slots[0].end-slots[0].start)/MIN);return slots.filter(s=>contains(s.start,s.end));}
  canonicalizeOwnedReferences(accountId){
    const account=this.account(accountId);if(!account?.ownerMemberId)return;
    const types=(this.meta('meetingTypes')??[]).map(type=>{
      if(type.teamScheduling){
        if(!type.teamScheduling.hosts.some(host=>host.accountId===accountId))return type;
        const hosts=type.teamScheduling.hosts.map(host=>host.accountId===accountId?{...host,useDefaultCalendar:true,calendarId:'',conflictCalendarIds:null}:host);
        return {...type,teamScheduling:{...type.teamScheduling,hosts},...(hosts[0].accountId===accountId?{accountId,useDefaultCalendar:true,calendarId:account.destinationCalendarId??''}:{})};
      }
      return type.accountId===accountId?{...type,useDefaultCalendar:true,calendarId:account.destinationCalendarId??''}:type;
    });
    // These are future-link references only. Accepted booking/config/assignment
    // snapshots retain their original calendars for deterministic recovery.
    this.putMeta('meetingTypes',types);
  }
  async connect(g){if(!g?.email||!g.tokens?.refresh_token)throw Error('A fresh Google grant is required');const id=g.accountId??g.id??g.email.toLowerCase();const old=this.account(id);if(!g.ownerMember&&old?.consentWithdrawn)throw Object.assign(Error('The calendar owner must reconnect their own withdrawn contribution.'),{status:409});if(g.ownerMember){await this.currentCalendarMember(g.ownerMember);if(g.email.toLowerCase()!==g.ownerMember.email||g.ownerMember.fenceEpoch!==this.memberCalendarEpoch(g.ownerMember.id)||old&&(old.email?.toLowerCase()!==g.ownerMember.email||old.ownerMemberId&&old.ownerMemberId!==g.ownerMember.id))throw Object.assign(Error('This calendar requires administrator review or a fresh connection.'),{status:409});}const grant=await encryptTokens(g.tokens,this.env.TOKEN_ENCRYPTION_KEY,this.hostId());if(g.ownerMember){await this.currentCalendarMember(g.ownerMember);if(g.ownerMember.fenceEpoch!==this.memberCalendarEpoch(g.ownerMember.id))throw Object.assign(Error('Company access changed. Reconnect your calendar.'),{status:409});}const latest=this.account(id);if(latest?.connectionVersion!==old?.connectionVersion)throw Object.assign(Error('Calendar connection changed. Try again.'),{status:409});this.putAccount({...old,...(g.ownerMember?{ownerMemberId:g.ownerMember.id,ownerJoinedAt:g.ownerMember.joinedAt,ownerFenceEpoch:g.ownerMember.fenceEpoch,consentWithdrawn:false}:{}),id,email:g.email,...(g.credentialOwnerId?{credentialOwnerId:g.credentialOwnerId}:{}),grant,connected:true,connectionVersion:(old?.connectionVersion??0)+1,syncCooldownUntil:0,syncFailures:0,destinationCalendarId:old?.destinationCalendarId??'',conflictCalendarIds:old?.conflictCalendarIds??[]});if(g.ownerMember)this.canonicalizeOwnedReferences(id);this.sql.exec("UPDATE live_bookings SET body=json_set(body,'$.syncAfter',0) WHERE status='confirmed' AND (json_extract(body,'$.accountId')=? OR EXISTS (SELECT 1 FROM json_each(live_bookings.body,'$.teamAssignment.hosts') WHERE json_extract(value,'$.accountId')=?))",id,id);this.availabilityCache.clear();await this.resumeConfirmedSync();return this.settings();}
  async access(id){let a=this.account(id);if(!a?.connected)throw Error('Calendar account is disconnected');const version=a.connectionVersion,current=()=>{const latest=this.account(id);if(!latest?.connected||latest.connectionVersion!==version)throw Error('Calendar authorization changed.');return latest;};let t=await decryptTokens(a.grant,this.env.TOKEN_ENCRYPTION_KEY,this.hostId());current();if(!t.access_token||!t.expires_at||t.expires_at<Date.now()+MIN){const fresh=await this.google.refreshTokens({clientId:this.env.GOOGLE_CLIENT_ID,clientSecret:this.env.GOOGLE_CLIENT_SECRET,refreshToken:t.refresh_token},{timeoutMs:10000});t={...t,...fresh,refresh_token:fresh.refresh_token??t.refresh_token,expires_at:fresh.expires_at??Date.now()+(fresh.expires_in??3600)*1000};const grant=await encryptTokens(t,this.env.TOKEN_ENCRYPTION_KEY,this.hostId());a=current();this.putAccount({...a,grant});}current();return t.access_token;}
  async listCalendars(){return {accounts:await Promise.all(this.accounts().filter(a=>a.connected).map(async a=>({id:a.id,email:a.email,...(a.ownerMemberId?{ownerMemberId:a.ownerMemberId,calendars:[]}: {calendars:await this.google.listCalendars(await this.access(a.id),{timeoutMs:10000})})})))};}
  async configureCalendars(data){
    if(!Array.isArray(data.accounts)||data.accounts.length>50)throw Error('Invalid calendar selections');
    const before=JSON.stringify(this.settings()),available=await this.listCalendars(),updates=new Map();if(before!==JSON.stringify(this.settings()))throw Error('Calendar settings changed. Reload before saving.');
    // Validate every selection before changing destinations. Read current grants
    // because calendar discovery may have refreshed them.
    for(const selection of data.accounts){
      if(!selection||!Array.isArray(selection.conflictCalendarIds??[]))throw Error('Invalid conflict calendars');
      const account=this.account(selection.accountId??selection.id);
      if(!account?.connected||updates.has(account.id))throw Error('Invalid calendar account selection');
      if(account.ownerMemberId){if(selection.destinationCalendarId!==account.destinationCalendarId||JSON.stringify([...new Set(selection.conflictCalendarIds??[])].sort())!==JSON.stringify([...new Set(account.conflictCalendarIds??[])].sort()))throw Object.assign(Error('Members manage their own calendar preferences.'),{status:403});continue;}
      const result=available.accounts.find(a=>a.id===account.id);
      const calendars=Array.isArray(result?.calendars)?result.calendars:result?.calendars?.items??[];
      const destination=calendars.find(c=>c.id===selection.destinationCalendarId&&!c.deleted);
      if(!destination||!['owner','writer'].includes(destination.accessRole))throw Error('Choose a writable destination calendar');
      const ids=[...new Set([selection.destinationCalendarId,...(selection.conflictCalendarIds??[])])];
      if(ids.length>50||ids.some(id=>typeof id!=='string'||!calendars.some(c=>c.id===id&&!c.deleted)))throw Error('Invalid conflict calendars');
      updates.set(account.id,{...account,destinationCalendarId:destination.id,conflictCalendarIds:ids});
    }
    const types=(this.meta('meetingTypes')??[]).map(type=>{
      const account=updates.get(type.accountId);
      return account&&type.useDefaultCalendar!==false?{...type,calendarId:account.destinationCalendarId}:type;
    });
    this.validateConflictCapacity(types,new Map(this.accounts().map(a=>[a.id,updates.get(a.id)??a])));
    // Existing booking snapshots retain their original calendar for management.
    this.ctx.storage.transactionSync(()=>{
      for(const account of updates.values())this.putAccount(account);
      this.putMeta('meetingTypes',types);
    });
    this.availabilityCache.clear();
    return this.settings();
  }
  type(slug,preview=false){const type=(this.meta('meetingTypes')??[]).find(t=>t.slug===slug&&(t.published||preview));return type?{...type,...(type.useDefaultCalendar!==false||this.account(type.accountId)?.ownerMemberId?{calendarId:this.account(type.accountId)?.destinationCalendarId??''}:{}),...resolveAvailabilitySchedule(type,this.meta('availabilitySchedules')??[],this.meta('defaultAvailabilityScheduleId')??null)}:undefined;}
  destination(t){if(t.teamScheduling){const host=this.teamHosts(t)[0];return {a:this.account(host.accountId),calendarId:host.calendarId};}const a=this.account(t.accountId);const calendarId=t.useDefaultCalendar===false&&!a?.ownerMemberId?t.calendarId:a?.destinationCalendarId;if(!a?.connected||!calendarId)throw Error('This meeting is not accepting bookings');return {a,calendarId};}
  conflictIds(account,types=this.meta('meetingTypes')??[]){if(account.ownerMemberId)return [...new Set([account.destinationCalendarId,...(account.conflictCalendarIds??[])].filter(Boolean))];const ids=[...new Set([account.destinationCalendarId,...(account.conflictCalendarIds??[]),...types.filter(t=>t.accountId===account.id).map(t=>t.useDefaultCalendar===false?t.calendarId:account.destinationCalendarId),...types.flatMap(t=>(t.teamScheduling?.hosts??[]).filter(h=>h.accountId===account.id).map(h=>h.useDefaultCalendar?account.destinationCalendarId:h.calendarId))].filter(Boolean))];if(ids.length>50)throw Error('At most 50 calendars per account can be checked for conflicts.');return ids;}
  validateConflictCapacity(types,accounts=new Map(this.accounts().map(a=>[a.id,a]))){for(const account of accounts.values())if(account.connected)this.conflictIds(account,types);}
  validateMemberDestinations(types){
    for(const type of types){const hosts=type.teamScheduling?.hosts??[{accountId:type.accountId,useDefaultCalendar:type.useDefaultCalendar,calendarId:type.calendarId,conflictCalendarIds:null}];for(const host of hosts){const account=typeof host.accountId==='string'?this.account(host.accountId):null;if(account?.ownerMemberId&&(host.useDefaultCalendar===false||host.conflictCalendarIds!=null))throw Object.assign(Error('Member hosts use their own calendar preferences.'),{status:400,code:'invalid_settings'});}}
  }
  async verifyMeetingDestinations(patch,current=this.settings()){
    this.validateMemberDestinations(patch.meetingTypes??current.meetingTypes);
    try{this.validateConflictCapacity(patch.meetingTypes??current.meetingTypes);}catch(error){throw Object.assign(error,{code:'invalid_settings',status:400});}
    const verified=new Set(),groups=new Map();for(const type of patch.meetingTypes??[]){const old=current.meetingTypes.find(t=>t.id===type.id);if(type.teamScheduling||type.useDefaultCalendar!==false||old?.useDefaultCalendar===false&&old.accountId===type.accountId&&old.calendarId===type.calendarId)continue;if(!groups.has(type.accountId))groups.set(type.accountId,[]);groups.get(type.accountId).push(type.calendarId);}
    for(const type of patch.meetingTypes??[])for(const host of normalizeTeamScheduling(type.teamScheduling)?.hosts??[]){const account=this.account(host.accountId),calendarId=host.useDefaultCalendar?account?.destinationCalendarId:host.calendarId;if(!type.published&&!account?.connected)continue;if(account?.ownerMemberId)continue;if(!groups.has(host.accountId))groups.set(host.accountId,[]);groups.get(host.accountId).push(calendarId);}
    for(const [id,ids] of groups){const account=this.account(id);if(!account?.connected)throw Object.assign(Error('Choose a connected calendar account.'),{code:'invalid_settings',status:400});const result=await this.google.listCalendars(await this.access(id),{timeoutMs:10000}),calendars=Array.isArray(result)?result:result?.items??[];for(const calendarId of ids){if(!calendars.some(c=>c.id===calendarId&&!c.deleted&&['owner','writer'].includes(c.accessRole)))throw Object.assign(Error('Choose a writable destination calendar.'),{code:'invalid_settings',status:400});verified.add(destinationKey(id,calendarId));}for(const type of patch.meetingTypes??[])for(const host of type.teamScheduling?.hosts??[])if(host.accountId===id)for(const calendarId of host.conflictCalendarIds??[])if(!calendars.some(c=>c.id===calendarId&&!c.deleted&&['freeBusyReader','reader','writer','owner'].includes(c.accessRole)))throw Object.assign(Error('Choose conflict calendars from this connected account.'),{code:'invalid_settings',status:400});}
    return verified;
  }
  localBusy(exclude){this.expireApprovals();return this.rows("SELECT body FROM live_bookings WHERE status IN ('awaiting_approval','pending','confirmed','cancelling')").map(r=>JSON.parse(r.body)).filter(b=>!(Array.isArray(exclude)?exclude:[exclude]).includes(b.id)).map(b=>({start:b.teamReviewHold?.start??b.start,end:b.teamReviewHold?.end??b.end,buffer:b.config.buffer*MIN,...policyBuffers(b.config)}));}
  dailyQuota(type,excludeId,referenceStart=Date.now(),referenceEnd=referenceStart+type.horizon*86400000){
    this.expireApprovals();
    const counts=new Map(),weeks=new Map(),months=new Map(),years=new Map(),bookedMillis=new Map(),weeklyBookedMillis=new Map(),monthlyBookedMillis=new Map(),yearlyBookedMillis=new Map(),format=new Intl.DateTimeFormat('en-CA',{timeZone:type.zone,year:'numeric',month:'2-digit',day:'2-digit'});
    const day=time=>{const parts=format.formatToParts(time),get=key=>parts.find(part=>part.type===key)?.value;return [get('year'),get('month'),get('day')].join('-');};
    const week=time=>{const date=new Date(day(time)+'T00:00:00Z');date.setUTCDate(date.getUTCDate()-(date.getUTCDay()+6)%7);return date.toISOString().slice(0,10);};
    if(hasQuota(type)){
      const live=this.rows("SELECT body FROM live_bookings WHERE status IN ('awaiting_approval','pending','confirmed','cancelling')").map(row=>JSON.parse(row.body));
      // Compact history survives PII cleanup. UTC coverage is padded for every
      // local zone; aggregation still uses the current type's local calendar.
      const from=Date.UTC(Number(day(referenceStart).slice(0,4)),0,1)-2*86400000,to=Date.UTC(Number(day(referenceEnd).slice(0,4))+1,0,1)+2*86400000;
      const history=this.rows('SELECT booking_id AS id,meeting_type_id AS meetingTypeId,start,end FROM live_quota_history WHERE meeting_type_id=? AND start>=? AND start<? AND booking_id NOT IN (SELECT id FROM live_bookings)',type.id,Math.max(from,Date.now()-QUOTA_RETENTION),to);
      for(const booking of [...live,...history]){
        if((Array.isArray(excludeId)?excludeId:[excludeId]).includes(booking.id)||booking.meetingTypeId!==type.id)continue;
        const key=day(booking.start),weekKey=week(booking.start),monthKey=key.slice(0,7),yearKey=key.slice(0,4);counts.set(key,(counts.get(key)??0)+1);weeks.set(weekKey,(weeks.get(weekKey)??0)+1);months.set(monthKey,(months.get(monthKey)??0)+1);years.set(yearKey,(years.get(yearKey)??0)+1);
        // Allocate the full actual elapsed duration to the booking's start
        // calendar period. Buffers and other meeting types never consume it.
        const elapsed=booking.end-booking.start;bookedMillis.set(key,(bookedMillis.get(key)??0)+elapsed);weeklyBookedMillis.set(weekKey,(weeklyBookedMillis.get(weekKey)??0)+elapsed);monthlyBookedMillis.set(monthKey,(monthlyBookedMillis.get(monthKey)??0)+elapsed);yearlyBookedMillis.set(yearKey,(yearlyBookedMillis.get(yearKey)??0)+elapsed);
      }
    }
    return {day,counts,week,weeks,months,years,bookedMillis,weeklyBookedMillis,monthlyBookedMillis,yearlyBookedMillis};
  }
  quotaAllows(type,start,end,quota){
    const {day,counts,week,weeks,months,years,bookedMillis,weeklyBookedMillis,monthlyBookedMillis,yearlyBookedMillis}=quota,key=day(start),weekKey=week(start),monthKey=key.slice(0,7),yearKey=key.slice(0,4),elapsed=end-start;
    return (!type.dailyBookingLimit||(counts.get(key)??0)<type.dailyBookingLimit)&&
      (!type.weeklyBookingLimit||(weeks.get(weekKey)??0)<type.weeklyBookingLimit)&&
      (!type.monthlyBookingLimit||(months.get(monthKey)??0)<type.monthlyBookingLimit)&&
      (!type.yearlyBookingLimit||(years.get(yearKey)??0)<type.yearlyBookingLimit)&&
      (!type.dailyBookedMinutesLimit||(bookedMillis.get(key)??0)+elapsed<=type.dailyBookedMinutesLimit*MIN)&&
      (!type.weeklyBookedMinutesLimit||(weeklyBookedMillis.get(weekKey)??0)+elapsed<=type.weeklyBookedMinutesLimit*MIN)&&
      (!type.monthlyBookedMinutesLimit||(monthlyBookedMillis.get(monthKey)??0)+elapsed<=type.monthlyBookedMinutesLimit*MIN)&&
      (!type.yearlyBookedMinutesLimit||(yearlyBookedMillis.get(yearKey)??0)+elapsed<=type.yearlyBookedMinutesLimit*MIN);
  }
  withinDailyLimit(type,start,excludeId,end=start+type.duration*MIN){
    if(!hasQuota(type))return true;
    return this.quotaAllows(type,start,end,this.dailyQuota(type,excludeId,start,end));
  }
  quotaSlots(type,slots,exclude){
    if(!slots.length||!hasQuota(type))return slots;
    const quota=this.dailyQuota(type,exclude,Math.min(...slots.map(slot=>slot.start)),Math.max(...slots.map(slot=>slot.end)));
    return slots.filter(slot=>this.quotaAllows(type,slot.start,slot.end,quota));
  }
  async providerBusy(from,to,requiredDestination){const result=await Promise.all(this.accounts().filter(a=>a.connected).map(async a=>{const ids=[...new Set([...this.conflictIds(a),...(requiredDestination?.accountId===a.id?[requiredDestination.calendarId]:[])].filter(Boolean))];if(ids.length>50)throw Error('At most 50 calendars per account can be checked for conflicts.');if(!ids.length)return [];const r=await this.google.freeBusy(await this.access(a.id),{calendarIds:ids,timeMin:new Date(from).toISOString(),timeMax:new Date(to).toISOString()},{timeoutMs:10000});if(Array.isArray(r))return r.map(b=>({start:+new Date(b.start),end:+new Date(b.end)}));if(r.busy)return r.busy.map(b=>({start:+new Date(b.start),end:+new Date(b.end)}));const calendars=Object.values(r.calendars??{});if(calendars.length!==ids.length||calendars.some(c=>c.errors?.length))throw Error('Calendar availability unavailable');return calendars.flatMap(c=>c.busy??[]).map(b=>({start:+new Date(b.start),end:+new Date(b.end)}));}));return result.flat();}
  teamHosts(type){
    const team=type.teamScheduling;if(!team)return [];
    const schedules=this.meta('availabilitySchedules')??[];validateTeamReferences(team,this.accounts().map(a=>a.ownerMemberId?{...a,connected:true}:a),schedules);
    return team.hosts.map(host=>{const account=this.account(host.accountId),calendarId=account.ownerMemberId||host.useDefaultCalendar?account.destinationCalendarId:host.calendarId,schedule=host.scheduleId?schedules.find(s=>s.id===host.scheduleId):null;
      const policy={...type,teamScheduling:null,...(schedule?Object.fromEntries(['zone','weeklyHours','dateOverrides','days','startHour','endHour'].filter(k=>schedule[k]!==undefined).map(k=>[k,schedule[k]])):{})};
      return {...host,...(account.ownerMemberId?{ownerMemberId:account.ownerMemberId,ownerFenceEpoch:account.ownerFenceEpoch,memberEligible:this.memberAccountAvailable(account),memberSchedule:account.memberSchedule??null}:{}),email:account.email.toLowerCase(),calendarId,connectionVersion:account.connectionVersion??0,conflictCalendarIds:[...new Set([calendarId,...(account.ownerMemberId?this.conflictIds(account):host.conflictCalendarIds??this.conflictIds(account))])],policy};
    });
  }
  teamSignature(type,hosts=this.teamHosts(type)){return JSON.stringify({type:validateConfig(type),hosts});}
  async teamRevision(type){await this.refreshMemberEligibility();return sha256(this.teamSignature(type));}
  teamVersions(assignment){
    if(!assignment)return null;const versions={};
    for(const host of assignment.hosts){const account=this.account(host.accountId);if((!account?.connected&&!(host.ownerMemberId&&host.memberEligible===false))||account.email?.toLowerCase()!==host.email)throw Error('A team calendar needs reconnection.');versions[host.accountId]=account.connectionVersion??0;}
    return versions;
  }
  teamAccountsCurrent(assignment,versions){
    if(!assignment)return true;
    try{const current=this.teamVersions(assignment);return !versions||JSON.stringify(current)===JSON.stringify(versions);}catch{return false;}
  }
  teamLocalBusy(host,exclude){
    this.expireApprovals();const excluded=Array.isArray(exclude)?exclude:[exclude];
    return this.rows("SELECT body FROM live_bookings WHERE status IN ('awaiting_approval','pending','confirmed','cancelling')").map(r=>JSON.parse(r.body)).filter(b=>!excluded.includes(b.id)&&(b.teamAssignment?.hosts??[{accountId:b.accountId,calendarId:b.calendarId,email:this.account(b.accountId)?.email}]).some(held=>hostsShareResource(host,held))).map(b=>({start:b.teamReviewHold?.start??b.start,end:b.teamReviewHold?.end??b.end,...policyBuffers(b.config)}));
  }
  async teamProviderBusy(hosts,from,to){
    const assignment={hosts},versions=this.teamVersions(assignment),result={};
    await Promise.all(hosts.map(async host=>{
      if(host.ownerMemberId&&host.memberEligible===false){result[host.id]=[];return;}
      if(host.conflictCalendarIds.length>50)throw Error('At most 50 calendars per host can be checked.');
      const access=await this.access(host.accountId);if(!this.teamAccountsCurrent(assignment,versions))throw Error('Team calendar authorization changed.');
      const raw=await this.google.freeBusy(access,{calendarIds:host.conflictCalendarIds,timeMin:new Date(from).toISOString(),timeMax:new Date(to).toISOString()},{timeoutMs:10000});
      if(!this.teamAccountsCurrent(assignment,versions))throw Error('Team calendar authorization changed.');
      let busy;if(Array.isArray(raw))busy=raw;else if(Array.isArray(raw.busy))busy=raw.busy;else{const calendars=Object.values(raw.calendars??{});if(calendars.length!==host.conflictCalendarIds.length||calendars.some(c=>c.errors?.length))throw Error('Team calendar availability unavailable.');busy=calendars.flatMap(c=>c.busy??[]);}
      result[host.id]=busy.map(b=>({start:+new Date(b.start),end:+new Date(b.end)}));if(result[host.id].some(b=>!Number.isFinite(b.start)||!Number.isFinite(b.end)||b.end<b.start))throw Error('Invalid calendar availability.');
    }));return {busy:result,versions};
  }
  teamSlots(type,hosts,busy,from,to,{exclude,now=Date.now(),fixedIds=null}={}){
    const memberWindows=new Map(hosts.map(host=>[host.id,this.memberHoursChecker(this.account(host.accountId),type.duration,now)]));
    if(type.teamScheduling.mode==='all'){
      if(hosts.some(h=>h.memberEligible===false||!this.memberAccountAvailable(this.account(h.accountId))))return [];
      const resources=hosts.map(host=>({host,contains:workingWindowChecker(host.policy,now),busy:[...(busy[host.id]??[]),...this.teamLocalBusy(host,exclude)]}));
      // The organizer supplies one start grid. Other hosts contribute hours and
      // conflicts, not independent grids anchored to different working starts.
      const slots=liveSlots(hosts[0].policy,now,resources[0].busy,from,to).filter(slot=>resources.every(({host,contains,busy})=>contains(slot.start,slot.end)&&memberWindows.get(host.id)(slot.start,slot.end)&&!busy.some(item=>overlap(slot,item,policyBuffers(host.policy))))).map(slot=>({...slot,hostIds:hosts.map(host=>host.id)}));
      return this.quotaSlots(type,slots,exclude);
    }
    const eligible=new Map();for(const host of hosts){if(host.memberEligible===false||!this.memberAccountAvailable(this.account(host.accountId)))continue;if(fixedIds&&!fixedIds.includes(host.id))continue;for(const slot of liveSlots(host.policy,now,[...(busy[host.id]??[]),...this.teamLocalBusy(host,exclude)],from,to)){if(!memberWindows.get(host.id)(slot.start,slot.end))continue;if(!eligible.has(slot.start))eligible.set(slot.start,{...slot,hostIds:[]});eligible.get(slot.start).hostIds.push(host.id);}}
    return this.quotaSlots(type,[...eligible.values()].filter(slot=>type.teamScheduling.mode!=='all'||slot.hostIds.length===hosts.length).sort((a,b)=>a.start-b.start),exclude);
  }
  assertOriginalTeam(type,hosts,original){
    if(original?.teamAssignment){
      if(original.teamAssignment.mode!==type.teamScheduling.mode)throw Object.assign(Error('The team booking mode changed.'),{status:409});
      for(const held of original.teamAssignment.hosts){const current=hosts.find(h=>h.id===held.id);if(!current||current.accountId!==held.accountId||current.calendarId!==held.calendarId||current.email!==held.email)throw Object.assign(Error('The original meeting host changed.'),{status:409});}
      if(type.teamScheduling.mode==='all'&&hosts.length!==original.teamAssignment.hosts.length)throw Object.assign(Error('The original meeting hosts changed.'),{status:409});
    }
  }
  chooseTeamAssignment(type,hosts,busy,start,end,{exclude,original,requestedHostId}={}){
    this.assertOriginalTeam(type,hosts,original);
    const fixedIds=original?.teamAssignment?.hosts.map(h=>h.id)??(type.teamScheduling.mode==='choose'?[requestedHostId]:null),slot=this.teamSlots(type,hosts,busy,start,end,{exclude,fixedIds}).find(s=>s.start===start);
    if(!slot)return null;
    let selected;
    if(type.teamScheduling.mode==='all')selected=hosts;
    else if(fixedIds)selected=[hosts.find(h=>h.id===fixedIds[0])];
    if(!selected){
      const last=new Map();for(const row of this.rows('SELECT rowid AS assignmentOrder,body FROM live_bookings ORDER BY rowid')){const b=JSON.parse(row.body);for(const h of b.teamAssignment?.hosts??[])last.set(h.accountId,row.assignmentOrder);}
      selected=hosts.filter(h=>slot.hostIds.includes(h.id)).sort((a,b)=>(last.get(a.accountId)??0)-(last.get(b.accountId)??0)||a.id.localeCompare(b.id)).slice(0,1);
    }
    return {mode:type.teamScheduling.mode,hosts:structuredClone(selected)};
  }
  async teamAvailability(type,from,to,range,maintenanceEpoch){
    await this.refreshMemberEligibility();const hosts=this.teamHosts(type),signature=this.teamSignature(type,hosts),now=Date.now(),day=86400000,coverageFrom=Math.floor(from/day)*day,coverageTo=Math.ceil(to/day)*day,key='team:'+signature+':'+coverageFrom+':'+coverageTo;
    this.assertOriginalTeam(type,hosts,range.acceptedBooking);
    let entry=this.availabilityCache.get(key);if(!entry||entry.expiresAt<=now){entry={kind:'team',expiresAt:now+20000,promise:this.teamProviderBusy(hosts,coverageFrom-policyBuffers(type).before,coverageTo+policyBuffers(type).after)};entry.promise.catch(()=>{if(this.availabilityCache.get(key)===entry)this.availabilityCache.delete(key);});if(this.availabilityCache.size>=4)this.availabilityCache.delete(this.availabilityCache.keys().next().value);this.availabilityCache.set(key,entry);}
    const {busy,versions}=await entry.promise;await this.refreshMemberEligibility();if(range.preview!==true&&this.maintenanceChanged(maintenanceEpoch))return maintenanceRefusal();
    const current=durationPolicy(this.type(type.slug,range.preview===true),type.duration,!!range.acceptedBooking);if(!current||this.teamSignature(current)!==signature||!this.teamAccountsCurrent({hosts},versions))throw Error('Team availability changed.');
    this.assertOriginalTeam(type,hosts,range.acceptedBooking);
    const {teamScheduling,followUpSubject,followUpBody,...config}=validateConfig(type),team={...publicTeam(teamScheduling),revision:await sha256(signature)};
    if(range.preview!==true&&this.maintenanceChanged(maintenanceEpoch))return maintenanceRefusal();if(this.teamSignature(durationPolicy(this.type(type.slug,range.preview===true),type.duration,!!range.acceptedBooking))!==signature)throw Error('Team availability changed.');
    if(range.preview!==true&&!range.acceptedBooking){const closed=this.linkAdmission(this.type(type.slug));if(closed)return closed;}
    return {config:{...config,team,...Object.fromEntries(['avatarImage','bannerImage'].map(key=>[key,this.meta('profile')?.[key]??null]))},slots:this.teamSlots(type,hosts,busy,from,to,{exclude:range.acceptedBooking?.id,fixedIds:range.acceptedBooking?.teamAssignment?.hosts.map(h=>h.id)??null}),mode:'live'};
  }
  async availabilityBusy(from,to){
    const now=Date.now(),day=86400000;
    for(const [key,entry] of this.availabilityCache){
      if(entry.expiresAt<=now)this.availabilityCache.delete(key);
      else if(entry.kind!=='team'&&entry.from<=from&&entry.to>=to)return entry.promise;
    }
    // Day-rounded coverage keeps default ranges reusable as Date.now advances.
    // Only this read path caches provider data; admission always calls providerBusy.
    const coverageFrom=Math.floor(from/day)*day,coverageTo=Math.ceil(to/day)*day;
    const key=`${coverageFrom}:${coverageTo}`,entry={from:coverageFrom,to:coverageTo,expiresAt:now+20000};
    entry.promise=this.providerBusy(coverageFrom,coverageTo).catch(error=>{
      if(this.availabilityCache.get(key)===entry)this.availabilityCache.delete(key);
      throw error;
    });
    if(this.availabilityCache.size>=4)this.availabilityCache.delete(this.availabilityCache.keys().next().value);
    this.availabilityCache.set(key,entry);
    return entry.promise;
  }
  async availability(slug,range={}){await this.refreshMemberEligibility();if(range.preview!==true&&this.maintenanceFrozen())return maintenanceRefusal();const maintenanceEpoch=this.maintenanceEpoch(),t=durationPolicy(this.type(slug,range.preview===true),range.duration,!!range.acceptedBooking);if(!t)return fail('Meeting not found',404);if(range.preview!==true&&!range.acceptedBooking){const closed=this.linkAdmission(t);if(closed)return closed;}this.destination(t);const now=Date.now(),from=Math.max(now,Number(range.from)||now),to=Math.min(now+t.horizon*86400000,Number(range.to)||now+t.horizon*86400000);try{if(t.teamScheduling)return await this.teamAvailability(t,from,to,range,maintenanceEpoch);const busy=await this.availabilityBusy(from-policyBuffers(t).before,to+policyBuffers(t).after);await this.refreshMemberEligibility();if(!this.memberAccountAvailable(this.account(t.accountId)))throw Error('A member calendar needs reconnection.');if(range.preview!==true&&this.maintenanceChanged(maintenanceEpoch))return maintenanceRefusal();if(range.preview!==true&&!range.acceptedBooking){const closed=this.linkAdmission(this.type(slug));if(closed)return closed;}const {teamScheduling,followUpSubject,followUpBody,...publicConfig}=validateConfig(t);return {config:{...publicConfig,...Object.fromEntries(['avatarImage','bannerImage'].map(key=>[key,this.meta('profile')?.[key]??null]))},slots:this.quotaSlots(t,this.memberHoursSlots(this.account(t.accountId),liveSlots(t,now,[...busy,...this.localBusy(range.acceptedBooking?.id)],from,to)),range.acceptedBooking?.id),mode:'live'};}catch(error){return fail(error.status===409?error.message:'Calendar availability is temporarily unavailable.',error.status===409?409:503);}}
  async rescheduleAvailability(id,token,range={},authority={}){
    if(this.maintenanceFrozen())return maintenanceRefusal();const epoch=this.maintenanceEpoch(),booking=await this.authorize(id,token);
    if(!booking)return fail('Booking link not found',404);const closed=closedChange(booking,'reschedule',authority);if(closed)return closed;
    if(!['confirmed','awaiting_approval'].includes(booking.status)||booking.end<=Date.now()||booking.replacementKey)return fail('This booking cannot currently be moved.',409);
    const type=this.type(booking.meetingTypeSlug);if(!type||type.id!==booking.meetingTypeId)return fail('Meeting not found',404);
    if(!!type.teamScheduling!==!!booking.teamAssignment||!booking.teamAssignment&&(type.accountId!==booking.accountId||type.calendarId!==booking.calendarId))return fail('The original meeting host changed. Contact the organizer.',409);
    const now=Date.now(),from=Math.max(now,range.from??now),to=Math.min(now+type.horizon*86400000,range.to??now+type.horizon*86400000);
    if(!Number.isSafeInteger(from)||!Number.isSafeInteger(to)||to<=from)return fail('Choose a valid availability window.',400);
    const snapshot=b=>JSON.stringify([b?.status,b?.version,b?.start,b?.end,b?.accountId,b?.calendarId,b?.tokenHash,b?.teamAssignment,b?.replacementKey,b?.successorId]);const before=snapshot(booking);
    const result=await this.availability(booking.meetingTypeSlug,{from,to,duration:(booking.end-booking.start)/MIN,acceptedBooking:booking});
    if(this.maintenanceChanged(epoch))return maintenanceRefusal();if(snapshot(this.booking(id))!==before)return fail('The booking changed. Refresh before choosing another time.',409);const closedNow=closedChange(this.booking(id),'reschedule',authority);if(closedNow)return closedNow;
    const current=this.type(booking.meetingTypeSlug);if(!current||current.id!==type.id||current.accountId!==type.accountId||current.calendarId!==type.calendarId||JSON.stringify(validateConfig(current))!==JSON.stringify(validateConfig(type)))return fail('Availability changed. Refresh before choosing another time.',409);
    return result;
  }
  async authorize(id,token){const b=this.booking(id);if(!b||typeof token!=='string'||!await timingSafeEqual(await sha256(token),b.tokenHash))return null;return this.booking(id);}
  // The router must authenticate the host owner before invoking this RPC.
  async hostBooking(id){
    this.expireApprovals();
    const booking=this.booking(id);
    if(!booking)return fail('Booking not found',404);
    const {token}=await decryptTokens(booking.tokenRecovery,this.env.TOKEN_ENCRYPTION_KEY,this.hostId());
    return {booking:this.ownerBooking(this.booking(id)??booking),managementToken:token};
  }
  async manage(id,token){this.expireApprovals();const b=await this.authorize(id,token);if(!b)return fail('Booking link not found',404);if(b.status==='confirmed'&&b.conferenceStatus==='pending')await this.reconcileConfirmed(id);return {booking:cleanBooking(this.booking(id))};}
  finishApprovalRequest(b,status){
    if(b.status!=='awaiting_approval')return;
    b.status=status;b.version++;b.approvalDecisionAt=Date.now();delete b.approvalCheck;const updates=[b];
    const old=b.replacesId?this.booking(b.replacesId):null;
    if(old?.status==='confirmed'&&old.successorId===b.id){delete old.replacementKey;delete old.successorId;updates.push(old);}this.putBookings(updates);
  }
  expireApprovals(){
    for(const row of this.rows("SELECT body FROM live_bookings WHERE status='awaiting_approval'")){
      const b=JSON.parse(row.body);if((b.approvalExpiresAt??b.start)<=Date.now())this.finishApprovalRequest(b,'expired');
    }
  }
  approvalCapacity(email,excludeId){const holds=this.rows("SELECT body FROM live_bookings WHERE status='awaiting_approval'").map(row=>JSON.parse(row.body)).filter(b=>b.id!==excludeId);return holds.length<100&&holds.filter(b=>b.email===email).length<3;}
  // Only the authenticated owner RPC may call this method. Guest capability
  // tokens and existing read/settings device scopes confer no decision power.
  async decideBooking(id,data){
    if(this.maintenanceFrozen())return maintenanceRefusal();
    const maintenanceEpoch=this.maintenanceEpoch();
    if(!data||Object.keys(data).some(key=>!['action','expectedVersion','key','reason'].includes(key))||!['approve','reject'].includes(data.action)||!Number.isInteger(data.expectedVersion)||typeof data.key!=='string'||data.key.length<16||data.key.length>150||data.reason!==undefined&&(typeof data.reason!=='string'||data.reason.length>500))return fail('Choose a valid booking decision.');
    await this.wake();
    const keyHash=await sha256(data.key),payloadHash=await sha256(JSON.stringify({action:data.action,expectedVersion:data.expectedVersion,reason:(data.reason??'').trim()}));if(this.maintenanceChanged(maintenanceEpoch))return maintenanceRefusal();this.expireApprovals();let b=this.booking(id);if(!b)return fail('Booking not found',404);
    if(b.approvalDecision?.keyHash===keyHash){if(b.approvalDecision.payloadHash!==payloadHash)return fail('This decision key was already used for another action.',409);return {booking:cleanBooking(b)};}
    if(b.status!=='awaiting_approval'||b.version!==data.expectedVersion)return fail('This request has changed. Refresh it before deciding.',409);
    if(data.action==='reject'){b.rejectionReason=(data.reason??'').trim();b.approvalDecision={keyHash,payloadHash,action:'reject'};this.finishApprovalRequest(b,'rejected');await this.wake();return {booking:cleanBooking(this.booking(id))};}
    if(b.approvalCheck?.until>Date.now())return fail('This request is already being checked. Refresh it shortly.',409);
    b.approvalCheck={keyHash,until:Date.now()+2*MIN};this.putBooking(b);
    try{
      await this.refreshMemberEligibility();const type=this.type(b.meetingTypeSlug);if(!type||type.id!==b.meetingTypeId||!!type.teamScheduling!==!!b.teamAssignment||!b.teamAssignment&&(type.accountId!==b.accountId||type.calendarId!==b.calendarId))return fail('The meeting calendar or availability changed. Review the request.',409);
      this.destination(type);
      const policy={...durationPolicy(type,(b.end-b.start)/MIN,true),notice:0},hosts=b.teamAssignment?this.teamHosts(policy):null,signature=hosts?this.teamSignature(policy,hosts):null;
      const busy=hosts?await this.teamProviderBusy(hosts,b.start-policyBuffers(policy).before,b.end+policyBuffers(policy).after):await this.providerBusy(b.start-Math.max(policyBuffers(b.config).before,policyBuffers(type).before),b.end+Math.max(policyBuffers(b.config).after,policyBuffers(type).after));
      await this.refreshMemberEligibility();
      if(this.maintenanceChanged(maintenanceEpoch))return maintenanceRefusal();
      this.expireApprovals();b=this.booking(id);
      if(b.status!=='awaiting_approval'||b.version!==data.expectedVersion||b.approvalCheck?.keyHash!==keyHash)return fail('This request has changed. Refresh it before deciding.',409);
      const current=this.type(b.meetingTypeSlug),exclude=[id,b.replacesId];
      if(!current||current.id!==type.id||current.accountId!==type.accountId||current.calendarId!==type.calendarId||JSON.stringify(validateConfig(current))!==JSON.stringify(validateConfig(type))||hosts&&(this.teamSignature({...durationPolicy(current,policy.duration,true),notice:0})!==signature||!this.teamAccountsCurrent({hosts},busy.versions)))return fail('Availability changed while checking this request. Try again.',409);
      let assignment;if(hosts)assignment=this.chooseTeamAssignment(policy,hosts,busy.busy,b.start,b.end,{exclude,original:b});
      if(!hosts&&(!this.memberAccountAvailable(this.account(b.accountId))||!this.memberHoursAllow(this.account(b.accountId),b.start,b.end)))return fail('The meeting host is unavailable. Review this request.',409);
      if((hosts?!assignment:!liveSlots(policy,Date.now(),[...busy,...this.localBusy(exclude)],b.start,b.end).some(slot=>slot.start===b.start))||!this.withinDailyLimit(policy,b.start,exclude,b.end))return fail('That time is no longer available. Decline this request or ask the guest to choose another time.',409);
      if(assignment)b.teamAssignment=assignment;
      const original=b.replacesId?this.booking(b.replacesId):null;
      if(b.replacesId&&(!original||original.status!=='confirmed'||original.end<=Date.now()||original.successorId!==b.id))return fail('The original booking has changed.',409);
      b.status='pending';b.version++;b.approvalDecisionAt=Date.now();b.approvalDecision={keyHash,payloadHash,action:'approve'};delete b.approvalCheck;this.putBooking(b);
      await this.wake();await this.reconcile(id);return {booking:cleanBooking(this.booking(id))};
    }catch(error){return fail(error.status===409?error.message:'Calendar availability is temporarily unavailable. Try again before the request expires.',error.status===409?409:503);}
    finally{const current=this.booking(id);if(current?.status==='awaiting_approval'&&current.approvalCheck?.keyHash===keyHash){delete current.approvalCheck;this.putBooking(current);}}
  }
  async reserve(slug,data,replacesId,authority={}){if(this.maintenanceFrozen())return maintenanceRefusal();const maintenanceEpoch=this.maintenanceEpoch();let t=this.type(slug);if(!t)return fail('Meeting not found',404);const source=['email','website'].includes(data.source)?data.source:'direct';const timeZone=data.timeZone??t.zone;if(typeof timeZone!=='string'||!validZone(timeZone))return fail('Choose a valid timezone');const start=Number(data.start),key=data.idempotencyKey??data.key,name=String(data.name??'').trim(),email=String(data.email??'').trim().toLowerCase(),answer=String(data.answer??'').trim();if(!Number.isSafeInteger(start)||typeof key!=='string'||key.length<16||key.length>150||!name||name.length>160||!validEmail(email)||answer.length>2000)return fail('Check your booking details');
    const requestKey=await sha256(key),existingRow=this.rows('SELECT body FROM live_bookings WHERE request_key=?',requestKey)[0],existing=existingRow?JSON.parse(existingRow.body):null;
    const rejectReviewed=(message,status=400)=>({...fail(message,status),...(existing?{code:'idempotency_conflict'}:{})});
    // A retry or authorized move answers the accepted form, never a later edit.
    // Read the source from durable storage, not a guest-supplied snapshot.
    if(this.maintenanceChanged(maintenanceEpoch))return maintenanceRefusal();
    this.expireApprovals();const original=replacesId?this.booking(replacesId):null;
    if(replacesId&&(!original||original.meetingTypeId!==t.id))return fail('The original booking has changed.',409);
    if(original&&!original.teamAssignment&&(original.accountId!==t.accountId||original.calendarId!==t.calendarId))return fail('The original meeting host changed. Contact the organizer.',409);
    const accepted=original??existing;if(!accepted){const closed=this.linkAdmission(t);if(closed)return closed;}
    let duration;try{duration=accepted?(accepted.end-accepted.start)/MIN:selectDuration(t,data.duration);if(accepted&&data.duration!==undefined&&data.duration!==duration)return rejectReviewed('This request uses a different meeting duration.',409);t=durationPolicy(t,duration,!!accepted);}catch(error){return rejectReviewed(error.message,existing?409:400);}
    const intakeConfig=accepted?.intakeVersion===1?{...accepted.config,questions:accepted.questionSnapshot,extraGuestsLimit:5}:accepted?{...accepted.config,...(accepted.answer&&!accepted.config.question?{question:'Guest note'}:{})}:t;
    const reviewedRevision=accepted?.intakeRevision??await intakeRevision(intakeConfig);
    let reviewedTeamRevision=null;try{reviewedTeamRevision=existing?existing.teamRevision??null:t.teamScheduling?await this.teamRevision(t):null;}catch{return fail('A team calendar needs attention.',503);}
    if(!existing&&original&&!!original.teamAssignment!==!!t.teamScheduling)return fail('The booking host setup changed. Create a new booking instead.',409);
    if(!original&&reviewedTeamRevision&&data.teamRevision!==reviewedTeamRevision)return rejectReviewed('Team availability changed. Refresh the booking page and choose again.',existing?409:400);
    const requestedHostId=original?.teamAssignment?.mode==='choose'?original.teamAssignment.hosts[0].id:data.teamHostId;
    if(!existing&&!original&&t.teamScheduling&&(t.teamScheduling.mode==='choose'?!t.teamScheduling.hosts.some(h=>h.id===requestedHostId):data.teamHostId!=null&&data.teamHostId!==''))return fail('Choose a valid meeting host.');
    // A new hold requires the exact form shown to the guest. Existing rows from
    // before revision enforcement retain their old retry contract; moves derive
    // intake from the authorized durable original rather than a browser form.
    if(!original&&(!existing||existing.intakeRevision!==undefined)&&data.intakeRevision!==reviewedRevision)return rejectReviewed('The booking questions changed. Refresh this page and review the updated form before confirming.',existing?409:400);
    let submitted=original?{answers:original.answers,answer:original.answer,additionalGuests:original.additionalGuests,email}:data;
    if(accepted?.intakeVersion===1){
      submitted={...submitted,answers:submitted.answers??{},answer:undefined};
      if(accepted.config.questions==null&&answer)submitted.answers={...submitted.answers,legacy:original?.answer??answer};
    }
    let intake;try{intake=validateIntake(intakeConfig,submitted);}catch(error){return rejectReviewed(error.message,existing?409:400);}
    const ownerEmail=this.account(accepted?.accountId??t.accountId)?.email?.toLowerCase();intake.additionalGuests=intake.additionalGuests.filter(guest=>guest!==ownerEmail);
    const intakeHash={answers:intake.answers,additionalGuests:intake.additionalGuests};
    const payload={slug,start,name,email,answer,...(!existing||existing.durationVersion===1?{duration}:{}),timeZone:data.timeZone??'',replacesId:replacesId??null,...(reviewedTeamRevision?{teamRevision:reviewedTeamRevision,teamHostId:original?original.teamRequestedHostId??null:data.teamHostId??null}:{})};
    // Old durable requests used the legacy hash. Retain their replay contract.
    const payloadHash=await sha256(JSON.stringify({...payload,...(existing&&existing.questionSnapshot===undefined?{}:intakeHash),...(!existing||existing.intakeRevision!==undefined?{intakeRevision:reviewedRevision}:{})}));
    if(this.maintenanceChanged(maintenanceEpoch))return maintenanceRefusal();
    if(existing){if(existing.payloadHash!==payloadHash)return rejectReviewed('This request was already used for another booking.',409);const {token}=await decryptTokens(existing.tokenRecovery,this.env.TOKEN_ENCRYPTION_KEY,this.hostId());if(this.maintenanceChanged(maintenanceEpoch))return maintenanceRefusal();return {booking:cleanBooking(existing),managementToken:token};}
    await this.refreshMemberEligibility();if(!t.teamScheduling&&!this.memberAccountAvailable(this.account(t.accountId)))return fail('The meeting host is unavailable. Contact the organizer.',409);
    const requiresApproval=!!(t.requiresApproval||original?.config.requiresApproval),createdAt=Date.now();
    let destination,teamContext;const end=start+t.duration*MIN;try{destination=this.destination(t);if(t.teamScheduling){const hosts=this.teamHosts(t),signature=this.teamSignature(t,hosts),{busy,versions}=await this.teamProviderBusy(hosts,start-policyBuffers(t).before,end+policyBuffers(t).after);if(this.maintenanceChanged(maintenanceEpoch))return maintenanceRefusal();const assignment=this.chooseTeamAssignment(t,hosts,busy,start,end,{exclude:replacesId,original,requestedHostId});if(!assignment)return fail('That time is no longer available for the selected hosts.',409);teamContext={hosts,signature,busy,versions,assignment};destination={a:this.account(assignment.hosts[0].accountId),calendarId:assignment.hosts[0].calendarId};}}catch(error){return fail(error.status===409?error.message:'Team calendar availability is temporarily unavailable.',error.status===409?409:503);}
    if(!teamContext&&!liveSlots(t,Date.now(),this.localBusy(replacesId),start,end).some(s=>s.start===start))return fail('That time is no longer available.',409);
    if(!this.withinDailyLimit(t,start,replacesId))return fail('The booking limit has been reached. Choose another day or week.',409);
    if(requiresApproval){if(!this.approvalCapacity(email,replacesId))return fail('Too many requests are awaiting approval. Cancel an existing request or try again later.',429);if(!teamContext)try{const busy=await this.providerBusy(start-policyBuffers(t).before,end+policyBuffers(t).after);if(busy.some(item=>overlap({start,end},item,policyBuffers(t))))return fail('That time is no longer available.',409);}catch{return fail('Calendar availability is temporarily unavailable.',503);}}
    const token=randomToken(),tokenHash=await sha256(token),tokenRecovery=await encryptTokens({token},this.env.TOKEN_ENCRYPTION_KEY,this.hostId());
    await this.wake();await this.refreshMemberEligibility();
    // Recheck immediately before the synchronous durable hold: hashing/encryption yields.
    if(this.maintenanceChanged(maintenanceEpoch))return maintenanceRefusal();
    let latest;try{latest=durationPolicy(this.type(slug),duration,!!accepted);}catch{return fail('Meeting durations changed. Refresh the booking page.',409);}
    if(!latest||latest.id!==t.id||latest.accountId!==t.accountId||latest.calendarId!==t.calendarId||JSON.stringify(validateConfig(latest))!==JSON.stringify(validateConfig(t)))return fail('Availability settings changed. Refresh the booking page and choose again.',409);
    if(this.rows('SELECT id FROM live_bookings WHERE request_key=?',requestKey).length)return this.reserve(slug,data,replacesId,authority);
    if(teamContext){if(this.teamSignature(latest)!==teamContext.signature||!this.teamAccountsCurrent({hosts:teamContext.hosts},teamContext.versions))return fail('Team availability changed. Refresh the booking page and choose again.',409);const assignment=this.chooseTeamAssignment(t,teamContext.hosts,teamContext.busy,start,end,{exclude:replacesId,original,requestedHostId});if(!assignment)return fail('That time is no longer available for the selected hosts.',409);teamContext.assignment=assignment;destination={a:this.account(assignment.hosts[0].accountId),calendarId:assignment.hosts[0].calendarId};}
    else if(!this.memberAccountAvailable(this.account(t.accountId))||!this.memberHoursAllow(this.account(t.accountId),start,end)||!liveSlots(t,Date.now(),this.localBusy(replacesId),start,end).some(s=>s.start===start))return fail('That time is no longer available.',409);
    if(!this.withinDailyLimit(t,start,replacesId))return fail('The booking limit has been reached. Choose another day or week.',409);
    if(requiresApproval&&(!this.approvalCapacity(email,replacesId)||Math.min(createdAt+(original?.config.approvalExpiryMinutes??t.approvalExpiryMinutes)*MIN,start)<=Date.now()))return fail('This request can no longer be accepted. Choose another time or cancel an existing request.',409);
    if(replacesId){const closed=closedChange(this.booking(replacesId),'reschedule',authority);if(closed)return closed;}
    if(replacesId&&(!['confirmed','awaiting_approval'].includes(this.booking(replacesId)?.status)||this.booking(replacesId).end<=Date.now()))return fail('The original booking has changed.',409);
    if(!original){const closed=this.linkAdmission(latest);if(closed)return closed;}
    const id=crypto.randomUUID(),b={id,requestKey,payloadHash,start,end,duration,durationVersion:1,name,email,answer,intakeVersion:1,intakeRevision:reviewedRevision,...intake,timeZone:String(data.timeZone??t.zone).slice(0,100),source,meetingTypeId:t.id,meetingTypeSlug:slug,title:t.title,location:t.locationType==='google_meet'?'':t.location,config:original?{...t,durationOptions:original.config.durationOptions??null,requiresApproval,approvalExpiryMinutes:original.config.approvalExpiryMinutes??t.approvalExpiryMinutes,reminder:original.config.reminder,reminderMinutes:original.config.reminderMinutes??null,...Object.fromEntries(['cancellationNoticeMinutes','rescheduleNoticeMinutes','followUpMinutes','followUpSubject','followUpBody'].map(key=>[key,original.config[key]??DEFAULT[key]]))}:{...t,requiresApproval},...(teamContext?{teamAssignment:teamContext.assignment,teamRevision:reviewedTeamRevision,teamRequestedHostId:t.teamScheduling.mode==='choose'?requestedHostId:null}:{}),accountId:destination.a.id,calendarId:destination.calendarId,eventId:'b'+id.replaceAll('-',''),tokenHash,tokenRecovery,status:requiresApproval?'awaiting_approval':'pending',...(requiresApproval?{approvalExpiresAt:Math.min(createdAt+(original?.config.approvalExpiryMinutes??t.approvalExpiryMinutes)*MIN,start)}:{}),version:1,leaseUntil:0,createdAt,replacesId:original?.status==='awaiting_approval'?undefined:replacesId,...(original?.status==='awaiting_approval'?{requestReplacesId:replacesId}:{})};const updates=[b];if(replacesId){const old=this.booking(replacesId);old.successorId=id;if(requiresApproval&&original?.status==='awaiting_approval'){old.status='cancelled';old.version++;old.requestSuperseded=true;}updates.push(old);}this.putBookings(updates);
    await this.wake();if(!requiresApproval)await this.reconcile(id);return {booking:cleanBooking(this.booking(id)),managementToken:token};
  }
  async wake(){if(this.lifecycleFrozen())return;await this.ctx.storage.setAlarm(Date.now()+15000);if(this.lifecycleFrozen())await this.ctx.storage.deleteAlarm?.();}
  async cancel(id,token,reasonValue,authority={}){
    const reason=cancellationReason(reasonValue);if(this.maintenanceFrozen())return maintenanceRefusal();const maintenanceEpoch=this.maintenanceEpoch();await this.wake();this.expireApprovals();const b=await this.authorize(id,token);
    if(this.maintenanceChanged(maintenanceEpoch))return maintenanceRefusal();if(!b)return fail('Booking link not found',404);if(['cancelled','rejected','expired'].includes(b.status))return {booking:cleanBooking(b)};
    const closed=closedChange(b,'cancel',authority);if(closed)return closed;
    if(b.status==='awaiting_approval'){rememberCancellation(b,reason);this.finishApprovalRequest(b,'cancelled');await this.wake();return {booking:cleanBooking(this.booking(id))};}
    if(b.status!=='pending'&&b.status!=='cancelling'&&b.end<=Date.now())return fail('This meeting has ended and can no longer be cancelled.',409);
    // No await between final deadline/state guard and accepted cancellation intent.
    rememberCancellation(b,reason);if(b.status!=='cancelling'){b.status='cancelling';b.version++;this.putBooking(b);}
    const successor=b.successorId?this.booking(b.successorId):null;if(successor?.status==='awaiting_approval')this.finishApprovalRequest(successor,'cancelled');else if(successor&&active.has(successor.status)){successor.status='cancelling';successor.version++;this.putBooking(successor);}await this.wake();await this.reconcile(id);if(successor)await this.reconcile(successor.id);return {booking:cleanBooking(this.booking(id))};
  }
  async reschedule(id,token,start,key,authority={}){if(this.maintenanceFrozen())return maintenanceRefusal();const maintenanceEpoch=this.maintenanceEpoch();this.expireApprovals();const b=await this.authorize(id,token);if(this.maintenanceChanged(maintenanceEpoch))return maintenanceRefusal();if(!b)return fail('Booking link not found',404);if(b.end<=Date.now())return fail('This meeting has ended and can no longer be rescheduled.',409);if(!['confirmed','awaiting_approval'].includes(b.status)){const existing=typeof key==='string'?this.rows('SELECT body FROM live_bookings WHERE request_key=?',await sha256(key))[0]:null;const next=existing?JSON.parse(existing.body):null;if(!next||(next.replacesId??next.requestReplacesId)!==id||next.start!==start)return fail('This booking cannot currently be moved.',409);}if(start===b.start){const closed=closedChange(b,'reschedule',authority);return closed??{booking:cleanBooking(b)};}if(typeof key!=='string'||key.length<16||key.length>150||!Number.isSafeInteger(start))return fail('Invalid reschedule request');const replacementKey=await sha256(key);if(this.maintenanceChanged(maintenanceEpoch))return maintenanceRefusal();const current=this.booking(id);if(current.end<=Date.now())return fail('This meeting has ended and can no longer be rescheduled.',409);const acceptedMove=this.rows('SELECT body FROM live_bookings WHERE request_key=?',replacementKey)[0];if(!acceptedMove){const closed=closedChange(current,'reschedule',authority);if(closed)return closed;}if(current.replacementKey&&current.replacementKey!==replacementKey)return fail('A move is already in progress.',409);if(!current.replacementKey){if(!['confirmed','awaiting_approval'].includes(current.status))return fail('The original booking has changed.',409);current.replacementKey=replacementKey;this.putBooking(current);}const t=(this.meta('meetingTypes')??[]).find(t=>t.id===b.meetingTypeId);if(!t)return fail('Meeting not found',404);const result=await this.reserve(t.slug,{...b,start,idempotencyKey:key},b.id,authority);if(result.error){const current=this.booking(id);if(current.replacementKey===replacementKey){delete current.replacementKey;this.putBooking(current);}return result;}if(this.maintenanceChanged(maintenanceEpoch))return maintenanceRefusal();const next=this.booking(result.booking.id);if(b.status!=='awaiting_approval'&&!next.requestReplacesId)next.replacesId=b.id;this.putBooking(next);if(next.status==='failed'){const current=this.booking(id);delete current.replacementKey;this.putBooking(current);}if(next.status==='confirmed')await this.finishReplacement(next);return {...result,previousBooking:cleanBooking(this.booking(id))};}
  async finishReplacement(next){const old=this.booking(next.replacesId);if(old&&old.status==='confirmed'){old.status='cancelling';old.version++;old.successorId=next.id;old.replacementConfirmed=true;this.putBooking(old);await this.wake();await this.reconcile(old.id);}}
  listBookings({includeNotifications=false}={}){
    this.expireApprovals();
    const reconciliationIssues=this.rows("SELECT body FROM live_bookings WHERE status IN ('pending','confirmed','cancelling','failed')").map(r=>JSON.parse(r.body)).flatMap(b=>{
      const issue=reconciliationMessages.get(b.lastError);return issue?[{bookingId:b.id,...issue}]:[];
    });
    const jobRows=this.rows("SELECT j.body AS job,b.body AS booking FROM live_jobs j LEFT JOIN live_bookings b ON json_extract(j.body,'$.bookingId')=b.id"),jobBookings=new Map(jobRows.filter(r=>r.booking).map(r=>{const b=JSON.parse(r.booking);return [b.id,b];})),jobs=jobRows.map(r=>JSON.parse(r.job));
    const notificationIssues=jobs.filter(j=>this.notificationStatus(j,jobBookings.get(j.bookingId))==='needs_review').map(j=>({bookingId:j.bookingId,kind:j.kind,error:j.error==='Delivery configuration requires review'?'Delivery configuration requires review':'Delivery requires review'}));
    const attentionIds=[...new Set(notificationIssues.map(j=>j.bookingId))].slice(0,500);
    const priority=includeNotifications&&attentionIds.length?'CASE WHEN id IN (SELECT value FROM json_each(?)) THEN 0 ELSE 1 END, ':'';
    const bookings=this.rows("SELECT body FROM live_bookings ORDER BY "+priority+"CASE WHEN status='awaiting_approval' THEN 0 ELSE 1 END, start DESC LIMIT 500",...(includeNotifications&&attentionIds.length?[JSON.stringify(attentionIds)]:[])).map(r=>JSON.parse(r.body));
    if(!includeNotifications)return {reconciliationIssues,notificationIssues,bookings:bookings.map(cleanBooking)};
    // Fetch the bounded receipt history once, rather than issuing queries for
    // every booking row. This projection is never returned to linked devices.
    const group=items=>{const map=new Map();for(const item of items){if(!map.has(item.bookingId))map.set(item.bookingId,[]);map.get(item.bookingId).push(item);}return map;};
    const receipts=this.rows('SELECT booking_id,body FROM live_notification_receipts WHERE updated_at>=? ORDER BY updated_at DESC',Date.now()-90*86400000).map(r=>({...JSON.parse(r.body),bookingId:r.booking_id}));
    const activity={jobs:group(jobs),receipts:group(receipts)};
    return {reconciliationIssues,notificationIssues,bookings:bookings.map(b=>this.ownerBooking(b,activity))};
  }
  async disconnect(id){this.expireApprovals();if(this.rows("SELECT id FROM live_bookings WHERE status IN ('awaiting_approval','pending','cancelling') OR (status='confirmed' AND end>?)",Date.now()).some(r=>(this.booking(r.id).teamAssignment?.hosts??[{accountId:this.booking(r.id).accountId}]).some(h=>h.accountId===id)))return fail('Cancel active bookings before disconnecting this calendar.',409);const a=this.account(id);if(a){this.sql.exec('DELETE FROM live_accounts WHERE id=?',id);this.putMeta('meetingTypes',(this.meta('meetingTypes')??[]).map(t=>t.accountId===id||t.teamScheduling?.hosts.some(h=>h.accountId===id)?{...t,published:false}:t));}return this.settings();}
  bookingAttendees(booking){
    const attendees=[{email:booking.email,displayName:booking.name}],seen=new Set([booking.email.toLowerCase()]),organizer=this.account(booking.accountId)?.email?.toLowerCase();
    for(const person of [...(booking.additionalGuests??[]).map(email=>({email})),...(booking.teamAssignment?.hosts.slice(1)??[]).map(h=>({email:h.email,displayName:h.name}))]){const key=person.email.toLowerCase();if(!seen.has(key)&&key!==organizer){seen.add(key);attendees.push(person);}}
    return attendees;
  }
  async reconcile(id){if(this.maintenanceFrozen())return;const maintenanceEpoch=this.maintenanceEpoch();let b=this.booking(id);if(!b||!['pending','cancelling'].includes(b.status)||b.leaseUntil>Date.now())return;b.leaseUntil=Date.now()+120000;this.putBooking(b);let rejectedCreate=false;
    try{const primaryVersion=this.account(b.accountId)?.connectionVersion,teamVersions=b.status==='cancelling'?null:this.teamVersions(b.teamAssignment);const effectCurrent=()=>{const current=this.booking(id),account=this.account(b.accountId);return current&&account?.connected&&account.connectionVersion===primaryVersion&&(!current.teamAssignment||account.email?.toLowerCase()===current.teamAssignment.hosts[0].email)&&(current.status==='cancelling'||this.teamAccountsCurrent(current.teamAssignment,teamVersions));};const access=await this.access(b.accountId);if(!effectCurrent())throw Error('Calendar connection changed');let event;try{event=await this.google.getEvent(access,{calendarId:b.calendarId,eventId:b.eventId,bookingId:b.id},{timeoutMs:10000});}catch(e){if(e.status!==404&&e.status!==410)throw e;}
      if(this.maintenanceChanged(maintenanceEpoch))return;if(!effectCurrent())throw Error('Calendar connection changed');
      b=this.booking(id);
      if(b.status==='cancelling'){if(event&&event.status!=='cancelled')await this.google.deleteEvent(access,{calendarId:b.calendarId,eventId:b.eventId,bookingId:b.id,etag:event.etag},{timeoutMs:10000});if(this.maintenanceChanged(maintenanceEpoch))return;if(!effectCurrent())throw Error('Calendar connection changed');b=this.booking(id);b.status='cancelled';b.leaseUntil=0;delete b.lastError;this.putBooking(b);await this.queueNotification(b,'cancelled');return;}
      if(event?.status==='cancelled'){
        // The deterministic event ID is already deleted and cannot be reused.
        // Release this pending hold without recreating or modifying the tombstone.
        b.status='failed';b.leaseUntil=0;b.lastError='This calendar booking was deleted.';this.putBooking(b);logReconciliationFailure('calendar_event_deleted',410);
        const old=b.replacesId?this.booking(b.replacesId):null;
        if(old?.status==='confirmed'&&old.successorId===b.id){delete old.replacementKey;delete old.successorId;this.putBooking(old);}
        return;
      }
      if(!event){
        let conflict;if(b.teamAssignment){const fresh=await this.teamProviderBusy(b.teamAssignment.hosts,b.start-policyBuffers(b.config).before,b.end+policyBuffers(b.config).after);conflict=b.teamAssignment.hosts.some(h=>[...fresh.busy[h.id],...this.teamLocalBusy(h,[id,b.replacesId])].some(x=>overlap(b,x,policyBuffers(h.policy??b.config))));}else{const busy=await this.providerBusy(b.start-policyBuffers(b.config).before,b.end+policyBuffers(b.config).after,b);conflict=[...busy,...this.localBusy(id)].some(x=>overlap(b,x,policyBuffers(b.config)));}if(this.maintenanceChanged(maintenanceEpoch))return;if(!effectCurrent())throw Error('Calendar connection changed');b=this.booking(id);if(b.status==='cancelling'){b.leaseUntil=0;this.putBooking(b);await this.reconcile(id);return;}
        if(conflict){b.status=b.attempted?'pending':'failed';b.leaseUntil=0;this.putBooking(b);if(b.attempted)await this.wake();return;}
        // Persist the attempted effect before calling Google. Retrying always GETs the same ID.
        b=this.booking(id);if(b.status==='cancelling'){b.leaseUntil=0;this.putBooking(b);await this.reconcile(id);return;}const hadAttempted=!!b.attempted;b.attempted=true;this.putBooking(b);try{event=await this.google.createEvent(access,{calendarId:b.calendarId,eventId:b.eventId,bookingId:b.id,conference:b.config.locationType==='google_meet',event:{summary:b.title,description:intakeDescription(b),location:b.location,start:{dateTime:new Date(b.start).toISOString(),timeZone:b.config.zone},end:{dateTime:new Date(b.end).toISOString(),timeZone:b.config.zone},attendees:this.bookingAttendees(b),extendedProperties:{private:{emailBooking:b.id}}}},{timeoutMs:10000});
        }catch(error){
          // These responses definitively reject this insert. A prior unknown
          // result still requires deterministic GET recovery: never release it.
          if(!hadAttempted&&error.retryable===false&&[400,401,403,404,422].includes(error.status)){
            b=this.booking(id);b.attempted=false;this.putBooking(b);
            rejectedCreate=[400,422].includes(error.status);
          }
          throw error;
        }
      }
      if(!effectCurrent())throw Error('Calendar connection changed');b=this.booking(id);b.leaseUntil=0;if(b.status==='cancelling'){this.putBooking(b);await this.reconcile(id);return;}b.status='confirmed';b.eventEtag=event?.etag;b.calendarEventStatus=event?.status??'confirmed';b.calendarSyncStatus='current';b.calendarSyncedAt=Date.now();this.captureConference(b,event);b.syncAfter=Date.now()+this.confirmedInterval(b);delete b.lastError;this.putBooking(b);const old=b.replacesId?this.booking(b.replacesId):null;if(old&&old.status==='confirmed'){old.status='cancelling';old.version++;old.successorId=b.id;old.replacementConfirmed=true;this.putBooking(old);}await this.queueNotification(b,'confirmed');if(old?.status==='cancelling')await this.reconcile(old.id);
    }catch(e){b=this.booking(id);b.leaseUntil=0;const authorization=e.code==='invalid_grant'||e.status===401||(e.status===403&&e.retryable!==true);
      logReconciliationFailure(authorization?'calendar_authorization_required':rejectedCreate?'calendar_validation_rejected':'calendar_sync_failed',e.status);
      if(rejectedCreate&&b.status==='pending'){
        b.status='failed';b.lastError='The calendar rejected these booking details.';
        const old=b.replacesId?this.booking(b.replacesId):null;
        if(old?.status==='confirmed'&&old.successorId===b.id){delete old.replacementKey;delete old.successorId;this.putBooking(old);}
      }else b.lastError=authorization?'Calendar authorization needs attention.':'Calendar synchronization is pending.';
      this.putBooking(b);await this.wake();} 
  }
  confirmedInterval(booking){return booking.conferenceStatus==='pending'?((booking.conferenceChecks??0)<6?10000:MIN):SYNC_INTERVAL;}
  captureConference(booking,event){
    if(booking.config.locationType!=='google_meet'||typeof this.google.conferenceDetails!=='function')return;
    const details=this.google.conferenceDetails(event);
    booking.conferenceStatus=details.conferenceStatus;
    if(details.meetingUrl)booking.meetingUrl=details.meetingUrl;else delete booking.meetingUrl;
  }
  // Existing hosts can have a distant retention-only alarm from before this watcher.
  async resumeConfirmedSync(){
    const due=this.nextConfirmedSync(),integrationDue=this.integrations.nextDue();if(due==null&&integrationDue==null)return;
    const current=await this.ctx.storage.getAlarm?.();
    // Re-read work after getAlarm yields: never postpone a concurrently queued
    // cancellation or message with an older confirmed-booking deadline.
    const pending=this.rows("SELECT id FROM live_bookings WHERE status IN ('pending','cancelling') LIMIT 1").length;
    const job=this.rows('SELECT MIN(due) AS due FROM live_jobs')[0]?.due;
    const target=Math.max(Date.now()+15000,Math.min(this.integrations.nextDue()??Infinity,this.nextConfirmedSync()??Infinity,pending?Date.now()+15000:Infinity,job??Infinity));
    if(Number.isFinite(target)&&(current==null||current>target))await this.ctx.storage.setAlarm(target);
  }
  nextConfirmedSync(){
    return this.rows("SELECT MIN(MAX(COALESCE(json_extract(body,'$.syncAfter'),0),COALESCE(json_extract(body,'$.syncLeaseUntil'),0))) AS due FROM live_bookings WHERE status='confirmed' AND json_extract(body,'$.replacementKey') IS NULL AND end>=?",Date.now()-SYNC_WINDOW)[0]?.due??null;
  }
  async reconcileConfirmed(id,{forNotification=false}={}){
    if(this.maintenanceFrozen())return;
    const maintenanceEpoch=this.maintenanceEpoch();
    let booking=this.booking(id);const now=Date.now();
    if(!booking||booking.status!=='confirmed'||(!forNotification&&booking.end<now-SYNC_WINDOW)||booking.replacementKey||(!forNotification&&(booking.syncAfter??0)>now)||(booking.syncLeaseUntil??0)>now)return;
    const connected=this.account(booking.accountId);
    if((connected?.syncCooldownUntil??0)>now){booking.syncAfter=connected.syncCooldownUntil;this.putBooking(booking);return;}
    booking.syncLeaseUntil=now+2*MIN;this.putBooking(booking);
    let teamVersions;const snapshot=JSON.stringify(booking),account=this.account(booking.accountId),connectionVersion=account?.connectionVersion;
    const currentBooking=()=>{
      const current=this.booking(id),latestAccount=this.account(booking.accountId);
      return !this.maintenanceChanged(maintenanceEpoch)&&current&&JSON.stringify(current)===snapshot&&latestAccount?.connected&&latestAccount.connectionVersion===connectionVersion&&this.teamAccountsCurrent(current.teamAssignment,teamVersions)?current:null;
    };
    try{
      teamVersions=this.teamVersions(booking.teamAssignment);
      if(booking.teamAssignment&&forNotification){await this.teamProviderBusy(booking.teamAssignment.hosts,booking.start,booking.end);if(!currentBooking())return;}
      const access=await this.access(booking.accountId);
      if(!currentBooking())return;
      let event;
      try{event=await this.google.getEvent(access,{calendarId:booking.calendarId,eventId:booking.eventId,bookingId:id},{timeoutMs:10000});}
      catch(error){if(![404,410].includes(error.status))throw error;}
      const current=currentBooking();if(!current)return;
      // An exact ID tombstone is read-only evidence. Every live event also needs
      // the booking ownership marker; never mutate an event from this path.
      if(event&&(event.id!==current.eventId||(event.status!=='cancelled'&&event.extendedProperties?.private?.emailBooking!==id)))throw Object.assign(Error('ownership'),{code:'unmanaged_event'});
      if(!event||event.status==='cancelled'){
        current.status='cancelled';current.version++;current.calendarChange='cancelled';current.calendarEventStatus='cancelled';
        current.calendarSyncStatus='current';current.calendarSyncedAt=Date.now();current.syncLeaseUntil=0;delete current.lastError;
        this.putBooking(current);return;
      }
      const staffNeedsReview=current.teamAssignment?.mode==='all'&&current.teamAssignment.hosts.slice(1).some(host=>!event.attendees?.some(person=>person.email?.toLowerCase()===host.email&&person.responseStatus!=='declined'));
      const start=Date.parse(event.start?.dateTime),end=Date.parse(event.end?.dateTime);
      if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||end<=start||!['confirmed','tentative',undefined].includes(event.status))throw Object.assign(Error('unsupported event'),{code:'unsupported_event'});
      const location=typeof event.location==='string'?event.location.slice(0,160):'';
      const zone=event.start?.timeZone;
      const changed=start!==current.start||end!==current.end||location!==current.location;
      // A free/busy response cannot distinguish the staff invitation itself from
      // an unrelated overlapping event. Keep both intervals blocked until an
      // explicit in-app move or cancellation rechecks the collective assignment.
      if(current.teamAssignment?.mode==='all'&&(current.teamReviewHold||staffNeedsReview||start!==current.start||end!==current.end)){
        current.teamReviewHold={start:Math.min(current.teamReviewHold?.start??current.start,start),end:Math.max(current.teamReviewHold?.end??current.end,end)};
        if(start!==current.start||end!==current.end){current.start=start;current.end=end;current.version++;current.calendarChange='updated';}
        current.calendarSyncStatus='pending';current.lastError='Calendar event needs review.';current.syncLeaseUntil=0;current.syncAfter=Date.now()+60*MIN;current.calendarSyncedAt=Date.now();this.putBooking(current);return;
      }
      if(changed){
        current.start=start;current.end=end;current.location=location;
        current.version++;current.calendarChange='updated';
      }
      if(zone&&validZone(zone))current.calendarTimeZone=zone;
      this.captureConference(current,event);
      if(current.conferenceStatus==='pending')current.conferenceChecks=(current.conferenceChecks??0)+1;
      const latestAccount=this.account(current.accountId);
      if(latestAccount?.connectionVersion===connectionVersion&&(latestAccount.syncFailures||latestAccount.syncCooldownUntil)){latestAccount.syncFailures=0;latestAccount.syncCooldownUntil=0;this.putAccount(latestAccount);}
      current.calendarEventStatus=event.status??'confirmed';
      current.eventEtag=event.etag;current.syncLeaseUntil=0;current.syncAttempts=0;current.syncAfter=Date.now()+this.confirmedInterval(current);
      current.calendarSyncStatus='current';current.calendarSyncedAt=Date.now();delete current.lastError;this.putBooking(current);
      // Old-version reminders are suppressed by processJob. A moved appointment
      // gets a new reminder only, never another confirmation or calendar insert.
      if(changed)await this.queueReminder(current);
      return true;
    }catch(error){
      const current=currentBooking();if(!current)return;
      const authorization=error.code==='invalid_grant'||error.status===401||(error.status===403&&error.retryable!==true),rateLimited=error.status===429||(error.status===403&&error.retryable===true),review=['unmanaged_event','unsupported_event'].includes(error.code);
      current.syncLeaseUntil=0;current.syncAttempts=(current.syncAttempts??0)+1;
      current.syncAfter=Date.now()+(authorization||review?60*MIN:Math.min(60*MIN,SYNC_INTERVAL*2**Math.min(current.syncAttempts-1,4)));
      current.calendarSyncStatus='pending';current.lastError=authorization?'Calendar authorization needs attention.':review?'Calendar event needs review.':'Calendar synchronization is pending.';
      this.putBooking(current);
      if(authorization||rateLimited){
        const latestAccount=this.account(current.accountId);
        latestAccount.syncFailures=(latestAccount.syncFailures??0)+1;
        latestAccount.syncCooldownUntil=Date.now()+(authorization?60*MIN:Math.min(60*MIN,SYNC_INTERVAL*2**Math.min(latestAccount.syncFailures-1,4)));
        this.putAccount(latestAccount);
        // A shared grant failure applies to this account, not the host's other accounts.
        this.sql.exec("UPDATE live_bookings SET body=json_set(body,'$.syncAfter',MAX(COALESCE(json_extract(body,'$.syncAfter'),0),?),'$.calendarSyncStatus','pending','$.lastError',?) WHERE status='confirmed' AND json_extract(body,'$.accountId')=?",latestAccount.syncCooldownUntil,current.lastError,latestAccount.id);
      }
      logReconciliationFailure(authorization?'calendar_authorization_required':review?'calendar_event_review':'calendar_sync_failed',error.status);
    }finally{
      // Concurrent mutations own their new state. Release only our own lease,
      // without restoring any old fields after a cancel, move, or reconnect.
      const current=this.booking(id);if(current?.syncLeaseUntil===now+2*MIN){current.syncLeaseUntil=0;current.syncAfter=Math.max(current.syncAfter??0,Date.now()+SYNC_INTERVAL);this.putBooking(current);}
    }
  }
  async queueReminder(b){
    if(!notificationConfigured(this.env))return;
    let queued=false;
    for(const minutesBefore of reminderOffsets(b.config)){
      const due=b.start-minutesBefore*MIN;if(due<=Date.now())continue;
      // The original 24-hour identity is kept so existing encrypted pending
      // payloads and provider idempotency keys remain valid after an upgrade.
      const id=`${b.id}:${b.version}:reminder${minutesBefore===1440?'':':'+minutesBefore}`;
      this.sql.exec('INSERT OR IGNORE INTO live_jobs VALUES (?,?,?)',id,due,JSON.stringify({id,bookingId:b.id,version:b.version,kind:'reminder',minutesBefore,dueAt:due,updatedAt:Date.now(),attempts:0}));queued=true;
    }
    if(queued)await this.wake();
  }
  queueFollowUp(b){
    const minutes=b.config?.followUpMinutes;
    if(!notificationConfigured(this.env)||b.followUpSentAt||!Number.isInteger(minutes)||minutes<5||minutes>10080)return;
    // An older uncertain send must be reviewed, never replaced with another job.
    if(this.rows("SELECT id FROM live_jobs WHERE json_extract(body,'$.bookingId')=? AND json_extract(body,'$.kind')='follow_up' AND json_extract(body,'$.firstAttemptAt') IS NOT NULL LIMIT 1",b.id).length)return;
    const due=b.end+minutes*MIN,id=`${b.id}:${b.version}:follow_up`;
    this.sql.exec('INSERT OR IGNORE INTO live_jobs VALUES (?,?,?)',id,due,JSON.stringify({id,bookingId:b.id,version:b.version,kind:'follow_up',dueAt:due,updatedAt:Date.now(),attempts:0}));
  }
  // These jobs commit in the same synchronous transaction as their booking state.
  // Owner email is initialized only by verified OAuth; display-policy input cannot
  // replace it. Never fall back to a connected calendar or a guest-supplied host.
  queueApprovalNotifications(b,previous){
    if(!notificationConfigured(this.env)||!b.config.requiresApproval)return;
    let kinds=[];
    if(b.status==='awaiting_approval')kinds=['approval_requested_guest',...(this.meta('profile')?.workspaceKind==='company'||validEmail(this.meta('profile')?.email)?['approval_requested_host']:[])];
    else if(previous?.status==='awaiting_approval'&&!b.requestSuperseded&&['rejected','expired','cancelled'].includes(b.status))kinds=[b.status];
    for(const kind of kinds){const id=`${b.id}:${b.version}:${kind}`;this.sql.exec('INSERT OR IGNORE INTO live_jobs VALUES (?,?,?)',id,Date.now(),JSON.stringify({id,bookingId:b.id,version:b.version,kind,dueAt:Date.now(),updatedAt:Date.now(),attempts:0}));}
  }
  notificationCurrent(j,b){
    const state={approval_requested_guest:'awaiting_approval',approval_requested_host:'awaiting_approval',rejected:'rejected',expired:'expired',cancelled:'cancelled'}[j.kind]??'confirmed';
    return !!b&&b.version===j.version&&b.status===state;
  }
  notificationDue(j,b){
    if(Number.isSafeInteger(j.dueAt))return j.dueAt;
    if(j.kind==='reminder'&&b)return b.start-(j.minutesBefore??1440)*MIN;
    if(j.kind==='follow_up'&&b)return b.end+(b.config.followUpMinutes??0)*MIN;
    return null;
  }
  notificationView(j,b,status){
    const kinds=new Set(['confirmed','cancelled','reminder','follow_up','approval_requested_host','approval_requested_guest','rejected','expired']);
    if(!kinds.has(j.kind))return null;
    return {id:j.id,kind:j.kind,recipientRole:j.kind==='approval_requested_host'?'host':'guest',status,...(status==='needs_review'?{reason:j.restoreQuarantine?'restored':j.error==='Delivery configuration requires review'?'configuration':j.superseded||!this.notificationCurrent(j,b)?'superseded':j.expired?'expired_attempt':'delivery_unknown'}:{}),dueAt:this.notificationDue(j,b),updatedAt:j.updatedAt??j.firstAttemptAt??b?.createdAt??Date.now()};
  }
  notificationStatus(j,b){
    const current=this.notificationCurrent(j,b),due=this.notificationDue(j,b);
    return j.requiresAttention||j.deliveryInFlight&&j.leaseUntil<=Date.now()||!current&&j.firstAttemptAt?'needs_review':!current?'cancelled':j.pausedForCalendarSync?'waiting_for_calendar':j.leaseUntil>Date.now()?'sending':j.firstAttemptAt?'retrying':due<Date.now()&&(j.kind==='reminder'&&b.start<=Date.now()||j.kind==='follow_up'&&Date.now()>due+24*60*MIN)?'skipped':'scheduled';
  }
  notificationActivity(b,activity){
    const receipts=activity?activity.receipts.get(b.id)??[]:this.rows('SELECT body FROM live_notification_receipts WHERE booking_id=? AND updated_at>=? ORDER BY updated_at DESC LIMIT 20',b.id,Date.now()-90*86400000).map(r=>JSON.parse(r.body));
    const pending=(activity?activity.jobs.get(b.id)??[]:this.rows("SELECT body FROM live_jobs WHERE json_extract(body,'$.bookingId')=?",b.id).map(r=>JSON.parse(r.body))).map(j=>{
      return this.notificationView(j,b,this.notificationStatus(j,b));
    }).filter(Boolean);
    return [...pending,...receipts.map(({bookingId,...receipt})=>receipt)].sort((a,b)=>b.updatedAt-a.updatedAt||b.dueAt-a.dueAt).slice(0,20);
  }
  ownerBooking(b,activity){return {...cleanBooking(b),notifications:this.notificationActivity(b,activity),notificationHistory:{startedAt:this.meta('notificationHistoryStartedAt'),retentionDays:90,limit:20,complete:false}};}
  pruneNotificationReceipts(){
    this.sql.exec('DELETE FROM live_notification_receipts WHERE updated_at<?',Date.now()-90*86400000);
    this.sql.exec('DELETE FROM live_notification_receipts WHERE id IN (SELECT id FROM live_notification_receipts ORDER BY updated_at DESC,id DESC LIMIT -1 OFFSET 2000)');
  }
  recordNotification(j,status){
    const receipt=this.notificationView({...j,updatedAt:Date.now()},this.booking(j.bookingId),status);if(!receipt)return;
    if(status==='sent')receipt.sentAt=Date.now();
    this.sql.exec('INSERT OR REPLACE INTO live_notification_receipts VALUES (?,?,?,?)',j.id,j.bookingId,Date.now(),JSON.stringify(receipt));
    this.sql.exec('DELETE FROM live_notification_receipts WHERE booking_id=? AND id IN (SELECT id FROM live_notification_receipts WHERE booking_id=? ORDER BY updated_at DESC,id DESC LIMIT -1 OFFSET 20)',j.bookingId,j.bookingId);
    this.pruneNotificationReceipts();
  }
  notificationLeaseCurrent(j,{allowExpired=false}={}){
    const row=this.rows('SELECT body FROM live_jobs WHERE id=?',j.id)[0];if(!row)return false;const current=JSON.parse(row.body);
    return !!j.leaseToken&&current.leaseToken===j.leaseToken&&!current.requiresAttention&&(allowExpired||current.leaseUntil>Date.now());
  }
  finishNotification(j,status){if(j.leaseToken&&!this.notificationLeaseCurrent(j))return;this.ctx.storage.transactionSync(()=>{this.recordNotification(j,status);this.sql.exec('DELETE FROM live_jobs WHERE id=?',j.id);});}
  suppressNotification(j){
    if(j.leaseToken&&!this.notificationLeaseCurrent(j))return;
    if(j.firstAttemptAt){j.requiresAttention=true;j.error='Delivery requires review';j.leaseUntil=0;j.superseded=true;this.sql.exec('UPDATE live_jobs SET due=?,body=? WHERE id=?',Date.now()+365*86400000,JSON.stringify(j),j.id);}
    else this.finishNotification(j,'cancelled');
  }
  async queueNotification(b,kind){
    if(!notificationConfigured(this.env))return;
    const id=`${b.id}:${b.version}:${kind}`;
    this.sql.exec('INSERT OR IGNORE INTO live_jobs VALUES (?,?,?)',id,Date.now(),JSON.stringify({id,bookingId:b.id,version:b.version,kind,dueAt:Date.now(),updatedAt:Date.now(),attempts:0}));
    if(kind==='confirmed')await this.queueReminder(b);
    await this.wake();
  }
  expireReminder(j,b){
    if(j.leaseToken&&!this.notificationLeaseCurrent(j))return true;
    if(j.kind==='follow_up'){if(Date.now()<=b.end+b.config.followUpMinutes*MIN+24*60*MIN)return false;}
    else if(j.kind!=='reminder'||b.start>Date.now())return false;
    if(j.firstAttemptAt){
      // An earlier provider call may have succeeded. Retain its exact encrypted
      // payload for reconciliation; never send it again after its delivery window closes.
      j.requiresAttention=true;j.error='Delivery requires review';j.leaseUntil=0;j.expired=true;
      this.sql.exec('UPDATE live_jobs SET due=?,body=? WHERE id=?',Date.now()+365*86400000,JSON.stringify(j),j.id);
    }else this.finishNotification(j,'skipped');
    return true;
  }
  async hostNotificationRecipient(){
    const profile=this.meta('profile');
    if(profile?.workspaceKind===undefined)return {id:this.hostId(),email:profile?.email,company:false,version:null};
    // Only verified server-created company profiles carry this immutable marker.
    // Never fall back to an old profile address when membership authority fails.
    if(profile.workspaceKind!=='company'||!this.env.AUTH)throw Object.assign(Error('Workspace notification authority unavailable'),{retryable:true});
    const workspace=await this.env.AUTH.getByName('workspace:'+this.hostId()).get(),owners=workspace?.members?.filter(m=>m.role==='owner')||[];
    if(workspace?.id!==this.hostId()||owners.length!==1||typeof owners[0].id!=='string'||!owners[0].id||!validEmail(owners[0].email))throw Object.assign(Error('Workspace notification authority unavailable'),{retryable:true});
    const identity=await verifiedIdentity(this.env,owners[0].id);
    if(identity!=null&&!validEmail(identity.email))throw Object.assign(Error('Workspace notification identity unavailable'),{retryable:true});
    return {id:owners[0].id,email:(identity?.email??owners[0].email).toLowerCase(),company:true,version:workspace.version,identityVersion:identity?.version??null};
  }
  deferHostRecipientChange(j){
    if(!this.notificationLeaseCurrent(j))return;
    if(j.firstAttemptAt){this.suppressNotification(j);return;}
    delete j.payloadCiphertext;delete j.provider;delete j.hostRecipientId;delete j.hostWorkspaceVersion;delete j.hostIdentityVersion;j.leaseUntil=0;j.updatedAt=Date.now();
    this.sql.exec('UPDATE live_jobs SET due=?,body=? WHERE id=?',Date.now()+15000,JSON.stringify(j),j.id);
  }
  async processJob(j){
    // Checked before any lease or attempt is recorded, so a frozen host never
    // marks a message as possibly sent.
    if(this.maintenanceFrozen())return;
    const maintenanceEpoch=this.maintenanceEpoch();
    this.expireApprovals();
    const stored=this.rows('SELECT body FROM live_jobs WHERE id=?',j.id)[0];if(!stored)return;j=JSON.parse(stored.body);if(j.leaseUntil>Date.now()||j.requiresAttention)return;j.leaseToken=randomToken(18);j.updatedAt=Date.now();j.dueAt??=this.notificationDue(j,this.booking(j.bookingId));j.leaseUntil=Date.now()+30000;this.sql.exec('UPDATE live_jobs SET body=? WHERE id=?',JSON.stringify(j),j.id);
    let b=this.booking(j.bookingId),calendarConnectionVersion,teamCalendarVersions;
    const scheduledEmail=j.kind==='reminder'||j.kind==='follow_up';
    if(!this.notificationCurrent(j,b)){this.suppressNotification(j);return;}
    if(j.requiresAttention)return;
    if(scheduledEmail){
      const due=j.kind==='follow_up'?b.end+b.config.followUpMinutes*MIN:b.start-(j.minutesBefore??1440)*MIN;
      if(Date.now()<due||b.replacementKey){j.leaseUntil=0;this.sql.exec('UPDATE live_jobs SET due=?,body=? WHERE id=?',Math.max(due,Date.now()+MIN),JSON.stringify(j),j.id);return;}
      if(this.expireReminder(j,b))return;
      // The bounded background watcher may not have reached this event yet.
      // Every due reminder/follow-up needs its own fresh exact-owned read,
      // including follow-ups beyond the normal 24-hour sync window.
      calendarConnectionVersion=this.account(b.accountId)?.connectionVersion;try{teamCalendarVersions=this.teamVersions(b.teamAssignment);}catch{j.leaseUntil=0;j.pausedForCalendarSync=true;this.sql.exec('UPDATE live_jobs SET due=?,body=? WHERE id=?',Date.now()+MIN,JSON.stringify(j),j.id);return;}
      const refreshed=await this.reconcileConfirmed(b.id,{forNotification:true});if(!this.notificationLeaseCurrent(j))return;b=this.booking(b.id);
      if(!this.notificationCurrent(j,b)){this.suppressNotification(j);return;}
      if(refreshed!==true||b.calendarSyncStatus!=='current'||b.syncLeaseUntil){j.leaseUntil=0;j.pausedForCalendarSync=true;this.sql.exec('UPDATE live_jobs SET due=?,body=? WHERE id=?',Math.max(Date.now()+MIN,b.syncAfter??0),JSON.stringify(j),j.id);return;}
    }
    if(j.provider==='cloudflare'&&j.deliveryInFlight){j.requiresAttention=true;j.error='Delivery requires review';j.leaseUntil=0;this.sql.exec('UPDATE live_jobs SET due=?,body=? WHERE id=?',Date.now()+365*86400000,JSON.stringify(j),j.id);return;}
    if(this.expireReminder(j,b))return;
    if(b.calendarSyncStatus==='pending'){
      j.leaseUntil=0;j.pausedForCalendarSync=true;
      this.sql.exec('UPDATE live_jobs SET due=?,body=? WHERE id=?',Math.max(Date.now()+MIN,b.syncAfter??Date.now()+SYNC_INTERVAL),JSON.stringify(j),j.id);return;
    }
    delete j.pausedForCalendarSync;
    // The provider's deduplication window is 24 hours. Unknown outcomes pause
    // before that window expires; an operator must reconcile them manually.
    if(j.provider!=='cloudflare'&&j.firstAttemptAt&&Date.now()-j.firstAttemptAt>23*60*MIN){j.requiresAttention=true;j.error='Delivery requires review';this.sql.exec('UPDATE live_jobs SET due=?,body=? WHERE id=?',Date.now()+365*86400000,JSON.stringify(j),j.id);return;}
    try{
      let payload;const host=j.kind==='approval_requested_host',profile=this.meta('profile'),recipient=host?await this.hostNotificationRecipient():null;
      if(!this.notificationLeaseCurrent(j))return;
      if(recipient?.company&&j.firstAttemptAt&&j.hostRecipientId!==recipient.id){this.suppressNotification(j);return;}
      if(host&&j.payloadCiphertext){const previous=await decryptTokens(j.payloadCiphertext,this.env.TOKEN_ENCRYPTION_KEY,this.hostId());if(!this.notificationLeaseCurrent(j))return;if(previous.to!==recipient.email||recipient.company&&j.hostRecipientId!==recipient.id){if(j.firstAttemptAt){this.suppressNotification(j);return;}delete j.payloadCiphertext;delete j.provider;}}
      if(!j.payloadCiphertext){
        let link=recipient?.company?`${this.env.PUBLIC_ORIGIN}/studio?workspace=${encodeURIComponent(this.hostId())}#booking=${b.id}`:`${this.env.PUBLIC_ORIGIN}/studio#booking=${b.id}`;
        if(!host){const {token}=await decryptTokens(b.tokenRecovery,this.env.TOKEN_ENCRYPTION_KEY,this.hostId());if(!this.notificationLeaseCurrent(j))return;link=`${this.env.PUBLIC_ORIGIN}/manage/${encodeURIComponent(this.hostId())}/${b.id}#${token}`;}
        const current=this.booking(b.id);if(!this.notificationCurrent(j,current)){this.suppressNotification(j);return;}
        const to=host?recipient.email:b.email;if(!validEmail(to))throw Object.assign(Error('Invalid notification recipient'),{retryable:false});
        payload=prepareNotification(this.env,{idempotencyKey:j.id,to,...bookingNotificationContent({booking:b,kind:j.kind,link,hostName:profile?.name})});
        j.provider=payload.provider;if(host){j.hostRecipientId=recipient.id;j.hostWorkspaceVersion=recipient.version;j.hostIdentityVersion=recipient.identityVersion;}
        j.payloadCiphertext=await encryptTokens(payload,this.env.TOKEN_ENCRYPTION_KEY,this.hostId());if(!this.notificationLeaseCurrent(j))return;
      }else{
        payload=await decryptTokens(j.payloadCiphertext,this.env.TOKEN_ENCRYPTION_KEY,this.hostId());if(!this.notificationLeaseCurrent(j))return;
        if(!payload.provider||!payload.from){
          // Older jobs did not snapshot MAIL_FROM. An attempted unknown outcome
          // cannot safely be replayed with today's potentially changed sender.
          if(j.firstAttemptAt){j.requiresAttention=true;j.error='Delivery requires review';j.leaseUntil=0;this.sql.exec('UPDATE live_jobs SET due=?,body=? WHERE id=?',Date.now()+365*86400000,JSON.stringify(j),j.id);return;}
          payload=prepareNotification({...this.env,NOTIFICATION_PROVIDER:'resend'},payload);j.provider=payload.provider;j.payloadCiphertext=await encryptTokens(payload,this.env.TOKEN_ENCRYPTION_KEY,this.hostId());if(!this.notificationLeaseCurrent(j))return;
        }
      }
      if(recipient?.company){const latestRecipient=await this.hostNotificationRecipient();if(!this.notificationLeaseCurrent(j))return;if(latestRecipient.id!==recipient.id||latestRecipient.email!==recipient.email){this.deferHostRecipientChange(j);return;}j.hostWorkspaceVersion=latestRecipient.version;j.hostIdentityVersion=latestRecipient.identityVersion;}
      const latest=this.booking(b.id);if((latest?.teamAssignment?.hosts??[{accountId:latest?.accountId}]).some(h=>typeof h.accountId==='string'&&this.account(h.accountId)?.consentWithdrawn)){j.leaseUntil=0;j.pausedForCalendarSync=true;this.sql.exec('UPDATE live_jobs SET due=?, body=? WHERE id=?',Date.now()+SYNC_INTERVAL,JSON.stringify(j),j.id);return;}if(!this.notificationCurrent(j,latest)){this.suppressNotification(j);return;}
      if(this.expireReminder(j,latest))return;
      if(scheduledEmail){
        const account=this.account(latest.accountId);
        const due=j.kind==='follow_up'?latest.end+latest.config.followUpMinutes*MIN:latest.start-(j.minutesBefore??1440)*MIN;
        if(!account?.connected||account.connectionVersion!==calendarConnectionVersion||!this.teamAccountsCurrent(latest.teamAssignment,teamCalendarVersions)||latest.calendarSyncStatus!=='current'||latest.syncLeaseUntil>Date.now()||latest.replacementKey||Date.now()<due){
          j.leaseUntil=0;j.pausedForCalendarSync=true;this.sql.exec('UPDATE live_jobs SET due=?,body=? WHERE id=?',Date.now()+MIN,JSON.stringify(j),j.id);return;
        }
      }
      if(!this.notificationLeaseCurrent(j))return;
      if(this.maintenanceChanged(maintenanceEpoch)){const stored=this.rows('SELECT body FROM live_jobs WHERE id=?',j.id)[0];if(stored){const current=JSON.parse(stored.body);current.leaseUntil=0;this.sql.exec('UPDATE live_jobs SET body=? WHERE id=?',JSON.stringify(current),j.id);}return;}
      j.firstAttemptAt??=Date.now();j.attempts++;if(j.provider==='cloudflare')j.deliveryInFlight=true;
      this.sql.exec('UPDATE live_jobs SET body=? WHERE id=?',JSON.stringify(j),j.id);
      await this.notify(this.env,payload);
      if(!this.notificationLeaseCurrent(j,{allowExpired:true}))return;
      this.ctx.storage.transactionSync(()=>{
        if(!this.notificationLeaseCurrent(j,{allowExpired:true}))return;
        this.recordNotification(j,'sent');
        if(j.kind==='follow_up')this.sql.exec("UPDATE live_bookings SET body=json_set(body,'$.followUpSentAt',?) WHERE id=?",Date.now(),b.id);
        this.sql.exec('DELETE FROM live_jobs WHERE id=?',j.id);
      });
    }catch(e){
      if(!this.notificationLeaseCurrent(j,{allowExpired:true}))return;
      j.leaseUntil=0;
      if(j.provider==='cloudflare'){
        if(e.deliveryUnknown===false)delete j.deliveryInFlight;
        else{j.requiresAttention=true;j.error='Delivery requires review';}
      }
      if(e.retryable===false&&!j.requiresAttention){j.requiresAttention=true;j.error=e.deliveryUnknown?'Delivery requires review':'Delivery configuration requires review';}
      const due=Date.now()+(j.requiresAttention?365*86400000:Math.min(60*MIN,15000*2**Math.min(j.attempts,8)));
      this.sql.exec('UPDATE live_jobs SET due=?,body=? WHERE id=?',due,JSON.stringify(j),j.id);
    }
  }
  // Operational evidence bypasses putMeta so it never clears availability caches.
  putOperationalMeta(k,v){this.sql.exec('INSERT INTO live_meta VALUES (?,?) ON CONFLICT(key) DO UPDATE SET body=excluded.body',k,JSON.stringify(v));}
  async runMaintenance(source='manual'){
    this.putOperationalMeta(source==='watchdog'?'operations:lastWatchdog':'operations:lastRepair',{at:Date.now()});
    if(this.maintenanceFrozen())return source==='watchdog'?{ok:true,frozen:true}:maintenanceRefusal();
    await this.alarm();return {ok:true};
  }
  async operationalStatus(){
    let alarm=null,bookmark=null;
    try{alarm=await this.ctx.storage.getAlarm?.()??null;}catch{}
    // PITR bookmarks exist only on deployed SQLite Durable Objects.
    try{bookmark=await this.ctx.storage.getCurrentBookmark?.()??null;}catch{}
    return operationalStatus(this,{alarm,bookmark,fence:maintenanceView(this)});
  }
  resolveParkedDelivery(data){return resolveParkedDelivery(this,data);}
  integrationStatus(){return this.integrations.status();}
  configureIntegration(data){return this.integrations.configure(data);}
  testIntegration(data){return this.integrations.test(data);}
  retryIntegrationDelivery(data){return this.integrations.retry(data);}
  // After any storage restore, every queued email may already have been sent
  // after the restore point. Park all of them; an operator releases or resolves each.
  quarantineDeliveriesAfterRestore(){
    let count=0;
    this.ctx.storage.transactionSync(()=>{count=this.quarantineQueuedDeliveries();});
    return {ok:true,count};
  }
  // Callers own the transaction (the maintenance fence also records its epoch).
  quarantineQueuedDeliveries(now=Date.now()){
    let count=0;
    for(const row of this.rows('SELECT body FROM live_jobs')){
      const j=JSON.parse(row.body);if(j.requiresAttention&&!j.restoreQuarantine)continue;
      Object.assign(j,{requiresAttention:true,restoreQuarantine:true,error:'Delivery requires review',leaseUntil:0,updatedAt:now});
      this.sql.exec('UPDATE live_jobs SET due=?,body=? WHERE id=?',now+365*86400000,JSON.stringify(j),j.id);count++;
    }
    const integrationCount=this.integrations.quarantine(now);
    this.putOperationalMeta('operations:lastRestoreQuarantine',{at:now,count,integrationCount});
    console.warn(JSON.stringify({event:'booking_restore_quarantine',count,integrationCount}));
    return count;
  }
  async alarm(){
    // A frozen host performs no maintenance; resuming schedules a new alarm.
    if(this.maintenanceFrozen()){this.putOperationalMeta('operations:lastFrozenAlarm',{at:Date.now()});return;}
    const startedAt=Date.now(),last=this.meta('operations:lastAlarm');this.putOperationalMeta('operations:lastAlarm',{startedAt,running:true,previous:last?.running?last.previous??null:last?{ok:last.ok,finishedAt:last.finishedAt}:null});
    try{await this.maintain();}
    catch(error){
      const code=typeof error?.code==='string'&&/^[a-z_]{1,40}$/.test(error.code)?error.code:'maintenance_error';
      this.putOperationalMeta('operations:lastAlarm',{startedAt,finishedAt:Date.now(),durationMs:Date.now()-startedAt,ok:false,code});
      console.error(JSON.stringify({event:'booking_maintenance_failed',code}));throw error;
    }
    this.putOperationalMeta('operations:lastAlarm',{startedAt,finishedAt:Date.now(),durationMs:Date.now()-startedAt,ok:true});
  }
  async processAlarmJob(j){
    const parked=row=>row&&JSON.parse(row.body).requiresAttention===true;
    const wasParked=parked(this.rows('SELECT body FROM live_jobs WHERE id=?',j.id)[0]);
    await this.processJob(j);
    const row=this.rows('SELECT body FROM live_jobs WHERE id=?',j.id)[0];
    if(!wasParked&&parked(row)){
      const job=JSON.parse(row.body),view=this.notificationView(job,this.booking(job.bookingId),'needs_review');
      // Codes only: no booking/job IDs, recipients, payloads or provider bodies.
      console.warn(JSON.stringify({event:'booking_delivery_parked',kind:view?.kind??'unknown',reason:view?.reason??'delivery_unknown',provider:['cloudflare','resend'].includes(job.provider)?job.provider:'unknown'}));
    }
  }
  async maintain(){
    this.expireApprovals();this.pruneMetrics();this.pruneNotificationReceipts();
    const pruneNow=Date.now(),bookingCutoff=pruneNow-90*86400000,quotaCutoff=pruneNow-QUOTA_RETENTION;
    this.ctx.storage.transactionSync(()=>{
      this.sql.exec("INSERT OR IGNORE INTO live_quota_history SELECT id,json_extract(body,'$.meetingTypeId'),start,end FROM live_bookings WHERE status='confirmed' AND end<? AND start>=? AND NOT EXISTS (SELECT 1 FROM live_jobs WHERE json_extract(live_jobs.body,'$.bookingId')=live_bookings.id)",bookingCutoff,quotaCutoff);
    this.sql.exec("DELETE FROM live_bookings WHERE end<? AND status IN ('confirmed','cancelled','failed','rejected','expired') AND NOT EXISTS (SELECT 1 FROM live_jobs WHERE json_extract(live_jobs.body,'$.bookingId')=live_bookings.id)",bookingCutoff);
      this.sql.exec('DELETE FROM live_quota_history WHERE start<?',quotaCutoff);
    });
    for(const r of this.rows("SELECT id FROM live_bookings WHERE status IN ('pending','cancelling') LIMIT 20"))await this.reconcile(r.id);
    for(const r of this.rows("SELECT id FROM live_bookings WHERE status='confirmed' AND json_extract(body,'$.replacementKey') IS NULL AND end>=? AND COALESCE(json_extract(body,'$.syncAfter'),0)<=? AND COALESCE(json_extract(body,'$.syncLeaseUntil'),0)<=? ORDER BY COALESCE(json_extract(body,'$.syncAfter'),0),id LIMIT ?",Date.now()-SYNC_WINDOW,Date.now(),Date.now(),SYNC_BATCH))await this.reconcileConfirmed(r.id);
    for(const r of this.rows('SELECT body FROM live_jobs WHERE due<=? LIMIT 20',Date.now()))await this.processAlarmJob(JSON.parse(r.body));
    await this.integrations.processBatch();
    const integrationDue=this.integrations.nextDue();
    const pending=this.rows("SELECT id FROM live_bookings WHERE status IN ('pending','cancelling') LIMIT 1").length,next=this.rows('SELECT MIN(due) AS due FROM live_jobs')[0]?.due;
    const retention=this.rows("SELECT MIN(end) AS end FROM live_bookings WHERE status IN ('confirmed','cancelled','failed','rejected','expired') AND NOT EXISTS (SELECT 1 FROM live_jobs WHERE json_extract(live_jobs.body,'$.bookingId')=live_bookings.id)")[0]?.end;
    const quotaRetention=this.rows('SELECT MIN(start) AS start FROM live_quota_history')[0]?.start;
    const sync=this.nextConfirmedSync(),approval=this.rows("SELECT MIN(json_extract(body,'$.approvalExpiresAt')) AS due FROM live_bookings WHERE status='awaiting_approval'")[0]?.due;
    if(integrationDue!=null||approval!=null||pending||next||retention||sync!=null||quotaRetention!=null)await this.ctx.storage.setAlarm(Math.max(Date.now()+15000,Math.min(integrationDue??Infinity,pending?Date.now()+MIN:Infinity,next??Infinity,retention?retention+90*86400000:Infinity,sync??Infinity,approval??Infinity,quotaRetention!=null?quotaRetention+QUOTA_RETENTION:Infinity)));
  }
}
