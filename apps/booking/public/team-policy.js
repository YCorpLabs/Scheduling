// A team host is an explicitly connected account in this profile, never a member lookup.
const id=v=>typeof v==='string'&&/^[A-Za-z0-9_-]{1,80}$/.test(v);
const calendar=v=>typeof v==='string'&&v.length<=1024&&!/[\x00-\x1f\x7f]/.test(v);
export function normalizeTeamScheduling(value){
 if(value==null)return null;
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!['mode','hosts'].includes(k))||!['any','choose','all'].includes(value.mode)||!Array.isArray(value.hosts)||value.hosts.length<1||value.hosts.length>8)throw Error('Choose a team mode and one to eight hosts.');
 const ids=new Set(),accounts=new Set();
 const hosts=value.hosts.map(host=>{
  if(!host||typeof host!=='object'||Array.isArray(host)||Object.keys(host).some(k=>!['id','name','accountId','useDefaultCalendar','calendarId','conflictCalendarIds','scheduleId'].includes(k))||!id(host.id)||ids.has(host.id)||typeof host.name!=='string'||!host.name.trim()||host.name.trim().length>160||!calendar(host.accountId)||!host.accountId||accounts.has(host.accountId)||host.useDefaultCalendar!==undefined&&typeof host.useDefaultCalendar!=='boolean'||host.calendarId!==undefined&&!calendar(host.calendarId)||host.scheduleId!=null&&!id(host.scheduleId))throw Error('Choose a unique name and connected account for each host.');
  ids.add(host.id);accounts.add(host.accountId);
  let conflictCalendarIds=null;if(host.conflictCalendarIds!=null){if(!Array.isArray(host.conflictCalendarIds)||host.conflictCalendarIds.length>49||host.conflictCalendarIds.some(v=>!calendar(v)||!v))throw Error('Choose at most 49 conflict calendars per host.');conflictCalendarIds=[...new Set(host.conflictCalendarIds)];}
  return {id:host.id,name:host.name.trim(),accountId:host.accountId,useDefaultCalendar:host.useDefaultCalendar!==false,calendarId:host.calendarId||'',conflictCalendarIds,scheduleId:host.scheduleId??null};
 });
 return {mode:value.mode,hosts};
}
export function validateTeamReferences(team,accounts,schedules=[],{requireConnected=true}={}){
 if(!team)return;const emails=new Set();
 for(const host of team.hosts){const account=accounts.find(a=>a.id===host.accountId),email=account?.email?.toLowerCase();if(host.scheduleId&&!schedules.some(s=>s.id===host.scheduleId))throw Error('A host availability schedule is missing. Choose another schedule first.');if(!account?.connected&&!requireConnected)continue;if(!account?.connected||!email||email.length>254||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||emails.has(email))throw Error('Each host needs a distinct connected Google account.');emails.add(email);if(!(host.useDefaultCalendar?account.destinationCalendarId:host.calendarId))throw Error('Choose a destination calendar for every host.');}
}
export const publicTeam=team=>team?{mode:team.mode,hosts:team.hosts.map(({id,name})=>({id,name}))}:undefined;
// Google calendar IDs are globally meaningful; the alias primary is account-local.
export const calendarResource=(accountId,calendarId,email)=>calendarId==='primary'?(email?'calendar:'+email.toLowerCase():'primary:'+accountId):'calendar:'+calendarId;
export function hostResources(host){return new Set(['account:'+host.accountId,calendarResource(host.accountId,host.calendarId,host.email)]);}
export function hostsShareResource(a,b){const aKeys=hostResources(a),bKeys=hostResources(b);return [...aKeys].some(key=>bKeys.has(key))||a.conflictCalendarIds?.some(id=>calendarResource(a.accountId,id,a.email)===calendarResource(b.accountId,b.calendarId,b.email))||b.conflictCalendarIds?.some(id=>calendarResource(b.accountId,id,b.email)===calendarResource(a.accountId,a.calendarId,a.email));}
