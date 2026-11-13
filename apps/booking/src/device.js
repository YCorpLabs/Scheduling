import {indexAccountObject} from './account-cleanup.js';
import {recordGeneration,assertLifecycleActive,lifecycleActive,withLifecycleAdmission} from './lifecycle.js';
import {randomToken,sha256,timingSafeEqual} from './crypto.js';
import {HttpError,readJson,response} from './http.js';
import {brandFromEnv,brandLabel,brandMark,escapeHTML} from '../public/brand.js';

const GRANT_MS=10*60_000,TOKEN_MS=30*86_400_000,POLL_MS=5_000,SCOPE='booking:read email:tracking';
const SETTINGS_SCOPE=SCOPE+' booking:settings';
const validScopes=new Set(['booking:read',SCOPE,SETTINGS_SCOPE]);
const grantScope=grant=>grant.scope??SCOPE;
const USER_ALPHABET='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const secureHeaders={'Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'"};
const userHash=code=>sha256(code.replace(/[\s-]/g,'').toUpperCase());
function userCode(){const bytes=crypto.getRandomValues(new Uint8Array(12));return Array.from(bytes,b=>USER_ALPHABET[b&31]).join('').match(/.{4}/g).join('-');}
function validCode(code){return typeof code==='string'&&/^[A-HJ-NP-Z2-9]{12}$/.test(code.replace(/[\s-]/g,'').toUpperCase());}
function origin(env){const value=new URL(env.PUBLIC_ORIGIN);if(value.origin!==env.PUBLIC_ORIGIN||(value.protocol!=='https:'&&!['localhost','127.0.0.1','[::1]'].includes(value.hostname)))throw new HttpError(503,'Desktop linking is not configured.');return value.origin;}
async function rate(request,env,kind,max){const bucket=Math.floor(Date.now()/60_000),ip=request.headers.get('CF-Connecting-IP')||'local';const key=await sha256(`${kind}:${bucket}:${ip}`);if(!await env.AUTH.getByName('device-rate:'+key).allow(max,60_000))throw new HttpError(429,'Too many linking requests. Try again shortly.');}
function requireOrigin(request,env){if(request.headers.get('Origin')!==origin(env))throw new HttpError(403,'Request not allowed.');}
async function browserUser(request,env,getSession){requireOrigin(request,env);const user=await getSession(request);if(!user?.hostId)throw new HttpError(401,'Sign in to approve a desktop.');await assertLifecycleActive(env,user.hostId,0);return user;}
function registry(env,hostId){return env.AUTH.getByName('desktop-sessions:'+hostId);}
async function updateRegistry(env,hostId,update,life){
  if(!life)return withLifecycleAdmission(env,hostId,'desktop_registry',context=>updateRegistry(env,hostId,update,context),{cleanup:async error=>error instanceof HttpError&&error.status<500});
  const store=registry(env,hostId);
  for(let attempt=0;attempt<5;attempt++){
    const current=await store.get(),sessions=(current?.sessions||[]).filter(s=>s.expiresAt>Date.now());
    const next=update(sessions);
    if(await(life?.write?life.write(()=>store.compareAndSwap(current?.version??null,{version:(current?.version??0)+1,sessions:next},TOKEN_MS)):store.compareAndSwap(current?.version??null,{version:(current?.version??0)+1,sessions:next},TOKEN_MS)))return next;
  }
  throw new HttpError(409,'Desktop sessions changed. Please retry.');
}
async function grantForUserCode(env,code){
  if(!validCode(code))throw new HttpError(404,'This linking code is not valid or has expired.');
  const codeHash=await userHash(code),index=await env.AUTH.getByName('device-user:'+codeHash).get();
  const store=index?.deviceHash?env.AUTH.getByName('device-grant:'+index.deviceHash):null,grant=store?await store.get():null;
  if(!grant||grant.expiresAt<=Date.now()||grant.status!=='pending')throw new HttpError(404,'This linking code is not valid or has expired.');
  return {store,grant,deviceHash:index.deviceHash,codeHash};
}
/** Only hashed bearer credentials are persisted. Every read checks the revocable host registry. */
export async function authenticateDevice(request,env){
  const match=/^Bearer ([A-Za-z0-9_-]{43})$/.exec(request.headers.get('Authorization')||'');if(!match)return null;
  const tokenHash=await sha256(match[1]),credential=await env.AUTH.getByName('desktop-token:'+tokenHash).get();
  if(!credential||!validScopes.has(credential.scope)||credential.expiresAt<=Date.now())return null;
  const generation=recordGeneration(credential.accountGeneration);if(!await lifecycleActive(env,credential.hostId,generation))return null;
  const state=await registry(env,credential.hostId).get();
  const session=state?.sessions?.find(s=>s.id===credential.id&&s.tokenHash===tokenHash&&s.expiresAt>Date.now()&&(s.scope===undefined||s.scope===credential.scope));
  if(credential.scope===SETTINGS_SCOPE&&session?.scope!==SETTINGS_SCOPE)return null;
  if(!session||(recordGeneration(session.accountGeneration))!==generation||!await lifecycleActive(env,credential.hostId,generation))return null;
  return session?{hostId:credential.hostId,name:session.name,scope:credential.scope,expiresAt:credential.expiresAt,sessionId:session.id}:null;
}
export async function handleDevice(request,env,{getSession=async()=>null}={}){
  try{
    const path=new URL(request.url).pathname,serviceOrigin=origin(env);
    if(new URL(request.url).origin!==serviceOrigin)throw new HttpError(421,'Use the configured booking address.');
    if(path==='/device'&&request.method==='GET')return new Response(devicePage(brandFromEnv(env)),{headers:{...secureHeaders,'Content-Type':'text/html; charset=utf-8'}});
    if(path==='/device-ui.js'&&request.method==='GET')return new Response(SCRIPT,{headers:{...secureHeaders,'Content-Type':'text/javascript; charset=utf-8'}});
    await rate(request,env,'all',90);
    if(path==='/api/device/start'&&request.method==='POST'){
      await rate(request,env,'start',10);const data=await readJson(request,2000);
      if(typeof data.name!=='string'||!data.name.trim()||data.name.length>80||/[\u0000-\u001f\u007f]/.test(data.name)||typeof data.codeChallenge!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(data.codeChallenge))throw new HttpError(400,'A desktop name and SHA-256 challenge are required.');
      if(data.settingsWrite!==undefined&&typeof data.settingsWrite!=='boolean')throw new HttpError(400,'Choose an explicit settings permission.');
      if(data.scope!==undefined||data.scopes!==undefined)throw new HttpError(400,'Use the supported settingsWrite permission option.');
      const scope=data.settingsWrite===true?SETTINGS_SCOPE:SCOPE;
      const deviceCode=randomToken(),deviceHash=await sha256(deviceCode),code=userCode(),expiresAt=Date.now()+GRANT_MS;
      const codeHash=await userHash(code),grantStore=env.AUTH.getByName('device-grant:'+deviceHash),userStore=env.AUTH.getByName('device-user:'+codeHash),grantBody={version:1,status:'pending',name:data.name.trim(),challenge:data.codeChallenge,scope,expiresAt,nextPollAt:0,userCodeHash:codeHash};
      await (grantStore.putEphemeral?grantStore.putEphemeral(grantBody,GRANT_MS):grantStore.put(grantBody,GRANT_MS));
      await (userStore.putEphemeral?userStore.putEphemeral({deviceHash},GRANT_MS):userStore.put({deviceHash},GRANT_MS));
      return response({deviceCode,userCode:code,verificationUrl:serviceOrigin+'/device#code='+encodeURIComponent(code),expiresIn:GRANT_MS/1000,interval:POLL_MS/1000});
    }
    if(path==='/api/device/inspect'&&request.method==='POST'){
      const user=await browserUser(request,env,getSession);const data=await readJson(request,1000),{grant}=await grantForUserCode(env,data.userCode);
      return response({name:grant.name,accountEmail:user.email,expiresAt:grant.expiresAt,scope:grantScope(grant),tokenExpiresIn:TOKEN_MS/1000});
    }
    if(path==='/api/device/approve'&&request.method==='POST'){
      const user=await browserUser(request,env,getSession),data=await readJson(request,1000);
      if(data.approve!==true)throw new HttpError(400,'Explicit approval is required.');
      if(data.accountEmail!==undefined&&data.accountEmail!==user.email)throw new HttpError(409,'Your signed-in account changed. Review this connection again.');
      const {store,grant,deviceHash,codeHash}=await grantForUserCode(env,data.userCode);
      if(grantScope(grant)===SETTINGS_SCOPE&&(data.approvedScope!==SETTINGS_SCOPE||data.accountEmail!==user.email))throw new HttpError(400,'Review and explicitly approve scheduling settings access.');
      if(data.approvedScope!==undefined&&data.approvedScope!==grantScope(grant))throw new HttpError(400,'Approve only the permissions shown in this connection.');
      return await withLifecycleAdmission(env,user.hostId,'device_approve',async life=>{const {write}=life;
        await indexAccountObject(env,user.hostId,'device-grant:'+deviceHash,grant.expiresAt,life);await indexAccountObject(env,user.hostId,'device-user:'+codeHash,grant.expiresAt,life);
        if(!await write(()=>store.compareAndSwap(grant.version,{...grant,version:grant.version+1,status:'approved',hostId:user.hostId,accountGeneration:0},grant.expiresAt-Date.now())))throw new HttpError(409,'Linking request changed. Please retry.');
        return new Response(null,{status:204,headers:secureHeaders});
      },{cleanup:async error=>{const current=await store.get();if(current?.status==='approved'&&current.hostId===user.hostId)await store.compareAndSwap(current.version,{...current,version:current.version+1,status:'revoked'},current.expiresAt-Date.now());return error instanceof HttpError&&error.status<500;}});
    }
    if(path==='/api/device/token'&&request.method==='POST'){
      const data=await readJson(request,2000);
      if(typeof data.deviceCode!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(data.deviceCode)||typeof data.codeVerifier!=='string'||!/^[A-Za-z0-9._~-]{43,128}$/.test(data.codeVerifier))throw new HttpError(400,'Invalid desktop exchange.');
      const store=env.AUTH.getByName('device-grant:'+await sha256(data.deviceCode)),grant=await store.get();
      if(!grant||grant.expiresAt<=Date.now()||grant.status==='consumed')throw new HttpError(410,'Desktop link expired or was already exchanged. Start again.');
      if(!await timingSafeEqual(await sha256(data.codeVerifier),grant.challenge))throw new HttpError(401,'Desktop verification failed.');
      if(grant.nextPollAt>Date.now())return response({error:'Wait before checking again.',interval:POLL_MS/1000},429);
      if(grant.status==='pending'){
        if(!await store.compareAndSwap(grant.version,{...grant,version:grant.version+1,nextPollAt:Date.now()+POLL_MS},grant.expiresAt-Date.now()))throw new HttpError(409,'Linking request changed. Please retry.');
        return response({error:'Approval is pending.',interval:POLL_MS/1000},428);
      }
      if(grant.status!=='approved'||!grant.hostId)throw new HttpError(410,'Desktop link expired. Start again.');
      const generation=recordGeneration(grant.accountGeneration);let issued;
      return await withLifecycleAdmission(env,grant.hostId,'device_exchange',async life=>{const {assertActive,write}=life;await assertActive();
      if(!await write(()=>store.compareAndSwap(grant.version,{...grant,version:grant.version+1,status:'consumed'},grant.expiresAt-Date.now())))throw new HttpError(409,'Desktop link was already exchanged.');
      const scope=grantScope(grant);if(!validScopes.has(scope))throw new HttpError(400,'Unsupported desktop permissions.');
      const accessToken=randomToken(),tokenHash=await sha256(accessToken),id=crypto.randomUUID(),expiresAt=Date.now()+TOKEN_MS;issued={tokenHash,id};
      await assertActive();await updateRegistry(env,grant.hostId,sessions=>{if(sessions.length>=20)throw new HttpError(409,'Revoke an existing desktop session before linking another.');return [...sessions,{id,name:grant.name,tokenHash,scope,accountGeneration:generation,createdAt:Date.now(),expiresAt}];},life);
      await indexAccountObject(env,grant.hostId,'desktop-token:'+tokenHash,expiresAt,life);
      await assertActive();await write(()=>env.AUTH.getByName('desktop-token:'+tokenHash).put({id,hostId:grant.hostId,scope,expiresAt,accountGeneration:generation},TOKEN_MS));
      return response({accessToken,tokenType:'Bearer',expiresAt,scope});
      },{generation,cleanup:async error=>{if(issued){await env.AUTH.getByName('desktop-token:'+issued.tokenHash).take();await updateRegistry(env,grant.hostId,sessions=>sessions.filter(s=>s.id!==issued.id));}return error instanceof HttpError&&error.status<500;}});
    }
    if(path==='/api/device/me'&&request.method==='GET'){
      const device=await authenticateDevice(request,env);if(!device)throw new HttpError(401,'Desktop session expired or was revoked.');return response(device);
    }
    if(path==='/api/device/token'&&request.method==='DELETE'){
      const device=await authenticateDevice(request,env);if(!device)throw new HttpError(401,'Desktop session expired or was revoked.');
      await updateRegistry(env,device.hostId,sessions=>sessions.filter(s=>s.id!==device.sessionId));return new Response(null,{status:204,headers:secureHeaders});
    }
    if(path==='/api/device/sessions'&&request.method==='GET'){
      const user=await getSession(request);if(!user?.hostId)throw new HttpError(401,'Sign in to manage desktop sessions.');
      const state=await registry(env,user.hostId).get();return response({sessions:(state?.sessions||[]).filter(s=>s.expiresAt>Date.now()).map(({tokenHash,accountGeneration,...session})=>session)});
    }
    if(path==='/api/device/revoke'&&request.method==='POST'){
      const user=await browserUser(request,env,getSession),data=await readJson(request,1000);
      if(typeof data.sessionId!=='string'||data.sessionId.length>80)throw new HttpError(400,'Choose a desktop session.');
      await updateRegistry(env,user.hostId,sessions=>sessions.filter(s=>s.id!==data.sessionId));return new Response(null,{status:204,headers:secureHeaders});
    }
    throw new HttpError(404,'Not found.');
  }catch(error){return response({error:error instanceof HttpError?error.message:'Desktop linking is temporarily unavailable.'},error instanceof HttpError?error.status:503);}
}
// The desktop client is named by the operator (DESKTOP_APP_NAME, else BRAND_NAME);
// unbranded instances say "your desktop app".
function devicePage(brand){
const app=brand.desktopAppName||'your desktop app',n={app:escapeHTML(app),yourApp:escapeHTML(brand.desktopAppName?`your ${brand.desktopAppName} app`:app),label:escapeHTML(brandLabel(brand)),mark:escapeHTML(brandMark(brand))};
return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Connect ${n.app}</title><script src="/device-ui.js" defer></script><style>
:root{color-scheme:light dark;--bg:#f7f8fa;--card:#fff;--ink:#242528;--muted:#777a83;--line:#e7e8ec;--soft:#f7f8fa;--button:#292a2e;--on-button:#fff}*{box-sizing:border-box}[hidden]{display:none!important}body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;padding:9vh 20px 32px}.shell{max-width:416px;margin:auto}.brand{display:flex;justify-content:center;align-items:center;gap:9px;font-size:15px;font-weight:600;margin-bottom:28px}.mark{display:grid;place-items:center;width:28px;height:28px;background:var(--ink);color:var(--card);border-radius:8px;font-size:20px;letter-spacing:-2px;padding-right:2px}.card{padding:32px;border:1px solid var(--line);border-radius:17px;background:var(--card);box-shadow:0 8px 32px #00000004}h1{font-size:25px;letter-spacing:-.7px;line-height:1.3;margin:0 0 8px;font-weight:600}h2{font-size:15px;line-height:1.4;font-weight:550;margin:0;overflow-wrap:anywhere}p{margin:0;color:var(--muted);font-size:13px}.device{display:flex;align-items:center;gap:14px;padding:18px 0 22px;margin:18px 0 20px;border-bottom:1px solid var(--line)}.device-icon{width:44px;height:44px;display:grid;place-items:center;border:1px solid var(--line);border-radius:10px;background:var(--soft);flex-shrink:0}.device small{font-size:11px;color:var(--muted);display:block;margin-top:3px}.account-email{font-size:12px;overflow-wrap:anywhere;margin-top:8px}.success .account-email{margin-bottom:14px}.summary{font-size:13px;color:var(--ink);line-height:1.7}.permissions{margin:14px 0 24px}.permissions summary{font-size:12px;cursor:pointer;color:var(--muted);list-style:none}.permissions summary:after{content:' +';padding-left:4px}.permissions[open] summary:after{content:' −'}.permissions ul{padding-left:17px;color:var(--muted);font-size:12px;line-height:1.8;margin-bottom:0}.permissions li+li{margin-top:6px}button,input,a{font:inherit}button{cursor:pointer;border:1px solid var(--line);border-radius:8px;padding:10px 14px;background:var(--card);color:var(--ink);font-size:13px;font-weight:500}button:disabled{opacity:.55;cursor:wait}.primary{display:block;background:var(--button);color:var(--on-button);border-color:var(--button);width:100%;text-align:center;text-decoration:none;min-height:42px;border-radius:8px;padding:10px}.primary:hover{opacity:.9}.safety{font-size:11px;text-align:center;line-height:1.7;margin-top:14px}.status{font-size:12px;line-height:1.7;color:var(--muted);margin-top:16px}.status:empty{display:none}.manual{margin-top:24px}label{font-size:12px;font-weight:500}input{display:block;width:100%;border:1px solid var(--line);background:var(--soft);color:var(--ink);border-radius:8px;margin:7px 0 14px;padding:11px 12px;letter-spacing:1px;text-transform:uppercase;font:18px ui-monospace,monospace}.text-button{border:0;padding:8px 0;font-size:12px;color:var(--muted)}.signin{margin-top:24px}.signin p{margin-bottom:18px}.signin .text-button{display:block;margin:10px auto 0}.success-icon{display:grid;place-items:center;width:42px;height:42px;margin:4px 0 20px;background:var(--soft);border:1px solid var(--line);border-radius:50%;font-size:22px}.success h1{font-size:25px}.success p{line-height:1.8}.management{margin-top:22px;text-align:center;color:var(--muted);font-size:11px}.management>summary{cursor:pointer;list-style:none}.management[open]{text-align:left;padding:20px;border:1px solid var(--line);border-radius:12px;background:var(--card)}.management[open]>summary{color:var(--ink);font-weight:500}.sessions{list-style:none;padding:0;margin:12px 0}.sessions li{padding:14px 0;border-bottom:1px solid var(--line)}.sessions span{display:block;overflow-wrap:anywhere;font-size:12px}.sessions small{font-size:10px}.sessions button{padding:4px 0;border:0;color:var(--muted);font-size:11px;margin-top:5px}a{color:inherit}button:focus-visible,input:focus-visible,a:focus-visible,summary:focus-visible{outline:2px solid var(--ink);outline-offset:3px}@media(prefers-color-scheme:dark){:root{--bg:#1b1c1f;--card:#232428;--ink:#eff0f3;--muted:#a0a3ae;--line:#383a41;--soft:#292b30;--button:#edeef2;--on-button:#25262a}}@media(max-width:480px){body{padding:32px 16px}.card{padding:26px}.brand{margin-bottom:24px}}
</style></head><body data-app="${n.app}" data-your-app="${n.yourApp}" data-label="${n.label}"><div class="shell"><div class="brand"><span class="mark" aria-hidden="true">${n.mark}</span>${n.label}</div><main class="card"><section id="connection"><h1>Connect ${n.app}</h1><p id="intro">Connect your desktop to your scheduling account.</p><form id="code-form" class="manual" hidden><label for="user-code">Desktop linking code</label><input id="user-code" maxlength="20" autocomplete="off" spellcheck="false" required placeholder="ABCD-EFGH-JKLM"><button class="primary">Continue</button></form><section id="review" hidden><p id="account-email" class="account-email"></p><div class="device"><span class="device-icon" aria-hidden="true"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.3"><rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8m-4-4v4"/></svg></span><div><h2 id="desktop-name"></h2><small>Access for 30 days</small></div></div><p id="access-summary" class="summary">Use your meeting links and optional email activity in ${n.app}.</p><details class="permissions"><summary>What you’re allowing</summary><ul><li>Read your meeting links, bookings, and aggregate analytics.</li><li>Create email-open tracking only when you turn it on for a message.</li><li id="settings-permission" hidden>Create, edit, publish, or remove meeting types and update your scheduling profile.</li><li>No access to mailbox text or recipients, Google credentials, or booking changes.</li><li>You can revoke this connection at any time.</li></ul></details><button id="approve" class="primary">Approve connection</button><p class="safety">Only continue if you started this in ${n.yourApp}.</p></section><section id="signin" class="signin" hidden><p>Sign in to choose the account to connect.</p><a class="primary" href="/auth/google?returnTo=device">Continue with Google</a><button id="signed-in" class="text-button">I’ve signed in</button></section><p id="status" class="status" role="status"></p><button id="retry" class="text-button" hidden>Try again</button><button id="different-code" class="text-button" hidden>Use a different code</button></section><section id="success" class="success" hidden><span class="success-icon" aria-hidden="true">✓</span><h1>You’re connected</h1><p id="success-account" class="account-email"></p><p>Return to ${n.app} to continue.<br>You can close this tab.</p></section></main><details id="devices" class="management"><summary>Manage connected devices</summary><ul id="sessions" class="sessions"></ul><p id="sessions-status" class="status" role="status"></p><button id="refresh" class="text-button">Refresh devices</button></details></div></body></html>`;
}
const SCRIPT=String.raw`(()=>{
 const byId=id=>document.getElementById(id),names=document.body.dataset;
 const fragment=location.hash;history.replaceState(null,'',location.pathname+location.search);
 const storageKey='email-device-pending';let expiryTimer;
 function forget(){clearTimeout(expiryTimer);try{sessionStorage.removeItem(storageKey);}catch{}}
 function remember(value,expiresAt){try{sessionStorage.setItem(storageKey,JSON.stringify({code:value,expiresAt}));}catch{}clearTimeout(expiryTimer);expiryTimer=setTimeout(()=>{forget();reviewedCode='';inspection++;byId('review').hidden=true;byId('signin').hidden=true;byId('retry').hidden=true;status('This connection expired. Start again in '+names.app+'.');},Math.max(0,Math.min(600000,expiresAt-Date.now())));}
 let saved;try{saved=JSON.parse(sessionStorage.getItem(storageKey)||'null');}catch{}
 if(!saved||saved.expiresAt<=Date.now()||typeof saved.code!=='string'){forget();saved=null;}
 const fragmentCode=new URLSearchParams(fragment.slice(1)).get('code');
 const code=fragmentCode??saved?.code??null;
 let pendingExpiresAt=fragmentCode!==null?Date.now()+600000:saved?.expiresAt??0;
 if(code!==null)remember(code,pendingExpiresAt);
 const fromFragment=code!==null;let requestedCode=code||'',reviewedCode='',accountEmail='',approvedScope='',inspection=0;
 async function api(path,data){const r=await fetch('/api/device/'+path,data?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)}:{});if(!r.ok){const value=await r.json();const error=Error(value.error);error.status=r.status;throw error;}return r.status===204?null:r.json();}
 function status(message){byId('status').textContent=message;}
 async function inspect(value){
   if(value===requestedCode&&pendingExpiresAt&&pendingExpiresAt<=Date.now()){forget();reviewedCode='';byId('review').hidden=true;byId('signin').hidden=true;byId('retry').hidden=true;status('This connection expired. Start again in '+names.app+'.');return;}
   const attempt=++inspection;requestedCode=value;pendingExpiresAt||=Date.now()+600000;remember(value,pendingExpiresAt);reviewedCode='';byId('review').hidden=true;byId('signin').hidden=true;byId('retry').hidden=true;byId('different-code').hidden=true;status('Checking your connection…');
   try{const result=await api('inspect',{userCode:value});if(attempt!==inspection)return;reviewedCode=value;pendingExpiresAt=Math.min(pendingExpiresAt||Date.now()+600000,result.expiresAt);remember(value,pendingExpiresAt);approvedScope=result.scope||'booking:read email:tracking';const settingsWrite=approvedScope.split(' ').includes('booking:settings');byId('settings-permission').hidden=!settingsWrite;byId('access-summary').textContent=settingsWrite?'Allow this device to manage your meeting settings, links, and scheduling profile.':'Use your meeting links and optional email activity in '+names.app+'.';byId('approve').textContent=settingsWrite?'Approve settings access':'Approve connection';accountEmail=typeof result.accountEmail==='string'?result.accountEmail:'';byId('account-email').textContent=accountEmail?'Connected as '+accountEmail:'';byId('success-account').textContent=accountEmail?'Connected as '+accountEmail:'';byId('desktop-name').textContent=result.name;byId('intro').textContent='Approve this connection to your account.';byId('code-form').hidden=true;byId('review').hidden=false;byId('different-code').hidden=fromFragment;status('');}
   catch(error){if(attempt!==inspection)return;if(error.status===401){byId('intro').textContent='One step before you connect.';byId('signin').hidden=false;status('');}else{if(error.status===404||error.status===410)forget();status(error.message);byId('retry').hidden=false;}}
 }
 byId('code-form').onsubmit=e=>{e.preventDefault();inspect(byId('user-code').value);};
 byId('user-code').oninput=()=>{inspection++;reviewedCode='';byId('review').hidden=true;byId('retry').hidden=true;};
 byId('different-code').onclick=()=>{forget();pendingExpiresAt=0;inspection++;reviewedCode='';byId('review').hidden=true;byId('different-code').hidden=true;byId('code-form').hidden=false;byId('intro').textContent='Enter the code shown in '+names.yourApp+'.';byId('user-code').focus();};
 byId('retry').onclick=()=>inspect(requestedCode);byId('signed-in').onclick=()=>inspect(requestedCode);
 byId('approve').onclick=async()=>{
   if(!reviewedCode)return;const value=reviewedCode;byId('approve').disabled=true;status('Connecting…');
   try{await api('approve',{userCode:value,approve:true,accountEmail,approvedScope});forget();reviewedCode='';byId('connection').hidden=true;byId('success').hidden=false;document.title='Connected · '+names.label;byId('success').setAttribute('tabindex','-1');byId('success').focus();}
   catch(error){if(error.status===404||error.status===410)forget();status(error.message);if(error.status===409){reviewedCode='';byId('review').hidden=true;byId('retry').hidden=false;}if(error.status===401){reviewedCode='';byId('review').hidden=true;byId('signin').hidden=false;}}
   finally{byId('approve').disabled=false;}
 };
 async function sessions(){const output=byId('sessions-status');output.textContent='Loading devices…';try{const result=await api('sessions');byId('sessions').replaceChildren();for(const session of result.sessions){const li=document.createElement('li'),label=document.createElement('span'),expiry=document.createElement('small'),button=document.createElement('button');label.textContent=session.name;expiry.textContent='Expires '+new Date(session.expiresAt).toLocaleDateString();button.textContent='Revoke access';button.onclick=async()=>{button.disabled=true;try{await api('revoke',{sessionId:session.id});await sessions();output.textContent='Device access revoked.';}catch(error){output.textContent=error.message;button.disabled=false;}};li.append(label,expiry,document.createElement('br'),button);byId('sessions').append(li);}output.textContent=result.sessions.length?'':'No connected devices.';}catch(error){output.textContent=error.message;}}
 window.addEventListener('focus',()=>{if(!byId('signin').hidden&&requestedCode)inspect(requestedCode);});
 byId('refresh').onclick=sessions;byId('devices').ontoggle=()=>{if(byId('devices').open)sessions();};
 if(fromFragment){byId('user-code').value=requestedCode;inspect(requestedCode);}else{byId('code-form').hidden=false;byId('intro').textContent='Enter the code shown in '+names.yourApp+'.';}
})();`;
