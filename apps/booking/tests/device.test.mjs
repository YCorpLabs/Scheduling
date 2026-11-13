import test from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {handleDevice,authenticateDevice} from '../src/device.js';
import {sha256,randomToken} from '../src/crypto.js';
if(!globalThis.crypto)globalThis.crypto=webcrypto;
const ORIGIN='https://booking.example';
function setup(){
 const records=new Map(),limits=new Map();
 const env={PUBLIC_ORIGIN:ORIGIN,AUTH:{getByName(key){return {
  get(){const row=records.get(key);if(!row||row.expiresAt<=Date.now()){records.delete(key);return null;}return structuredClone(row.body);},
  put(body,ttl){records.set(key,{body:structuredClone(body),expiresAt:Date.now()+ttl});},
  compareAndSwap(version,body,ttl){const old=this.get();if((old?.version??null)!==version)return false;this.put(body,ttl);return true;},
  allow(max){const count=limits.get(key)||0;limits.set(key,count+1);return count<max;}
 };}}};
 const getSession=async request=>request.headers.get('Cookie')==='session=owner'?{hostId:'host-one',email:'owner@example.test'}:request.headers.get('Cookie')==='session=other'?{hostId:'host-other',email:'other@example.test'}:null;
 async function call(path,data,{cookie,origin=ORIGIN,token,method=data?'POST':'GET'}={}){const headers={};if(data)headers['Content-Type']='application/json';if(cookie)headers.Cookie='session='+cookie;if(origin)headers.Origin=origin;if(token)headers.Authorization='Bearer '+token;return handleDevice(new Request(ORIGIN+path,{method,headers,...(data?{body:JSON.stringify(data)}:{})}),env,{getSession});}
 async function begin(name='Email on my Mac'){const verifier=randomToken(),r=await call('/api/device/start',{name,codeChallenge:await sha256(verifier)});assert.equal(r.status,200);return {...await r.json(),verifier};}
 async function approve(link,cookie='owner'){return call('/api/device/approve',{userCode:link.userCode,approve:true},{cookie});}
 async function exchange(link){return call('/api/device/token',{deviceCode:link.deviceCode,codeVerifier:link.verifier});}
 return {env,records,limits,call,begin,approve,exchange};
}
test('desktop grant requires explicit authenticated browser approval and PKCE proof before one-time exchange',async()=>{
 const {env,records,call,begin,approve,exchange}=setup(),link=await begin('<svg> desktop');
 assert.equal(link.verificationUrl,ORIGIN+'/device#code='+link.userCode);assert.equal(new URL(link.verificationUrl).search,'');assert.equal(new URL(link.verificationUrl).hash,'#code='+link.userCode);assert.ok(!link.verificationUrl.includes(link.deviceCode));assert.ok(!link.verificationUrl.includes(link.verifier));assert.equal(link.expiresIn,600);assert.equal(link.interval,5);
 assert.equal((await approve(link,null)).status,401);
 assert.equal((await call('/api/device/approve',{userCode:link.userCode,approve:true},{cookie:'owner',origin:'https://evil.example'})).status,403);
 assert.equal((await call('/api/device/approve',{userCode:link.userCode},{cookie:'owner'})).status,400);
 assert.equal((await call('/api/device/token',{deviceCode:link.deviceCode,codeVerifier:randomToken()})).status,401);
 const inspected=await call('/api/device/inspect',{userCode:link.userCode},{cookie:'owner'});assert.deepEqual(await inspected.json(),{name:'<svg> desktop',accountEmail:'owner@example.test',expiresAt:[...records.values()].find(r=>r.body.challenge)?.body.expiresAt,scope:'booking:read email:tracking',tokenExpiresIn:2592000});
 assert.equal((await approve(link)).status,204);const tokenResponse=await exchange(link);assert.equal(tokenResponse.status,200);const credential=await tokenResponse.json();assert.equal(credential.scope,'booking:read email:tracking');assert.equal(credential.tokenType,'Bearer');assert.ok(credential.expiresAt>Date.now()+29*86400000);
 assert.equal((await exchange(link)).status,410);assert.equal((await approve(link)).status,404);
 const me=await call('/api/device/me',undefined,{token:credential.accessToken});assert.equal(me.status,200);assert.equal((await me.json()).hostId,'host-one');
 assert.equal((await authenticateDevice(new Request(ORIGIN,{headers:{Authorization:'Bearer '+credential.accessToken}}),env)).scope,'booking:read email:tracking');
 const persisted=JSON.stringify([...records]);for(const secret of [credential.accessToken,link.deviceCode,link.verifier])assert.ok(!persisted.includes(secret));
});
test('pending polling is bounded and expiry invalidates both approval and token exchange',async t=>{
 t.mock.timers.enable({apis:['Date'],now:Date.UTC(2026,10,12,12)});
 const {records,call,begin,approve,exchange}=setup(),link=await begin();assert.equal((await exchange(link)).status,428);assert.equal((await exchange(link)).status,429);
 for(const row of records.values())if(row.body.challenge||row.body.deviceHash)row.expiresAt=Date.now()-1;
 assert.equal((await approve(link)).status,404);assert.equal((await exchange(link)).status,410);
 for(let n=0;n<9;n++)await begin();assert.equal((await call('/api/device/start',{name:'Extra',codeChallenge:await sha256(randomToken())})).status,429);
});
test('concurrent exchanges yield exactly one bearer credential',async()=>{
 const {begin,approve,exchange}=setup(),link=await begin();await approve(link);const results=await Promise.all([exchange(link),exchange(link)]);assert.equal(results.filter(r=>r.status===200).length,1);assert.ok(results.some(r=>r.status===409||r.status===410));
});
test('host-scoped registry allows browser and native revocation without exposing hashes or bearer secrets',async()=>{
 const {records,call,begin,approve,exchange}=setup(),link=await begin();await approve(link);const credential=await(await exchange(link)).json();
 const sessions=await(await call('/api/device/sessions',undefined,{cookie:'owner'})).json();assert.equal(sessions.sessions.length,1);assert.deepEqual(Object.keys(sessions.sessions[0]).sort(),['createdAt','expiresAt','id','name','scope']);
 assert.deepEqual(await(await call('/api/device/sessions',undefined,{cookie:'other'})).json(),{sessions:[]});
 await call('/api/device/revoke',{sessionId:sessions.sessions[0].id},{cookie:'other'});assert.equal((await call('/api/device/me',undefined,{token:credential.accessToken})).status,200);
 assert.equal((await call('/api/device/revoke',{sessionId:sessions.sessions[0].id},{cookie:'owner'})).status,204);assert.equal((await call('/api/device/me',undefined,{token:credential.accessToken})).status,401);
 const second=await begin();await approve(second);const next=await(await exchange(second)).json();assert.equal((await call('/api/device/token',undefined,{token:next.accessToken,method:'DELETE',origin:null})).status,204);assert.equal((await call('/api/device/me',undefined,{token:next.accessToken})).status,401);
 const third=await begin();await approve(third);const expired=await(await exchange(third)).json();for(const row of records.values())if(row.body.scope)row.body.expiresAt=Date.now()-1;assert.equal((await call('/api/device/me',undefined,{token:expired.accessToken})).status,401);
});
test('approval page has restrictive CSP and consumes only the user-code fragment before inspection',async()=>{
 const {call}=setup();const page=await call('/device');assert.equal(page.status,200);assert.match(page.headers.get('Content-Security-Policy'),/frame-ancestors 'none'/);const html=await page.text();assert.ok(html.includes('src="/device-ui.js"'));assert.ok(html.includes('Approve connection'));assert.ok(html.includes('No access to mailbox text or recipients'));assert.ok(!html.includes('grants read-only access'));assert.ok(!html.includes('onclick='));
 const script=await(await call('/device-ui.js')).text();assert.ok(script.includes('textContent=result.name'));assert.ok(!script.includes('innerHTML'));assert.ok(script.includes("new URLSearchParams(fragment.slice(1)).get('code')"));assert.ok(script.indexOf('history.replaceState')<script.indexOf("api('inspect'"));assert.ok(!script.includes('approve.click'));assert.ok(html.includes('Manage connected devices'));
});
test('competing owners cannot approve the same grant twice or change its host binding',async()=>{
 const {call,begin,approve,exchange}=setup(),link=await begin();const results=await Promise.all([approve(link,'owner'),approve(link,'other')]);
 assert.equal(results.filter(r=>r.status===204).length,1);assert.ok(results.some(r=>r.status===409||r.status===404));
 const winner=results[0].status===204?'host-one':'host-other';const issued=await(await exchange(link)).json();
 assert.equal((await(await call('/api/device/me',undefined,{token:issued.accessToken})).json()).hostId,winner);
 assert.equal((await approve(link,winner==='host-one'?'other':'owner')).status,404);
});
test('only an authenticated same-origin browser sees its account email and approval cannot silently switch it',async()=>{
 const {call,begin,exchange}=setup(),link=await begin();assert.equal((await call('/api/device/inspect',{userCode:link.userCode})).status,401);assert.equal((await call('/api/device/inspect',{userCode:link.userCode},{cookie:'owner',origin:'https://evil.example'})).status,403);
 const inspected=await(await call('/api/device/inspect',{userCode:link.userCode},{cookie:'owner'})).json();assert.equal(inspected.accountEmail,'owner@example.test');
 assert.equal((await call('/api/device/approve',{userCode:link.userCode,approve:true,accountEmail:inspected.accountEmail},{cookie:'other'})).status,409);
 assert.equal((await call('/api/device/approve',{userCode:link.userCode,approve:true,accountEmail:inspected.accountEmail},{cookie:'owner'})).status,204);const token=await(await exchange(link)).json();assert.ok(token.accessToken);
});
test('settings write access is a separate explicit browser approval and old grants remain read-only',async()=>{
 const {env,records,call,begin,approve,exchange}=setup(),old=await begin();await approve(old);const read=await(await exchange(old)).json();assert.equal(read.scope,'booking:read email:tracking');
 const verifier=randomToken(),start=await call('/api/device/start',{name:'MCP setup',codeChallenge:await sha256(verifier),settingsWrite:true}),link={...await start.json(),verifier};
 const inspected=await(await call('/api/device/inspect',{userCode:link.userCode},{cookie:'owner'})).json(),scope='booking:read email:tracking booking:settings';assert.equal(inspected.scope,scope);
 assert.equal((await approve(link)).status,400);assert.equal((await call('/api/device/approve',{userCode:link.userCode,approve:true,accountEmail:'owner@example.test',approvedScope:'booking:read email:tracking'},{cookie:'owner'})).status,400);
 assert.equal((await call('/api/device/approve',{userCode:link.userCode,approve:true,accountEmail:inspected.accountEmail,approvedScope:scope},{cookie:'owner'})).status,204);
 const write=await(await exchange(link)).json();assert.equal(write.scope,scope);assert.equal((await authenticateDevice(new Request(ORIGIN,{headers:{Authorization:'Bearer '+read.accessToken}}),env)).scope,'booking:read email:tracking');
 assert.equal((await authenticateDevice(new Request(ORIGIN,{headers:{Authorization:'Bearer '+write.accessToken}}),env)).scope,scope);
 const session=records.get('desktop-sessions:host-one').body.sessions.find(s=>s.scope===scope);delete session.scope;assert.equal(await authenticateDevice(new Request(ORIGIN,{headers:{Authorization:'Bearer '+write.accessToken}}),env),null);
});
test('unsupported permission requests cannot create a settings grant',async()=>{
 const {call}=setup();for(const options of [{settingsWrite:'true'},{scope:'booking:settings'},{scopes:['booking:settings']}])assert.equal((await call('/api/device/start',{name:'Client',codeChallenge:await sha256(randomToken()),...options})).status,400);
});
