import {test} from 'node:test';
import {build} from 'esbuild';
import assert from 'node:assert/strict';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {GOOGLE_SCOPES} from '../src/google.js';
import {intakeRevision} from '../public/intake.js';
test('Worker export enforces browser and company authority without provider reads',async()=>{
 let identity='owner@example.test',calendar=false;const events=new Map(),trace=[];
 const wrapper=await build({stdin:{contents:`import worker,{BookingHost,LiveBookingHost,AuthStore} from './dist/worker.js';export {BookingHost,LiveBookingHost,AuthStore};export default{fetch(request,env,ctx){if(request.headers.has('X-Test-Deny-Host'))env={...env,LIVE_HOSTS:{getByName(){throw Error('Export touched host before account assertion');}}};return worker.fetch(request,env,ctx);}};`,resolveDir:new URL('..',import.meta.url).pathname},bundle:true,format:'esm',platform:'browser',external:['cloudflare:workers'],write:false});
 const mf=new Miniflare(convertV4MiniflareOptions({workers:[{name:'company-management',modules:true,script:wrapper.outputFiles[0].text,compatibilityDate:'2026-11-10',durableObjects:{HOSTS:{className:'BookingHost',useSQLite:true},LIVE_HOSTS:{className:'LiveBookingHost',useSQLite:true},AUTH:{className:'AuthStore',useSQLite:true}},bindings:{LIVE_ENABLED:'true',PUBLIC_ORIGIN:'http://localhost',GOOGLE_CLIENT_ID:'fixture',GOOGLE_CLIENT_SECRET:'fixture',TOKEN_ENCRYPTION_KEY:Buffer.alloc(32,11).toString('base64')},outboundService:async request=>{
  const url=new URL(request.url);trace.push(request.method+' '+url.pathname);if(url.hostname==='oauth2.googleapis.com')return Response.json({access_token:'fixture',expires_in:3600,scope:calendar?GOOGLE_SCOPES.join(' '):'openid email profile',...(calendar?{refresh_token:'fixture-refresh'}:{})});if(url.hostname==='openidconnect.googleapis.com')return Response.json({sub:identity,email:identity,email_verified:true,name:'Fixture'});
  if(url.hostname==='www.googleapis.com'){
   if(url.pathname.endsWith('/calendarList'))return Response.json({items:[{id:'primary',summary:'Work',accessRole:'owner'}]});
   if(url.pathname.endsWith('/freeBusy'))return Response.json({calendars:{primary:{busy:[]}}});
   if(url.pathname.endsWith('/events')&&request.method==='POST'){const body=await request.json();const event={...body,status:'confirmed',etag:'"fixture"'};events.set(event.id,event);return Response.json(event);}
   const id=url.pathname.split('/').at(-1);if(request.method==='DELETE'){events.delete(id);return new Response(null,{status:204});}if(events.has(id))return Response.json(events.get(id));return Response.json({error:{message:'missing'}},{status:404});
  }throw Error('Unexpected outbound destination');
 }}]}));
 const call=(path,{cookie,workspace,body,origin='http://localhost'}={})=>mf.dispatchFetch('http://localhost'+path,{redirect:'manual',method:body?'POST':'GET',headers:{...(cookie?{Cookie:cookie}:{}),...(workspace?{'X-Scheduling-Workspace':workspace}:{}),...(body?{Origin:origin,'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
 async function login(email,cookie,workspace){const start=await call('/auth/google'+(cookie?'?connect=1&workspace='+workspace:''),{cookie});assert.equal(start.status,302);const binding=start.headers.get('Set-Cookie').split(';')[0],state=new URL(start.headers.get('Location')).searchParams.get('state');identity=email;calendar=!!cookie;const done=await call('/auth/google/callback?state='+state+'&code=fixture',{cookie:[cookie,binding].filter(Boolean).join('; ')});assert.equal(done.status,303,await done.clone().text());return cookie||done.headers.getSetCookie().find(v=>v.startsWith('email_booking_session='))?.split(';')[0];}

 const ok=async(response)=>{assert.equal(response.status,200,await response.clone().text());return response.json();};
 try{
 const owner=await login('owner@example.test'),admin=await login('admin@example.test'),member=await login('member@example.test');
 const made=await ok(await call('/api/live/workspaces',{cookie:owner,body:{name:'Company'}})),id=made.workspace.id;
 for(const [email,role,cookie] of [['admin@example.test','admin',admin],['member@example.test','member',member]]){const invite=await ok(await call('/api/live/workspace/invitations',{cookie:owner,workspace:id,body:{email,role}}));await ok(await call('/api/live/workspace/invitations/accept',{cookie,body:{token:decodeURIComponent(invite.url.split('#invite=')[1])}}));}
 const personal=await ok(await call('/api/live/account/export',{cookie:owner,workspace:'h_'+'Z'.repeat(24),body:{}}));assert.equal(personal.scope,'account');assert.equal(personal.sections[0].name,'profile');assert.equal(personal.sections[0].data.email,'owner@example.test');assert.notEqual(personal.sections[0].data.id,id);assert.ok(personal.nextCursor);
 const assertionCall=(account,denyHost=false)=>mf.dispatchFetch('http://localhost/api/live/account/export',{method:'POST',headers:{Cookie:owner,Origin:'http://localhost','Content-Type':'application/json','X-Scheduling-Account':account,...(denyHost?{'X-Test-Deny-Host':'1'}:{})},body:'{}'});
 const mismatch=await assertionCall('h_'+'Z'.repeat(24),true);assert.equal(mismatch.status,409);assert.equal((await mismatch.json()).code,'export_account_changed');
 assert.equal((await assertionCall(personal.sections[0].data.id,true)).status,503,'matching assertion reaches the deliberately blocked host');
 assert.equal((await assertionCall(personal.sections[0].data.id)).status,200,'matching assertion exports normally');
 const before=trace.length,a=await ok(await call('/api/live/account/export',{cookie:owner,body:{cursor:personal.nextCursor}})),b=await ok(await call('/api/live/account/export',{cookie:owner,body:{cursor:personal.nextCursor}}));assert.deepEqual(a,b);assert.equal(trace.length,before,'export must not call providers');
 assert.equal((await call('/api/live/account/export',{cookie:admin,body:{cursor:personal.nextCursor}})).status,403);assert.equal((await call('/api/live/workspace/export',{cookie:owner,workspace:id,body:{cursor:personal.nextCursor}})).status,403);
 assert.equal((await call('/api/live/account/export',{body:{}})).status,401);assert.equal((await mf.dispatchFetch('http://localhost/api/live/account/export',{method:'POST',headers:{Authorization:'Bearer '+'A'.repeat(43),Origin:'http://localhost','Content-Type':'application/json'},body:'{}'})).status,401);
 assert.equal((await call('/api/live/account/export',{cookie:owner,origin:'https://foreign.test',body:{}})).status,403);assert.equal((await call('/api/live/account/export',{cookie:owner,body:{target:id}})).status,400);assert.equal((await call('/api/live/workspace/export',{cookie:member,workspace:id,body:{}})).status,403);
 let page=await ok(await call('/api/live/workspace/export',{cookie:admin,workspace:id,body:{}}));const all=[page];while(page.nextCursor){page=await ok(await call('/api/live/workspace/export',{cookie:admin,workspace:id,body:{cursor:page.nextCursor}}));all.push(page);}
 assert.equal(all.flatMap(p=>p.sections).find(s=>s.name==='members').data.length,3);for(const hidden of ['fixture-refresh','tokenHash','managementToken'])assert.ok(!JSON.stringify(all).includes(hidden));
 const old=await ok(await call('/api/live/workspace/export',{cookie:admin,workspace:id,body:{}})),team=await ok(await call('/api/live/workspace',{cookie:owner,workspace:id})),adminId=team.members.find(m=>m.email==='admin@example.test').id;
 await ok(await call('/api/live/workspace/members',{cookie:owner,workspace:id,body:{action:'role',memberId:adminId,role:'viewer'}}));assert.equal((await call('/api/live/workspace/export',{cookie:admin,workspace:id,body:{cursor:old.nextCursor}})).status,403);
 const fresh=await ok(await call('/api/live/account/export',{cookie:owner,body:{}})),settings=await ok(await call('/api/live/settings',{cookie:owner}));await ok(await call('/api/live/settings',{cookie:owner,body:{expectedRevision:settings.revision,patch:{profile:{name:'Changed after export'}}}}));const changed=await call('/api/live/account/export',{cookie:owner,body:{cursor:fresh.nextCursor}});assert.equal(changed.status,409);assert.equal((await changed.json()).code,'export_changed');
 }finally{await mf.dispose();}
});
