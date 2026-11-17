// Real Worker + SQLite through Miniflare. Only Google sign-in is faked at the runtime boundary.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {sha256} from '../src/crypto.js';

const ORIGIN='http://localhost',REDIRECT='https://claude.ai/api/mcp/auth_callback';
function worker(){
  const people=new Map();let sequence=0;
  const mf=new Miniflare(convertV4MiniflareOptions({workers:[{name:'mcp-test',modules:true,scriptPath:new URL('../dist/worker.js',import.meta.url).pathname,compatibilityDate:'2026-11-10',
    durableObjects:{HOSTS:{className:'BookingHost',useSQLite:true},LIVE_HOSTS:{className:'LiveBookingHost',useSQLite:true},AUTH:{className:'AuthStore',useSQLite:true}},
    bindings:{LIVE_ENABLED:'true',PUBLIC_ORIGIN:ORIGIN,GOOGLE_CLIENT_ID:'test-client',GOOGLE_CLIENT_SECRET:'test-secret',TOKEN_ENCRYPTION_KEY:Buffer.alloc(32,9).toString('base64'),PRODUCT_NAME:'Scheduling'},
    outboundService:async request=>{
      const u=new URL(request.url);
      if(u.hostname==='oauth2.googleapis.com'){const code=new URLSearchParams(await request.text()).get('code');return Response.json({access_token:'access-'+code,expires_in:3600,scope:'openid email profile'});}
      if(u.hostname==='openidconnect.googleapis.com'){const who=people.get(request.headers.get('Authorization').replace('Bearer access-',''));return Response.json({sub:who,email:who+'@example.com',email_verified:true,name:'Ada'});}
      throw Error('Unexpected provider request: '+u.href);
    }}]}));
  const call=(path,{cookie,body,form,headers={},method,origin=ORIGIN}={})=>mf.dispatchFetch(ORIGIN+path,{redirect:'manual',method:method||(body||form?'POST':'GET'),
    headers:{...headers,...(cookie?{Cookie:cookie}:{}),...(body?{'Content-Type':'application/json',Origin:origin}:{}),...(form?{'Content-Type':'application/x-www-form-urlencoded',Origin:origin}:{})},
    ...(body?{body:JSON.stringify(body)}:{}),...(form?{body:new URLSearchParams(form).toString()}:{})});
  async function signIn(who,{returnTo,extraCookie}={}){
    const begin=await call('/auth/google'+(returnTo?'?returnTo='+returnTo:''));assert.equal(begin.status,302);
    const state=new URL(begin.headers.get('Location')).searchParams.get('state'),binding=begin.headers.get('Set-Cookie').split(';')[0],code='code-'+(++sequence);people.set(code,who);
    const done=await call('/auth/google/callback?state='+state+'&code='+code,{cookie:[binding,extraCookie].filter(Boolean).join('; ')});assert.equal(done.status,303);
    return {cookie:done.headers.getSetCookie().find(v=>v.startsWith('email_booking_session=')).split(';')[0],location:done.headers.get('Location')};
  }
  return {mf,call,signIn};
}
async function pkce(){const verifier='v'.repeat(20)+crypto.randomUUID().replaceAll('-','');return {verifier,challenge:await sha256(verifier)};}

test('an MCP client connects with OAuth, manages links and hours, and every change shows in the Studio activity',{timeout:60000},async()=>{
  const {mf,call,signIn}=worker();
  try{
    // Discovery and the unauthenticated challenge.
    const resource=await (await call('/.well-known/oauth-protected-resource')).json();assert.equal(resource.resource,ORIGIN+'/mcp');assert.deepEqual(resource.authorization_servers,[ORIGIN]);
    const server=await (await call('/.well-known/oauth-authorization-server')).json();assert.equal(server.token_endpoint,ORIGIN+'/oauth/token');assert.deepEqual(server.code_challenge_methods_supported,['S256']);
    const anonymous=await call('/mcp',{body:{jsonrpc:'2.0',id:1,method:'initialize',params:{}}});assert.equal(anonymous.status,401);assert.match(anonymous.headers.get('WWW-Authenticate'),/resource_metadata="http:\/\/localhost\/\.well-known\/oauth-protected-resource"/);

    // Dynamic registration is stateless and rejects unsafe redirects.
    assert.equal((await call('/oauth/register',{body:{client_name:'Bad',redirect_uris:['javascript:alert(1)']}})).status,400);
    const client=await (await call('/oauth/register',{body:{client_name:'Claude',redirect_uris:[REDIRECT],token_endpoint_auth_method:'none'}})).json();assert.match(client.client_id,/^mcp_v1\./);assert.equal(client.token_endpoint_auth_method,'none');

    // An unregistered redirect never redirects.
    const {verifier,challenge}=await pkce(),query=p=>'/oauth/authorize?'+new URLSearchParams({response_type:'code',client_id:client.client_id,redirect_uri:REDIRECT,code_challenge:challenge,code_challenge_method:'S256',state:'xyz',resource:ORIGIN+'/mcp',...p});
    const wrong=await call(query({redirect_uri:'https://evil.example/cb'}));assert.equal(wrong.status,400);assert.equal(wrong.headers.get('Location'),null);
    // Registration is open, so malformed requests never redirect before a person chooses.
    for(const p of [{response_type:'token'},{code_challenge_method:'plain'},{resource:'https://other.example/mcp'}]){const r=await call(query(p));assert.equal(r.status,400);assert.equal(r.headers.get('Location'),null);}

    // Signed out: the request is kept in a cookie, Google sign-in returns to the consent page.
    const first=await call(query());assert.equal(first.status,200);const firstPage=await first.text();assert.match(firstPage,/Continue with Google/);
    const held=first.headers.get('Set-Cookie').split(';')[0];assert.match(held,/^scheduling_mcp_authorize=/);assert.equal(first.headers.get('Referrer-Policy'),'same-origin');
    // Cancelling Google sign-in tells the client instead of stranding it.
    const declined=await call('/oauth/authorize?connection=declined',{cookie:held});assert.equal(declined.status,303);const why=new URL(declined.headers.get('Location'));assert.equal(why.searchParams.get('error'),'access_denied');assert.equal(why.searchParams.get('state'),'xyz');
    const {cookie,location}=await signIn('ada',{returnTo:'mcp'});assert.equal(location,ORIGIN+'/oauth/authorize');
    const consent=await call('/oauth/authorize',{cookie:[cookie,held].join('; ')}),page=await consent.text();assert.equal(consent.status,200);
    assert.match(page,/Allow Claude to manage your scheduling\?/);assert.match(page,/ada@example\.com/);assert.match(page,/Sends access to <strong>claude\.ai<\/strong>/);assert.match(consent.headers.get('Content-Security-Policy'),/form-action 'self' https:\/\/claude\.ai/);
    const sealed=/name="request" value="([^"]+)"/.exec(page)[1].replaceAll('&amp;','&');

    // Cross-site posts and account switches are refused; Allow redirects with a code.
    assert.equal((await call('/oauth/authorize',{cookie,form:{request:sealed,account:'ada@example.com',decision:'allow'},origin:'https://evil.example'})).status,403);
    assert.equal((await call('/oauth/authorize',{cookie,form:{request:sealed,account:'eve@example.com',decision:'allow'}})).status,400);
    const allowed=await call('/oauth/authorize',{cookie,form:{request:sealed,account:'ada@example.com',decision:'allow'}});assert.equal(allowed.status,303);
    const back=new URL(allowed.headers.get('Location'));assert.equal(back.origin+back.pathname,REDIRECT);assert.equal(back.searchParams.get('state'),'xyz');assert.equal(back.searchParams.get('iss'),ORIGIN);
    const code=back.searchParams.get('code');

    // The code is single-use, bound to the client, redirect and verifier, and never works as a desktop link.
    const exchange=extra=>call('/oauth/token',{form:{grant_type:'authorization_code',code,code_verifier:verifier,redirect_uri:REDIRECT,client_id:client.client_id,...extra}});
    assert.equal((await (await exchange({code_verifier:'w'.repeat(43)})).json()).error,'invalid_grant');
    assert.equal((await call('/api/device/token',{body:{deviceCode:code,codeVerifier:verifier}})).status,410);
    const token=await (await exchange()).json();assert.equal(token.token_type,'Bearer');assert.equal(token.scope,'scheduling');assert.ok(token.access_token);
    assert.equal((await (await exchange()).json()).error,'invalid_grant');

    // MCP over Streamable HTTP with JSON responses.
    let id=0;const rpc=async(method,params={})=>{const r=await call('/mcp',{body:{jsonrpc:'2.0',id:++id,method,params},headers:{Authorization:'Bearer '+token.access_token,Accept:'application/json, text/event-stream'}});assert.equal(r.status,200,await r.clone().text());return (await r.json()).result;};
    const tool=async(name,args={})=>{const r=await rpc('tools/call',{name,arguments:args});assert.ok(!r.isError,`${name}: ${r.content?.[0]?.text}`);return r.structuredContent;};
    const init=await rpc('initialize',{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'test',version:'1'}});assert.equal(init.protocolVersion,'2025-06-18');assert.ok(init.capabilities.tools);
    const note=await call('/mcp',{body:{jsonrpc:'2.0',method:'notifications/initialized'},headers:{Authorization:'Bearer '+token.access_token}});assert.equal(note.status,202);
    const names=(await rpc('tools/list')).tools.map(t=>t.name);for(const name of ['get_overview','list_bookings','decide_booking','cancel_booking','reschedule_booking','create_link','update_hours','connect_integration','get_activity'])assert.ok(names.includes(name),name);
    const overview=await tool('get_overview');assert.equal(overview.account,'ada@example.com');assert.ok(overview.timeZone);

    const created=await tool('create_link',{title:'Coffee chat',duration_minutes:20,published:false,description:'Quick intro'});
    assert.equal(created.link.title,'Coffee chat');assert.equal(created.link.durationMinutes,20);assert.equal(created.link.slug,'coffee-chat');assert.match(created.link.url,/\/b\/h_[A-Za-z0-9_-]{24}\/coffee-chat$/);
    const updated=await tool('update_link',{link:'coffee-chat',title:'Coffee',hours:{monday:['10:00-12:00']}});assert.equal(updated.link.title,'Coffee');assert.deepEqual(updated.link.hours.monday,['10:00-12:00']);assert.deepEqual(updated.link.hours.tuesday,[]);
    assert.equal((await tool('get_link',{link:created.link.id})).link.settings.duration,20);
    const hours=await tool('update_hours',{weekly_hours:{friday:['09:00-12:00']},date_overrides:{'2026-12-24':[]}});assert.deepEqual(hours.weeklyHours.friday,['09:00-12:00']);assert.deepEqual(hours.dateOverrides['2026-12-24'],[]);
    const bad=await rpc('tools/call',{name:'update_hours',arguments:{weekly_hours:{funday:['09:00-10:00']}}});assert.equal(bad.isError,true);assert.match(bad.content[0].text,/Unknown weekday/);
    const unknown=await rpc('tools/call',{name:'create_link',arguments:{title:'X',colour:'red'}});assert.equal(unknown.isError,true);
    await tool('delete_link',{link:'coffee-chat'});assert.ok(!(await tool('list_links')).links.some(l=>l.slug==='coffee-chat'));

    // Every change is attributed to the app, for the agent and for the Studio.
    const activity=(await tool('get_activity')).activity;assert.deepEqual(activity.map(a=>a.action),['delete_link','update_hours','update_link','create_link']);assert.ok(activity.every(a=>a.by==='Claude'));
    const studio=await (await call('/api/live/activity',{cookie})).json();assert.equal(studio.activity[0].summary,'Deleted link Coffee (/coffee-chat)');assert.equal(studio.activity[0].actor.kind,'mcp');assert.equal(studio.activity[0].actor.email,'ada@example.com');
    // MCP connections cannot bypass the log through the desktop routes.
    assert.equal((await call('/api/device/settings',{headers:{Authorization:'Bearer '+token.access_token}})).status,403);

    // Connecting the same client again replaces its session rather than adding one.
    const again=await pkce(),againPage=await (await call(query({code_challenge:again.challenge}),{cookie})).text(),againSealed=/name="request" value="([^"]+)"/.exec(againPage)[1].replaceAll('&amp;','&');
    const againCode=new URL((await call('/oauth/authorize',{cookie,form:{request:againSealed,account:'ada@example.com',decision:'allow'}})).headers.get('Location')).searchParams.get('code');
    const second=await (await call('/oauth/token',{form:{grant_type:'authorization_code',code:againCode,code_verifier:again.verifier,redirect_uri:REDIRECT,client_id:client.client_id}})).json();assert.ok(second.access_token);
    assert.equal((await call('/mcp',{body:{jsonrpc:'2.0',id:98,method:'tools/list'},headers:{Authorization:'Bearer '+token.access_token}})).status,401);
    token.access_token=second.access_token;

    // The connection is listed with the desktop sessions and revocation cuts it off at once.
    const sessions=(await (await call('/api/device/sessions',{cookie})).json()).sessions;assert.equal(sessions.filter(s=>s.kind==='mcp').length,1);assert.equal(sessions[0].clientHash,undefined);const mine=sessions.find(s=>s.kind==='mcp');assert.equal(mine.name,'Claude');assert.equal(mine.accountEmail,'ada@example.com');
    assert.equal((await call('/api/device/revoke',{cookie,body:{sessionId:mine.id}})).status,204);
    assert.equal((await call('/mcp',{body:{jsonrpc:'2.0',id:99,method:'tools/list'},headers:{Authorization:'Bearer '+token.access_token}})).status,401);
  }finally{await mf.dispose();}
});
