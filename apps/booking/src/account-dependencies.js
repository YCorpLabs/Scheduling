import {lifecycleSnapshot} from './lifecycle.js';
import {hostLifecycleImpact} from './host-lifecycle.js';
import {HttpError} from './http.js';
const HOST=/^h_[A-Za-z0-9_-]{24}$/;
const checked=value=>{if(value?.error)throw Object.assign(new HttpError(value.status||503,value.error),{code:value.code});return value;};
const busy=()=>Object.assign(new HttpError(409,'Account dependencies changed. Check them again.'),{code:'deletion_dependencies_changed'});
const email=value=>String(value??'').trim().toLowerCase();
export function memberDeletionImpact(ledger,memberId,address,{ownMutation=false}={}){
 if(!HOST.test(memberId))throw busy();
 const owned=ledger.accounts().filter(a=>a.ownerMemberId===memberId||a.credentialOwnerId===memberId),ids=new Set(owned.map(a=>a.id));
 const relevant=ledger.rows("SELECT body FROM live_bookings WHERE status IN ('pending','awaiting_approval','cancelling') OR (status='confirmed' AND end>?)",Date.now()).map(r=>JSON.parse(r.body)).filter(b=>(b.teamAssignment?.hosts??[{accountId:b.accountId}]).some(h=>ids.has(h.accountId)||h.ownerMemberId===memberId));
 const ambiguous=ledger.accounts().filter(a=>!a.ownerMemberId&&!a.credentialOwnerId&&a.grant&&email(a.email)===email(address));
 const impact=hostLifecycleImpact(ledger);
 return {accounts:owned.map(a=>({id:a.id,connected:!!a.grant||a.connected===true,connectionVersion:a.connectionVersion??0,preferenceVersion:a.preferenceVersion??0})),ambiguousGrants:ambiguous.length,futureBookings:relevant.length,busy:impact.blockers.activeMutations>(ownMutation?1:0)||impact.blockers.outboundCalls>0||impact.needsReview,revision:impact.revision};
}
export async function discoverAccountDependencies(env,user){
 const registry=env.AUTH.getByName('host-registry'),saved=await env.AUTH.getByName('workspace-index:'+user.hostId).get();
 const ids=new Set((saved?.ids??[]).filter(id=>HOST.test(id)));let after='',complete=false;
 for(let page=0;page<500;page++){const batch=await registry.list(after);if(!Array.isArray(batch)||batch.some(id=>!HOST.test(id)))throw busy();for(const id of batch)ids.add(id);if(batch.length<20){complete=true;break;}if(batch.at(-1)<=after)throw busy();after=batch.at(-1);}
 if(!complete)throw new HttpError(503,'Account discovery needs review.');
 const contributions=await env.AUTH.getByName('calendar-contributions:'+user.hostId).get();for(const c of contributions?.contributions??[])if(HOST.test(c.workspaceId))ids.add(c.workspaceId);
 const blockers=[],workspaces=[];
 for(const id of [...ids].sort()){
  if(id===user.hostId)continue;
  const record=await env.AUTH.getByName('workspace:'+id).get();
  const member=record?.members?.find(m=>m.id===user.hostId),invited=record?.invitations?.some(i=>email(i.email)===email(user.email)||i.usedBy===user.hostId);
  const state=checked(await env.LIVE_HOSTS.getByName(id).accountDeletionDependencies(user.hostId,user.email));
  if(!member&&!invited&&!state.accounts.length&&!state.ambiguousGrants)continue;
  const name=record?.name||'another booking profile';
  if(member?.role==='owner')blockers.push({code:'owned_workspace',label:`Transfer ownership of ${name} first.`,workspaceId:id});
  if(state.accounts.some(a=>a.connected))blockers.push({code:'shared_calendar',label:`Stop sharing your calendar with ${name} first.`,workspaceId:id});
  if(state.futureBookings)blockers.push({code:'workspace_bookings',label:`Resolve your upcoming or pending bookings in ${name} first.`,count:state.futureBookings,workspaceId:id});
  if(state.ambiguousGrants)blockers.push({code:'legacy_calendar',label:`Ask an administrator of ${name} to disconnect your older calendar connection first.`,workspaceId:id});
  if(state.busy)blockers.push({code:'workspace_work_pending',label:`Work is still running in ${name}. Try again shortly.`,workspaceId:id});
  workspaces.push({id,member:!!member,role:member?.role??null,accounts:state.accounts,revision:state.revision,authority:JSON.stringify({members:record?.members,invitations:record?.invitations})});
 }
 const manifest={workspaces,email:email(user.email)};
 return {blockers,manifest,digestInput:manifest};
}
export async function detachDeletedMemberCalendar(ledger,data){
 const {hostId,operationId,generation}=data??{};if(!HOST.test(hostId))throw busy();
 const state=await lifecycleSnapshot(ledger.env,hostId);if(state.operationId!==operationId||state.generation!==generation||state.state!=='fenced')throw busy();
 // The check and local erasure are synchronous: no other booking can appear
 // between checking dependency rows and dropping the disconnected grant data.
 const impact=memberDeletionImpact(ledger,hostId,data.email,{ownMutation:true});
 if(impact.accounts.some(a=>a.connected)||impact.futureBookings||impact.ambiguousGrants||impact.busy)return {done:false,needsReview:true,code:'member_dependencies_changed'};
 const ids=new Set(impact.accounts.map(a=>a.id));
 ledger.ctx.storage.transactionSync(()=>{
  for(const id of ids)ledger.sql.exec('DELETE FROM live_accounts WHERE id=?',id);
  const types=ledger.meta('meetingTypes')??[];
  if(types.some(t=>ids.has(t.accountId)||t.teamScheduling?.hosts.some(h=>ids.has(h.accountId))))ledger.putMeta('meetingTypes',types.map(t=>ids.has(t.accountId)||t.teamScheduling?.hosts.some(h=>ids.has(h.accountId))?{...t,published:false,...(t.teamScheduling?{teamScheduling:{...t.teamScheduling,hosts:t.teamScheduling.hosts.filter(h=>!ids.has(h.accountId))}}:{})}:t));
  ledger.sql.exec('DELETE FROM live_meta WHERE key=?','memberCalendarFence:'+hostId);
 });ledger.availabilityCache.clear();return {done:true};
}
export async function detachAccountDependencies(env,hostId,{operationId,generation,manifest}){
 const life=await lifecycleSnapshot(env,hostId);if(life.operationId!==operationId||life.generation!==generation||life.state!=='fenced')throw busy();
 for(const item of manifest.workspaces){
  const target=env.AUTH.getByName('workspace:'+item.id),first=await target.get();if(first?.members?.some(m=>m.id===hostId&&m.role==='owner'))return {done:false,needsReview:true,code:'owned_workspace'};
  const detached=checked(await env.LIVE_HOSTS.getByName(item.id).detachDeletedMember({hostId,operationId,generation,email:manifest.email}));if(!detached.done)return detached;
  let done=false;
  for(let attempt=0;attempt<12;attempt++){
   const current=await target.get();if(!current){done=true;break;}if(current.lifecycleReservation)return {done:false,needsReview:true,code:'workspace_reserved'};
   if(current.members?.some(m=>m.id===hostId&&m.role==='owner'))return {done:false,needsReview:true,code:'owned_workspace'};
   const next={...current,members:(current.members??[]).filter(m=>m.id!==hostId),invitations:(current.invitations??[]).filter(i=>i.usedBy!==hostId&&email(i.email)!==manifest.email),version:(current.version??0)+1};
   if(await target.compareAndSwap(current.version??null,next,Number.MAX_SAFE_INTEGER-Date.now())){done=true;break;}
  }
  if(!done)return {done:false,needsReview:true,code:'workspace_changed'};
 }
 return {done:true};
}
