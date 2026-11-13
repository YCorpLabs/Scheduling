import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {webcrypto} from 'node:crypto';
import {randomToken,sha256} from '../src/crypto.js';
globalThis.crypto??=webcrypto;

// Run the real auth/session handlers; only the platform base class and Google
// transport are replaced. No network requests or external consent are involved.
const authUrl=new URL('../src/auth.js',import.meta.url);
const source=(await readFile(authUrl,'utf8'))
  .replace("import { DurableObject } from 'cloudflare:workers';",'class DurableObject {}')
  .replace("import { authorizationUrl, exchangeCode, getUserInfo } from './google.js';",`
    import {authorizationUrl} from '${new URL('../src/google.js',import.meta.url).href}';
    async function exchangeCode({code}) {return {access_token:code,refresh_token:'fixture-refresh',scope:'https://www.googleapis.com/auth/calendar.calendarlist.readonly https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.freebusy'};}
    async function getUserInfo(sub) {return {sub,email:sub+'@example.test',email_verified:true,name:'Fixture'};}
  `)
  .replace(/from '(\.\.?\/[^']+)'/g,(_all,path)=>`from '${new URL(path,authUrl).href}'`);
const {oauthStart,oauthCallback,storeBrowserSession,session,browserSessions,revokeBrowserSession,revokeOtherBrowserSessions,signOut}=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
const ORIGIN='https://scheduler.example';
function fixture({connect=async()=>{},register=async()=>{}}={}) {
  const records=new Map(),connections=[],initializations=[];
  const env={PUBLIC_ORIGIN:ORIGIN,GOOGLE_CLIENT_ID:'fixture',GOOGLE_CLIENT_SECRET:'fixture',
    AUTH:{getByName(name){return {
      getWithExpiry(){const value=records.get(name);return value&&value.expiresAt>Date.now()?structuredClone(value):null;},
      get(){return this.getWithExpiry()?.body??null;},
      put(body,ttl){records.set(name,{body:structuredClone(body),expiresAt:Date.now()+ttl});},
      compareAndSwap(version,body,ttl){if((this.get()?.version??null)!==version)return false;this.put(body,ttl);return true;},
      take(){const body=this.get();records.delete(name);return body;},
      register,
    };}},
    LIVE_HOSTS:{getByName(hostId){return {
      async init(profile){initializations.push({hostId,profile});},
      async connectAccount(account){connections.push({hostId,...account});await connect();},
    };}},
  };
  const request=(token,path='/api/live/sessions',method='GET')=>new Request(ORIGIN+path,{method,headers:{Origin:ORIGIN,...(token?{Cookie:'email_booking_session='+token}:{})}});
  async function add(){const token=randomToken();await storeBrowserSession(env,token,{hostId:'host-owner',email:'owner@example.test'});return token;}
  async function begin(token,{legacy=false}={}){
    const result=await oauthStart(request(token,'/auth/google'+(token?'?connect=1':'')),env),url=new URL(result.headers.get('Location'));
    const state=url.searchParams.get('state'),binding=result.headers.get('Set-Cookie').split(';')[0];
    if(legacy){const store=env.AUTH.getByName('oauth:'+await sha256(state)),saved=store.get();delete saved.flow;store.put(saved,600000);}
    return new Request(ORIGIN+'/auth/google/callback?state='+state+'&code=calendar-b',{headers:{Cookie:[token?'email_booking_session='+token:'',binding].filter(Boolean).join('; ')}});
  }
  const inventory=async token=>(await(await browserSessions(request(token),env)).json()).sessions;
  return {env,records,connections,initializations,request,add,begin,inventory};
}
function deferred(){let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};}
function loginCookie(response){return response.headers.getSetCookie().find(value=>value.startsWith('email_booking_session='));}

for(const legacy of [false,true]) {
  test(`${legacy?'legacy':'current'} calendar connection preserves owner bearer, expiry and session inventory`,async()=>{
    const f=fixture(),token=await f.add(),key='session:'+await sha256(token),before=structuredClone(f.records.get(key));
    const result=await oauthCallback(await f.begin(token,{legacy}),f.env);
    assert.equal(result.status,303);assert.equal(loginCookie(result),undefined);
    assert.deepEqual(f.records.get(key),before);assert.equal((await f.inventory(token)).length,1);
    assert.deepEqual(await session(f.request(token),f.env),{hostId:'host-owner',email:'owner@example.test'});
    assert.equal(f.connections[0].hostId,'host-owner');assert.equal(f.connections[0].email,'calendar-b@example.test');assert.equal(f.initializations.length,0);
  });
  for(const action of ['revoke','revoke-others','logout']) {
    test(`${legacy?'legacy':'current'} callback cannot resurrect a session after ${action} during calendar connection`,async()=>{
      const entered=deferred(),release=deferred();
      const f=fixture({connect:async()=>{entered.resolve();await release.promise;}}),owner=await f.add(),other=await f.add();
      const before=await f.inventory(other),id=before.find(s=>!s.current).id;
      const pending=oauthCallback(await f.begin(owner,{legacy}),f.env);await entered.promise;
      let revoked;
      if(action==='revoke')revoked=await revokeBrowserSession(f.request(other,'/api/live/sessions','POST'),f.env,{id});
      else if(action==='revoke-others')revoked=await revokeOtherBrowserSessions(f.request(other,'/api/live/sessions','POST'),f.env,{});
      else revoked=await signOut(f.request(owner,'/auth/logout','POST'),f.env);
      assert.equal(revoked.status,action==='logout'?204:200);release.resolve();
      const result=await pending;
      assert.equal(loginCookie(result),undefined,'a calendar-only callback must never create or clear a browser credential');
      assert.equal(result.status,401);assert.equal(await session(f.request(owner),f.env),null);
      assert.deepEqual((await f.inventory(other)).map(s=>s.id),before.filter(s=>s.current).map(s=>s.id));
      const registry=f.records.get('browser-sessions:host-owner').body.sessions;
      assert.equal(registry.length,2,'revocation must not be escaped through a new registry entry');
    });
  }
  test(`${legacy?'legacy':'current'} initial Google sign-in still issues a new browser login`,async()=>{
    const f=fixture(),result=await oauthCallback(await f.begin(null,{legacy}),f.env);
    assert.equal(result.status,303);const cookie=loginCookie(result);assert.ok(cookie);assert.match(cookie,/HttpOnly/);
    const token=cookie.split(';')[0].split('=')[1],user=await session(f.request(token),f.env);
    assert.equal(user.email,'calendar-b@example.test');assert.equal(f.initializations.length,1);
    assert.equal(f.connections.length,legacy?1:0);
  });
}
test('revocation during registry registration also cannot renew the owner credential',async()=>{
  const entered=deferred(),release=deferred(),f=fixture({register:async()=>{entered.resolve();await release.promise;}}),token=await f.add();
  const pending=oauthCallback(await f.begin(token),f.env);await entered.promise;
  await signOut(f.request(token,'/auth/logout','POST'),f.env);release.resolve();
  const result=await pending;assert.equal(result.status,401);assert.equal(loginCookie(result),undefined);assert.equal(await session(f.request(token),f.env),null);
});

test('fresh OAuth writes canonical identity and cached browser snapshots never replace it',async()=>{
 const f=fixture(),response=await oauthCallback(await f.begin(null),f.env);assert.equal(response.status,303);const cookie=loginCookie(response).split(';')[0],token=cookie.split('=')[1],fresh=await session(f.request(token),f.env);const record=f.records.get('identity:'+fresh.hostId);assert.equal(record.body.email,fresh.email);
 const older=randomToken();await storeBrowserSession(f.env,older,{hostId:fresh.hostId,email:'former@example.test'});assert.equal((await session(f.request(older),f.env)).email,fresh.email);assert.equal(f.records.get('identity:'+fresh.hostId).body.version,record.body.version);
 f.records.set('identity:'+fresh.hostId,{body:{hostId:'wrong',email:'leak@example.test',version:1},expiresAt:Date.now()+60000});await assert.rejects(session(f.request(older),f.env),e=>e.status===503);
});
