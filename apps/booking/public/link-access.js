/** Admission limits apply to new requests, never accepted booking management. */
export function normalizeLinkAccess(value={}) {
 const singleUse=value.singleUse===undefined?false:value.singleUse;
 const expiresAt=value.expiresAt===undefined?null:value.expiresAt;
 if(typeof singleUse!=='boolean')throw Error('Choose a valid single-use setting.');
 if(expiresAt!==null&&(!Number.isSafeInteger(expiresAt)||expiresAt<0||expiresAt>8640000000000000))throw Error('Choose a valid link expiration date.');
 return {singleUse,expiresAt};
}
export function linkAccessState(config,used=false,now=Date.now()) {
 const {singleUse,expiresAt}=normalizeLinkAccess(config);
 return {state:expiresAt!==null&&now>=expiresAt?'expired':singleUse&&used?'used':'open',used:used===true,expiresAt};
}
export function linkAdmissionFailure(config,used=false,now=Date.now()) {
 const {state}=linkAccessState(config,used,now);
 return state==='expired'?{error:'This booking link has expired.',status:410,code:'link_expired'}:state==='used'?{error:'This booking link has already been used.',status:410,code:'link_used'}:null;
}
