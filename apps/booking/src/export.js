import {indexAccountObject} from './account-cleanup.js';
import {HttpError} from './http.js';
import {assertLifecycleActive,withLifecycleAdmission} from './lifecycle.js';
import {base64url,randomToken,sha256,timingSafeEqual} from './crypto.js';
import {LEDGER_EXPORT_SECTIONS} from './export-ledger.js';
const TTL=15*60000,ID=/^h_[A-Za-z0-9_-]{24}$/,encoder=new TextEncoder();
const fail=(status,message,code)=>Object.assign(new HttpError(status,message),code?{code}:{});
const changed=()=>fail(409,'Your data changed. Start the export again.','export_changed');
const expired=()=>fail(410,'This export expired. Start again.','export_expired');
const stable=value=>JSON.stringify(value??null);
// DO RPC lifecycle refusals are serialized results, not thrown custom error properties.
async function exportRpc(call){const value=await call();if(value?.error){if(value.status===403)throw fail(403,'This profile is unavailable.');if(value.status===409)throw changed();if(value.status===413)throw fail(413,'An export record is too large.');throw fail(503,'Your data could not be exported. Try again.');}if(!Number.isSafeInteger(value?.revision)||value.revision<0)throw fail(503,'Your data could not be exported. Try again.');return value;}
const pick=(v,keys)=>Object.fromEntries(keys.filter(k=>v?.[k]!==undefined&&(v[k]===null||['string','number','boolean'].includes(typeof v[k]))).map(k=>[k,v[k]]));
const decode=value=>Uint8Array.from(atob(value.replace(/-/g,'+').replace(/_/g,'/')),c=>c.charCodeAt(0));
async function signature(secret,value){const key=await crypto.subtle.importKey('raw',encoder.encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']);return base64url(await crypto.subtle.sign('HMAC',key,encoder.encode(value)));}
async function cursorFor(id,plan,position){const positionText=base64url(encoder.encode(JSON.stringify(position)));return id+'.'+positionText+'.'+await signature(plan.secret,id+'.'+positionText);}
function readBody(data){if(!data||typeof data!=='object'||Array.isArray(data)||Object.keys(data).some(k=>k!=='cursor')||data.cursor!==undefined&&(typeof data.cursor!=='string'||data.cursor.length>1000))throw fail(400,'Choose a valid export page.');return data.cursor;}
const readIndex=(env,key)=>env.AUTH.getByName(key).get();
function bounded(value,max){if(value==null)return [];if(!Array.isArray(value)||value.length>max)throw fail(413,'Export discovery exceeds the supported limit.');return value;}
async function company(env,user,target){
 if(!ID.test(target||'')||target===user.hostId)throw fail(400,'Choose a company profile to export.');
 const record=await readIndex(env,'workspace:'+target),member=record?.members?.find(m=>m.id===user.hostId);
 if(!member||!['owner','admin'].includes(member.role))throw fail(403,'An owner or admin must export this company profile.');
 return record;
}
async function authIndexes(env,user){const keys=['workspace-index:','calendar-contributions:','mail-tracking-index:'];return Object.fromEntries(await Promise.all(keys.map(async key=>[key,await readIndex(env,key+user.hostId)])));}
async function createPlan(env,user,scope,target){
 if(!await env.AUTH.getByName('account-export-starts:'+user.hostId).allow(5,60000))throw fail(429,'Wait a moment before starting another export.');
 const host=env.LIVE_HOSTS.getByName(target),first=await exportRpc(()=>host.exportPage({section:'check'})),now=Date.now();
 const record=scope==='workspace'?await company(env,user,target):null,indexes=scope==='account'?await authIndexes(env,user):null;
 const plan={kind:'account-export',version:1,secret:randomToken(),actor:user.hostId,target,scope,generatedAt:now,expiresAt:now+TTL,hostRevision:first.revision,workspaceVersion:record?.version??null,indexHash:indexes?await sha256(stable(indexes)):null,sources:{},manifest:{}};
 if(record)plan.manifest.members=(record.members??[]).map(m=>pick(m,['id','email','role','joinedAt']));
 if(indexes){
  plan.manifest.memberships=bounded(indexes['workspace-index:']?.ids,40).filter(id=>ID.test(id));
  plan.manifest.contributions=bounded(indexes['calendar-contributions:']?.contributions,200).filter(c=>ID.test(c.workspaceId)&&typeof c.accountId==='string').map(c=>pick(c,['workspaceId','accountId','email']));
  plan.manifest.tracking=bounded(indexes['mail-tracking-index:']?.entries,500).filter(e=>e.expiresAt>now&&typeof e.id==='string').map(e=>({id:e.id}));
 }
 const id=randomToken(),name='account-export:'+await sha256(id),store=env.AUTH.getByName(name);const remaining=plan.expiresAt-Date.now();if(remaining<=0)throw expired();await withLifecycleAdmission(env,user.hostId,'account_export_plan',async life=>{await indexAccountObject(env,user.hostId,name,plan.expiresAt,life);await life.write(()=>store.putExport(plan,Math.max(1,plan.expiresAt-Date.now())));},{generation:user.accountGeneration??0,cleanup:async error=>error instanceof HttpError&&error.status<500});return {id,plan,store};
}
async function loadPlan(env,user,scope,target,cursor){
 const m=/^([A-Za-z0-9_-]{43})\.([A-Za-z0-9_-]{1,700})\.([A-Za-z0-9_-]{43})$/.exec(cursor||'');if(!m)throw fail(400,'Choose a valid export page.');
 const store=env.AUTH.getByName('account-export:'+await sha256(m[1])),plan=await store.get();if(!plan||plan.expiresAt<=Date.now())throw expired();
 if(plan.actor!==user.hostId||plan.scope!==scope||plan.target!==target)throw fail(403,'This export belongs to another account or profile.');
 if(!await timingSafeEqual(m[3],await signature(plan.secret,m[1]+'.'+m[2])))throw fail(400,'Choose a valid export page.');
 let position;try{position=JSON.parse(new TextDecoder().decode(decode(m[2])));}catch{throw fail(400,'Choose a valid export page.');}
 return {id:m[1],plan,store,position};
}
async function bindSource(context,key,revision){
 for(let attempt=0;attempt<8;attempt++){
  const plan=await context.store.get();if(!plan||plan.expiresAt<=Date.now())throw expired();
  if(plan.sources[key]!==undefined){if(plan.sources[key]!==revision)throw changed();return;}
  const next={...plan,version:plan.version+1,sources:{...plan.sources,[key]:revision}};
  if(await context.store.compareAndSwap(plan.version,next,plan.expiresAt-Date.now()))return;
 }
 throw changed();
}
async function readBound(context,env,key){const value=await readIndex(env,key),revision=await sha256(stable(value));await bindSource(context,key,revision);const again=await readIndex(env,key);if(await sha256(stable(again))!==revision)throw changed();return value;}
function stages(scope){return [...LEDGER_EXPORT_SECTIONS,...(scope==='account'?['memberships','calendarContributions','emailTracking']:['members'])];}
async function page(env,user,scope,target,data){
 if(!user||!ID.test(user.hostId||''))throw fail(401,'Sign in to export your data.');
 await assertLifecycleActive(env,user.hostId,user.accountGeneration??0);
 if(scope==='workspace')await company(env,user,target);
 const cursor=readBody(data),context=cursor?await loadPlan(env,user,scope,target,cursor):await createPlan(env,user,scope,target),{id,plan}=context;
 const stageNames=stages(scope),position=context.position??{stage:0},stage=stageNames[position.stage];if(!stage)throw fail(400,'Choose a valid export page.');
 const host=env.LIVE_HOSTS.getByName(target);let section,nextPosition;
 if(LEDGER_EXPORT_SECTIONS.includes(stage)){
  const result=await exportRpc(()=>host.exportPage({section:stage,offset:position.offset??0,after:position.after??'',expectedRevision:plan.hostRevision,company:scope==='workspace'}));
  section={name:stage,data:result.data};nextPosition=result.next?{stage:position.stage,...result.next}:{stage:position.stage+1};
 }else if(stage==='members'){section={name:stage,data:plan.manifest.members};nextPosition={stage:position.stage+1};}
 else{
  const entries=plan.manifest[stage==='emailTracking'?'tracking':stage==='calendarContributions'?'contributions':'memberships'],offset=position.offset??0,items=[];
  for(const entry of entries.slice(offset,offset+5)){
   if(stage==='memberships'){
    const record=await readBound(context,env,'workspace:'+entry),member=record?.members?.find(m=>m.id===user.hostId);
    if(member)items.push({...pick(record,['id','name','createdAt']),...pick(member,['role','joinedAt'])});
   }else if(stage==='calendarContributions'){
    const owned=env.LIVE_HOSTS.getByName(entry.workspaceId),result=await exportRpc(()=>owned.exportContribution(user.hostId,entry.accountId));
    await bindSource(context,'contribution:'+entry.workspaceId,result.revision);await exportRpc(()=>owned.exportPage({section:'check',expectedRevision:result.revision}));
    if(result.data)items.push(result.data);
   }else{
    const record=await readBound(context,env,'mail-tracking:'+user.hostId+':'+entry.id);
    if(record?.hostId===user.hostId&&record.expiresAt>plan.generatedAt)items.push({...pick(record,['id','pixelRequests','firstRequestedAt','lastRequestedAt','expiresAt','timelineComplete']),events:(Array.isArray(record.events)?record.events:[]).slice(-100).map(e=>pick(e,['at','count']))});
   }
  }
  section={name:stage,data:items};nextPosition=offset+5<entries.length?{stage:position.stage,offset:offset+5}:{stage:position.stage+1};
 }
 const nextCursor=nextPosition.stage<stageNames.length?await cursorFor(id,plan,nextPosition):null;
 // Recheck source/authority after all cursor cryptography and awaited reads before returning a page.
 await exportRpc(()=>host.exportPage({section:'check',expectedRevision:plan.hostRevision}));
 if(scope==='workspace'){const current=await company(env,user,target);if(current.version!==plan.workspaceVersion)throw changed();}
 else if(await sha256(stable(await authIndexes(env,user)))!==plan.indexHash)throw changed();
 if(plan.expiresAt<=Date.now())throw expired();
 await assertLifecycleActive(env,user.hostId,user.accountGeneration??0);
 const result={schema:1,generatedAt:plan.generatedAt,scope,sections:[section],nextCursor};
 if(encoder.encode(JSON.stringify(result)).byteLength>262144)throw fail(413,'An export page is too large.');
 return result;
}
async function safePage(...args){try{return await page(...args);}catch(error){if(error instanceof HttpError||['export_changed','export_expired'].includes(error?.code))throw error;if(error?.status===413)throw fail(413,'An export record is too large.');throw fail(503,'Your data could not be exported. Try again.');}}
export const exportAccount=(env,user,data)=>safePage(env,user,'account',user?.hostId,data);
export const exportWorkspace=(env,user,selectedWorkspaceId,data)=>safePage(env,user,'workspace',selectedWorkspaceId,data);
