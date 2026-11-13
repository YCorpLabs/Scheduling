import {indexAccountObject,inspectAccountObjectSync,accountObjectReferences} from './account-cleanup.js';
import {recordGeneration,lifecycleRecord,lifecycleStore,lifecycleSnapshot,assertLifecycleActive,lifecycleActive,withLifecycleAdmission,beginLifecycleStore,ackLifecycleStore,stepLifecycleStore,hasLifecycleReservation,reserveLifecycleSync,readLifecycleReservationSync,registerLifecycleProofSync,armLifecycleReservationSync,beginReservedLifecycleSync,cancelLifecycleReservationSync,attachAccountDeletionSync,updateAccountDeletionSync,completeAccountDeletionSync} from './lifecycle.js';
import {verifiedIdentity,rememberVerifiedIdentity} from './identity.js';
import { DurableObject } from 'cloudflare:workers';
import { randomToken, sha256, timingSafeEqual } from './crypto.js';
import { authorizationUrl, exchangeCode, getUserInfo } from './google.js';
import {HttpError,response} from './http.js';
import {brandFromEnv,escapeHTML,legalLinksMarkup} from '../public/brand.js';
import {workspaceAccess,ownCalendarMember,reserveWorkspaceOwnershipSync,releaseWorkspaceOwnershipSync} from './workspaces.js';

const checkedHostResult=value=>{if(value?.error)throw Object.assign(new HttpError(value.status||503,value.error),{code:value.code});return value;};
const SESSION_MS=7*86400000,MAX_BROWSER_SESSIONS=50,MAX_BROWSER_RECORDS=500,LAST_SEEN_MS=5*60000;

export class AuthStore extends DurableObject {
  constructor(ctx,env) {
    super(ctx,env); this.sql=ctx.storage.sql;this.exportStorage=ctx.storage;this.cleanupEnv=env;
    this.sql.exec('CREATE TABLE IF NOT EXISTS state (id INTEGER PRIMARY KEY, body TEXT NOT NULL, expires INTEGER NOT NULL)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS hosts (id TEXT PRIMARY KEY, touched INTEGER NOT NULL)');
  }
  lifecycleReservationRPC(fn,hostId,data){try{return fn(this,hostId,data);}catch(error){if(error instanceof HttpError)return {error:error.message,status:error.status,code:error.code};throw error;}}
  lifecycleReserve(hostId,data){return this.lifecycleReservationRPC(reserveLifecycleSync,hostId,data);}
  lifecycleReservationRead(hostId,data){return this.lifecycleReservationRPC(readLifecycleReservationSync,hostId,data);}
  lifecycleRegisterProof(hostId,data){return this.lifecycleReservationRPC(registerLifecycleProofSync,hostId,data);}
  lifecycleArm(hostId,data){return this.lifecycleReservationRPC(armLifecycleReservationSync,hostId,data);}
  lifecycleBeginReserved(hostId,data){return this.lifecycleReservationRPC(beginReservedLifecycleSync,hostId,data);}
  lifecycleCancelReservation(hostId,data){return this.lifecycleReservationRPC(cancelLifecycleReservationSync,hostId,data);}
  workspaceOwnershipReserve(hostId,data){return this.lifecycleReservationRPC(reserveWorkspaceOwnershipSync,hostId,data);}
  workspaceOwnershipRelease(hostId,data){return this.lifecycleReservationRPC(releaseWorkspaceOwnershipSync,hostId,data);}
  async accountDeletionAttach(hostId,data){const result=this.lifecycleReservationRPC(attachAccountDeletionSync,hostId,data);if(!result?.error)await this.exportStorage.setAlarm(Date.now()+60000);return result;}
  accountDeletionUpdate(hostId,data){return this.lifecycleReservationRPC(updateAccountDeletionSync,hostId,data);}
  accountDeletionComplete(hostId,data){return this.lifecycleReservationRPC(completeAccountDeletionSync,hostId,data);}
  accountCleanupInspect(){return inspectAccountObjectSync(this);}
  accountCleanupReferences(){return accountObjectReferences(this);}
  async putEphemeral(body,ttl){if(!Number.isSafeInteger(ttl)||ttl<1||ttl>900000)throw new HttpError(400,'Choose an ephemeral expiry.');this.put(body,ttl);try{await this.exportStorage.setAlarm(Date.now()+ttl);}catch(error){this.sql.exec('DELETE FROM state');throw error;}}
  lifecycleRead(hostId){return lifecycleRecord(this.get(),hostId);}
  lifecycleBegin(hostId,data){return beginLifecycleStore(this,hostId,data);}
  lifecycleAck(hostId,data){return ackLifecycleStore(this,hostId,data);}
  lifecycleStep(hostId,data){return stepLifecycleStore(this,hostId,data);}
  // Only export-plan objects schedule this cleanup; existing credential TTL paths are unchanged.
  async putExport(body,ttl){
    if(body?.kind!=='account-export'||!Number.isSafeInteger(ttl)||ttl<1||ttl>900000||new TextEncoder().encode(JSON.stringify(body)).byteLength>524288)throw new HttpError(400,'Choose a valid export plan.');
    this.put(body,ttl);try{await this.exportStorage.setAlarm(Date.now()+ttl);}catch(error){this.sql.exec('DELETE FROM state');throw error;}
  }
  async alarm(){
    const row=this.sql.exec('SELECT body,expires FROM state WHERE id=1').toArray()[0];if(!row)return;
    const body=JSON.parse(row.body);
    if(body?.kind==='lifecycle'&&body.deletion){
      try{const {resumeAccountDeletion}=await import('./account-deletion.js');await resumeAccountDeletion(this.cleanupEnv,body.hostId);}catch{/* Durable retry retains the fence and private recovery evidence. */}
      const current=this.get();if(current?.deletion&&current.state!=='deleted'&&!(current.state==='active'&&['cancelled','expired'].includes(current.reservation?.status)))await this.exportStorage.setAlarm(Date.now()+60000);
      return;
    }
    if(row.expires<=Date.now()){this.sql.exec('DELETE FROM state');return;}await this.exportStorage.setAlarm(row.expires);
  }
  put(body,ttl) {this.sql.exec('INSERT OR REPLACE INTO state VALUES(1,?,?)',JSON.stringify(body),Date.now()+ttl);}
  get() {const row=this.sql.exec('SELECT * FROM state WHERE id=1').toArray()[0];if(!row||row.expires<Date.now()){this.sql.exec('DELETE FROM state');return null;}return JSON.parse(row.body);}
  getWithExpiry() {const row=this.sql.exec('SELECT * FROM state WHERE id=1').toArray()[0];if(!row||row.expires<=Date.now()){this.sql.exec('DELETE FROM state');return null;}return {body:JSON.parse(row.body),expiresAt:row.expires};}
  compareAndSwap(expectedVersion,body,ttl) {const current=this.get();if((current?.version??null)!==expectedVersion)return false;this.put(body,ttl);return true;}
  takeExpired(cutoff){if(!Number.isSafeInteger(cutoff))throw new HttpError(400,'Choose an expiry cutoff.');const before=this.sql.exec('SELECT expires FROM state WHERE id=1').toArray()[0];if(!before)return true;if(before.expires>Math.min(cutoff,Date.now()))return false;this.sql.exec('DELETE FROM state WHERE id=1 AND expires<=?',Math.min(cutoff,Date.now()));return true;}
  take() {const body=this.get();this.sql.exec('DELETE FROM state');return body;}
  allow(max,ttl) {let record=this.get()||{count:0};if(record.count>=max)return false;record.count++;const expiry=this.sql.exec('SELECT expires FROM state WHERE id=1').toArray()[0]?.expires||Date.now()+ttl;this.sql.exec('INSERT OR REPLACE INTO state VALUES(1,?,?)',JSON.stringify(record),expiry);return true;}
  register(id) {this.sql.exec('INSERT INTO hosts VALUES(?,?) ON CONFLICT(id) DO UPDATE SET touched=excluded.touched',id,Date.now());}
  list(after='') {return this.sql.exec('SELECT id FROM hosts WHERE id>? ORDER BY id LIMIT 20',after).toArray().map(x=>x.id);}
}
export const localOrigin=url=>['localhost','127.0.0.1','[::1]'].includes(url.hostname);
export function configured(env) {return !!(env.PUBLIC_ORIGIN && env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.TOKEN_ENCRYPTION_KEY && env.LIVE_ENABLED==='true');}
export function originFor(env) {const u=new URL(env.PUBLIC_ORIGIN);if(u.origin!==env.PUBLIC_ORIGIN|| (u.protocol!=='https:'&&!localOrigin(u)))throw Error('Invalid service origin');return u.origin;}
function cookies(request) {return Object.fromEntries((request.headers.get('Cookie')||'').split(';').map(x=>x.trim().split(/=(.*)/s)).filter(x=>x.length>1).map(([k,v])=>[k,v]));}
export function cookie(name,value,origin,maxAge,path='/') {return `${name}=${value}; Path=${path}; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${origin.startsWith('https:')?'; Secure':''}`;}
const browserRegistry=(env,host)=>env.AUTH.getByName('browser-sessions:'+host);
const browserId=hash=>sha256('email-browser-session-id:'+hash);
async function updateBrowserRegistry(env,host,change,life){
  if(!life)return withLifecycleAdmission(env,host,'browser_registry',context=>updateBrowserRegistry(env,host,change,context),{cleanup:async error=>error instanceof HttpError&&error.status<500});
  const store=browserRegistry(env,host);
  for(let attempt=0;attempt<8;attempt++){
    const current=await store.get(),time=Date.now();
    const state={legacyRevokedUntil:current?.legacyRevokedUntil??0,sessions:(current?.sessions??[]).filter(s=>s.expiresAt>time)};
    const result=change(state,time);
    state.version=(current?.version??0)+1;
    const expiresAt=Math.max(time+1,state.legacyRevokedUntil,...state.sessions.map(s=>s.expiresAt));
    if(await (life?.write?life.write(()=>store.compareAndSwap(current?.version??null,state,expiresAt-time)):store.compareAndSwap(current?.version??null,state,expiresAt-time)))return result;
  }
  throw new HttpError(409,'Browser sessions changed. Please retry.');
}
function admitBrowser(state,record,{legacy=false,time=Date.now()}={}){
  const existing=state.sessions.find(s=>s.id===record.id);
  if(existing)return !existing.revokedAt&&existing.tokenHash===record.tokenHash?existing:null;
  if(legacy&&state.legacyRevokedUntil>time)return null;
  if(state.sessions.filter(s=>!s.revokedAt).length>=MAX_BROWSER_SESSIONS||state.sessions.length>=MAX_BROWSER_RECORDS)throw new HttpError(429,'Browser session limit reached. Sign out another browser or wait for older sessions to expire.');
  state.sessions.push(record);return record;
}
/** The bearer is sent only through the existing HttpOnly cookie. Both the
 * credential lookup and authoritative host registry retain hashes, not tokens.
 */
export async function storeBrowserSession(env,token,user){
  const time=Date.now(),tokenHash=await sha256(token),id=await browserId(tokenHash),expiresAt=time+SESSION_MS,generation=recordGeneration(user.accountGeneration);
  const store=env.AUTH.getByName('session:'+tokenHash);
  return withLifecycleAdmission(env,user.hostId,'browser_session',async life=>{const {assertActive,write}=life;
    await assertActive();
    const admitted=await updateBrowserRegistry(env,user.hostId,(state,now)=>admitBrowser(state,{id,tokenHash,accountGeneration:generation,createdAt:time,lastSeenAt:time,expiresAt},{time:now}),life);
    if(!admitted)throw new HttpError(409,'This browser session was already revoked.');
    await indexAccountObject(env,user.hostId,'session:'+tokenHash,expiresAt,life);
    await assertActive();await write(()=>store.put({hostId:user.hostId,email:user.email,accountGeneration:generation,sessionVersion:1,id,createdAt:time,expiresAt},SESSION_MS));
    return id;
  },{generation,cleanup:async error=>{await store.take();await revokeBrowserRecord(env,user.hostId,id);return error instanceof HttpError&&error.status<500;}});
}
async function browserContext(request,env){
  const token=cookies(request).email_booking_session;if(!token||token.length>100)return null;
  const tokenHash=await sha256(token),stored=await env.AUTH.getByName('session:'+tokenHash).getWithExpiry();
  if(!stored?.body?.hostId||stored.expiresAt<=Date.now())return null;
  const user=stored.body,id=await browserId(tokenHash),generation=recordGeneration(user.accountGeneration);
  if(!await lifecycleActive(env,user.hostId,generation))return null;
  if(user.sessionVersion===1&&user.id!==id)return null;
  const registry=await browserRegistry(env,user.hostId).get();
  let record=registry?.sessions?.find(s=>s.id===id&&s.tokenHash===tokenHash);
  if(!record){
    // Legacy cookies have no index. Adopt them only until revoke-others sets a
    // host-wide legacy cutoff. Their original TTL is never extended.
    if(user.sessionVersion!==undefined)return null;
    try{record=await withLifecycleAdmission(env,user.hostId,'legacy_browser',life=>{return updateBrowserRegistry(env,user.hostId,(state,time)=>admitBrowser(state,{id,tokenHash,accountGeneration:generation,createdAt:user.createdAt??Math.max(0,stored.expiresAt-SESSION_MS),lastSeenAt:time,expiresAt:stored.expiresAt},{legacy:true,time}),life);},{generation,cleanup:async error=>{await revokeBrowserRecord(env,user.hostId,id);return error instanceof HttpError&&error.status<500;}});}catch(error){if(['lifecycle_fenced','lifecycle_changed'].includes(error.code))return null;throw error;}
  }
  if(!record||record.revokedAt||record.expiresAt<=Date.now()||(recordGeneration(record.accountGeneration))!==generation)return null;
  if(Date.now()-record.lastSeenAt>=LAST_SEEN_MS&&!hasLifecycleReservation(await lifecycleSnapshot(env,user.hostId))){
    try{record=await withLifecycleAdmission(env,user.hostId,'browser_touch',life=>{return updateBrowserRegistry(env,user.hostId,(state,time)=>{
      const current=state.sessions.find(s=>s.id===id&&s.tokenHash===tokenHash&&!s.revokedAt);
      if(current)current.lastSeenAt=time;return current??null;
    },life);},{generation,cleanup:async error=>error instanceof HttpError&&error.status<500});}catch(error){if(['lifecycle_fenced','lifecycle_changed'].includes(error.code))return null;if(error.code!=='lifecycle_reserved')throw error;}
    if(!record)return null;
  }
  const identity=await verifiedIdentity(env,user.hostId);
  if(!await lifecycleActive(env,user.hostId,generation))return null;
  return {user:{hostId:user.hostId,email:identity?.email??user.email},id,tokenHash,record};
}
export async function session(request,env) {
  return (await browserContext(request,env))?.user??null;
}
async function revokeBrowserRecord(env,host,id,authorizerId,legacyRecord){
  return updateBrowserRegistry(env,host,(state,time)=>{
    if(authorizerId&&!state.sessions.some(s=>s.id===authorizerId&&!s.revokedAt))throw new HttpError(401,'This browser session was revoked. Sign in again.');
    const record=state.sessions.find(s=>s.id===id);
    if(record){if(!record.revokedAt)record.revokedAt=time;return record;}
    // Logout can revoke a legacy cookie without first admitting an active
    // session. Keep the tombstone even if deleting its credential later fails.
    if(legacyRecord){
      if(state.sessions.length>=MAX_BROWSER_RECORDS)throw new HttpError(429,'Browser session history is full.');
      const revoked={...legacyRecord,revokedAt:time};state.sessions.push(revoked);return revoked;
    }
    return null;
  });
}
async function browserUser(request,env,mutation=false){
  const origin=originFor(env);
  if(new URL(request.url).origin!==origin||(mutation&&request.headers.get('Origin')!==origin))throw new HttpError(403,'Request not allowed.');
  if(request.method!==(mutation?'POST':'GET'))throw new HttpError(405,'Method not allowed.');
  const context=await browserContext(request,env);if(!context)throw new HttpError(401,'Sign in to manage browser sessions.');return context;
}
function sessionError(error){return response({error:error instanceof HttpError?error.message:'Browser session management is temporarily unavailable.'},error instanceof HttpError?error.status:503);}
export async function browserSessions(request,env){
  try{
    const current=await browserUser(request,env),state=await browserRegistry(env,current.user.hostId).get();
    const sessions=(state?.sessions??[]).filter(s=>!s.revokedAt&&s.expiresAt>Date.now()).map(s=>({id:s.id,label:s.id===current.id?'This browser':'Browser session',createdAt:s.createdAt,lastSeenAt:s.lastSeenAt,expiresAt:s.expiresAt,current:s.id===current.id})).sort((a,b)=>Number(b.current)-Number(a.current)||b.lastSeenAt-a.lastSeenAt);
    return response({sessions});
  }catch(error){return sessionError(error);}
}
export async function revokeBrowserSession(request,env,data){
  try{
    const current=await browserUser(request,env,true);
    if(!data||Object.keys(data).some(k=>k!=='id')||typeof data.id!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(data.id))throw new HttpError(400,'Choose a valid browser session.');
    const revoked=await revokeBrowserRecord(env,current.user.hostId,data.id,current.id);if(!revoked)throw new HttpError(404,'Browser session not found.');
    // Keep the tombstone until original expiry: a legacy token must never be
    // able to enroll itself again, even if credential cleanup fails.
    try{await env.AUTH.getByName('session:'+revoked.tokenHash).take();}catch{/* Registry revocation is authoritative. */}
    const result=response({revoked:true,current:data.id===current.id});
    if(data.id===current.id)result.headers.set('Set-Cookie',cookie('email_booking_session','',originFor(env),0));
    return result;
  }catch(error){return sessionError(error);}
}
export async function revokeOtherBrowserSessions(request,env,data={}){
  try{
    const current=await browserUser(request,env,true);
    if(!data||typeof data!=='object'||Array.isArray(data)||Object.keys(data).length)throw new HttpError(400,'No session selection is needed.');
    const revoked=await updateBrowserRegistry(env,current.user.hostId,(state,time)=>{
      if(!state.sessions.some(s=>s.id===current.id&&!s.revokedAt))throw new HttpError(401,'This browser session was revoked. Sign in again.');
      state.legacyRevokedUntil=Math.max(state.legacyRevokedUntil,time+SESSION_MS);
      const others=state.sessions.filter(s=>s.id!==current.id&&!s.revokedAt);
      for(const record of others)record.revokedAt=time;return others;
    });
    await Promise.allSettled(revoked.map(record=>env.AUTH.getByName('session:'+record.tokenHash).take()));
    return response({revokedCount:revoked.length});
  }catch(error){return sessionError(error);}
}
export async function signOut(request,env) {
  const origin=originFor(env);
  if(new URL(request.url).origin!==origin||request.headers.get('Origin')!==origin)return response({error:'Request not allowed.'},403);
  if(request.method!=='POST')return response({error:'Method not allowed.'},405);
  let failed=false;
  try{
    // Logout must not need to enroll an old cookie in a full registry first.
    const token=cookies(request).email_booking_session;
    if(token&&token.length<=100){
      const tokenHash=await sha256(token),store=env.AUTH.getByName('session:'+tokenHash);
      try{
        const stored=await store.getWithExpiry();
        if(stored?.body?.hostId&&await lifecycleActive(env,stored.body.hostId,recordGeneration(stored.body.accountGeneration))){
          const id=await browserId(tokenHash);
          await revokeBrowserRecord(env,stored.body.hostId,id,undefined,{id,tokenHash,createdAt:stored.body.createdAt??Math.max(0,stored.expiresAt-SESSION_MS),lastSeenAt:Date.now(),expiresAt:stored.expiresAt});
        }
      }finally{await store.take();}
    }
  }catch{failed=true;}
  const result=failed?response({error:'This browser was signed out locally. Server session cleanup needs another attempt.'},503):new Response(null,{status:204,headers:{'Cache-Control':'no-store'}});
  result.headers.set('Set-Cookie',cookie('email_booking_session','',origin,0));return result;
}
export async function oauthStart(request,env) {
  const url=new URL(request.url),existing=await session(request,env),connect=url.searchParams.get('connect')==='1';
  if(connect&&!existing)return new Response('Sign in first',{status:401});
  const workspaceId=url.searchParams.get('workspace'),own=url.searchParams.get('own')==='1';let targetHostId=existing?.hostId,ownerMember;
  if(own&&(!connect||!workspaceId))throw new HttpError(400,'Choose a company calendar connection.');
  if(workspaceId){if(!connect)throw new HttpError(400,'Choose a calendar connection.');const access=await workspaceAccess(env,existing,workspaceId);if(own){const member=await ownCalendarMember(env,existing,workspaceId);ownerMember={...member,fenceEpoch:await env.LIVE_HOSTS.getByName(access.hostId).memberCalendarEpoch(member.id)};}else if(!access.capabilities.manageCalendars)throw new HttpError(403,'An admin must connect this workspace calendar.');targetHostId=access.hostId;}
  const state=randomToken(),binding=randomToken(),verifier=randomToken();
  const oauthName='oauth:'+await sha256(state),oauthStore=env.AUTH.getByName(oauthName),oauthBody={binding:await sha256(binding),verifier,accountGeneration:0,targetGeneration:0,flow:connect?'calendar':'identity',hostId:connect?targetHostId:null,...(workspaceId?{workspaceId,initiatorHostId:existing.hostId}:{}),...(ownerMember?{ownerMember}:{}),returnTo:url.searchParams.get('returnTo')==='device'?'/device':'/studio'};
  if(existing?.hostId)await withLifecycleAdmission(env,existing.hostId,'oauth_state',async life=>{await indexAccountObject(env,existing.hostId,oauthName,Date.now()+600000,life);await life.write(()=>oauthStore.putEphemeral?oauthStore.putEphemeral(oauthBody,600000):oauthStore.put(oauthBody,600000));},{cleanup:async error=>error instanceof HttpError&&error.status<500});
  else await (oauthStore.putEphemeral?oauthStore.putEphemeral(oauthBody,600000):oauthStore.put(oauthBody,600000));
  const location=authorizationUrl({clientId:env.GOOGLE_CLIENT_ID,redirectUri:originFor(env)+'/auth/google/callback',state,codeChallenge:await sha256(verifier),identityOnly:!connect});
  return new Response(null,{status:302,headers:{Location:location,'Set-Cookie':cookie('email_booking_oauth',binding,originFor(env),600,'/auth'),'Cache-Control':'no-store','Referrer-Policy':'no-referrer'}});
}
function expiredSignIn(env) {
  const product=escapeHTML(brandFromEnv(env).productName);
  return new Response(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Sign in again · ${product}</title><link rel="stylesheet" href="/tokens.css"><link rel="stylesheet" href="/style.css"><main class="sign-in-card"><h1>Sign-in expired</h1><p>Start again to sign in to ${product}.</p><a class="primary" href="/auth/google">Sign in with Google</a><nav class="legal-links" aria-label="Legal">${legalLinksMarkup(brandFromEnv(env))}</nav></main></html>`,{status:400,headers:{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'none'; style-src 'self'; frame-ancestors 'none'; base-uri 'none'",'Set-Cookie':cookie('email_booking_oauth','',originFor(env),0,'/auth')}});
}
async function mayFinishConnection(request,env,saved){
 const current=await session(request,env);if(!saved.workspaceId)return current?.hostId===saved.hostId;
 if(current?.hostId!==saved.initiatorHostId)return false;
 try{const access=await workspaceAccess(env,current,saved.workspaceId);if(saved.ownerMember){const member=await ownCalendarMember(env,current,saved.workspaceId);return member.id===saved.ownerMember.id&&member.email===saved.ownerMember.email&&member.joinedAt===saved.ownerMember.joinedAt&&await env.LIVE_HOSTS.getByName(access.hostId).memberCalendarEpoch(member.id)===saved.ownerMember.fenceEpoch;}return access.hostId===saved.hostId&&access.capabilities.manageCalendars;}catch{return false;}
}
export async function oauthCallback(request,env) {
  const url=new URL(request.url),state=url.searchParams.get('state'),binding=cookies(request).email_booking_oauth;
  if(!state||state.length>100||!binding||binding.length>100)return expiredSignIn(env);
  const saved=await env.AUTH.getByName('oauth:'+await sha256(state)).take();
  if(!saved||!await timingSafeEqual(saved.binding,await sha256(binding)))return expiredSignIn(env);
  // States created before the flow split requested calendar access as well as
  // identity. Finish them under that original, stricter calendar contract.
  const legacy=saved.flow===undefined,calendarFlow=legacy||saved.flow==='calendar';
  if(!legacy&&!['identity','calendar'].includes(saved.flow))return expiredSignIn(env);
  if((saved.flow==='calendar'&&!saved.hostId)||(saved.flow==='identity'&&saved.hostId))return expiredSignIn(env);
  if(saved.hostId&&!await mayFinishConnection(request,env,saved))return new Response('Sign in again to connect this calendar.',{status:401});
  if(url.searchParams.has('error'))return new Response(null,{status:303,headers:{Location:originFor(env)+(saved.returnTo==='/device'?'/device':'/studio')+'?connection=declined','Set-Cookie':cookie('email_booking_oauth','',originFor(env),0,'/auth')}});
  const code=url.searchParams.get('code');if(!code||code.length>4096)return new Response('Invalid sign-in response',{status:400});
  const tokens=await exchangeCode({clientId:env.GOOGLE_CLIENT_ID,clientSecret:env.GOOGLE_CLIENT_SECRET,redirectUri:originFor(env)+'/auth/google/callback',code,codeVerifier:saved.verifier});
  const user=await getUserInfo(tokens.access_token);if(!user.sub||!user.email||user.email_verified!==true)throw Error('A verified Google account is required.');
  if(calendarFlow){
    if(saved.ownerMember&&user.email.trim().toLowerCase()!==saved.ownerMember.email)throw new HttpError(403,'Choose the Google account matching your company member email. Your calendar connection has not changed.');
    const required=['calendar.calendarlist.readonly','calendar.events','calendar.freebusy'],scopes=new Set((typeof tokens.scope==='string'?tokens.scope:'').split(' '));
    if(required.some(scope=>!scopes.has('https://www.googleapis.com/auth/'+scope)))throw Error('Calendar permission was not granted. Your existing calendar connection has not changed.');
    if(typeof tokens.refresh_token!=='string'||!tokens.refresh_token.trim()||tokens.refresh_token.length>8192)throw Error('Calendar access could not be saved. Reconnect Google and grant calendar permission.');
    // Recheck the owner after provider I/O. A calendar selected in Google may
    // belong to another account, but it must never become this host's identity.
    if(saved.hostId&&!await mayFinishConnection(request,env,saved))return new Response('Sign in again to connect this calendar.',{status:401});
  }
  const hostId=saved.hostId||'h_'+(await sha256('google:'+user.sub)).slice(0,24);
  const actorId=saved.initiatorHostId||hostId,credentialOwnerId='h_'+(await sha256('google:'+user.sub)).slice(0,24);
  const finishCallback=async({write})=>{
  const host=env.LIVE_HOSTS.getByName(hostId);
  if(!saved.hostId){checkedHostResult(await write(()=>host.init({id:hostId,name:user.name||user.email,email:user.email,profileSetupRequired:true})));await rememberVerifiedIdentity(env,{hostId,email:user.email});}
  if(saved.ownerMember){const target=env.AUTH.getByName('calendar-contributions:'+saved.ownerMember.id);for(let attempt=0;attempt<12;attempt++){const current=await target.get(),contributions=current?.contributions??[],entry={workspaceId:saved.hostId,accountId:user.sub,email:saved.ownerMember.email};if(contributions.some(c=>c.workspaceId===entry.workspaceId&&c.accountId===entry.accountId))break;if(contributions.length>=200)throw new HttpError(409,'Calendar contribution limit reached.');const body={contributions:[...contributions,entry],version:(current?.version??0)+1};if(await write(()=>target.compareAndSwap(current?.version??null,body,Number.MAX_SAFE_INTEGER-Date.now())))break;if(attempt===11)throw new HttpError(409,'Calendar contributions changed. Reload your connections.');}}

  if(calendarFlow){checkedHostResult(await write(()=>host.connectAccount({accountId:user.sub,email:user.email,tokens,credentialOwnerId,...(saved.ownerMember?{ownerMember:saved.ownerMember}:{})})));}

  await write(()=>env.AUTH.getByName('host-registry').register(hostId));
  const headers=new Headers({Location:originFor(env)+(saved.returnTo==='/device'?'/device':'/studio')+(saved.workspaceId?'?workspace='+encodeURIComponent(saved.workspaceId)+(saved.ownerMember?'&calendar=connected':''):''),'Cache-Control':'no-store','Referrer-Policy':'no-referrer'});
  // Connecting a calendar is authorized by the existing owner session, not a
  // fresh identity login. Never mint a replacement bearer: revocation during
  // provider/storage I/O must remain effective, including legacy owner states.
  if(saved.hostId){
    if(!await mayFinishConnection(request,env,saved))return new Response('Sign in again to connect this calendar.',{status:401});
  }else{
    const sessionToken=randomToken();await storeBrowserSession(env,sessionToken,{hostId,email:user.email});
    headers.append('Set-Cookie',cookie('email_booking_session',sessionToken,originFor(env),7*86400));
  }
  headers.append('Set-Cookie',cookie('email_booking_oauth','',originFor(env),0,'/auth'));
  return new Response(null,{status:303,headers});
  };
  // Calendar consent also admits the verified Google credential owner. An
  // administrator connecting a different account must not restore that account's
  // grant after its own deletion fence. All owner/actor/target IDs are deduped.
  const identities=[...new Set([actorId,hostId,...(calendarFlow?[credentialOwnerId]:[])])],contexts=[];
  const enter=async index=>{
    if(index===identities.length){const write=mutation=>contexts.reduceRight((next,context)=>()=>context.write(next),mutation)();return finishCallback({write});}
    const id=identities[index],generation=id===actorId?recordGeneration(saved.accountGeneration):id===hostId?recordGeneration(saved.targetGeneration):0;
    return withLifecycleAdmission(env,id,index===0?'oauth_callback':'oauth_calendar',async context=>{contexts.push(context);try{return await enter(index+1);}finally{contexts.pop();}},{generation,cleanup:async error=>error instanceof HttpError&&error.status<500});
  };
  return enter(0);
}
