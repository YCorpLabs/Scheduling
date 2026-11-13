const fallback={subject:'Following up: {meeting_title}',body:'Hi {guest_name},\n\nFollowing up on {meeting_title}.\n\n{host_name}'};
function template(value,label,max,singleLine=false){
 if(typeof value!=='string'||value.length>max||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)||(singleLine&&/[\r\n]/.test(value)))throw Error(`Choose a valid follow-up ${label}.`);
 const rest=value.replace(/\{(guest_name|meeting_title|host_name)\}/g,'');if(/[{}]/.test(rest))throw Error('Use only {guest_name}, {meeting_title}, or {host_name} in follow-up templates.');
 return value.trim();
}
export function normalizeFollowUp(config={}){
 const followUpMinutes=config.followUpMinutes??null;
 if(followUpMinutes!==null&&(!Number.isInteger(followUpMinutes)||followUpMinutes<5||followUpMinutes>10080))throw Error('Choose a follow-up between 5 minutes and 7 days after the meeting.');
 return {followUpMinutes,followUpSubject:template(config.followUpSubject===undefined?'':config.followUpSubject,'subject',160,true),followUpBody:template(config.followUpBody===undefined?'':config.followUpBody,'message',4000)};
}
export function followUpContent(config={},values={}){
 const c=normalizeFollowUp(config),replace=value=>value.replace(/\{(guest_name|meeting_title|host_name)\}/g,(_,key)=>String(values[key]??'').replace(/[\u0000-\u001f\u007f]/g,' ').trim());
 return {subject:replace(c.followUpSubject||fallback.subject),body:replace(c.followUpBody||fallback.body)};
}
