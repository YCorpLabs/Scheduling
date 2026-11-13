import {DEFAULT,validZone} from './policy.js';
export function meetingSlug(title,types=[],id=''){
 const base=String(title).normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,55)||'meeting';let slug=base,n=2;
 while(types.some(t=>t.id!==id&&t.slug===slug))slug=base+'-'+n++;
 return slug;
}
export function newMeeting(settings,calendars=[],browserZone='UTC',id=crypto.randomUUID().slice(0,8)){
 const accounts=settings.accounts.filter(a=>a.connected),source=[...settings.meetingTypes].reverse().find(t=>accounts.some(a=>a.id===t.accountId))||settings.meetingTypes[0]||{},account=accounts.find(a=>a.id===source.accountId&&a.destinationCalendarId)||accounts.find(a=>a.destinationCalendarId)||accounts[0];
 const schedule=settings.availabilitySchedules?.find(s=>s.id===settings.defaultAvailabilityScheduleId),calendar=calendars.find(a=>a.id===account?.id)?.calendars?.find(c=>c.id===account?.destinationCalendarId),meet=!!account&&(account.destinationCalendarId==='primary'||calendar?.primary||calendar?.conferenceProperties?.allowedConferenceSolutionTypes?.includes('hangoutsMeet')||source.accountId===account.id&&source.locationType==='google_meet');
 const inherited=Object.fromEntries(['duration','zone','startHour','endHour','days','weeklyHours','buffer','bufferBefore','bufferAfter','notice','horizon','slotInterval','theme','accent','motion'].filter(k=>source[k]!==undefined).map(k=>[k,structuredClone(source[k])]));
 const duration=inherited.duration||30,title=duration+' minute meeting',zone=[schedule?.zone,calendar?.timeZone,source.accountId?inherited.zone:null,browserZone,'UTC'].find(validZone);
 // Guest length choices are per link; a new link starts fixed at the inherited default.
 return {...DEFAULT,...inherited,durationOptions:null,id,title,slug:meetingSlug(title,settings.meetingTypes,id),host:settings.profile.name,company:settings.profile.company||'',zone,description:'',locationType:meet?'google_meet':'custom',location:meet?'':source.accountId===account?.id&&source.location!=='Video call'?source.location||'':'',accountId:account?.id||'',useDefaultCalendar:true,calendarId:account?.destinationCalendarId||'',useDefaultSchedule:!!schedule,scheduleId:null,dateOverrides:{},question:'',questions:[],required:false,extraGuestsLimit:0,reminder:false,reminderMinutes:[],followUpMinutes:null,followUpSubject:'',followUpBody:'',published:false};
}
