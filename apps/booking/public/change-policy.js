const MAX_NOTICE=43200;
export function normalizeChangeNotices(config={}){
 const result={};for(const key of ['cancellationNoticeMinutes','rescheduleNoticeMinutes']){const value=config[key]===undefined?0:config[key];if(!Number.isInteger(value)||value<0||value>MAX_NOTICE)throw Error('Choose a change notice between 0 and 43200 minutes.');result[key]=value;}return result;
}
export function changePolicyForStart(config,start){
 if(!Number.isSafeInteger(start))throw Error('Choose a valid meeting start.');const notices=normalizeChangeNotices(config);return {...notices,cancelUntil:notices.cancellationNoticeMinutes?start-notices.cancellationNoticeMinutes*60000:null,rescheduleUntil:notices.rescheduleNoticeMinutes?start-notices.rescheduleNoticeMinutes*60000:null};
}
export function changeWindowOpen(policy,kind,now=Date.now()){
 if(!['cancel','reschedule'].includes(kind))throw Error('Choose a valid booking change.');const deadline=kind==='cancel'?policy.cancelUntil:policy.rescheduleUntil;return deadline===null||Number.isFinite(deadline)&&Number.isFinite(now)&&now<deadline;
}
