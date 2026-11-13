import {test} from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {handleTracking} from '../src/tracking.js';
globalThis.crypto??=webcrypto;
const origin='https://booking.example',host='h_abcdefghijklmnopqrstuvwx',id='11223344-5566-4788-99aa-bbccddeeff00';
function setup(){
  const records=new Map();
  const env={PUBLIC_ORIGIN:origin,AUTH:{getByName(name){return {
    async get(){return structuredClone(records.get(name)??null);},
    async put(value){records.set(name,structuredClone(value));},
    async compareAndSwap(version,value){if((records.get(name)?.version??null)!==version)return false;records.set(name,structuredClone(value));return true;},
  };}}};
  return {env,records};
}
const auth=(owner=host,scope='booking:read email:tracking')=>({authenticateDevice:async()=>({hostId:owner,scope})});
const request=(path,body)=>new Request(origin+path,body===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
test('tracking registration is explicit, authenticated, owner scoped and idempotent',async()=>{
  const {env}=setup();
  assert.equal((await handleTracking(request('/api/device/tracking',{id}),env,auth(host,'booking:read'))).status,401);
  for(const body of [{id,subject:'private'},{id,recipients:['private@example.com']},{id:'../private'},{id,body:'private'}])assert.equal((await handleTracking(request('/api/device/tracking',body),env,auth())).status,400);
  const first=await (await handleTracking(request('/api/device/tracking',{id}),env,auth())).json();
  const second=await (await handleTracking(request('/api/device/tracking',{id}),env,auth())).json();
  assert.deepEqual(first,second);assert.match(first.pixelUrl,/^https:\/\/booking\.example\/api\/tracking\/pixel\/[A-Za-z0-9_-]{43}\.gif$/);
  const other=await (await handleTracking(request('/api/device/tracking?id='+id),env,auth('h_123456789012345678901234'))).json();assert.deepEqual(other.items,[]);
});
test('pixel records aggregate requests without recipient, IP, user agent or event log',async()=>{
  const {env,records}=setup();
  const registration=await (await handleTracking(request('/api/device/tracking',{id}),env,auth())).json();
  for(let i=0;i<3;i++){
    const result=await handleTracking(new Request(registration.pixelUrl,{headers:{'CF-Connecting-IP':'192.0.2.123','User-Agent':'private scanner'}}),env);
    assert.equal(result.status,200);assert.equal(result.headers.get('Content-Type'),'image/gif');assert.match(result.headers.get('Cache-Control'),/no-store/);assert.equal(result.headers.get('Cloudflare-CDN-Cache-Control'),'no-store');
    assert.equal(new TextDecoder().decode((await result.arrayBuffer()).slice(0,6)),'GIF89a');
  }
  const activity=await (await handleTracking(request('/api/device/tracking?id='+id),env,auth())).json();
  assert.equal(activity.items[0].pixelRequests,3);assert(activity.items[0].firstRequestedAt<=activity.items[0].lastRequestedAt);
  assert(!JSON.stringify(activity).includes('capability'));assert(!JSON.stringify(activity).includes('pixelUrl'));
  const stored=JSON.stringify([...records.values()]);assert(!stored.includes('192.0.2.123'));assert(!stored.includes('private scanner'));
  const pixel=new URL(registration.pixelUrl).pathname;
  await handleTracking(new Request(origin+pixel,{method:'HEAD'}),env);
  assert.equal((await (await handleTracking(request('/api/device/tracking?id='+id),env,auth())).json()).items[0].pixelRequests,3);
});
test('unknown, expired and failed storage return the same uncacheable image',async()=>{
  const {env,records}=setup();
  const registration=await (await handleTracking(request('/api/device/tracking',{id}),env,auth())).json();
  for(const [name,value] of records)if(name.startsWith('mail-pixel:'))records.set(name,{...value,expiresAt:1});
  const expired=await handleTracking(new Request(registration.pixelUrl),env);
  const unknown=await handleTracking(request('/api/tracking/pixel/'+'a'.repeat(43)+'.gif'),env);
  const failed=await handleTracking(new Request(registration.pixelUrl),{...env,AUTH:{getByName(){throw Error('private failure');}}});
  assert.equal(expired.status,200);assert.equal(unknown.status,200);assert.equal(failed.status,200);
  assert.deepEqual(await expired.arrayBuffer(),await unknown.arrayBuffer());assert.deepEqual(await failed.arrayBuffer(),await (await handleTracking(request('/api/tracking/pixel/invalid.gif'),env)).arrayBuffer());
});
test('concurrent image requests atomically increase aggregate without lost updates',async()=>{
  const {env}=setup();const registration=await (await handleTracking(request('/api/device/tracking',{id}),env,auth())).json();
  await Promise.all(Array.from({length:6},()=>handleTracking(new Request(registration.pixelUrl),env)));
  assert.equal((await (await handleTracking(request('/api/device/tracking?id='+id),env,auth())).json()).items[0].pixelRequests,6);
});
test('expired history entries cannot permanently exhaust the per-host quota',async()=>{
  const {env,records}=setup();
  records.set('mail-tracking-index:'+host,{version:7,entries:Array.from({length:500},(_,n)=>({id:String(n),expiresAt:1}))});
  const registered=await handleTracking(request('/api/device/tracking',{id}),env,auth());
  assert.equal(registered.status,200);assert.equal(records.get('mail-tracking-index:'+host).entries.length,1);
});

test('history groups a minute by its first real request time, stays bounded and is detail-only',async()=>{
  const {env}=setup();const registration=await (await handleTracking(request('/api/device/tracking',{id}),env,auth())).json();
  const original=Date.now;let now=original();Date.now=()=>now;
  try {
    now=Math.floor(now/60000)*60000+12345;
    await handleTracking(new Request(registration.pixelUrl),env);
    now+=100;await handleTracking(new Request(registration.pixelUrl),env);
    let detail=(await (await handleTracking(request('/api/device/tracking?id='+id),env,auth())).json()).items[0];
    assert.deepEqual(detail.events,[{at:now-100,count:2}]);assert.equal(detail.timelineComplete,true);
    const summary=(await (await handleTracking(request('/api/device/tracking'),env,auth())).json()).items[0];
    assert.equal('events' in summary,false);assert.equal('timelineComplete' in summary,false);
    for(let n=0;n<100;n++){now+=60000;await handleTracking(new Request(registration.pixelUrl),env);}
    detail=(await (await handleTracking(request('/api/device/tracking?id='+id),env,auth())).json()).items[0];
    assert.equal(detail.pixelRequests,102);assert.equal(detail.events.length,100);assert.equal(detail.timelineComplete,false);
    assert.equal(detail.events.at(-1).at,now);
  } finally {Date.now=original;}
});

test('legacy aggregates never manufacture historical requests or claim complete history',async()=>{
  const {env,records}=setup();const registration=await (await handleTracking(request('/api/device/tracking',{id}),env,auth())).json();
  const key='mail-tracking:'+host+':'+id,legacy=records.get(key);delete legacy.events;delete legacy.timelineComplete;
  legacy.pixelRequests=7;legacy.firstRequestedAt=100;legacy.lastRequestedAt=200;records.set(key,legacy);
  let detail=(await (await handleTracking(request('/api/device/tracking?id='+id),env,auth())).json()).items[0];
  assert.deepEqual(detail.events,[]);assert.equal(detail.timelineComplete,false);
  await handleTracking(new Request(registration.pixelUrl),env);
  detail=(await (await handleTracking(request('/api/device/tracking?id='+id),env,auth())).json()).items[0];
  assert.equal(detail.pixelRequests,8);assert.equal(detail.events.length,1);assert.equal(detail.events[0].count,1);assert.equal(detail.timelineComplete,false);
});
