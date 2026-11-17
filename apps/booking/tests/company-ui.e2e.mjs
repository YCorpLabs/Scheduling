// Real Studio + real Worker/SQLite, with all identity and notification providers
// intercepted at the runtime boundary. No browser API routes are mocked.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {resolve,extname} from 'node:path';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {chromium,expect} from '@playwright/test';
import {sha256} from '../src/crypto.js';
const port=Number(process.env.BOOKING_E2E_PORT||8804),origin='http://127.0.0.1:'+port,publicRoot=resolve(new URL('../public',import.meta.url).pathname);
test('real company UI creates, invites, delivers a synthetic notification and revokes access',{timeout:90000},async()=>{
 let identity='owner@example.test';const sent=[];
 const asset=async request=>{
  const pathname=new URL(request.url).pathname,file=resolve(publicRoot,'.'+pathname);
  if(!file.startsWith(publicRoot+'/'))return new Response('Not found',{status:404});
  try{return new Response(await readFile(file),{headers:{'content-type':{'.js':'text/javascript','.mjs':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.html':'text/html'}[extname(file)]||'application/octet-stream'}});}
  catch{return new Response(await readFile(resolve(publicRoot,'index.html')),{headers:{'content-type':'text/html'}});}
 };
 const mf=new Miniflare(convertV4MiniflareOptions({host:'127.0.0.1',port,workers:[{name:'company-browser',modules:true,scriptPath:new URL('../dist/worker.js',import.meta.url).pathname,compatibilityDate:'2026-11-10',durableObjects:{HOSTS:{className:'BookingHost',useSQLite:true},LIVE_HOSTS:{className:'LiveBookingHost',useSQLite:true},AUTH:{className:'AuthStore',useSQLite:true}},bindings:{LIVE_ENABLED:'true',PUBLIC_ORIGIN:origin,GOOGLE_CLIENT_ID:'fixture',GOOGLE_CLIENT_SECRET:'fixture',TOKEN_ENCRYPTION_KEY:Buffer.alloc(32,12).toString('base64')},serviceBindings:{ASSETS:asset},outboundService:async request=>{
  const url=new URL(request.url);
  if(url.hostname==='oauth2.googleapis.com')return Response.json({access_token:'fixture',expires_in:3600,scope:'openid email profile'});
  if(url.hostname==='openidconnect.googleapis.com')return Response.json({sub:identity,email:identity,email_verified:true,name:identity.split('@')[0]});
  if(url.hostname==='cloudflare-dns.com')return Response.json({Status:0,Answer:[{type:1,data:'93.184.216.34'}]});
  if(url.hostname==='hooks.slack.com'){sent.push(await request.json());return new Response('ok',{status:200});}
  throw Error('Unexpected provider; real network is forbidden');
 }}]}));
 let browser;
 try{
  await mf.ready;browser=await chromium.launch({headless:true,executablePath:process.env.BOOKING_BROWSER});
  async function signedIn(email){
   const start=await mf.dispatchFetch(origin+'/auth/google',{redirect:'manual'});assert.equal(start.status,302);const binding=start.headers.get('Set-Cookie').split(';')[0],state=new URL(start.headers.get('Location')).searchParams.get('state');identity=email;
   const done=await mf.dispatchFetch(origin+'/auth/google/callback?state='+state+'&code=fixture',{redirect:'manual',headers:{Cookie:binding}});assert.equal(done.status,303);const raw=done.headers.getSetCookie().find(v=>v.startsWith('email_booking_session=')).split(';')[0];const context=await browser.newContext();await context.addCookies([{name:'email_booking_session',value:raw.slice(raw.indexOf('=')+1),url:origin,httpOnly:true,sameSite:'Lax'}]);return context;
  }
  const ownerContext=await signedIn('owner@example.test'),memberContext=await signedIn('admin@example.test'),owner=await ownerContext.newPage();
  await owner.goto(origin+'/studio');await expect(owner.getByRole('dialog',{name:'Create your profile'})).toHaveCount(0);await owner.locator('#workspace-trigger').click();await owner.getByRole('menuitem',{name:'New team'}).click();const create=owner.getByRole('dialog',{name:'New team'});await expect(create).toBeVisible();await create.getByLabel('Name',{exact:true}).fill('Fixture Company');await create.getByLabel('Website',{exact:false}).fill('fixture.test');await create.getByRole('button',{name:'Create team',exact:true}).click();await expect(create).toHaveCount(0);await expect(owner.locator('#workspace-trigger')).toContainText('Fixture Company');
  await owner.getByRole('button',{name:'Team',exact:true}).click();await owner.getByRole('button',{name:'Invite',exact:true}).click();const invite=owner.getByRole('dialog',{name:'Invite to Fixture Company'});await invite.getByLabel('Email',{exact:true}).fill('admin@example.test');await invite.getByRole('radio',{name:/Admin/}).check();await invite.getByRole('button',{name:'Create invite link'}).click();const url=await invite.getByLabel('Invite link').inputValue();await invite.getByRole('button',{name:'Done',exact:true}).click();
  const admin=await memberContext.newPage();await admin.goto(url);const acceptance=admin.getByRole('dialog',{name:'Profile invitation',exact:true});await expect(acceptance).toBeVisible();await acceptance.getByRole('button',{name:'Join Fixture Company',exact:true}).click();await expect(acceptance).toHaveCount(0);await expect(admin.locator('#workspace-trigger')).toContainText('Fixture Company');
  await admin.getByRole('button',{name:'Integrations',exact:true}).click();await admin.getByRole('button',{name:'Connect Slack',exact:true}).click();const integration=admin.getByRole('dialog',{name:'Connect Slack'});await integration.getByLabel('Name',{exact:true}).fill('Team notifications');await integration.getByLabel('Slack webhook URL').fill('https://hooks.slack.com/services/T123456/B123456/abcdefghijklmnopqrstuv');await integration.getByRole('button',{name:'Connect',exact:true}).click();await expect(integration).toHaveCount(0);
  const connected=admin.getByRole('dialog',{name:'Team notifications is connected'});await connected.getByRole('button',{name:'Send test',exact:true}).click();await expect(connected.getByRole('status')).toHaveText('Delivered. Check the channel.',{timeout:10000});assert.equal(sent.length,1);
  assert.equal(sent[0].text,'Test notification');assert.ok(JSON.stringify(sent[0].blocks).includes('Booking updates will appear in this channel.'));assert.ok(!JSON.stringify(sent[0]).includes('admin@example.test'));
  await connected.getByRole('button',{name:'Done',exact:true}).click();await expect(connected).toHaveCount(0);await expect(admin.getByRole('button',{name:'Edit Team notifications',exact:true})).toBeVisible();
  await admin.getByRole('button',{name:'More for Team notifications',exact:true}).click();await admin.getByRole('menuitem',{name:'Send test',exact:true}).click();await expect(admin.locator('#host-status')).toHaveText('Test delivered to Team notifications');assert.equal(sent.length,2);await admin.locator('summary',{hasText:'Recent deliveries'}).click();await expect(admin.locator('.delivery-entry .booking-badge',{hasText:'Delivered'})).toHaveCount(2);
  await admin.setViewportSize({width:390,height:844});assert.ok(await admin.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await admin.screenshot({path:`${process.env.BOOKING_SCREENSHOT_DIR||'test-results'}/company-ui-real-worker-mobile.png`,fullPage:true});
  // A real browser approves an MCP connection: the consent form must post with a real Origin.
  // The loopback redirect is served by this local Worker, so nothing leaves the machine.
  const mcpRedirect=origin+'/mcp-test-callback';
  const mcpClient=await admin.evaluate(async uri=>(await fetch('/oauth/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({client_name:'Claude Code',redirect_uris:[uri]})})).json(),mcpRedirect);
  const mcpVerifier='m'.repeat(48);
  await admin.goto(origin+'/oauth/authorize?'+new URLSearchParams({response_type:'code',client_id:mcpClient.client_id,redirect_uri:mcpRedirect,code_challenge:await sha256(mcpVerifier),code_challenge_method:'S256',state:'s1'}));
  await expect(admin.getByRole('heading',{name:'Allow Claude Code to manage your scheduling?'})).toBeVisible();await admin.getByRole('button',{name:'Allow'}).click();
  await admin.waitForURL(/\/mcp-test-callback\?/);const mcpBack=new URL(admin.url());assert.equal(mcpBack.searchParams.get('state'),'s1');assert.ok(mcpBack.searchParams.get('code'));
  const mcpToken=await (await mf.dispatchFetch(origin+'/oauth/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'authorization_code',code:mcpBack.searchParams.get('code'),code_verifier:mcpVerifier,redirect_uri:mcpRedirect,client_id:mcpClient.client_id}).toString()})).json();
  const mcpOverview=await (await mf.dispatchFetch(origin+'/mcp',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+mcpToken.access_token},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'get_overview',arguments:{}}})})).json();
  assert.equal(mcpOverview.result.structuredContent.account,'admin@example.test');
  await admin.goto(origin+'/studio');await expect(admin.locator('#workspace-trigger')).toBeVisible();
  await owner.getByRole('button',{name:'Team',exact:true}).click();await owner.getByRole('button',{name:'Manage admin@example.test',exact:true}).click();const manage=owner.getByRole('dialog',{name:'Manage admin@example.test'});await manage.getByRole('button',{name:/Remove from/}).click();await manage.getByRole('button',{name:'Remove member',exact:true}).click();await expect(manage).toHaveCount(0);
  await admin.reload();await expect(admin.locator('#workspace-trigger')).toContainText('admin');await admin.locator('#workspace-trigger').click();await expect(admin.getByRole('menuitemradio',{name:/Fixture Company/})).toHaveCount(0);await owner.setViewportSize({width:375,height:812});await owner.goto(origin+'/auth/google/callback');await expect(owner.getByRole('heading',{name:'Sign-in expired',exact:true})).toBeVisible();await expect(owner.getByRole('link',{name:'Sign in with Google',exact:true})).toHaveAttribute('href','/auth/google');assert.ok(await owner.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await owner.screenshot({path:`${process.env.BOOKING_SCREENSHOT_DIR||'test-results'}/company-expired-real-worker-mobile.png`,fullPage:true});
 }finally{await browser?.close();await mf.dispose();}
});
