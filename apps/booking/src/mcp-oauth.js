// OAuth 2.1 for remote MCP clients (authorization code + PKCE, dynamic client registration).
// Nothing new is stored: clients and pending requests are sealed with TOKEN_ENCRYPTION_KEY, the
// authorization code is an approved device grant owned by the account, and the access token is a
// desktop session with the agent scope. Revocation, lifecycle checks and account cleanup therefore
// cover MCP connections exactly as they cover desktop links.
import {encryptTokens,decryptTokens,randomToken,sha256,timingSafeEqual} from './crypto.js';
import {HttpError,readJson} from './http.js';
import {AGENT_SCOPE,approveGrantForUser,exchangeApprovedGrant} from './device.js';
import {brandFromEnv,brandLabel,brandMark,escapeHTML} from '../public/brand.js';

const CODE_MS=5*60_000,REQUEST_MS=10*60_000,PUBLIC_SCOPE='scheduling';
const REQUEST_COOKIE='scheduling_mcp_authorize';
const BLOCKED_SCHEMES=new Set(['javascript','data','file','vbscript','about','blob','ws','wss','ftp','http']);
export const corsHeaders={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'GET, POST, OPTIONS','Access-Control-Allow-Headers':'Authorization, Content-Type, Mcp-Protocol-Version, Mcp-Session-Id, Last-Event-ID','Access-Control-Expose-Headers':'WWW-Authenticate, Mcp-Session-Id','Access-Control-Max-Age':'600'};
const json=(body,status=200,headers={})=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json','Cache-Control':'no-store',...corsHeaders,...headers}});
const oauthError=(error,description,status=400)=>json({error,error_description:description},status);

export function protectedResourceMetadata(origin,env){
  return {resource:origin+'/mcp',authorization_servers:[origin],scopes_supported:[PUBLIC_SCOPE],bearer_methods_supported:['header'],resource_name:brandFromEnv(env).productName};
}
export function authorizationServerMetadata(origin){
  return {issuer:origin,authorization_endpoint:origin+'/oauth/authorize',token_endpoint:origin+'/oauth/token',registration_endpoint:origin+'/oauth/register',
    response_types_supported:['code'],response_modes_supported:['query'],grant_types_supported:['authorization_code'],token_endpoint_auth_methods_supported:['none'],
    code_challenge_methods_supported:['S256'],scopes_supported:[PUBLIC_SCOPE],authorization_response_iss_parameter_supported:true};
}

// Loopback redirects may use any port (RFC 8252); everything else must match exactly.
export function validRedirect(value){
  if(typeof value!=='string'||value.length>500)return false;
  let url;try{url=new URL(value);}catch{return false;}
  if(url.hash||url.username||url.password)return false;
  const scheme=url.protocol.slice(0,-1);
  if(scheme==='https')return !!url.hostname;
  if(scheme==='http')return ['127.0.0.1','localhost','[::1]'].includes(url.hostname);
  return /^[a-z][a-z0-9+.-]{1,40}$/.test(scheme)&&!BLOCKED_SCHEMES.has(scheme);
}
export function redirectMatches(registered,candidate){
  if(registered.includes(candidate))return true;
  let url;try{url=new URL(candidate);}catch{return false;}
  if(url.protocol!=='http:'||!['127.0.0.1','localhost','[::1]'].includes(url.hostname))return false;
  return registered.some(item=>{try{const r=new URL(item);return r.protocol==='http:'&&r.hostname===url.hostname&&r.pathname===url.pathname&&r.search===url.search;}catch{return false;}});
}
const cleanName=value=>{const name=typeof value==='string'?value.replace(/[\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g,'').trim():'';return name&&!/[\u0000-\u001f\u007f]/.test(name)?name.slice(0,80):'MCP client';};

export async function sealClient(env,{name,redirectUris}){return 'mcp_'+await encryptTokens({v:1,n:name,r:redirectUris,t:Date.now()},env.TOKEN_ENCRYPTION_KEY,'mcp-client');}
export async function openClient(env,clientId){
  if(typeof clientId!=='string'||!clientId.startsWith('mcp_')||clientId.length>4000)return null;
  try{const c=await decryptTokens(clientId.slice(4),env.TOKEN_ENCRYPTION_KEY,'mcp-client');return c?.v===1&&Array.isArray(c.r)&&c.r.every(validRedirect)?{name:cleanName(c.n),redirectUris:c.r}:null;}catch{return null;}
}
async function sealRequest(env,request){return encryptTokens({v:1,...request,e:Date.now()+REQUEST_MS},env.TOKEN_ENCRYPTION_KEY,'mcp-request');}
async function openRequest(env,sealed){
  if(typeof sealed!=='string'||sealed.length>6000)return null;
  try{const r=await decryptTokens(sealed,env.TOKEN_ENCRYPTION_KEY,'mcp-request');return r?.v===1&&r.e>Date.now()?r:null;}catch{return null;}
}
async function rate(request,env,kind,max){
  const bucket=Math.floor(Date.now()/60_000),ip=request.headers.get('CF-Connecting-IP')||'local',key=await sha256(`mcp-${kind}:${bucket}:${ip}`);
  if(!await env.AUTH.getByName('device-rate:'+key).allow(max,60_000))throw new HttpError(429,'Too many requests. Try again shortly.');
}
function readCookie(request,name){return (request.headers.get('Cookie')||'').split(/;\s*/).map(part=>part.split('=')).find(([key])=>key===name)?.slice(1).join('=')||null;}
function requestCookie(origin,value,maxAge){return `${REQUEST_COOKIE}=${value}; Path=/oauth; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${origin.startsWith('https:')?'; Secure':''}`;}
function withQuery(target,params){const url=new URL(target);for(const [key,value] of Object.entries(params))if(value!==undefined&&value!==null&&value!=='')url.searchParams.set(key,value);return url.href;}

export async function handleOAuth(request,env,{origin,getSession}){
  const url=new URL(request.url),path=url.pathname;
  if(request.method==='OPTIONS')return new Response(null,{status:204,headers:corsHeaders});
  if(path==='/.well-known/oauth-protected-resource'||path==='/.well-known/oauth-protected-resource/mcp')return json(protectedResourceMetadata(origin,env));
  if(path==='/.well-known/oauth-authorization-server'||path==='/.well-known/openid-configuration')return json(authorizationServerMetadata(origin));
  if(path==='/oauth/register'&&request.method==='POST'){
    await rate(request,env,'register',20);
    let data;try{data=await readJson(request,8000);}catch{return oauthError('invalid_client_metadata','Send client metadata as JSON.');}
    const redirectUris=data.redirect_uris;
    if(!Array.isArray(redirectUris)||!redirectUris.length||redirectUris.length>5||!redirectUris.every(validRedirect))return oauthError('invalid_redirect_uri','Use https, loopback or app redirect URIs.');
    if(data.grant_types!==undefined&&(!Array.isArray(data.grant_types)||!data.grant_types.includes('authorization_code')))return oauthError('invalid_client_metadata','Only the authorization code grant is supported.');
    if(data.response_types!==undefined&&(!Array.isArray(data.response_types)||!data.response_types.includes('code')))return oauthError('invalid_client_metadata','Only the code response type is supported.');
    const name=cleanName(data.client_name),clientId=await sealClient(env,{name,redirectUris});
    return json({client_id:clientId,client_id_issued_at:Math.floor(Date.now()/1000),client_name:name,redirect_uris:redirectUris,grant_types:['authorization_code'],response_types:['code'],token_endpoint_auth_method:'none'},201);
  }
  if(path==='/oauth/authorize'&&request.method==='GET'){
    await rate(request,env,'authorize',60);
    const brand=brandFromEnv(env);
    // Coming back from Google sign-in: the reviewed request rides in a short-lived cookie.
    const resuming=!url.search||[...url.searchParams.keys()].every(key=>key==='connection');
    if(resuming){
      const sealed=readCookie(request,REQUEST_COOKIE),saved=sealed?await openRequest(env,sealed):null;if(!saved)return page(brand,{error:'This connection request expired. Start again from your app.'},origin);
      if(url.searchParams.get('connection')==='declined')return new Response(null,{status:303,headers:{Location:withQuery(saved.u,{error:'access_denied',state:saved.s,iss:origin}),'Set-Cookie':requestCookie(origin,'',0),'Cache-Control':'no-store','Referrer-Policy':'no-referrer'}});
      return consent(request,env,{origin,getSession,brand,saved,sealed});
    }
    const params=Object.fromEntries(url.searchParams),client=await openClient(env,params.client_id);
    if(!client||!validRedirect(params.redirect_uri)||!redirectMatches(client.redirectUris,params.redirect_uri))return page(brand,{error:'This connection link is not valid. Start again from your app.'},origin);
    // Registration is open, so nothing redirects until the signed-in person has chosen Allow or Deny.
    const invalid=params.response_type!=='code'||params.code_challenge_method!=='S256'||!/^[A-Za-z0-9_-]{43,128}$/.test(params.code_challenge||'')||params.state!==undefined&&params.state.length>1000||params.resource!==undefined&&![origin+'/mcp',origin,origin+'/'].includes(params.resource);
    if(invalid)return page(brand,{error:'This connection link is not valid. Start again from your app.'},origin);
    const saved={c:await sha256(params.client_id),n:client.name,u:params.redirect_uri,ch:params.code_challenge,s:params.state??null},sealed=await sealRequest(env,saved);
    return consent(request,env,{origin,getSession,brand,saved,sealed,setCookie:true});
  }
  if(path==='/oauth/authorize'&&request.method==='POST'){
    if(request.headers.get('Origin')!==origin)throw new HttpError(403,'Request not allowed.');
    await rate(request,env,'approve',30);
    const form=await request.formData(),saved=await openRequest(env,String(form.get('request')||''));const brand=brandFromEnv(env);
    if(!saved)return page(brand,{error:'This connection request expired. Start again from your app.'},origin);
    const user=await getSession(request);if(!user?.hostId)return page(brand,{error:'Sign in again to continue.'},origin);
    if(form.get('account')!==user.email)return page(brand,{error:'Your signed-in account changed. Start again from your app.'},origin);
    const clear={'Set-Cookie':requestCookie(origin,'',0),'Cache-Control':'no-store','Referrer-Policy':'no-referrer'};
    if(form.get('decision')!=='allow')return new Response(null,{status:303,headers:{Location:withQuery(saved.u,{error:'access_denied',state:saved.s,iss:origin}),...clear}});
    const code=randomToken(),deviceHash=await sha256(code);
    await approveGrantForUser(env,user,deviceHash,{name:saved.n,challenge:saved.ch,scope:AGENT_SCOPE,expiresAt:Date.now()+CODE_MS,nextPollAt:0,kind:'mcp',clientHash:saved.c,redirectUri:saved.u,accountEmail:user.email});
    return new Response(null,{status:303,headers:{Location:withQuery(saved.u,{code,state:saved.s,iss:origin}),...clear}});
  }
  if(path==='/oauth/token'&&request.method==='POST'){
    await rate(request,env,'token',60);
    let data;const type=request.headers.get('Content-Type')||'';
    try{data=type.includes('application/json')?await readJson(request,8000):Object.fromEntries(new URLSearchParams(await request.text()));}catch{return oauthError('invalid_request','Send a form-encoded token request.');}
    if(data.grant_type!=='authorization_code')return oauthError('unsupported_grant_type','Use the authorization code grant.');
    if(!/^[A-Za-z0-9_-]{43}$/.test(data.code||'')||!/^[A-Za-z0-9._~-]{43,128}$/.test(data.code_verifier||'')||typeof data.client_id!=='string'||typeof data.redirect_uri!=='string')return oauthError('invalid_request','Code, verifier, client and redirect are required.');
    const store=env.AUTH.getByName('device-grant:'+await sha256(data.code)),grant=await store.get();
    const valid=grant&&grant.kind==='mcp'&&grant.status==='approved'&&grant.hostId&&grant.expiresAt>Date.now()&&grant.redirectUri===data.redirect_uri&&await timingSafeEqual(grant.clientHash,await sha256(data.client_id))&&await timingSafeEqual(await sha256(data.code_verifier),grant.challenge);
    if(!valid)return oauthError('invalid_grant','The authorization code is invalid, expired or already used.');
    try{const issued=await exchangeApprovedGrant(env,store,grant);return json({access_token:issued.accessToken,token_type:'Bearer',expires_in:issued.expiresIn,scope:PUBLIC_SCOPE},200,{Pragma:'no-cache'});}
    catch(error){if(error?.code==='session_limit')return oauthError('invalid_request','Too many connected apps. Disconnect one in the Studio under Activity, then connect again.');if(error instanceof HttpError&&error.status===409)return oauthError('invalid_grant','The authorization code was already used.');if(error instanceof HttpError&&error.status<500)return oauthError('invalid_request',error.message);throw error;}
  }
  return json({error:'not_found'},404);
}

async function consent(request,env,{origin,getSession,brand,saved,sealed,setCookie}){
  const user=await getSession(request);
  const headers=setCookie?{'Set-Cookie':requestCookie(origin,sealed,REQUEST_MS/1000)}:{};
  return page(brand,{user,saved,sealed},origin,headers);
}
// Server-rendered, no script. form-action names the client's redirect origin because browsers
// apply it to the redirect that follows the form post.
function page(brand,{error,user,saved,sealed},origin,extraHeaders={}){
  const label=escapeHTML(brandLabel(brand)),mark=escapeHTML(brandMark(brand));let body,formAction="'self'";
  if(error)body=`<h1>Can't connect</h1><p class="muted">${escapeHTML(error)}</p>`;
  else{
    const app=escapeHTML(saved.n);let target='';try{const u=new URL(saved.u);target=u.protocol==='https:'||u.protocol==='http:'?u.host:u.protocol.slice(0,-1);formAction+=` ${u.protocol==='https:'||u.protocol==='http:'?u.origin:u.protocol}`;}catch{}
    const can=`<ul><li>See your bookings, links and availability</li><li>Approve, decline, cancel and reschedule bookings</li><li>Change links, hours and integrations</li></ul>`;
    const where=`<p class="where">Sends access to <strong>${escapeHTML(target)}</strong></p>`;
    body=user?.hostId?`<h1>Allow ${app} to manage your scheduling?</h1>${where}<p class="account">${escapeHTML(user.email)}</p>${can}<form method="post" action="/oauth/authorize"><input type="hidden" name="request" value="${escapeHTML(sealed)}"><input type="hidden" name="account" value="${escapeHTML(user.email)}"><div class="actions"><button name="decision" value="deny" class="secondary">Deny</button><button name="decision" value="allow" class="primary">Allow</button></div></form>`
      :`<h1>Connect ${app}</h1>${where}${can}<div class="actions"><a class="primary" href="/auth/google?returnTo=mcp">Continue with Google</a></div>`;
  }
  const csp=`default-src 'none'; style-src 'unsafe-inline'; form-action ${formAction}; base-uri 'none'; frame-ancestors 'none'`;
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Connect · ${label}</title><style>
:root{color-scheme:light dark;--bg:#f7f8fa;--card:#fff;--ink:#202124;--muted:#72747a;--line:#e5e6ea;--button:#202124;--on:#fff}@media(prefers-color-scheme:dark){:root{--bg:#111;--card:#191919;--ink:#f2f2f2;--muted:#a3a3a3;--line:#2b2b2b;--button:#f2f2f2;--on:#111}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.55 Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;padding:10vh 20px 32px}.shell{max-width:400px;margin:auto}.brand{display:flex;justify-content:center;align-items:center;gap:9px;font-size:15px;font-weight:600;margin-bottom:24px}.mark{display:grid;place-items:center;width:28px;height:28px;background:var(--ink);color:var(--card);border-radius:8px;font-weight:700}
main{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:28px}h1{font-size:19px;line-height:1.3;letter-spacing:-.3px;margin:0 0 10px}.where{margin:0 0 4px}.account{margin:0 0 14px;color:var(--muted)}ul{margin:0 0 22px;padding-left:18px}li{margin:4px 0}.muted{color:var(--muted);margin:0}.small{font-size:12.5px;margin-top:14px;text-align:center}
form{margin:0}.actions{display:flex;gap:10px}.actions>*{flex:1;display:inline-flex;justify-content:center;align-items:center;min-height:42px;border-radius:10px;font:inherit;font-weight:600;cursor:pointer;text-decoration:none}.primary{background:var(--button);color:var(--on);border:0}.secondary{background:transparent;color:var(--ink);border:1px solid var(--line)}
</style></head><body><div class="shell"><div class="brand"><span class="mark" aria-hidden="true">${mark}</span>${label}</div><main>${body}</main></div></body></html>`,{status:error?400:200,headers:{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','Referrer-Policy':'same-origin','X-Content-Type-Options':'nosniff','Content-Security-Policy':csp,...extraHeaders}});
}
