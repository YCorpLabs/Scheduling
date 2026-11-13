import {indexAccountObject} from './account-cleanup.js';
import {recordGeneration,assertLifecycleActive,lifecycleActive,withLifecycleAdmission} from './lifecycle.js';
import {sha256,randomToken} from './crypto.js';
import {HttpError,readJson,response} from './http.js';

const TTL=90*86400000,MAX_EVENTS=100;
const idPattern=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const hostPattern=/^h_[A-Za-z0-9_-]{24}$/;
const GIF=Uint8Array.from(atob('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'),c=>c.charCodeAt(0));
const pixelHeaders={'Content-Type':'image/gif','Content-Length':String(GIF.length),'Cache-Control':'private, no-store, no-cache, must-revalidate, max-age=0','CDN-Cache-Control':'no-store','Cloudflare-CDN-Cache-Control':'no-store','Pragma':'no-cache','Expires':'0','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'};
const image=()=>new Response(GIF,{headers:pixelHeaders});
const recordName=(host,id)=>`mail-tracking:${host}:${id}`;
const summary=(record,detail=false)=>({id:record.id,pixelRequests:record.pixelRequests,firstRequestedAt:record.firstRequestedAt,lastRequestedAt:record.lastRequestedAt,expiresAt:record.expiresAt,...(detail?{events:record.events??[],timelineComplete:record.timelineComplete===true}: {})});
function recordRequest(record,time){
  const minute=Math.floor(time/60000)*60000,events=[...(record.events??[])];
  const last=events.at(-1);
  if(last&&Math.floor(last.at/60000)*60000===minute)events[events.length-1]={at:last.at,count:Math.min(Number.MAX_SAFE_INTEGER,last.count+1)};
  else events.push({at:time,count:1});
  return {events:events.slice(-MAX_EVENTS),timelineComplete:(record.timelineComplete===true||record.pixelRequests===0)&&events.length<=MAX_EVENTS};
}

async function indexRecord(env,host,id,expiresAt,generation,life){
  const store=env.AUTH.getByName('mail-tracking-index:'+host);
  for(let attempt=0;attempt<8;attempt++){
    const current=await store.get(),entries=(current?.entries??[]).filter(item=>item.expiresAt>Date.now());
    const existing=entries.find(item=>item.id===id);if(existing){if((recordGeneration(existing.accountGeneration))!==generation)throw new HttpError(409,'Tracking history belongs to another account generation.');return existing;}
    if(entries.length>=500)throw new HttpError(409,'The tracking history limit has been reached.');
    if(await life.write(()=>store.compareAndSwap(current?.version??null,{version:(current?.version??0)+1,entries:[...entries,{id,expiresAt,accountGeneration:generation}]},TTL)))return {id,expiresAt,accountGeneration:generation};
  }
  throw new HttpError(409,'Tracking history changed. Try again.');
}
async function create(env,host,id,origin){
 const name=recordName(host,id),store=env.AUTH.getByName(name);let record,pixelKey;
 // Indexed immutable records can be shared by concurrent same-ID replays; never tear them down on one request's failure.
 return withLifecycleAdmission(env,host,'tracking_create',async life=>{const {generation,assertActive,write}=life;
  record=await store.get();await assertActive();
  // Reserve authoritative discovery before any tracking record/capability write.
  const reservation=await indexRecord(env,host,id,record?.expiresAt??Date.now()+TTL,generation,life);await indexAccountObject(env,host,name,reservation.expiresAt,life);await assertActive();
  if(!record){const next={version:1,id,hostId:host,accountGeneration:generation,capability:randomToken(),expiresAt:reservation.expiresAt,pixelRequests:0,firstRequestedAt:null,lastRequestedAt:null,events:[],timelineComplete:true};
   if(await write(()=>store.compareAndSwap(null,next,Math.max(1,next.expiresAt-Date.now())))){record=next;}else record=await store.get();}
  if(!record||record.hostId!==host||(recordGeneration(record.accountGeneration))!==generation||record.expiresAt<=Date.now())throw new HttpError(410,'This tracking record has expired.');
  await assertActive();pixelKey='mail-pixel:'+await sha256(record.capability);
  await indexAccountObject(env,host,pixelKey,record.expiresAt,life);
  await write(()=>env.AUTH.getByName(pixelKey).put({name,hostId:host,accountGeneration:generation,expiresAt:record.expiresAt},record.expiresAt-Date.now()));
  return {id,hostId:host,pixelUrl:`${origin}/api/tracking/pixel/${record.capability}.gif`,expiresAt:record.expiresAt};
 },{cleanup:async error=>error instanceof HttpError&&error.status<500});
}
async function count(env,capability){
 const index=await env.AUTH.getByName('mail-pixel:'+await sha256(capability)).get();if(!index||index.expiresAt<=Date.now())return;
 const store=env.AUTH.getByName(index.name),first=await store.get();if(!first||!hostPattern.test(first.hostId)||first.expiresAt<=Date.now())return;
 const generation=recordGeneration(first.accountGeneration);if(!await lifecycleActive(env,first.hostId,generation))return;
 await withLifecycleAdmission(env,first.hostId,'tracking_count',async({assertActive,write})=>{
  for(let attempt=0;attempt<8;attempt++){const record=await store.get();if(!record||record.hostId!==first.hostId||(recordGeneration(record.accountGeneration))!==generation||record.expiresAt<=Date.now())return;
   await assertActive();const time=Date.now(),next={...record,...recordRequest(record,time),version:record.version+1,pixelRequests:Math.min(Number.MAX_SAFE_INTEGER,record.pixelRequests+1),firstRequestedAt:record.firstRequestedAt??time,lastRequestedAt:time};
   if(await write(()=>store.compareAndSwap(record.version,next,record.expiresAt-time)))return;
  }
 },{generation,cleanup:async error=>error instanceof HttpError&&error.status<500});
}
/** Application storage keeps counts and up to 100 minute-grouped timestamps only:
 * no IP, UA, recipient, subject or body. Requests may be proxies/scanners/reloads;
 * these counters are not proof a person read a message. Records expire in 90d.
 */
export async function handleTracking(request,env,{authenticateDevice}={}){
  const url=new URL(request.url),pixel=url.pathname.startsWith('/api/tracking/pixel/');
  if(pixel){
    // Unknown/expired capabilities and storage failures are indistinguishable.
    // Do not log requests: their path contains a private image capability.
    const match=/^\/api\/tracking\/pixel\/([A-Za-z0-9_-]{43})\.gif$/.exec(url.pathname);
    if(request.method==='GET'&&match&&url.origin===env.PUBLIC_ORIGIN){try{await count(env,match[1]);}catch{/* Image delivery never reveals storage state. */}}
    return request.method==='HEAD'?new Response(null,{headers:pixelHeaders}):image();
  }
  try{
    if(url.origin!==env.PUBLIC_ORIGIN)throw new HttpError(421,'Use the configured service address.');
    if(url.pathname!=='/api/device/tracking')throw new HttpError(404,'Not found.');
    const device=await authenticateDevice?.(request,env);
    if(!device||!hostPattern.test(device.hostId)||!device.scope?.split(' ').includes('email:tracking')||!await lifecycleActive(env,device.hostId,recordGeneration(device.accountGeneration)))throw new HttpError(401,'Reconnect Email and approve optional email tracking.');
    if(request.method==='POST'){
      const data=await readJson(request,200);
      if(Object.keys(data).length!==1||!idPattern.test(data.id))throw new HttpError(400,'An opaque tracking identifier is required.');
      return response(await create(env,device.hostId,data.id,url.origin));
    }
    if(request.method==='GET'){
      const id=url.searchParams.get('id');
      if(id!==null&&!idPattern.test(id))throw new HttpError(400,'Tracking identifier is not valid.');
      const ids=id?[id]:((await env.AUTH.getByName('mail-tracking-index:'+device.hostId).get())?.entries??[]).filter(item=>item.expiresAt>Date.now()).slice(-200).map(item=>item.id);
      const items=[];
      for(let offset=0;offset<ids.length;offset+=10){
        const records=await Promise.all(ids.slice(offset,offset+10).map(id=>env.AUTH.getByName(recordName(device.hostId,id)).get()));
        for(const record of records)if(record?.hostId===device.hostId&&(recordGeneration(record.accountGeneration))===(recordGeneration(device.accountGeneration))&&record.expiresAt>Date.now())items.push(summary(record,id!==null));
      }
      if(!await lifecycleActive(env,device.hostId,recordGeneration(device.accountGeneration)))throw new HttpError(401,'Reconnect Email and approve optional email tracking.');
      return response({hostId:device.hostId,items});
    }
    throw new HttpError(405,'Method not allowed.');
  }catch(error){return response({error:error instanceof HttpError?error.message:'Email activity is temporarily unavailable.'},error instanceof HttpError?error.status:503);}
}
