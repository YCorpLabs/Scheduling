import {recordGeneration,assertLifecycleActive,lifecycleActive,withLifecycleAdmission} from './lifecycle.js';
// Only a fresh, verified Google identity callback writes this record. Cached
// browser-session email snapshots must never replace a newer verified address.
import {HttpError} from './http.js';
const email=value=>typeof value==='string'?value.trim().toLowerCase():'';
const valid=value=>typeof value==='string'&&value.length<=254&&/^\S+@[^\s@]+\.[^\s@]+$/.test(value)&&!/[\x00-\x20]/.test(value);
const identityStore=(env,hostId)=>env.AUTH.getByName('identity:'+hostId);
export async function verifiedIdentity(env,hostId){
 if(!await lifecycleActive(env,hostId,0))return null;
 const value=await identityStore(env,hostId).get();
 if(value==null)return null;
 if(value.hostId!==hostId||!valid(value.email)||!Number.isSafeInteger(value.version)||value.version<1)throw new HttpError(503,'Account identity is temporarily unavailable.');
 const generation=recordGeneration(value.accountGeneration);if(generation<0)throw new HttpError(503,'Account identity is temporarily unavailable.');
 if(!await lifecycleActive(env,hostId,generation))return null;
 return {...value,email:email(value.email)};
}
export async function rememberVerifiedIdentity(env,user){
 if(!/^h_[A-Za-z0-9_-]{24}$/.test(user.hostId)||!valid(email(user.email)))throw new HttpError(400,'A verified account identity is required.');
 return withLifecycleAdmission(env,user.hostId,'verified_identity',async({write})=>{
 const target=identityStore(env,user.hostId);
 for(let attempt=0;attempt<12;attempt++){
  const current=await verifiedIdentity(env,user.hostId),body={hostId:user.hostId,email:email(user.email),version:(current?.version||0)+1,verifiedAt:Date.now(),accountGeneration:0};
  if(await write(()=>target.compareAndSwap(current?.version??null,body,Number.MAX_SAFE_INTEGER-Date.now())))return body;
 }
 throw new HttpError(409,'Account identity changed. Sign in again.');
 },{cleanup:async error=>error instanceof HttpError&&error.status<500});
}
