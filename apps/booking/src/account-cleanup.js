import {lifecycleSnapshot} from './lifecycle.js';
import {sha256} from './crypto.js';
import {HttpError} from './http.js';

const HOST=/^h_[A-Za-z0-9_-]{24}$/,OBJECT=/^[a-f0-9]{64}$/,HASH=/^[A-Za-z0-9_-]{43}$/;
const forever=()=>Number.MAX_SAFE_INTEGER-Date.now();
const failed=(code='account_cleanup_changed')=>Object.assign(new HttpError(409,'Account cleanup needs another check.'),{code});
const fixedPrefixes=['identity:','browser-sessions:','desktop-sessions:','workspace-index:','calendar-contributions:','mail-tracking-index:','account-export-starts:'];
const accountIndex=(env,host)=>env.AUTH.getByName('account-cleanup-index:'+host);
const read=(env,name)=>env.AUTH.getByName(name).get();
const unique=values=>[...new Set(values)].sort();
const fixedNames=host=>fixedPrefixes.map(prefix=>prefix+host);
function permittedName(host,name){return fixedNames(host).includes(name)||/^(session|desktop-token|device-grant|device-user|oauth|account-export|mail-pixel):[A-Za-z0-9_-]{43}$/.test(name)||new RegExp('^mail-tracking:'+host+':[0-9a-f-]{36}$').test(name);}

/** Reserve discovery before a dynamic account-owned object write. The index is
 * retained until acknowledged deletion, even after its entries expire. */
export async function indexAccountObject(env,host,name,expiresAt,life){
 if(typeof host!=='string'||!/^[A-Za-z0-9_-]{1,100}$/.test(host)||!permittedName(host,name)||!Number.isSafeInteger(expiresAt)||expiresAt<1)throw failed();
 const target=accountIndex(env,host);
 for(let attempt=0;attempt<12;attempt++){
  const current=await target.get();let entries=current?.entries??[];
  if(!Array.isArray(entries)||entries.length>4096)throw failed('account_cleanup_capacity');
  // Never forget an expired reference before its target acknowledges physical
  // expiry cleanup. Atomic expiry checks cannot erase a concurrently renewed row.
  const removed=new Set();for(const entry of entries.filter(e=>e.expiresAt<=Date.now()).slice(0,50)){const object=env.AUTH.getByName(entry.name);if(typeof object.takeExpired==='function'&&await (life?.write?life.write(()=>object.takeExpired(Date.now())):object.takeExpired(Date.now())))removed.add(entry.name);}
  if(removed.size)entries=entries.filter(e=>!removed.has(e.name));
  const existing=entries.find(e=>e.name===name);if(existing&&existing.expiresAt>=expiresAt)return;
  if(!existing&&entries.length>=4096)throw new HttpError(429,'Account data is busy. Try again later.');
  const next={kind:'account-cleanup-index',hostId:host,version:(current?.version??0)+1,entries:[...entries.filter(e=>e.name!==name),{name,expiresAt}]};
  if(await (life?.write?life.write(()=>target.compareAndSwap(current?.version??null,next,forever())):target.compareAndSwap(current?.version??null,next,forever())))return;
 }
 throw failed();
}

/** Internal, service-binding-only inventory projection. Never returns bodies,
 * credentials, subjects, guest data or raw token values. Expired rows remain
 * visible so a scan cannot mistake logical expiry for physical erasure. */
export function inspectAccountObjectSync(store){
 const row=store.sql.exec('SELECT body,expires FROM state WHERE id=1').toArray()[0];
 const hasHostRegistry=store.sql.exec('SELECT COUNT(*) AS n FROM hosts').toArray()[0].n>0;
 if(!row)return {schema:1,hasState:false,owners:[],references:[],type:hasHostRegistry?'host-registry':'empty',protected:hasHostRegistry};
 let body;try{body=JSON.parse(row.body);}catch{return {schema:1,hasState:true,owners:[],references:[],type:'malformed',protected:true,expiresAt:row.expires};}
 const owners=new Set(),references=new Set();let workspaceId;const add=id=>{if(HOST.test(id??''))owners.add(id);};
 if(body.binding&&body.verifier&&(body.initiatorHostId||body.ownerMember?.id)){add(body.initiatorHostId||body.ownerMember?.id);}else for(const key of ['hostId','actor','initiatorHostId'])add(body[key]);
 if(typeof body.name==='string'){const match=/^mail-tracking:(h_[A-Za-z0-9_-]{24}):/.exec(body.name);if(match){add(match[1]);references.add(body.name);}}
 if(Array.isArray(body.sessions))for(const s of body.sessions)if(HASH.test(s.tokenHash??'')){references.add((typeof s.scope==='string'?'desktop-token:':'session:')+s.tokenHash);}
 if(HASH.test(body.deviceHash??''))references.add('device-grant:'+body.deviceHash);
 if(HASH.test(body.userCodeHash??''))references.add('device-user:'+body.userCodeHash);
 if(typeof body.capability==='string'&&HASH.test(body.capability)){
  // Hashing is asynchronous, so the inventory caller follows this immutable
  // record through a separate narrow reference RPC below.
 }
 let type='unknown',protectedValue=hasHostRegistry;
 const keys=Object.keys(body),only=allowed=>keys.every(k=>allowed.includes(k));
 if(body.kind==='lifecycle'||body.kind==='account-deletion'||body.reservationHistory||body.ledgerAcks){type='lifecycle';protectedValue=true;}
 else if(Array.isArray(body.members)&&HOST.test(body.id??'')){type='workspace';protectedValue=true;workspaceId=body.id;for(const member of body.members)add(member.id);}
 else if(body.kind==='account-export')type='account-export';
 else if(body.kind==='account-cleanup-index'){type='cleanup-index';protectedValue=true;for(const e of body.entries??[])if(typeof e.name==='string')references.add(e.name);}
 else if(body.kind==='account-cleanup-receipt'){type='cleanup-receipt';protectedValue=true;}
 else if(body.kind?.startsWith?.('account-cleanup-inventory')||body.schema===1&&typeof body.scanId==='string'&&(Array.isArray(body.objectIds)||Array.isArray(body.knownHostIds))){type='inventory';protectedValue=true;}
 else if(Array.isArray(body.sessions))type='credential-registry';
 else if(body.capability&&body.hostId)type='tracking';
 else if(body.binding&&body.verifier&&(owners.size>0||HASH.test(body.binding)&&HASH.test(body.verifier)&&body.hostId===null&&(body.flow==='identity'&&only(['binding','verifier','accountGeneration','targetGeneration','flow','hostId','returnTo'])||only(['binding','verifier','hostId']))))type='oauth';
 else if(body.challenge&&body.status&&(owners.size>0||body.status==='pending'&&only(['version','status','name','challenge','scope','expiresAt','nextPollAt','userCodeHash'])))type='device-grant';
 else if(only(['count'])&&Number.isSafeInteger(body.count)&&body.count>=0)type='anonymous-rate';
 else if(only(['after'])&&typeof body.after==='string'&&(body.after===''||HOST.test(body.after)))type='watchdog-cursor';
 else if(only(['epoch','frozen','reason','changedAt','version'])&&Number.isSafeInteger(body.epoch)&&typeof body.frozen==='boolean'&&Number.isSafeInteger(body.changedAt))type='operations-fence';
 else if(only(['deviceHash'])&&HASH.test(body.deviceHash??''))type='device-user';
 return {schema:1,hasState:true,owners:[...owners].sort(),references:[...references].sort(),type,protected:protectedValue,expiresAt:row.expires,...(type==='unknown'?{fieldNames:keys.map(k=>/^[A-Za-z_][A-Za-z0-9_]{0,40}$/.test(k)?k:'<nonstandard>').sort()}:{}),...(workspaceId?{workspaceId}:{})};
}
export async function accountObjectReferences(store){
 const row=store.sql.exec('SELECT body FROM state WHERE id=1').toArray()[0];if(!row)return [];
 let body;try{body=JSON.parse(row.body);}catch{return [];}
 return HOST.test(body.hostId??'')&&HASH.test(body.capability??'')?['mail-pixel:'+await sha256(body.capability)]:[];
}

export async function discoverAccountDeletion(env,hostId){
 if(!HOST.test(hostId??''))throw failed();
 const [index,browser,desktop,tracking,inventory,epoch]=await Promise.all([
  accountIndex(env,hostId).get(),read(env,'browser-sessions:'+hostId),read(env,'desktop-sessions:'+hostId),read(env,'mail-tracking-index:'+hostId),read(env,'account-cleanup-inventory:'+hostId),read(env,'account-cleanup-inventory-epoch')]);
 const names=new Set(fixedNames(hostId));
 for(const entry of index?.entries??[]){if(!permittedName(hostId,entry.name))throw failed();names.add(entry.name);}
 for(const entry of browser?.sessions??[])if(HASH.test(entry.tokenHash??''))names.add('session:'+entry.tokenHash);
 for(const entry of desktop?.sessions??[])if(HASH.test(entry.tokenHash??''))names.add('desktop-token:'+entry.tokenHash);
 for(const entry of tracking?.entries??[]){
  if(!/^[0-9a-f-]{36}$/.test(entry.id??''))continue;
  const name='mail-tracking:'+hostId+':'+entry.id;names.add(name);const record=await read(env,name);
  if(record?.hostId===hostId&&HASH.test(record.capability??''))names.add('mail-pixel:'+await sha256(record.capability));
 }
 const validEpoch=epoch?.schema===1&&epoch.complete===true&&typeof epoch.scanId==='string'&&Number.isSafeInteger(epoch.activatedAt)&&Number.isSafeInteger(epoch.completedAt)&&epoch.completedAt>=epoch.activatedAt;
 const fresh=validEpoch&&!inventory&&Array.isArray(epoch.knownHostIds)&&epoch.knownHostIds.every(id=>HOST.test(id))&&!epoch.knownHostIds.includes(hostId);
 const complete=validEpoch&&(fresh||inventory?.schema===1&&inventory.hostId===hostId&&inventory.complete===true&&inventory.scanId===epoch.scanId&&inventory.schemaActivatedAt===epoch.activatedAt&&Array.isArray(inventory.objectIds)&&inventory.objectIds.every(id=>OBJECT.test(id)));
 const manifest={schema:1,hostId,names:unique([...names]),objectIds:complete&&!fresh?unique(inventory.objectIds):[],inventory:complete?{scanId:epoch.scanId,activatedAt:epoch.activatedAt,...(fresh?{fresh:true}:{})}:null};
 return {manifest,digestInput:manifest,blockers:complete?[]:[{code:'legacy_inventory_required',label:'Account data inventory is being prepared.'}]};
}
async function assertPurge(env,hostId,data){
 const state=await lifecycleSnapshot(env,hostId);
 if(state.operationId!==data.operationId||state.generation!==data.generation||state.state!=='fenced'||!state.ledgerIds.every(id=>state.ledgerAcks[id])||Object.keys(state.admissions??{}).length||(state.unknownOverflowCount??0)>0)throw failed('account_cleanup_not_drained');
}
export async function purgeAccountData(env,hostId,data){
 await assertPurge(env,hostId,data);const manifest=data.manifest;
 if(manifest?.schema!==1||manifest.hostId!==hostId||!manifest.inventory||!Array.isArray(manifest.names)||!manifest.names.every(n=>permittedName(hostId,n))||!Array.isArray(manifest.objectIds)||!manifest.objectIds.every(id=>OBJECT.test(id)))return {done:false,needsReview:true,code:'legacy_inventory_required'};
 const digest=await sha256(JSON.stringify(manifest)),receiptStore=env.AUTH.getByName('account-cleanup-receipt:'+hostId);
 let receipt=await receiptStore.get();
 if(receipt&&(receipt.operationId!==data.operationId||receipt.generation!==data.generation||receipt.digest!==digest))return {done:false,needsReview:true,code:'account_cleanup_changed'};
 if(receipt?.stage==='done')return {done:true,needsReview:false};
 if(receipt?.stage!=='data_purged'){
  const epoch=await read(env,'account-cleanup-inventory-epoch'),inventory=await read(env,'account-cleanup-inventory:'+hostId);
  const fresh=manifest.inventory.fresh===true&&!inventory&&manifest.objectIds.length===0&&Array.isArray(epoch?.knownHostIds)&&epoch.knownHostIds.every(id=>HOST.test(id))&&!epoch.knownHostIds.includes(hostId);
  if(epoch?.complete!==true||epoch.scanId!==manifest.inventory.scanId||epoch.activatedAt!==manifest.inventory.activatedAt||!(fresh||inventory?.complete===true&&inventory.scanId===epoch.scanId&&inventory.schemaActivatedAt===epoch.activatedAt&&JSON.stringify(unique(inventory.objectIds??[]))===JSON.stringify(manifest.objectIds)))return {done:false,needsReview:true,code:'legacy_inventory_changed'};
  receipt??={kind:'account-cleanup-receipt',hostId,operationId:data.operationId,generation:data.generation,digest,stage:'purging',nextId:0,nextName:0};
  let remaining=50;
  while(receipt.nextId<manifest.objectIds.length&&remaining-->0){
   const id=manifest.objectIds[receipt.nextId],target=env.AUTH.get(env.AUTH.idFromString(id)),inspection=await target.accountCleanupInspect();
   if(inspection.protected)return {done:false,needsReview:true,code:'account_cleanup_protected'};
   if(inspection.owners?.some(owner=>owner!==hostId))return {done:false,needsReview:true,code:'account_cleanup_shared'};
   await target.take();receipt.nextId++;
  }
  while(receipt.nextId===manifest.objectIds.length&&receipt.nextName<manifest.names.length&&remaining-->0){await env.AUTH.getByName(manifest.names[receipt.nextName]).take();receipt.nextName++;}
  if(receipt.nextId===manifest.objectIds.length&&receipt.nextName===manifest.names.length)receipt.stage='data_purged';
  await receiptStore.put(receipt,forever());
  if(receipt.stage!=='data_purged')return {done:false,needsReview:false};
 }
 // Persist data_purged before deleting discovery. A crash after either take can
 // resume from this receipt without requiring a now-deleted inventory manifest.
 await assertPurge(env,hostId,data);
 await accountIndex(env,hostId).take();await env.AUTH.getByName('account-cleanup-inventory:'+hostId).take();
 await receiptStore.put({...receipt,stage:'done',nextId:undefined,nextName:undefined},forever());
 return {done:true,needsReview:false};
}
