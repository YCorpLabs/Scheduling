import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {webcrypto} from 'node:crypto';
import {sha256,randomToken} from '../src/crypto.js';
globalThis.crypto??=webcrypto;

// Exercise the real auth handlers and crypto. Only the Cloudflare base class is
// stubbed for Node; provider transports are imported unchanged and never called.
const authUrl=new URL('../src/auth.js',import.meta.url);
const source=(await readFile(authUrl,'utf8'))
  .replace("import { DurableObject } from 'cloudflare:workers';",'class DurableObject {}')
  .replace(/from '(\.\.?\/[^']+)'/g,(_all,path)=>`from '${new URL(path,authUrl).href}'`);
const {session,storeBrowserSession,browserSessions,revokeBrowserSession,revokeOtherBrowserSessions,signOut}=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
const ORIGIN='https://booking.example',DAY=86400000;
function setup({failCleanup=false,beforeCompare}={}){
  const records=new Map();let writes=0;
  const env={PUBLIC_ORIGIN:ORIGIN,AUTH:{getByName(name){return {
    getWithExpiry(){const row=records.get(name);if(!row||row.expiresAt<=Date.now()){records.delete(name);return null;}return structuredClone(row);},
    get(){return this.getWithExpiry()?.body??null;},
    put(body,ttl){records.set(name,{body:structuredClone(body),expiresAt:Date.now()+ttl});if(name.startsWith('browser-sessions:'))writes++;},
    async compareAndSwap(version,body,ttl){await beforeCompare?.(name);const old=this.get();if((old?.version??null)!==version)return false;this.put(body,ttl);return true;},
    take(){if(failCleanup&&name.startsWith('session:'))throw Error('private storage details');const old=this.get();records.delete(name);return old;},
  };}}};
  function request(token,{method='GET',origin=ORIGIN}={}){return new Request(ORIGIN+'/api/live/sessions',{method,headers:{...(token?{Cookie:'email_booking_session='+token}:{}),...(origin?{Origin:origin}:{})}});}
  async function add(host='host-a',email='owner@example.com'){const token=randomToken();await storeBrowserSession(env,token,{hostId:host,email});return token;}
  async function legacy(host='host-a',remaining=DAY){const token=randomToken(),hash=await sha256(token);env.AUTH.getByName('session:'+hash).put({hostId:host,email:host+'@example.com'},remaining);return token;}
  return {env,records,request,add,legacy,writes:()=>writes};
}
test('inventory exposes safe opaque IDs and timestamps for only the authenticated host',async()=>{
  const {env,request,add}=setup(),current=await add(),other=await add(),foreign=await add('host-b');
  const result=await browserSessions(request(current),env);assert.equal(result.status,200);assert.equal(result.headers.get('Cache-Control'),'no-store');
  const data=await result.json();assert.equal(data.sessions.length,2);assert.equal(data.sessions.filter(s=>s.current).length,1);
  const serialized=JSON.stringify(data);for(const token of [current,other,foreign]){assert(!serialized.includes(token));assert(!serialized.includes(await sha256(token)));}
  for(const item of data.sessions){assert.match(item.id,/^[A-Za-z0-9_-]{43}$/);assert(item.createdAt<=item.lastSeenAt);assert(item.expiresAt>item.lastSeenAt);assert.deepEqual(Object.keys(item).sort(),['createdAt','current','expiresAt','id','label','lastSeenAt']);}
  assert.equal(await session(request(data.sessions[0].id),env),null,'inventory IDs cannot authenticate as cookies');
  assert.equal((await browserSessions(request(),env)).status,401);
});
test('legacy cookies enroll lazily without extending expiry and cannot resurrect after revocation',async()=>{
  const {env,records,request,add,legacy}=setup({failCleanup:true}),owner=await add(),old=await legacy();
  const key='session:'+await sha256(old),originalExpiry=records.get(key).expiresAt;
  assert.equal((await session(request(old),env)).hostId,'host-a');assert.equal(records.get(key).expiresAt,originalExpiry);
  const inventory=await(await browserSessions(request(owner),env)).json(),id=inventory.sessions.find(s=>!s.current).id;
  const revoked=await revokeBrowserSession(request(owner,{method:'POST'}),env,{id});assert.equal(revoked.status,200);assert.deepEqual(await revoked.json(),{revoked:true,current:false});
  assert(records.has(key),'cleanup failure leaves a credential, so registry revocation must be sufficient');
  assert.deepEqual(await Promise.all(Array.from({length:6},()=>session(request(old),env))),Array(6).fill(null));
  assert.equal((await(await browserSessions(request(owner),env)).json()).sessions.length,1);
});
test('revoking others also rejects unseen legacy cookies, keeps current and allows later new sessions',async()=>{
  const {env,request,add,legacy}=setup(),current=await add(),known=await legacy(),unseen=await legacy(),foreign=await legacy('host-b');
  await session(request(known),env);
  const result=await revokeOtherBrowserSessions(request(current,{method:'POST'}),env,{});assert.equal(result.status,200);assert.equal((await result.json()).revokedCount,1);
  assert.equal(await session(request(known),env),null);assert.equal(await session(request(unseen),env),null);
  assert.equal((await session(request(current),env)).hostId,'host-a');assert.equal((await session(request(foreign),env)).hostId,'host-b');
  const later=await add();assert.equal((await session(request(later),env)).hostId,'host-a');
});
test('single and bulk revocation enforce origin, host isolation and explicit input',async()=>{
  const {env,records,request,add}=setup(),a=await add(),b=await add('host-b');
  const bid=(await(await browserSessions(request(b),env)).json()).sessions[0].id;
  for(const origin of ['https://evil.example',null]){
    assert.equal((await revokeBrowserSession(request(a,{method:'POST',origin}),env,{id:bid})).status,403);
    assert.equal((await revokeOtherBrowserSessions(request(a,{method:'POST',origin}),env,{})).status,403);
  }
  assert.equal((await revokeBrowserSession(request(a,{method:'POST'}),env,{id:bid})).status,404);
  assert.equal((await session(request(b),env)).hostId,'host-b');
  assert.equal((await revokeOtherBrowserSessions(request(a,{method:'POST'}),env,{hostId:'host-b'})).status,400);
  assert.equal((await revokeBrowserSession(request(a,{method:'POST'}),env,{id:bid,hostId:'host-b'})).status,400);
  assert.equal((await revokeBrowserSession(request(),env,{id:bid})).status,405);
  assert.equal((await revokeBrowserSession(request(null,{method:'POST'}),env,{id:bid})).status,401);
  env.AUTH.getByName('desktop-sessions:host-a').put({scope:'booking:settings',sentinel:'unchanged'},DAY);
  const untouched=structuredClone(records.get('desktop-sessions:host-a'));
  await revokeOtherBrowserSessions(request(a,{method:'POST'}),env,{});assert.deepEqual(records.get('desktop-sessions:host-a'),untouched);
});
test('revoking the current browser clears the cookie and immediately rejects that bearer',async()=>{
  const {env,request,add}=setup(),token=await add(),id=(await(await browserSessions(request(token),env)).json()).sessions[0].id;
  const result=await revokeBrowserSession(request(token,{method:'POST'}),env,{id});assert.deepEqual(await result.json(),{revoked:true,current:true});
  assert.match(result.headers.get('Set-Cookie'),/Max-Age=0/);assert.match(result.headers.get('Set-Cookie'),/HttpOnly/);assert.equal(await session(request(token),env),null);
});
test('concurrent registrations retain every admitted browser and active session count is bounded',async()=>{
  const {env,request,add}=setup();const tokens=await Promise.all(Array.from({length:6},()=>add()));
  assert.equal((await(await browserSessions(request(tokens[0]),env)).json()).sessions.length,6);
  for(let n=6;n<50;n++)await add();
  await assert.rejects(add(),error=>error.status===429);
  assert.equal((await(await browserSessions(request(tokens[0]),env)).json()).sessions.length,50);
});
test('last-seen updates are bounded and expiry removes old registry entries without keeping cookies alive',async()=>{
  const original=Date.now;let time=2*DAY;Date.now=()=>time;
  try{
    const {env,records,request,add,legacy,writes}=setup(),token=await add(),old=await legacy('host-a',1000);await session(request(old),env);
    const before=writes();await session(request(token),env);await session(request(token),env);assert.equal(writes(),before);
    time+=5*60000;await session(request(token),env);assert.equal(writes(),before+1);
    const inventory=await(await browserSessions(request(token),env)).json();assert.equal(inventory.sessions.length,1);assert.equal(inventory.sessions[0].lastSeenAt,time);
    assert.equal(records.get('browser-sessions:host-a').body.sessions.length,1);
    time+=7*DAY;assert.equal(await session(request(token),env),null);assert.equal(await session(request(old),env),null);
  }finally{Date.now=original;}
});
test('logout uses registry revocation while retaining normal cookie clearing',async()=>{
  const {env,request,add}=setup(),token=await add();const result=await signOut(request(token,{method:'POST'}),env);
  assert.equal(result.status,204);assert.match(result.headers.get('Set-Cookie'),/Max-Age=0/);assert.equal(await session(request(token),env),null);
});
test('concurrent revocation requests cannot use an already revoked caller to remove the retained browser',async()=>{
  for(const operation of ['single','others']){
    let enabled=false,count=0,release;const gate=new Promise(resolve=>release=resolve);
    const {env,request,add}=setup({beforeCompare:async()=>{if(enabled&&++count<=2){if(count===2)release();await gate;}}});
    const a=await add(),b=await add(),aid=(await(await browserSessions(request(a),env)).json()).sessions.find(s=>s.current).id,bid=(await(await browserSessions(request(b),env)).json()).sessions.find(s=>s.current).id;
    enabled=true;
    const responses=await Promise.all(operation==='others'?[revokeOtherBrowserSessions(request(a,{method:'POST'}),env,{}),revokeOtherBrowserSessions(request(b,{method:'POST'}),env,{})]:[revokeBrowserSession(request(a,{method:'POST'}),env,{id:bid}),revokeBrowserSession(request(b,{method:'POST'}),env,{id:aid})]);
    assert.deepEqual(responses.map(r=>r.status).sort(),[200,401]);
    assert.equal((await Promise.all([session(request(a),env),session(request(b),env)])).filter(Boolean).length,1);
  }
});
test('logout clears a legacy cookie even when the active registry is full or cleanup fails',async()=>{
  const {env,request,add,legacy}=setup();for(let n=0;n<50;n++)await add();const old=await legacy();
  const result=await signOut(request(old,{method:'POST'}),env);assert.equal(result.status,204);assert.match(result.headers.get('Set-Cookie'),/Max-Age=0/);assert.equal(await session(request(old),env),null);
  const failed=setup({failCleanup:true}),token=await failed.add();
  const failure=await signOut(failed.request(token,{method:'POST'}),failed.env);assert.equal(failure.status,503);assert.match(failure.headers.get('Set-Cookie'),/Max-Age=0/);assert.equal(await session(failed.request(token),failed.env),null);
  const failedLegacy=setup({failCleanup:true}),legacyToken=await failedLegacy.legacy();
  const legacyFailure=await signOut(failedLegacy.request(legacyToken,{method:'POST'}),failedLegacy.env);assert.equal(legacyFailure.status,503);assert.match(legacyFailure.headers.get('Set-Cookie'),/Max-Age=0/);assert.equal(await session(failedLegacy.request(legacyToken),failedLegacy.env),null,'a failed credential deletion cannot re-enroll a signed-out legacy cookie');
});
