import {validateTeamReferences} from '../public/team-policy.js';
import {validateBrandImage} from '../public/branding.js';
import {meetingDestination,policyReferenceAccounts} from './ledger.js';
import {DEFAULT,validateConfig,reminderOffsets,normalizeAvailabilitySchedules,normalizeDefaultAvailabilityScheduleId,resolveAvailabilitySchedule} from '../public/policy.js';
import {sha256} from './crypto.js';
const problem=(message,status=400,code='invalid_settings')=>Object.assign(Error(message),{status,code});
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const stable=value=>JSON.stringify(value,(_key,item)=>object(item)?Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])):item);
function keys(value,allowed,label){if(!object(value)||Object.keys(value).some(key=>!allowed.includes(key)))throw problem(`Unsupported ${label} fields.`);}
function text(value,label,max=160,empty=true){if(typeof value!=='string'||value.length>max||(!empty&&!value.trim()))throw problem(`Choose a valid ${label}.`);return value.trim();}
function diff(before,after,path='',result=[]){
  if(stable(before)===stable(after))return result;
  if(object(before)&&object(after)){for(const key of new Set([...Object.keys(before),...Object.keys(after)]))diff(before[key],after[key],path?path+'.'+key:key,result);}
  else result.push({path,before:before??null,after:after??null});
  return result;
}
/** Only display profile and meeting policies are editable, never grants or bookings. */
export function normalizeSettingsPatch(current,patch,{reminders=true}={}){
  keys(patch,['profile','meetingTypes','availabilitySchedules','defaultAvailabilityScheduleId'],'settings');
  if(!Object.keys(patch).length)throw problem('Choose settings to update.');
  const normalized={},warnings=[];
  if(patch.availabilitySchedules!==undefined){try{normalized.availabilitySchedules=normalizeAvailabilitySchedules(patch.availabilitySchedules);}catch(error){throw problem(error.message);}}
  const schedules=normalized.availabilitySchedules??current.availabilitySchedules??[];
  let defaultId;try{defaultId=normalizeDefaultAvailabilityScheduleId(patch.defaultAvailabilityScheduleId!==undefined?patch.defaultAvailabilityScheduleId:current.defaultAvailabilityScheduleId??null,schedules);}catch(error){throw problem(error.message);}
  if(patch.defaultAvailabilityScheduleId!==undefined)normalized.defaultAvailabilityScheduleId=defaultId;
  if(patch.profile!==undefined){
    keys(patch.profile,['name','company','avatarImage','bannerImage'],'profile');normalized.profile={};
    if(patch.profile.name!==undefined)normalized.profile.name=text(patch.profile.name,'host name',160,false);
    for(const key of ['avatarImage','bannerImage'])if(patch.profile[key]!==undefined){try{normalized.profile[key]=validateBrandImage(patch.profile[key],key);}catch(error){throw problem(error.message);}}
    if(patch.profile.company!==undefined)normalized.profile.company=text(patch.profile.company,'company');
  }
  if(patch.meetingTypes!==undefined){
    if(!Array.isArray(patch.meetingTypes)||patch.meetingTypes.length>20)throw problem('Choose at most 20 meeting types.');
    const ids=new Set(),slugs=new Set(),allowed=[...Object.keys(DEFAULT),'id','slug','published','accountId','calendarId'];
    normalized.meetingTypes=patch.meetingTypes.map(type=>{
      keys(type,allowed,'meeting type');
      const id=text(type.id,'meeting identifier',100,false),slug=text(type.slug,'meeting link',64,false);
      if(!/^[A-Za-z0-9_-]+$/.test(id)||ids.has(id)||!/^[a-z0-9][a-z0-9-]{0,63}$/.test(slug)||slugs.has(slug))throw problem('Choose unique meeting identifiers and links.');
      ids.add(id);slugs.add(slug);
      if(type.published!==undefined&&typeof type.published!=='boolean')throw problem('Choose a valid published setting.');
      const published=type.published??false,old=current.meetingTypes.find(t=>t.id===id);let destination;try{destination=meetingDestination({...type,published},current.accounts,old);}catch(error){throw problem(error.message);}const {accountId,calendarId,useDefaultCalendar}=destination;
      let config;try{config=validateConfig({...type,...(old&&type.useDefaultSchedule===undefined?{useDefaultSchedule:old.useDefaultSchedule??false}:{}),...Object.fromEntries(['expiresAt','singleUse','cancellationNoticeMinutes','rescheduleNoticeMinutes','durationOptions','teamScheduling','motion','monthlyBookingLimit','yearlyBookingLimit','monthlyBookedMinutesLimit','yearlyBookedMinutesLimit','dailyBookedMinutesLimit','weeklyBookedMinutesLimit','followUpMinutes','followUpSubject','followUpBody'].filter(key=>old&&type[key]===undefined).map(key=>[key,old[key]??DEFAULT[key]])),...(old&&type.requiresApproval===undefined?{requiresApproval:old.requiresApproval??false}:{}),...(old&&type.approvalExpiryMinutes===undefined?{approvalExpiryMinutes:old.approvalExpiryMinutes??1440}:{})});}catch(error){throw problem(error.message);}
      try{validateTeamReferences(config.teamScheduling,policyReferenceAccounts({...config,accountId,published},current.accounts,old),schedules,{requireConnected:published});}catch(error){throw problem(error.message);}
      if(published&&!old?.published)warnings.push(`Publishing ${slug} makes its page available for guest bookings.`);
      if(config.followUpMinutes!==null&&!reminders)warnings.push(`Follow-ups for ${slug} require email delivery to be configured.`);
      if(reminderOffsets(config).length&&!reminders)warnings.push(`Reminders for ${slug} require email delivery to be configured.`);
      return {...config,id,slug,published,accountId,calendarId,useDefaultCalendar};
    });
    if(current.meetingTypes.some(type=>!ids.has(type.id)))warnings.push('Removed meeting types keep existing bookings, but their public links and rescheduling pages will no longer be available.');
  }
  const settings={...current,profile:{...current.profile,...normalized.profile},meetingTypes:normalized.meetingTypes??current.meetingTypes,availabilitySchedules:schedules,defaultAvailabilityScheduleId:defaultId};
  try{for(const type of settings.meetingTypes){resolveAvailabilitySchedule(type,settings.availabilitySchedules,defaultId);validateTeamReferences(type.teamScheduling,policyReferenceAccounts(type,current.accounts,current.meetingTypes.find(t=>t.id===type.id)),settings.availabilitySchedules,{requireConnected:type.published});}}catch(error){throw problem(error.message);}
  if((normalized.availabilitySchedules!==undefined||normalized.defaultAvailabilityScheduleId!==undefined)&&settings.meetingTypes.some(type=>{
    if(!type.scheduleId&&!type.useDefaultSchedule)return false;
    const old=current.meetingTypes.find(item=>item.id===type.id);if(!old)return false;
    const beforeId=old.useDefaultSchedule?current.defaultAvailabilityScheduleId:old.scheduleId,afterId=type.useDefaultSchedule?defaultId:type.scheduleId;
    return stable(current.availabilitySchedules?.find(schedule=>schedule.id===beforeId))!==stable(schedules.find(schedule=>schedule.id===afterId));
  }))warnings.push('Availability schedule changes apply to every linked meeting. Existing bookings keep their accepted details.');
  return {patch:normalized,settings,changes:diff(current,settings),warnings:[...new Set(warnings)]};
}
export class HostedSettings {
  constructor(ledger,storage,features={}){this.ledger=ledger;this.storage=storage;this.features=features;}
  async read(){
    for(let attempt=0;attempt<3;attempt++){
      const settings=this.ledger.settings(),serialized=stable(settings),revision=await sha256(serialized);
      if(serialized===stable(this.ledger.settings()))return {...settings,revision};
    }
    throw problem('Settings changed while loading. Try again.',409,'settings_conflict');
  }
  async preview(patch){
    const {revision,...current}=await this.read();
    const normalized=normalizeSettingsPatch(current,patch,this.features);await this.ledger.verifyMeetingDestinations(normalized.patch,current);if(stable(current)!==stable(this.ledger.settings()))throw problem('Settings changed. Reload them and review your changes before saving.',409,'settings_conflict');return {...normalized,revision};
  }
  async apply(patch,expectedRevision){
    if(typeof expectedRevision!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(expectedRevision))throw problem('Load current settings and review your changes before saving.',409,'settings_conflict');
    const {revision,...current}=await this.read();
    if(revision!==expectedRevision)throw problem('Settings changed. Reload them and review your changes before saving.',409,'settings_conflict');
    const normalized=normalizeSettingsPatch(current,patch,this.features);
    const verifiedDestinations=await this.ledger.verifyMeetingDestinations(normalized.patch,current);
    // The digest yields; compare the snapshot again immediately before the
    // synchronous transaction. No provider I/O or grant writes occur here.
    if(stable(current)!==stable(this.ledger.settings()))throw problem('Settings changed. Reload them and review your changes before saving.',409,'settings_conflict');
    const settings=this.storage.transactionSync(()=>this.ledger.saveSettings(normalized.patch,{verifiedDestinations}));
    return {settings,revision:await sha256(stable(settings)),changes:normalized.changes,warnings:normalized.warnings};
  }
}
