import {normalizeLinkAccess} from './link-access.js';
import {normalizeChangeNotices} from './change-policy.js';
import {validDuration,normalizeDurationOptions} from './durations.js';
import {normalizeTeamScheduling} from './team-policy.js';
import { normalizeQuestions } from './intake.js';
import { normalizeFollowUp } from './followup.js';
export const DEFAULT = {
  teamScheduling: null, singleUse:false, expiresAt:null,
  host: 'Alex Morgan', company: 'Studio', title: 'Product demo',
  description: 'A walkthrough of the product, with time for your questions.',
  duration: 30, durationOptions:null, zone: 'Europe/London', startHour: 9, endHour: 17,
  buffer: 15, notice: 120, horizon: 28, days: [1,2,3,4,5], accent: 'graphite',
  location: 'Video call', question: 'Anything you’d like to talk about?', required: false,
  reminder: true, theme: 'light', motion: 'smooth',
  useDefaultCalendar: true, weeklyHours: null, dateOverrides: {}, dailyBookingLimit: 0, dailyBookedMinutesLimit: 0, weeklyBookedMinutesLimit: 0, monthlyBookingLimit: 0, yearlyBookingLimit: 0, monthlyBookedMinutesLimit: 0, yearlyBookedMinutesLimit: 0,
  bufferBefore: null, bufferAfter: null, slotInterval: 15, weeklyBookingLimit: 0, locationType: 'custom',
  questions: null, extraGuestsLimit: 0, reminderMinutes: null, scheduleId: null, useDefaultSchedule: false,
  followUpMinutes: null, followUpSubject: '', followUpBody: '',
  requiresApproval: false, approvalExpiryMinutes: 1440, cancellationNoticeMinutes:0, rescheduleNoticeMinutes:0
};
export function validZone(zone) { if(typeof zone!=='string'||!zone||zone.length>100||/^[+-]/.test(zone))return false;try { new Intl.DateTimeFormat('en',{timeZone:zone}).format(); return true; } catch { return false; } }
export function validateConfig(value) {
  if(value.duration!==undefined&&!validDuration(value.duration))throw Error('Choose a duration between 5 and 480 minutes.');
  if(value.motion!==undefined&&!['smooth','none'].includes(value.motion))throw Error('Choose smooth or instant transitions.');
  if(value.useDefaultCalendar!==undefined&&typeof value.useDefaultCalendar!=='boolean')throw Error('Choose a valid default calendar setting.');
  for(const [key,max] of [['dailyBookedMinutesLimit',1440],['weeklyBookedMinutesLimit',10080],['monthlyBookedMinutesLimit',44640],['yearlyBookedMinutesLimit',527040]])if(value[key]!==undefined&&(!Number.isInteger(value[key])||value[key]<0||value[key]>max||value[key]%5))throw Error('Choose a booked-time limit in 5-minute increments, or zero for no limit.');
  for(const [key,max] of [['monthlyBookingLimit',1500],['yearlyBookingLimit',18000]])if(value[key]!==undefined&&(!Number.isInteger(value[key])||value[key]<0||value[key]>max))throw Error('Choose a valid monthly or yearly booking limit, or zero for no limit.');
  if(value.useDefaultSchedule!==undefined&&typeof value.useDefaultSchedule!=='boolean')throw Error('Choose whether to use the default availability schedule.');
  if(value.requiresApproval!==undefined&&typeof value.requiresApproval!=='boolean'||value.approvalExpiryMinutes!==undefined&&(!Number.isInteger(value.approvalExpiryMinutes)||value.approvalExpiryMinutes<15||value.approvalExpiryMinutes>10080))throw Error('Choose a valid approval setting and a window between 15 minutes and 7 days.');
  const c = Object.fromEntries(Object.keys(DEFAULT).map(k=>[k,value[k] ?? DEFAULT[k]]));
  c.teamScheduling=normalizeTeamScheduling(c.teamScheduling);Object.assign(c,normalizeChangeNotices(value),normalizeLinkAccess(value));
  for (const k of ['host','company','title','description','location','question']) {
    if(typeof c[k] !== 'string' || c[k].length > (k==='description'?600:160)) throw Error('Please shorten '+k+'.');
    c[k]=c[k].trim();
  }
  if(!c.host || !c.title) throw Error('Add a host name and meeting title.');
  c.durationOptions=normalizeDurationOptions(value.durationOptions,c.duration);
  if(!validDuration(c.duration) || !validZone(c.zone)) throw Error('Choose a valid duration and timezone.');
  for (const [k,min,max] of [['startHour',0,23],['endHour',1,24],['buffer',0,60],['notice',0,1440],['horizon',1,60]]) {
    if(!Number.isInteger(c[k]) || c[k]<min || c[k]>max) throw Error('Invalid '+k+'.');
  }
  if(c.weeklyHours==null&&(c.endHour<=c.startHour)) throw Error('End time must be after start time.');
  if(!Array.isArray(c.days) || (!c.days.length&&c.weeklyHours==null) || c.days.some(d=>!Number.isInteger(d)||d<0||d>6)) throw Error('Choose at least one available day.');
  if(!['clay','iris','sage','graphite'].includes(c.accent) || !['light','dark'].includes(c.theme)) throw Error('Choose a supported appearance.');
  if(typeof c.required!=='boolean'||typeof c.reminder!=='boolean') throw Error('Invalid preference.');
  c.weeklyHours=normalizeWeeklyHours(c.weeklyHours);
  c.dateOverrides=normalizeDateOverrides(c.dateOverrides);
  for(const key of ['bufferBefore','bufferAfter'])if(c[key]!==null&&(!Number.isInteger(c[key])||c[key]<0||c[key]>60))throw Error('Choose a buffer between 0 and 60 minutes.');
  if(![5,10,15,20,30,45,60].includes(c.slotInterval))throw Error('Choose a supported interval between start times.');
  if(!Number.isInteger(c.weeklyBookingLimit)||c.weeklyBookingLimit<0||c.weeklyBookingLimit>250)throw Error('Weekly booking limit must be between 0 and 250.');
  if(!['custom','google_meet'].includes(c.locationType))throw Error('Choose a supported meeting location.');
  if(!Number.isInteger(c.dailyBookingLimit)||c.dailyBookingLimit<0||c.dailyBookingLimit>50)throw Error('Daily booking limit must be between 0 and 50.');
  if(!Number.isInteger(c.extraGuestsLimit)||c.extraGuestsLimit<0||c.extraGuestsLimit>5)throw Error('Allow between zero and five additional guests.');
  if(c.questions!==null)c.questions=normalizeQuestions(c);
  c.reminderMinutes=normalizeReminderMinutes(c.reminderMinutes);
  Object.assign(c,normalizeFollowUp(value));
  if(c.scheduleId!==null&&(typeof c.scheduleId!=='string'||!/^[A-Za-z0-9_-]{1,64}$/.test(c.scheduleId)))throw Error('Choose a valid availability schedule.');
  if(typeof c.requiresApproval!=='boolean'||!Number.isInteger(c.approvalExpiryMinutes)||c.approvalExpiryMinutes<15||c.approvalExpiryMinutes>10080)throw Error('Choose an approval window between 15 minutes and 7 days.');
  return c;
}
/** Host-owned reusable hours. Booking limits, notice and buffers stay per meeting. */
export function normalizeAvailabilitySchedules(value){
  if(!Array.isArray(value)||value.length>20)throw Error('Use up to 20 availability schedules.');
  const ids=new Set();return value.map(schedule=>{
    if(!plainObject(schedule)||Object.keys(schedule).some(key=>!['id','name','zone','weeklyHours','dateOverrides'].includes(key)))throw Error('Unsupported availability schedule fields.');
    const {id,zone}=schedule,name=typeof schedule.name==='string'?schedule.name.trim():'';
    if(typeof id!=='string'||!/^[A-Za-z0-9_-]{1,64}$/.test(id)||ids.has(id))throw Error('Use unique availability schedule identifiers.');
    if(!name||name.length>80||!validZone(zone)||schedule.weeklyHours==null)throw Error('Choose a schedule name, timezone and weekly hours.');
    ids.add(id);return {id,name,zone,weeklyHours:normalizeWeeklyHours(schedule.weeklyHours),dateOverrides:normalizeDateOverrides(schedule.dateOverrides??{})};
  });
}
/** The host default is itself a reference and cannot point outside this host. */
export function normalizeDefaultAvailabilityScheduleId(value,schedules=[]){
  if(value===null)return null;
  if(typeof value!=='string'||!/^[A-Za-z0-9_-]{1,64}$/.test(value)||!schedules.some(schedule=>schedule.id===value))throw Error('Choose an existing default availability schedule before removing or replacing it.');
  return value;
}
/** Resolve host-owned hours without rewriting a meeting's raw fallback policy. */
export function resolveAvailabilitySchedule(config,schedules=[],defaultAvailabilityScheduleId=null){
  const normalized=validateConfig(config);
  if(normalized.scheduleId&&!schedules.some(item=>item.id===normalized.scheduleId))throw Error('This availability schedule is still in use or is unavailable. Choose another schedule before removing it.');
  const id=normalized.useDefaultSchedule?normalizeDefaultAvailabilityScheduleId(defaultAvailabilityScheduleId,schedules):normalized.scheduleId;
  if(normalized.useDefaultSchedule&&!id)throw Error('Choose a default availability schedule before using it for a meeting.');
  if(!id)return normalized;
  const schedule=schedules.find(item=>item.id===id);
  return validateConfig({...normalized,zone:schedule.zone,weeklyHours:schedule.weeklyHours,dateOverrides:schedule.dateOverrides});
}

function normalizeReminderMinutes(value){
  if(value==null)return null;
  if(!Array.isArray(value)||value.length>3||value.some(minutes=>!Number.isInteger(minutes)||minutes<5||minutes>10080)||new Set(value).size!==value.length)throw Error('Choose up to three distinct reminders between 5 minutes and 7 days before the meeting.');
  return [...value].sort((a,b)=>b-a);
}
/** Legacy on/off remains the master preference. Explicit [] means no reminders. */
export function reminderOffsets(config={}){
  const offsets=normalizeReminderMinutes(config.reminderMinutes);
  return config.reminder===false?[]:offsets??[1440];
}
function plainObject(value){return !!value&&typeof value==='object'&&!Array.isArray(value);}
function normalizeRanges(value){
  if(!Array.isArray(value)||value.length>3)throw Error('Use up to three time ranges per day.');
  const ranges=value.map(range=>{
    if(!plainObject(range)||Object.keys(range).some(key=>!['start','end'].includes(key))||!Number.isInteger(range.start)||!Number.isInteger(range.end)||range.start<0||range.start>=1440||range.end<=range.start||range.end>1440)throw Error('Choose valid time ranges between 00:00 and 24:00.');
    return {start:range.start,end:range.end};
  }).sort((a,b)=>a.start-b.start);
  if(ranges.some((range,index)=>index&&range.start<ranges[index-1].end))throw Error('Time ranges cannot overlap.');
  return ranges;
}
function normalizeWeeklyHours(value){
  if(value==null)return null;
  if(!plainObject(value)||Object.keys(value).some(day=>!/^[0-6]$/.test(day)))throw Error('Choose valid weekdays for weekly hours.');
  return Object.fromEntries(Array.from({length:7},(_,day)=>[String(day),normalizeRanges(value[day]??[])]));
}
function normalizeDateOverrides(value){
  if(!plainObject(value)||Object.keys(value).length>60)throw Error('Use up to 60 date overrides.');
  return Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([day,ranges])=>{
    if(!/^\d{4}-\d{2}-\d{2}$/.test(day)||!Number.isFinite(Date.parse(day+'T00:00:00Z'))||new Date(day+'T00:00:00Z').toISOString().slice(0,10)!==day)throw Error('Choose valid dates for availability overrides.');
    return [day,normalizeRanges(ranges)];
  }));
}
/** Buffer sides inherit the legacy symmetric value independently. Values are milliseconds. */
export function buffersFor(config){return {before:(config.bufferBefore??config.buffer??0)*60000,after:(config.bufferAfter??config.buffer??0)*60000};}
/** A date override replaces that host-local date, including [] for closed. */
export function hoursFor(config,day,weekday){
  if(Object.hasOwn(config.dateOverrides??{},day))return config.dateOverrides[day];
  if(config.weeklyHours!=null)return config.weeklyHours[weekday]??[];
  return config.days.includes(weekday)?[{start:config.startHour*60,end:config.endHour*60}]:[];
}

/** Test a shared candidate against hours without imposing this host's slot grid. */
export function workingWindowChecker(config,now){
  config=validateConfig(config);const minuteMs=60000,lower=now+config.notice*minuteMs,upper=now+config.horizon*86400000;
  const format=new Intl.DateTimeFormat('en-GB',{timeZone:config.zone,year:'numeric',month:'2-digit',day:'2-digit',weekday:'short',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}),weekdays=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  const parts=time=>{const items=format.formatToParts(time),get=key=>items.find(item=>item.type===key)?.value;return {day:[get('year'),get('month'),get('day')].join('-'),weekday:weekdays.indexOf(get('weekday')),minute:Number(get('hour'))*60+Number(get('minute'))};};
  return (start,end)=>{
    if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<lower||start>=upper||end-start!==config.duration*minuteMs)return false;
    const first=parts(start),range=hoursFor(config,first.day,first.weekday).find(range=>first.minute>=range.start&&first.minute<range.end);if(!range)return false;
    const last=parts(end-minuteMs);if(last.day!==first.day||last.minute<range.start||last.minute>=range.end)return false;
    if(last.minute!==first.minute+config.duration-1)for(let i=1;i<config.duration;i++){const current=parts(start+i*minuteMs);if(current.day!==first.day||current.minute<range.start||current.minute>=range.end)return false;}
    return true;
  };
}

export function dateKey(ms,zone) {
  const p=new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(ms);
  return ['year','month','day'].map(k=>p.find(x=>x.type===k).value).join('-');
}
/** Absolute-time traversal preserves both repeated DST times and skips nonexistent ones.
 * Each interval bucket contributes a start anchored to a working range, e.g. 09:10.
 * Only transition buckets/meetings need minute-by-minute checks.
 */
export function policySlots(config,now,from=now,to=now+config.horizon*86400000){
  config=validateConfig(config);
  const minuteMs=60000,interval=config.slotInterval,step=interval*minuteMs,lower=Math.max(from,now+config.notice*minuteMs),upper=Math.min(to,now+config.horizon*86400000);
  if(!Number.isFinite(lower)||!Number.isFinite(upper)||upper<=lower)return [];
  const format=new Intl.DateTimeFormat('en-GB',{timeZone:config.zone,year:'numeric',month:'2-digit',day:'2-digit',weekday:'short',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
  const weekdays=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  const parts=time=>{const items=format.formatToParts(time),get=key=>items.find(item=>item.type===key)?.value;return {day:[get('year'),get('month'),get('day')].join('-'),weekday:weekdays.indexOf(get('weekday')),minute:Number(get('hour'))*60+Number(get('minute'))};};
  const result=[],seen=new Set();
  function consider(time,startParts){
    if(time<lower||time>=upper||seen.has(time))return;
    const start=startParts??parts(time),ranges=hoursFor(config,start.day,start.weekday);
    const range=ranges.find(range=>start.minute>=range.start&&start.minute<range.end&&(start.minute-range.start)%interval===0);
    if(!range)return;
    const end=time+config.duration*minuteMs,last=parts(end-minuteMs);
    if(last.day!==start.day||last.minute<range.start||last.minute>=range.end)return;
    if(last.minute!==start.minute+config.duration-1){
      for(let i=1;i<config.duration;i++){
        const current=parts(time+i*minuteMs);
        if(current.day!==start.day||current.minute<range.start||current.minute>=range.end)return;
      }
    }
    seen.add(time);result.push({start:time,end});
  }
  // Horizon and interval validation cap this at 17,282 five-minute buckets.
  for(let time=Math.floor(lower/step)*step;time<upper;time+=step){
    const first=parts(time),last=parts(time+step-minuteMs);
    if(first.day!==last.day||last.minute!==first.minute+interval-1){
      for(let i=0;i<interval;i++)consider(time+i*minuteMs);
      continue;
    }
    for(const range of hoursFor(config,first.day,first.weekday)){
      const offset=((range.start-first.minute)%interval+interval)%interval,minute=first.minute+offset;
      if(minute>=range.start&&minute<range.end)consider(time+offset*minuteMs,{...first,minute});
    }
  }
  return result.sort((a,b)=>a.start-b.start);
}
export function slots(config, now, reservations=[]) {
  config=validateConfig(config);const buffers=buffersFor(config);
  const format=new Intl.DateTimeFormat('en-GB',{timeZone:config.zone,hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
  return policySlots(config,now).filter(slot=>{
    const values=format.formatToParts(slot.start),get=key=>values.find(value=>value.type===key)?.value;
    const minute=Number(get('hour'))*60+Number(get('minute'));
    // Only the fixture keeps its established synthetic lunch break. Live hours are explicit.
    if(minute<13*60&&minute+config.duration>12*60)return false;
    return !reservations.some(booking=>slot.start<booking.end+Math.max(buffers.before,booking.after??booking.buffer??0)&&slot.end+Math.max(buffers.after,booking.before??booking.buffer??0)>booking.start);
  });
}
