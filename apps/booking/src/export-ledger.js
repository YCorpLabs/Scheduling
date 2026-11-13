import {changePolicyForStart} from '../public/change-policy.js';
// Deliberate export schema. Never serialize stored account/booking/config bodies directly.
const pick=(value,keys)=>Object.fromEntries(keys.filter(k=>value?.[k]!==undefined&&(value[k]===null||['string','number','boolean'].includes(typeof value[k]))).map(k=>[k,value[k]]));
const list=value=>Array.isArray(value)?value:[];
const scalars=value=>list(value).filter(v=>v===null||['string','number','boolean'].includes(typeof v));
const hours=value=>value&&typeof value==='object'?Object.fromEntries(Object.entries(value).filter(([key])=>/^(?:[0-6]|\d{4}-\d{2}-\d{2})$/.test(key)).map(([key,ranges])=>[key,list(ranges).map(r=>pick(r,['start','end']))])):null;
const schedule=value=>({...pick(value,['id','name','zone']),weeklyHours:hours(value?.weeklyHours),dateOverrides:hours(value?.dateOverrides)});
const question=value=>({...pick(value,['id','type','label','required']),...(Array.isArray(value?.options)?{options:scalars(value.options)}:{})});
const TYPE_SCALARS=['id','slug','published','host','company','title','description','duration','zone','startHour','endHour','buffer','notice','horizon','accent','location','question','required','reminder','theme','motion','dailyBookingLimit','dailyBookedMinutesLimit','weeklyBookingLimit','monthlyBookingLimit','yearlyBookingLimit','monthlyBookedMinutesLimit','yearlyBookedMinutesLimit','weeklyBookedMinutesLimit','bufferBefore','bufferAfter','slotInterval','locationType','extraGuestsLimit','scheduleId','useDefaultSchedule','followUpMinutes','followUpSubject','followUpBody','requiresApproval','approvalExpiryMinutes','cancellationNoticeMinutes','rescheduleNoticeMinutes','singleUse','expiresAt','accountId','calendarId','useDefaultCalendar'];
export function exportMeeting(type,memberAccounts=new Set(),company=false){
 const out={...pick(type,TYPE_SCALARS),days:scalars(type?.days),durationOptions:type?.durationOptions===null?null:scalars(type?.durationOptions),reminderMinutes:type?.reminderMinutes===null?null:scalars(type?.reminderMinutes),weeklyHours:hours(type?.weeklyHours),dateOverrides:hours(type?.dateOverrides),questions:type?.questions===null?null:list(type?.questions).map(question)};
 if(type?.teamScheduling)out.teamScheduling={...pick(type.teamScheduling,['mode']),hosts:list(type.teamScheduling.hosts).map(h=>({...pick(h,company||memberAccounts.has(h.accountId)?['id','name','accountId','useDefaultCalendar']:['id','name','accountId','useDefaultCalendar','calendarId','scheduleId']),...(!company&&!memberAccounts.has(h.accountId)?{conflictCalendarIds:h.conflictCalendarIds===null?null:scalars(h.conflictCalendarIds)}:{})}))};
 return out;
}
export function exportCalendar(account,{company=false}={}){
 const shared=company;
 return {...pick(account,['id','email','connected','ownerMemberId','consentWithdrawn']),...(!shared?{...pick(account,['destinationCalendarId']),conflictCalendarIds:scalars(account.conflictCalendarIds),...(account.memberSchedule?{memberSchedule:schedule(account.memberSchedule)}:{})}:{})};
}
export function exportBooking(b){
 const out={changePolicy:changePolicyForStart(b.config??{},b.start),requiresApproval:b.config?.requiresApproval===true,...pick(b,['id','status','version','duration','approvalExpiresAt','approvalDecisionAt','rejectionReason','cancellationReason','start','end','name','email','answer','intakeVersion','timeZone','meetingTypeId','meetingTypeSlug','title','location','successorId','replacesId','calendarSyncStatus','calendarEventStatus','calendarTimeZone','calendarSyncedAt','calendarChange','conferenceStatus','meetingUrl'])};
 if(b.answers&&typeof b.answers==='object'&&!Array.isArray(b.answers))out.answers=Object.fromEntries(Object.entries(b.answers).filter(([,v])=>typeof v==='string'||typeof v==='boolean'));
 if(b.questionSnapshot)out.questionSnapshot=list(b.questionSnapshot).map(question);
 if(b.additionalGuests)out.additionalGuests=scalars(b.additionalGuests);
 if(b.teamAssignment){out.teamMode=b.teamAssignment.mode;out.assignedHosts=list(b.teamAssignment.hosts).map(h=>pick(h,['id','name']));}
 return out;
}
export function installExportRevision(ledger){
 ledger.sql.exec('CREATE TABLE IF NOT EXISTS live_export_revision (id INTEGER PRIMARY KEY CHECK(id=1),version INTEGER NOT NULL)');
 ledger.sql.exec('INSERT OR IGNORE INTO live_export_revision VALUES(1,0)');
 for(const table of ['live_meta','live_accounts','live_bookings'])for(const action of ['INSERT','UPDATE','DELETE'])ledger.sql.exec(`CREATE TRIGGER IF NOT EXISTS export_${table}_${action.toLowerCase()} AFTER ${action} ON ${table} BEGIN UPDATE live_export_revision SET version=version+1 WHERE id=1; END`);
}
export const exportRevision=ledger=>ledger.rows('SELECT version FROM live_export_revision WHERE id=1')[0].version;
const changed=()=>Object.assign(Error('Your data changed. Start the export again.'),{status:409,code:'export_changed'});
export const LEDGER_EXPORT_SECTIONS=['profile','meetingTypes','availabilitySchedules','calendars','bookings'];
export function ledgerExportPage(ledger,{section,offset=0,after='',expectedRevision,company=false}={}){
 const revision=exportRevision(ledger);if(expectedRevision!==undefined&&expectedRevision!==revision)throw changed();
 if(section==='check')return {revision};
 if(!LEDGER_EXPORT_SECTIONS.includes(section)||!Number.isSafeInteger(offset)||offset<0||typeof after!=='string'||after.length>100)throw Object.assign(Error('Choose a valid export page.'),{status:400});
 let data,next=null;
 if(section==='profile')data={...pick(ledger.meta('profile'),['id','name','company','email','website','avatarImage','bannerImage','workspaceKind']),defaultAvailabilityScheduleId:ledger.meta('defaultAvailabilityScheduleId')??null};
 else if(section==='bookings'){
  const rows=ledger.rows('SELECT id,body FROM live_bookings WHERE id>? ORDER BY id LIMIT 11',after);data=[];
  for(const row of rows.slice(0,10)){const safe={...exportBooking(JSON.parse(row.body)),id:row.id};if(data.length&&new TextEncoder().encode(JSON.stringify([...data,safe])).byteLength>200000)break;data.push(safe);}
  if(rows.length>data.length)next={after:data.at(-1).id};
 }else{
  if(section==='calendars'){const rows=ledger.rows('SELECT body FROM live_accounts ORDER BY id LIMIT 6 OFFSET ?',offset);data=rows.slice(0,5).map(row=>exportCalendar(JSON.parse(row.body),{company}));if(rows.length>5)next={offset:offset+5};}
  else{const owned=new Set(company?ledger.rows("SELECT id FROM live_accounts WHERE json_extract(body,'$.ownerMemberId') IS NOT NULL").map(a=>a.id):[]);
   const all=section==='meetingTypes'?(ledger.meta('meetingTypes')??[]).map(t=>exportMeeting(t,owned,company)):(ledger.meta('availabilitySchedules')??[]).map(schedule);
   data=all.slice(offset,offset+5);if(offset+data.length<all.length)next={offset:offset+data.length};}
 }
 if(new TextEncoder().encode(JSON.stringify(data)).byteLength>250000)throw Object.assign(Error('An export record is too large.'),{status:413});
 return {revision,section,data,next};
}
export function ledgerExportContribution(ledger,memberId,accountId){
 const account=ledger.account(accountId);if(!account||account.ownerMemberId!==memberId)return {revision:exportRevision(ledger),data:null};
 return {revision:exportRevision(ledger),data:{workspaceId:ledger.hostId(),...exportCalendar(account),...(account.memberSchedule?{hours:schedule(account.memberSchedule)}:{})}};
}
