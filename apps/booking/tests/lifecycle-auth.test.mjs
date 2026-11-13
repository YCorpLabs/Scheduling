import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomToken,sha256} from '../src/crypto.js';
import {beginLifecycle,ackLifecycle,lifecycleSnapshot,assertLifecycleActive,withLifecycleAdmission,safeLifecycleStatus} from '../src/lifecycle.js';
import {handleDevice,authenticateDevice} from '../src/device.js';
import {handleTracking} from '../src/tracking.js';
import {createWorkspace,acceptInvitation,inviteMember,workspaceAccess} from '../src/workspaces.js';
const authUrl=new URL('../src/auth.js',import.meta.url),source=(await readFile(authUrl,'utf8')).replace("import { DurableObject } from 'cloudflare:workers';",'class DurableObject {}').replace("import { authorizationUrl, exchangeCode, getUserInfo } from './google.js';",`import {authorizationUrl} from '${new URL('../src/google.js',import.meta.url).href}';async function exchangeCode(){return {access_token:'fixture',refresh_token:'fixture-refresh',scope:'https://www.googleapis.com/auth/calendar.calendarlist.readonly https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.freebusy'};}async function getUserInfo(){return {sub:'calendar-b',email:'calendar@example.test',email_verified:true,name:'Fixture'};}`).replace(/from '(\.\.?\/[^']+)'/g,(_all,path)=>`from '${new URL(path,authUrl).href}'`);
const {session,storeBrowserSession,oauthStart,oauthCallback,revokeBrowserSession}=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
const origin='https://scheduler.example',host='h_'+'a'.repeat(24),target='h_'+'b'.repeat(24),trackingId='11223344-5566-4788-99aa-bbccddeeff00';
function fixture(){
 const records=new Map(),writes=[],hooks={},initializations=[],connections=[];
 const raw=name=>{const r=records.get(name);return r&&r.expiresAt>Date.now()?structuredClone(r):null;};
 const env={PUBLIC_ORIGIN:origin,GOOGLE_CLIENT_ID:'fixture',GOOGLE_CLIENT_SECRET:'fixture',AUTH:{getByName(name){return {
  async get(){await hooks.get?.(name);return raw(name)?.body??null;},async getWithExpiry(){await hooks.get?.(name);return raw(name);},
  async put(body,ttl){await hooks.put?.(name,body);records.set(name,{body:structuredClone(body),expiresAt:Date.now()+ttl});writes.push(name);},
  async compareAndSwap(version,body,ttl){await hooks.cas?.(name,body);if((raw(name)?.body?.version??null)!==version)return false;records.set(name,{body:structuredClone(body),expiresAt:Date.now()+ttl});writes.push(name);return true;},
  async take(){const value=raw(name)?.body??null;records.delete(name);return value;},async register(){await hooks.register?.();},async allow(){return true;}
 };}},LIVE_HOSTS:{getByName(id){return {async init(profile){await hooks.init?.(id);initializations.push(profile);return {};},async connectAccount(data){await hooks.connect?.();connections.push(data);return {};},async fenceMemberCalendar(){return 1;}};}}};
 const req=(path,body,cookie)=>new Request(origin+path,{method:body?'POST':'GET',headers:{Origin:origin,...(body?{'Content-Type':'application/json'}:{}),...(cookie?{Cookie:'email_booking_session='+cookie}:{})},...(body?{body:JSON.stringify(body)}:{})});
 const begin=(id=host,ledgerIds=[])=>beginLifecycle(env,id,{operationId:'operation-lifecycle-test',expectedGeneration:0,ledgerIds});
 const add=async()=>{const token=randomToken();await storeBrowserSession(env,token,{hostId:host,email:'owner@example.test'});return token;};
 const device=(path,body)=>handleDevice(req('/api/device/'+path,body),env,{getSession:async()=>({hostId:host,email:'owner@example.test'})});
 const track=()=>handleTracking(req('/api/device/tracking',{id:trackingId}),env,{authenticateDevice:async()=>({hostId:host,scope:'email:tracking'})});
 return {env,records,hooks,writes,initializations,connections,req,begin,add,device,track};
}
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};

test('coordinator generations and all-ledger acknowledgements never claim purge or revocation',async()=>{
 const f=fixture();assert.equal((await lifecycleSnapshot(f.env,host)).generation,0);await assertLifecycleActive(f.env,host);
 const begun=await f.begin(host,[host,target]);assert.equal(begun.generation,1);assert.equal(begun.state,'fencing');await assert.rejects(assertLifecycleActive(f.env,host),e=>e.code==='lifecycle_fenced');
 assert.equal((await f.begin(host,[host,target])).generation,1);await assert.rejects(beginLifecycle(f.env,host,{operationId:'different-operation',expectedGeneration:0,ledgerIds:[]}),e=>e.code==='lifecycle_changed');
 await ackLifecycle(f.env,host,{operationId:begun.operationId,generation:1,ledgerId:host,epoch:2});assert.equal((await lifecycleSnapshot(f.env,host)).state,'fencing');
 await ackLifecycle(f.env,host,{operationId:begun.operationId,generation:1,ledgerId:target,epoch:3});const state=await lifecycleSnapshot(f.env,host);assert.equal(state.state,'fenced');assert.equal(safeLifecycleStatus(state).localDataDeleted,false);assert.equal(safeLifecycleStatus(state).providerRevocation,'not_requested');
 await assert.rejects(ackLifecycle(f.env,host,{operationId:begun.operationId,generation:0,ledgerId:target,epoch:3}));
});

test('pre-fence admissions must settle before fenced and stale work cannot commit a result',async()=>{
 const f=fixture(),entered=deferred(),release=deferred();const work=withLifecycleAdmission(f.env,host,'read_fixture',async()=>{entered.resolve();await release.promise;return 'old result';});await entered.promise;
 assert.equal((await f.begin()).state,'fencing');release.resolve();await assert.rejects(work,e=>e.code==='lifecycle_fenced');assert.equal((await lifecycleSnapshot(f.env,host)).state,'fenced');
});

test('more than50 pre-write failures and failures after acknowledged writes do not consume admission slots',async()=>{
 const f=fixture();for(let i=0;i<75;i++)await assert.rejects(withLifecycleAdmission(f.env,host,'read_failure',async()=>{throw Error('provider read failed');}));
 await assert.rejects(withLifecycleAdmission(f.env,host,'acknowledged_write',async({write})=>{await write(async()=>true);throw Error('later read failed');}));
 const state=await lifecycleSnapshot(f.env,host);assert.equal(state.state,'active');assert.deepEqual(state.admissions,{});assert.equal(await withLifecycleAdmission(f.env,host,'later_success',async()=>123),123);
});

test('genuinely unknown writes remain reviewable and elapsed time is never drain proof',async()=>{
 const f=fixture();await assert.rejects(withLifecycleAdmission(f.env,host,'unknown_write',async({write})=>{await write(async()=>{throw Error('transport outcome unknown');});}));
 assert.equal(Object.keys((await lifecycleSnapshot(f.env,host)).admissions).length,1);assert.equal((await f.begin()).state,'needs_review');const original=Date.now;try{Date.now=()=>original()+100*86400000;assert.equal((await lifecycleSnapshot(f.env,host)).state,'needs_review');}finally{Date.now=original;}
});

test('fenced browser credentials and unseen legacy cookies return unauthenticated without adoption',async()=>{
 const f=fixture(),token=await f.add();assert.equal((await session(f.req('/',null,token),f.env)).hostId,host);await f.begin();assert.equal(await session(f.req('/',null,token),f.env),null);
 const old=randomToken();await f.env.AUTH.getByName('session:'+await sha256(old)).put({hostId:host,email:'old@example.test'},60000);const before=f.records.get('browser-sessions:'+host).body.sessions.length;assert.equal(await session(f.req('/',null,old),f.env),null);assert.equal(f.records.get('browser-sessions:'+host).body.sessions.length,before);
});

test('legacy adoption racing a fence cannot restore usable authentication',async()=>{
 const f=fixture(),token=randomToken();await f.env.AUTH.getByName('session:'+await sha256(token)).put({hostId:host,email:'old@example.test'},60000);let fired=false;
 f.hooks.cas=async name=>{if(!fired&&name==='browser-sessions:'+host){fired=true;await f.begin();}};
 assert.equal(await session(f.req('/',null,token),f.env),null);assert.equal(await session(f.req('/',null,token),f.env),null);assert.equal((await lifecycleSnapshot(f.env,host)).state,'fenced');
});

test('late session credential write is generation-bound and never returns usable access',async()=>{
 const f=fixture(),token=randomToken();let fired=false;f.hooks.put=async name=>{if(!fired&&name.startsWith('session:')){fired=true;await f.begin();}};
 await assert.rejects(storeBrowserSession(f.env,token,{hostId:host,email:'owner@example.test'}),e=>e.code==='lifecycle_fenced');assert.equal(await session(f.req('/',null,token),f.env),null);
 const credential=f.records.get('session:'+await sha256(token)).body;assert.equal(credential.accountGeneration,0);const hash=await sha256(token);assert.ok(f.records.get('browser-sessions:'+host).body.sessions.some(s=>s.tokenHash===hash));
});

test('a stale initial OAuth callback cannot initialize a fenced or deleted identity',async()=>{
 const f=fixture(),id='h_'+(await sha256('google:calendar-b')).slice(0,24);const start=await oauthStart(f.req('/auth/google'),f.env),state=new URL(start.headers.get('Location')).searchParams.get('state'),binding=start.headers.get('Set-Cookie').split(';')[0];await f.begin(id);
 await assert.rejects(oauthCallback(new Request(origin+'/auth/google/callback?state='+state+'&code=fixture',{headers:{Cookie:binding}}),f.env),e=>e.code==='lifecycle_fenced');assert.equal(f.initializations.length,0);assert.equal(f.connections.length,0);assert.equal([...f.records.keys()].filter(k=>k.startsWith('session:')).length,0);
 const current=await lifecycleSnapshot(f.env,id);await f.env.AUTH.getByName('lifecycle:'+id).put({...current,state:'deleted'},Number.MAX_SAFE_INTEGER-Date.now());const again=await oauthStart(f.req('/auth/google'),f.env),againState=new URL(again.headers.get('Location')).searchParams.get('state'),againBinding=again.headers.get('Set-Cookie').split(';')[0];await assert.rejects(oauthCallback(new Request(origin+'/auth/google/callback?state='+againState+'&code=fixture',{headers:{Cookie:againBinding}}),f.env));assert.equal(f.initializations.length,0);
});

test('a callback already inside calendar storage cannot renew access after the fence',async()=>{
 const f=fixture(),token=await f.add(),start=await oauthStart(f.req('/auth/google?connect=1',null,token),f.env),state=new URL(start.headers.get('Location')).searchParams.get('state'),binding=start.headers.get('Set-Cookie').split(';')[0],entered=deferred(),release=deferred();f.hooks.connect=async()=>{entered.resolve();await release.promise;};
 const callback=oauthCallback(new Request(origin+'/auth/google/callback?state='+state+'&code=fixture',{headers:{Cookie:'email_booking_session='+token+'; '+binding}}),f.env);await entered.promise;await f.begin();release.resolve();await assert.rejects(callback,e=>e.code==='lifecycle_fenced');assert.equal(await session(f.req('/',null,token),f.env),null);assert.equal((await lifecycleSnapshot(f.env,host)).state,'needs_review');
});

test('approved desktop exchange and existing bearer are denied after fencing',async()=>{
 const f=fixture(),verifier=randomToken(),started=await (await f.device('start',{name:'Email',codeChallenge:await sha256(verifier)})).json();assert.equal((await f.device('approve',{userCode:started.userCode,approve:true})).status,204);
 await f.begin();assert.equal((await f.device('token',{deviceCode:started.deviceCode,codeVerifier:verifier})).status,403);assert.equal([...f.records.keys()].filter(k=>k.startsWith('desktop-token:')).length,0);
 const active=fixture(),v=randomToken(),link=await (await active.device('start',{name:'Email',codeChallenge:await sha256(v)})).json();await active.device('approve',{userCode:link.userCode,approve:true});const credential=await(await active.device('token',{deviceCode:link.deviceCode,codeVerifier:v})).json();const request=new Request(origin,{headers:{Authorization:'Bearer '+credential.accessToken}});assert.ok(await authenticateDevice(request,active.env));await active.begin();assert.equal(await authenticateDevice(request,active.env),null);
});

test('tracking reserves discovery before record creation and a fence suppresses pixel counting',async()=>{
 const f=fixture();let fired=false;f.hooks.cas=async name=>{if(!fired&&name.startsWith('mail-tracking:')){fired=true;assert.ok(f.records.get('mail-tracking-index:'+host).body.entries.some(e=>e.id===trackingId));await f.begin();}};
 assert.equal((await f.track()).status,403);assert.equal((await f.track()).status,401);assert.ok(f.records.get('mail-tracking-index:'+host).body.entries.some(e=>e.id===trackingId));assert.equal((await lifecycleSnapshot(f.env,host)).state,'fenced');
 const active=fixture(),registration=await(await active.track()).json();await handleTracking(new Request(registration.pixelUrl),active.env);const key='mail-tracking:'+host+':'+trackingId;assert.equal(active.records.get(key).body.pixelRequests,1);await active.begin();const image=await handleTracking(new Request(registration.pixelUrl),active.env);assert.equal(image.status,200);assert.equal(active.records.get(key).body.pixelRequests,1);
});

test('workspace pre-write validation failures do not leak admissions and fenced invitations cannot be accepted',async()=>{
 const f=fixture(),user={hostId:host,email:'owner@example.test'};for(let i=0;i<60;i++)await assert.rejects(createWorkspace(f.env,user,{name:''}));assert.deepEqual((await lifecycleSnapshot(f.env,host)).admissions,{});
 const made=await createWorkspace(f.env,user,{name:'Company'}),company=made.workspace.id,invite=await inviteMember(f.env,user,company,{email:'guest@example.test'},origin),token=decodeURIComponent(invite.url.split('#invite=')[1]);await f.begin(company);await assert.rejects(acceptInvitation(f.env,{hostId:target,email:'guest@example.test'},token));assert.equal(f.records.get('workspace:'+company).body.members.length,1);
});


test('a browser fenced during its identity read is unauthenticated rather than unavailable',async()=>{
 const f=fixture(),token=await f.add();await f.env.AUTH.getByName('identity:'+host).put({hostId:host,email:'owner@example.test',version:1,accountGeneration:0},60000);let once=true;
 f.hooks.get=async name=>{if(name==='identity:'+host&&once){once=false;await f.begin();}};
 assert.equal(await session(f.req('/api/live/settings',null,token),f.env),null);
});

test('a failed tracking creation never deletes a concurrent successful same-ID replay',async()=>{
 const f=fixture(),entered=deferred(),release=deferred();let calls=0;
 f.hooks.put=async name=>{if(name.startsWith('mail-pixel:')&&++calls===1){entered.resolve();await release.promise;throw Error('unknown transport');}};
 const first=f.track();await entered.promise;const second=await f.track();assert.equal(second.status,200);const result=await second.json();release.resolve();assert.equal((await first).status,503);
 const record=await f.env.AUTH.getByName('mail-tracking:'+host+':'+trackingId).get();assert.ok(record);assert.ok(await f.env.AUTH.getByName('mail-pixel:'+await sha256(record.capability)).get());assert.ok(result.pixelUrl.includes(record.capability));
});

test('automatic workspace identity repair remains accounted for while its write is suspended',async()=>{
 const f=fixture(),entered=deferred(),release=deferred();await f.env.AUTH.getByName('identity:'+host).put({hostId:host,email:'new@example.test',version:1,accountGeneration:0},60000);
 await f.env.AUTH.getByName('workspace:'+target).put({id:target,name:'Team',version:1,registryRegistered:true,members:[{id:host,email:'old@example.test',role:'owner',joinedAt:1,accountGeneration:0}]},60000);
 f.hooks.cas=async name=>{if(name==='workspace:'+target){entered.resolve();await release.promise;}};
 const repair=workspaceAccess(f.env,{hostId:host,email:'new@example.test'},target);await entered.promise;await f.begin(target);const state=await lifecycleSnapshot(f.env,target);
 assert.notEqual(state.state,'fenced');assert.ok(Object.keys(state.admissions).length>0);release.resolve();await assert.rejects(repair,e=>e.code==='lifecycle_fenced');
});


test('bounded uncertainty never permanently consumes active-account concurrency slots',async()=>{
 const f=fixture();for(let i=0;i<70;i++)await assert.rejects(withLifecycleAdmission(f.env,host,'unknown_fixture',async({write})=>write(async()=>{throw Error('transport unknown');})));
 const current=await lifecycleSnapshot(f.env,host);assert.equal(current.state,'active');assert.equal(Object.values(current.admissions).filter(a=>a.unknown).length,50);assert.equal(current.unknownOverflowCount,20);assert.equal(safeLifecycleStatus(current).needsReview,true);assert.equal(safeLifecycleStatus({...current,admissions:{}}).needsReview,true);assert.equal(safeLifecycleStatus({...current,admissions:{}}).unknownAuthWrites,20);
 assert.equal(await withLifecycleAdmission(f.env,host,'successful_fixture',async()=>42),42);const begun=await f.begin();assert.equal(begun.state,'needs_review');assert.equal(safeLifecycleStatus(begun).pendingAuthWrites,70);assert.equal(safeLifecycleStatus(begun).localDataDeleted,false);
});


test('failed finalization recovers concurrency only by retaining expired writes as unknown',async()=>{
 const f=fixture();f.hooks.cas=async(name,next)=>{if(name==='lifecycle:'+host){const current=f.records.get(name)?.body?.admissions??{};if(Object.keys(next.admissions).length<=Object.keys(current).length)throw Error('finalization unavailable');}};
 for(let i=0;i<50;i++)await assert.rejects(withLifecycleAdmission(f.env,host,'finalize_failure',async()=>1));f.hooks.cas=null;
 const stuck=await lifecycleSnapshot(f.env,host);assert.equal(Object.values(stuck.admissions).filter(a=>a.unknown).length,0);await assert.rejects(withLifecycleAdmission(f.env,host,'busy',async()=>1),e=>e.status===429);
 const original=Date.now;Date.now=()=>original()+6*60000;
 try{assert.equal(await withLifecycleAdmission(f.env,host,'recovered',async()=>42),42);const begun=await f.begin();assert.equal(begun.state,'needs_review');assert.equal(safeLifecycleStatus(begun).pendingAuthWrites,50);assert.equal(safeLifecycleStatus(begun).localDataDeleted,false);}finally{Date.now=original;}
});


test('browser revocation already in storage is drained before account cleanup may finish',async()=>{
 const f=fixture(),token=await f.add(),second=await f.add(),secondHash=await sha256(second),current=f.records.get('browser-sessions:'+host).body.sessions.find(s=>s.tokenHash===secondHash);
 const entered=deferred(),release=deferred();let once=true;f.hooks.cas=async name=>{if(name==='browser-sessions:'+host&&once){once=false;entered.resolve();await release.promise;}};
 const pending=revokeBrowserSession(f.req('/api/live/sessions/revoke',{id:current.id},token),f.env,{id:current.id});await entered.promise;assert.equal((await f.begin()).state,'fencing');release.resolve();assert.notEqual((await pending).status,200);assert.equal((await lifecycleSnapshot(f.env,host)).state,'fenced');
});

test('desktop revocation is a durable admission rather than a post-purge registry recreation',async()=>{
 const f=fixture(),verifier=randomToken(),link=await(await f.device('start',{name:'Desktop',codeChallenge:await sha256(verifier)})).json();await f.device('approve',{userCode:link.userCode,approve:true});await f.device('token',{deviceCode:link.deviceCode,codeVerifier:verifier});const id=f.records.get('desktop-sessions:'+host).body.sessions[0].id;
 const entered=deferred(),release=deferred();let once=true;f.hooks.cas=async name=>{if(name==='desktop-sessions:'+host&&once){once=false;entered.resolve();await release.promise;}};
 const pending=f.device('revoke',{sessionId:id});await entered.promise;assert.equal((await f.begin()).state,'fencing');release.resolve();assert.notEqual((await pending).status,204);assert.equal((await lifecycleSnapshot(f.env,host)).state,'fenced');
});

test('company administrator consent cannot restore a separately fenced Google credential owner',async()=>{
 const f=fixture(),token=await f.add(),credentialOwner='h_'+(await sha256('google:calendar-b')).slice(0,24);
 await f.env.AUTH.getByName('workspace:'+target).put({id:target,name:'Company',version:1,registryRegistered:true,members:[{id:host,email:'owner@example.test',role:'owner',joinedAt:1}]},60000);
 const start=await oauthStart(f.req('/auth/google?connect=1&workspace='+target,null,token),f.env),state=new URL(start.headers.get('Location')).searchParams.get('state'),binding=start.headers.get('Set-Cookie').split(';')[0];await f.begin(credentialOwner);
 await assert.rejects(oauthCallback(new Request(origin+'/auth/google/callback?state='+state+'&code=fixture',{headers:{Cookie:'email_booking_session='+token+'; '+binding}}),f.env),{code:'lifecycle_fenced'});assert.equal(f.connections.length,0);
});

test('company calendar write is admitted against its verified Google owner through acknowledgement',async()=>{
 const f=fixture(),token=await f.add(),credentialOwner='h_'+(await sha256('google:calendar-b')).slice(0,24);
 await f.env.AUTH.getByName('workspace:'+target).put({id:target,name:'Company',version:1,registryRegistered:true,members:[{id:host,email:'owner@example.test',role:'owner',joinedAt:1}]},60000);
 const start=await oauthStart(f.req('/auth/google?connect=1&workspace='+target,null,token),f.env),state=new URL(start.headers.get('Location')).searchParams.get('state'),binding=start.headers.get('Set-Cookie').split(';')[0],entered=deferred(),release=deferred();f.hooks.connect=async()=>{entered.resolve();await release.promise;};
 const pending=oauthCallback(new Request(origin+'/auth/google/callback?state='+state+'&code=fixture',{headers:{Cookie:'email_booking_session='+token+'; '+binding}}),f.env);await entered.promise;
 assert.ok(Object.keys((await lifecycleSnapshot(f.env,credentialOwner)).admissions).length>0);assert.notEqual((await f.begin(credentialOwner)).state,'fenced');release.resolve();await assert.rejects(pending,{code:'lifecycle_fenced'});assert.equal(f.connections[0].credentialOwnerId,credentialOwner);
});
