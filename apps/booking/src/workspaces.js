import {recordGeneration,assertLifecycleActive,lifecycleActive,withLifecycleAdmission,readLifecycleReservation,registerLifecycleProof} from './lifecycle.js';
import {profileWebsite} from '../public/profile-identity.js';
import {verifiedIdentity} from './identity.js';
import {randomToken,sha256} from './crypto.js';
import {HttpError} from './http.js';

const checkedHostResult=value=>{if(value?.error)throw Object.assign(new HttpError(value.status||503,value.error),{code:value.code});return value;};
const ID=/^h_[A-Za-z0-9_-]{24}$/;
const INVITE_ROLES=new Set(['admin','member','viewer']);
const INVITE_MS=7*86400000,MAX_WORKSPACES=40,MAX_MEMBERS=100,MAX_INVITES=100;
const email=value=>typeof value==='string'?value.trim().toLowerCase():'';
const summary=(record,role)=>({id:record.id,name:record.name,role,personal:false,capabilities:capabilities(role)});
export function capabilities(role='viewer'){
 const manage=role==='owner'||role==='admin';
 return {readBookings:true,readAnalytics:true,manageOwnCalendar:role!=='viewer',approveBookings:role!=='viewer',manageSettings:manage,exportProfile:manage,manageCalendars:manage,manageMembers:manage,manageIntegrations:manage,manageOperations:manage,transferOwnership:role==='owner',grantAdmin:role==='owner'};
}
function validName(value){if(typeof value!=='string'||value.trim().length<2||value.trim().length>80||/[\x00-\x1f]/.test(value))throw new HttpError(400,'Use a company name between 2 and 80 characters.');return value.trim();}
function validEmail(value){const normalized=email(value);if(normalized.length>254||!/^\S+@[^\s@]+\.[^\s@]+$/.test(normalized)||/[\x00-\x20]/.test(normalized))throw new HttpError(400,'Enter a valid email address.');return normalized;}
const store=(env,id)=>env.AUTH.getByName('workspace:'+id);
const index=(env,id)=>env.AUTH.getByName('workspace-index:'+id);
async function update(target,change,life){for(let i=0;i<12;i++){const current=await target.get(),next=structuredClone(current);const result=change(next,current);const body=result.body;assertOwnershipMutation(current,body);body.version=(current?.version??0)+1;if(await(life?.write?life.write(()=>target.compareAndSwap(current?.version??null,body,Number.MAX_SAFE_INTEGER-Date.now())):target.compareAndSwap(current?.version??null,body,Number.MAX_SAFE_INTEGER-Date.now())))return result.value;}throw new HttpError(409,'Workspace changed. Try again.');}
function actor(record,user,roles){const member=record?.members?.find(m=>m.id===user.hostId);if(!member||roles&&!roles.includes(member.role))throw new HttpError(403,'You do not have access to this workspace action.');return member;}
async function addIndex(env,userId,id,life){
 const target=index(env,userId),reservation=randomToken(16);
 for(let attempt=0;attempt<12;attempt++){
  const current=await target.get(),time=Date.now(),ids=[...new Set(current?.ids||[])],pins=current?.pins||{},retained=[];
  // An admission reserves discovery before it commits membership. Protect that
  // entry while its cross-object writes finish; a competing admission changes
  // the index version, forcing this pruning pass to reread the reservation.
  for(const candidate of ids){
   if(!ID.test(candidate))continue;
   if(candidate===id||(typeof pins[candidate]==='number'?pins[candidate]:pins[candidate]?.until)>time){retained.push(candidate);continue;}
   const record=await store(env,candidate).get();
   if(record?.members?.some(member=>member.id===userId))retained.push(candidate);
  }
  if(!retained.includes(id)&&retained.length>=MAX_WORKSPACES)throw new HttpError(409,'Workspace limit reached.');
  const nextIds=[...new Set([...retained,id])],nextPins=Object.fromEntries(nextIds.filter(key=>(typeof pins[key]==='number'?pins[key]:pins[key]?.until)>time).map(key=>[key,pins[key]]));nextPins[id]={until:time+3600000,reservation};
  const body={accountGeneration:0,...(current?.primaryId?{primaryId:current.primaryId}:{}),ids:nextIds,pins:nextPins,version:(current?.version??0)+1};
  if(await(life?.write?life.write(()=>target.compareAndSwap(current?.version??null,body,Number.MAX_SAFE_INTEGER-Date.now())):target.compareAndSwap(current?.version??null,body,Number.MAX_SAFE_INTEGER-Date.now())))return reservation;
 }
 throw new HttpError(409,'Workspace changed. Try again.');
}
async function finishIndex(env,userId,id,reservation,firstProfile=false,life){
 // Cleanup does not authorize or roll back an admitted membership. A newer
 // admission has a different reservation and must retain its protection.
 try{await update(index(env,userId),(draft,current)=>{const body=draft||{ids:[id]};if(body.pins?.[id]?.reservation===reservation)delete body.pins[id];if(firstProfile&&!body.primaryId)body.primaryId=id;return {body,value:true};},life);}catch{/* A protected stale entry expires; membership and discovery remain intact. */}
}
async function ensureRegistered(env,id,life){
 // Registry writes are idempotent and non-authoritative. If creation stopped
 // between the company commit and this write, the next authenticated access
 // repairs discovery before any shared administrative work can proceed.
 await(life?.write?life.write(()=>env.AUTH.getByName('host-registry').register(id)):env.AUTH.getByName('host-registry').register(id));
 return update(store(env,id),(record)=>{if(!record)throw new HttpError(404,'Workspace not found.');record.registryRegistered=true;return {body:record,value:record};},life);
}
function personal(user){return {id:user.hostId,name:user.name||user.email||'Your profile',role:'owner',personal:true,capabilities:capabilities('owner')};}
export async function workspaceAccess(env,user,id){
 await assertLifecycleActive(env,user.hostId,0);
 if(!id||id===user.hostId||id==='personal')return {...personal(user),hostId:user.hostId};
 if(!ID.test(id))throw new HttpError(400,'Choose a workspace.');
 await assertLifecycleActive(env,id,0);
 let record=await store(env,id).get();if(!record)throw new HttpError(404,'Workspace not found.');
 const identity=await verifiedIdentity(env,user.hostId);
 if(identity&&email(actor(record,user).email)!==identity.email){record=await withWorkspaceWrite(env,user,id,'workspace_identity_repair',async life=>{checkedHostResult(await life.write(()=>env.LIVE_HOSTS.getByName(id).fenceMemberCalendar(user.hostId)));return update(store(env,id),record=>{const member=actor(record,user);if(record.members.some(other=>other.id!==member.id&&email(other.email)===identity.email))throw new HttpError(409,'A company member email needs review.');member.email=identity.email;return {body:record,value:record};},life);});}
 actor(record,user);if(record.registryRegistered!==true)record=await withWorkspaceWrite(env,user,id,'workspace_registry',life=>ensureRegistered(env,id,life));
 const member=actor(record,user);await assertLifecycleActive(env,user.hostId,0);await assertLifecycleActive(env,id,0);return {...summary(record,member.role),hostId:record.id};
}
// Narrow member authority: never confers global calendar/settings access.
export async function ownCalendarMember(env,user,id){
 companyId(id);if(id===user.hostId)throw new HttpError(400,'Choose a company workspace.');
 const access=await workspaceAccess(env,user,id),record=await store(env,id).get(),member=actor(record,user,['owner','admin','member']),identity=await verifiedIdentity(env,user.hostId);
 if(!identity||email(identity.email)!==email(member.email)||email(user.email)!==email(member.email))throw new HttpError(403,'Sign in again with your company member email.');
 return {id:member.id,email:email(member.email),joinedAt:member.joinedAt,role:member.role,workspaceId:access.hostId};
}
export async function workspaceList(env,user,selected){
 await assertLifecycleActive(env,user.hostId,0);
 const saved=await index(env,user.hostId).get(),ids=saved?.ids||[],workspaces=[personal(user)];
 for(const id of ids){if(!ID.test(id))continue;const record=await store(env,id).get(),member=record?.members?.find(m=>m.id===user.hostId);if(member&&await lifecycleActive(env,id,0))workspaces.push(summary(record,member.role));}
 await assertLifecycleActive(env,user.hostId,0);return {workspaces,activeWorkspaceId:workspaces.some(w=>w.id===selected)?selected:workspaces.some(w=>w.id===saved?.primaryId)?saved.primaryId:user.hostId};
}
async function createWorkspaceImpl(env,user,data,life){
 let website;try{website=profileWebsite(data.website);}catch(error){throw new HttpError(400,error.message);}
 const name=validName(data.name),id='h_'+(await sha256('workspace:'+randomToken())).slice(0,24),createdAt=Date.now();
 // Discovery is deliberately non-authoritative. Writing it first means an
 // interrupted acceptance/create cannot leave a real member unable to discover
 // their company. A stale index entry can never grant access.
 const reservation=await addIndex(env,user.hostId,id,life);
 // Global discovery precedes the company commit too. A crashed creation may
 // leave an empty registry entry, but never an undiscoverable live company.
 await life.write(()=>env.AUTH.getByName('host-registry').register(id));
 checkedHostResult(await life.write(()=>env.LIVE_HOSTS.getByName(id).init({id,name,company:'',website,email:user.email,workspaceKind:'company'})));
 const record={id,name,createdAt,members:[{id:user.hostId,email:email(user.email),role:'owner',joinedAt:createdAt,accountGeneration:0}],invitations:[]};
 const result=await update(store(env,id),(_draft,current)=>{if(current)throw new HttpError(409,'Workspace already exists.');return {body:record,value:{workspace:summary(record,'owner')}};},life);
 await finishIndex(env,user.hostId,id,reservation,data.firstProfile===true,life);await ensureRegistered(env,id,life);return result;
}
export async function workspaceDetail(env,user,id){
 const access=await workspaceAccess(env,user,id);if(access.personal)return {workspace:access,members:[{id:user.hostId,email:user.email,role:'owner'}],invitations:[]};
 const record=await store(env,id).get(),member=actor(record,user),manage=capabilities(member.role).manageMembers;
 return {workspace:summary(record,member.role),members:record.members.map(({id,email,role,joinedAt})=>({id,email,role,joinedAt})),invitations:manage?record.invitations.filter(i=>!i.usedAt&&!i.revokedAt&&i.expiresAt>Date.now()).map(({id,email,role,expiresAt})=>({id,email,role,expiresAt})):[]};
}
function companyId(id){if(!ID.test(id||''))throw new HttpError(400,'Choose a company workspace.');return id;}
async function inviteMemberImpl(env,user,id,data,origin,life){
 companyId(id);const address=validEmail(data.email),role=data.role||'member';if(!INVITE_ROLES.has(role))throw new HttpError(400,'Choose an invitation role.');
 const secret=randomToken(),token=id+'.'+secret,tokenHash=await sha256(token),invitationId=randomToken(16),time=Date.now();
 return update(store(env,id),(record)=>{const member=actor(record,user,['owner','admin']);if(role==='admin'&&member.role!=='owner')throw new HttpError(403,'Only the owner can invite an admin.');if(record.members.some(m=>email(m.email)===address))throw new HttpError(409,'This person is already a member.');record.invitations=record.invitations.filter(i=>i.expiresAt>time&&!i.usedAt&&!i.revokedAt);if(member.role!=='owner'&&record.invitations.some(i=>i.email===address&&i.role==='admin'))throw new HttpError(403,'Only the owner can change admin invitations.');if(record.invitations.length>=MAX_INVITES)throw new HttpError(409,'Invitation limit reached.');for(const i of record.invitations)if(i.email===address)i.revokedAt=time;
 const invitation={id:invitationId,email:address,role,accountGeneration:0,expiresAt:time+INVITE_MS,tokenHash};record.invitations.push(invitation);return {body:record,value:{invitation:{id:invitationId,email:address,role,expiresAt:invitation.expiresAt},url:origin+'/studio#invite='+encodeURIComponent(token)}};},life);
}
function parseToken(token){if(typeof token!=='string'||token.length>180||!/^h_[A-Za-z0-9_-]{24}\.[A-Za-z0-9_-]{43}$/.test(token))throw new HttpError(404,'Invitation is not available.');return token.split('.')[0];}
async function invitationContext(env,user,token){await assertLifecycleActive(env,user.hostId,0);const id=parseToken(token);await assertLifecycleActive(env,id,0);const record=await store(env,id).get(),hash=await sha256(token),invitation=record?.invitations?.find(i=>i.tokenHash===hash);if(!invitation||(recordGeneration(invitation.accountGeneration))!==0||invitation.usedAt||invitation.revokedAt||invitation.expiresAt<=Date.now())throw new HttpError(404,'Invitation is not available.');if(email(user.email)!==invitation.email)throw new HttpError(403,'Sign in with the invited email address.');return {id,record,invitation,hash};}
export async function inspectInvitation(env,user,token){const {record,invitation}=await invitationContext(env,user,token);return {invitation:{id:invitation.id,email:invitation.email,role:invitation.role,expiresAt:invitation.expiresAt,workspaceName:record.name,workspaceId:record.id}};}
async function acceptInvitationImpl(env,user,token,life){
 const {id,hash}=await invitationContext(env,user,token),reservation=await addIndex(env,user.hostId,id,life);
 const accepted=await update(store(env,id),(record)=>{const time=Date.now(),invitation=record?.invitations?.find(i=>i.tokenHash===hash);if(!invitation||(recordGeneration(invitation.accountGeneration))!==0||invitation.usedAt||invitation.revokedAt||invitation.expiresAt<=time)throw new HttpError(404,'Invitation is not available.');if(email(user.email)!==invitation.email)throw new HttpError(403,'Sign in with the invited email address.');if(record.members.some(m=>m.id===user.hostId||email(m.email)===email(user.email)))throw new HttpError(409,'You are already a member.');if(record.members.length>=MAX_MEMBERS)throw new HttpError(409,'Member limit reached.');record.members.push({id:user.hostId,email:email(user.email),role:invitation.role,joinedAt:time,accountGeneration:0});invitation.usedAt=time;invitation.usedBy=user.hostId;return {body:record,value:{workspace:summary(record,invitation.role)}};},life);
 await finishIndex(env,user.hostId,id,reservation,false,life);return accepted;
}
async function revokeInvitationImpl(env,user,id,data,life){companyId(id);return update(store(env,id),(record)=>{const member=actor(record,user,['owner','admin']),invitation=record.invitations.find(i=>i.id===data.id);if(!invitation)throw new HttpError(404,'Invitation not found.');if(invitation.role==='admin'&&member.role!=='owner')throw new HttpError(403,'Only the owner can change admin invitations.');invitation.revokedAt=Date.now();return {body:record,value:{revoked:true}};},life);}
async function changeMemberImpl(env,user,id,data,life){companyId(id);const change=(record)=>{const member=actor(record,user),target=record.members.find(m=>m.id===data.memberId);if(!target)throw new HttpError(404,'Member not found.');const leaving=data.action==='remove'&&target.id===member.id;if(!leaving&&!['owner','admin'].includes(member.role))throw new HttpError(403,'You do not have access to this workspace action.');if(data.action==='transfer'){
 if(member.role!=='owner')throw new HttpError(403,'Only the owner can transfer ownership.');if(target.id===member.id)throw new HttpError(400,'Choose another member.');member.role='admin';target.role='owner';
 }else if(data.action==='remove'){
 if(target.role==='owner')throw new HttpError(409,'Transfer ownership before removing the owner.');if(member.role!=='owner'&&target.role==='admin'&&!leaving)throw new HttpError(403,'Only the owner can remove an admin.');record.members=record.members.filter(m=>m.id!==target.id);
 }else if(data.action==='role'){
 if(!INVITE_ROLES.has(data.role))throw new HttpError(400,'Choose a member role.');if(target.role==='owner')throw new HttpError(409,'Transfer ownership to change the owner.');if(member.role!=='owner'&&(target.role==='admin'||data.role==='admin'))throw new HttpError(403,'Only the owner can grant or change admin access.');target.role=data.role;
 }else throw new HttpError(400,'Choose a member action.');const remaining=record.members.find(m=>m.id===user.hostId);return {body:record,value:{workspace:remaining?summary(record,remaining.role):null,left:!remaining,members:remaining?record.members.map(({id,email,role})=>({id,email,role})):[]}};};
 // Fence assignment in the booking coordination atom BEFORE membership changes.
 // A failed remote CAS may conservatively pause hosting until explicit reconnect.
 const before=await store(env,id).get();change(structuredClone(before));
 if(data.action==='remove'||data.action==='role'&&data.role==='viewer'){checkedHostResult(await life.write(()=>env.LIVE_HOSTS.getByName(id).fenceMemberCalendar(data.memberId)));}
 return update(store(env,id),change,life);
}
export function authorizeWorkspaceRoute(access,path,method){
 if(access.personal||access.role==='owner'||access.role==='admin')return;
 if(method==='GET'&&['/api/live/settings','/api/live/bookings','/api/live/analytics'].includes(path))return;
 if(method==='GET'&&/^\/api\/live\/bookings\/[-a-zA-Z0-9_]{16,80}$/.test(path))return;
 if(method==='POST'&&access.role==='member'&&/^\/api\/live\/bookings\/[-a-zA-Z0-9_]{16,80}\/decision$/.test(path))return;
 throw new HttpError(403,'An admin must manage this workspace setting.');
}
export function projectWorkspaceSettings(settings,access){
 if(access.personal||access.capabilities.manageSettings)return {...settings,...(!access.personal?{accounts:(settings.accounts??[]).map(account=>{if(!account.ownerMemberId)return account;const {memberSchedule,conflictCalendarIds,...safe}=account;return safe;})}:{}),hostId:access.hostId,workspace:access};
 const p=settings.profile||{};
 // A read-only Studio shell may show public link identity, never connected
 // calendar metadata, private availability policy or operational configuration.
 return {hostId:access.hostId,workspace:access,revision:settings.revision,profile:{name:p.name,company:p.company,avatarImage:p.avatarImage,bannerImage:p.bannerImage},accounts:[],meetingTypes:(settings.meetingTypes||[]).map(t=>({id:t.id,slug:t.slug,title:t.title,description:t.description,duration:t.duration,host:t.host,company:t.company,published:t.published,theme:t.theme,accent:t.accent,motion:t.motion}))};
}
export function projectWorkspaceBooking(detail,access){if(access.personal||detail?.error)return detail;const {managementToken,...safe}=detail;if(!access.capabilities.manageSettings&&safe.booking){const {cancellationReason,...booking}=safe.booking;safe.booking=booking;}return {...safe,...(access.capabilities.manageSettings?{hostActions:{manage:true}}:{})};}
export function projectWorkspaceBookingList(list,access){if(access.personal||access.capabilities.manageSettings||list?.error)return list;return {...list,bookings:(list.bookings??[]).map(({cancellationReason,...booking})=>booking)};}
export async function workspaceRoute(path,method,data,{env,user,selected,origin}){
 if(path==='/api/live/workspaces'){if(method==='GET')return workspaceList(env,user,selected);if(method==='POST')return createWorkspace(env,user,data);}
 if(path==='/api/live/workspace'&&method==='GET')return workspaceDetail(env,user,selected);
 if(path==='/api/live/workspace/invitations/inspect'&&method==='POST')return inspectInvitation(env,user,data.token);
 if(path==='/api/live/workspace/invitations/accept'&&method==='POST')return acceptInvitation(env,user,data.token);
 if(path==='/api/live/workspace/invitations'&&method==='POST')return inviteMember(env,user,selected,data,origin);
 if(path==='/api/live/workspace/invitations/revoke'&&method==='POST')return revokeInvitation(env,user,selected,data);
 if(path==='/api/live/workspace/members'&&method==='POST')return changeMember(env,user,selected,data);
 throw new HttpError(405,'Workspace operation not supported.');
}

async function withWorkspaceWrite(env,user,target,kind,work){
 const cleanup=async error=>error instanceof HttpError&&error.status<500;
 return withLifecycleAdmission(env,user.hostId,kind,actor=>target&&target!==user.hostId?withLifecycleAdmission(env,target,kind,company=>work({...actor,write:mutation=>actor.write(()=>company.write(mutation))}),{cleanup}):work(actor),{cleanup});
}
export const createWorkspace=(env,user,data)=>withWorkspaceWrite(env,user,null,'workspace_create',life=>createWorkspaceImpl(env,user,data,life));
export const inviteMember=(env,user,id,data,origin)=>withWorkspaceWrite(env,user,id,'workspace_invite',life=>inviteMemberImpl(env,user,id,data,origin,life));
export const acceptInvitation=(env,user,token)=>withWorkspaceWrite(env,user,parseToken(token),'workspace_accept',life=>acceptInvitationImpl(env,user,token,life));
export const revokeInvitation=(env,user,id,data)=>withWorkspaceWrite(env,user,id,'workspace_invite_revoke',life=>revokeInvitationImpl(env,user,id,data,life));
export const changeMember=(env,user,id,data)=>withWorkspaceWrite(env,user,id,'workspace_member',life=>{
 const grantsAuthority=data.action==='transfer'||data.action==='role'&&data.role==='admin';
 if(!grantsAuthority||data.memberId===user.hostId)return changeMemberImpl(env,user,id,data,life);
 return withLifecycleAdmission(env,data.memberId,'workspace_receive_authority',recipient=>changeMemberImpl(env,user,id,data,{...life,write:mutation=>life.write(()=>recipient.write(mutation))}),{cleanup:async error=>error instanceof HttpError&&error.status<500});
});


// Ownership reservation is reversible and separate from the company's permanent fence.
const ownershipReserved=()=>Object.assign(new HttpError(409,'Company ownership is reserved. Cancel the pending operation first.'),{code:'lifecycle_reserved'});
const ownershipChanged=()=>Object.assign(new HttpError(409,'Company ownership changed. Prepare it again.'),{code:'lifecycle_reservation_changed'});
const authority=record=>JSON.stringify({id:record?.id,members:(record?.members??[]).map(({id,role,joinedAt,accountGeneration})=>({id,role,joinedAt,accountGeneration})),invitations:record?.invitations??[]});
function assertOwnershipMutation(current,next){if(current?.lifecycleReservation&&authority(current)!==authority(next))throw ownershipReserved();if(current?.lifecycleReservation&&JSON.stringify(current.lifecycleReservation)!==JSON.stringify(next.lifecycleReservation))throw ownershipReserved();}
const sameOwnership=(lock,data)=>['operationId','nonce','manifestHash','actorId','actorGeneration','expectedGeneration','notAfter'].every(k=>lock[k]===data[k]);
export function reserveWorkspaceOwnershipSync(target,id,data){
 const current=target.get();if(!current||current.id!==id||!ID.test(id)||data.coordinatorId!==id||!Number.isSafeInteger(data.revision)||data.revision<1||!Number.isSafeInteger(data.notAfter)||Date.now()>=data.notAfter||data.actorGeneration!==0||data.expectedGeneration!==0)throw ownershipChanged();
 if(current.lifecycleReservation){if(!sameOwnership(current.lifecycleReservation,data)||current.lifecycleReservation.revision!==data.revision)throw ownershipChanged();return structuredClone(current.lifecycleReservation);}
 if(current.version!==data.revision||current.members.find(m=>m.id===data.actorId)?.role!=='owner')throw ownershipChanged();
 const lock={coordinatorId:id,operationId:data.operationId,nonce:data.nonce,manifestHash:data.manifestHash,actorId:data.actorId,actorGeneration:data.actorGeneration,expectedGeneration:data.expectedGeneration,notAfter:data.notAfter,revision:data.revision,proofNonce:randomToken(24)};
 const next={...current,version:current.version+1,lifecycleReservation:lock};target.put(next,Number.MAX_SAFE_INTEGER-Date.now());return structuredClone(lock);
}
export function releaseWorkspaceOwnershipSync(target,id,data){
 const current=target.get();if(!current?.lifecycleReservation)return {released:true};const lock=current.lifecycleReservation;
 if(current.id!==id||!sameOwnership(lock,data)||lock.proofNonce!==data.proofNonce)throw ownershipChanged();
 const next={...current,version:current.version+1};delete next.lifecycleReservation;target.put(next,Number.MAX_SAFE_INTEGER-Date.now());return {released:true};
}
const checkedOwnership=value=>{if(value?.error)throw Object.assign(new HttpError(value.status||503,value.error),{code:value.code});return value;};
export async function reserveWorkspaceOwnership(env,user,id,data){
 companyId(id);if(data.actorId!==user.hostId||data.coordinatorId!==id)throw ownershipChanged();
 await assertLifecycleActive(env,user.hostId,recordGeneration(data.actorGeneration));
 const state=await readLifecycleReservation(env,id,data),r=state.reservation;
 if(state.state!=='active'||!r||r.status!=='reserving'||!sameOwnership(r,data)||!r.targets.some(t=>t.kind==='ownership'&&t.id===id&&t.revision===data.revision))throw ownershipChanged();
 const proof=checkedOwnership(await store(env,id).workspaceOwnershipReserve(id,data));
 await registerLifecycleProof(env,id,{operationId:data.operationId,nonce:data.nonce,manifestHash:data.manifestHash,kind:'ownership',id,proofNonce:proof.proofNonce,revision:proof.revision,notAfter:proof.notAfter});return proof;
}
export async function releaseWorkspaceOwnership(env,id,data){
 companyId(id);const snapshot=await readLifecycleReservation(env,id,data),r=snapshot.reservation;
 if(!r||!sameOwnership(r,data)||!['cancelled','expired'].includes(r.status)||r.proofs?.['ownership:'+id]?.proofNonce&&r.proofs['ownership:'+id].proofNonce!==data.proofNonce)throw ownershipChanged();
 return checkedOwnership(await store(env,id).workspaceOwnershipRelease(id,data));
}
