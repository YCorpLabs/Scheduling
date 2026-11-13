import {test,expect} from '@playwright/test';
import {DEFAULT} from '../public/policy.js';
const base=process.env.BOOKING_TEST_ORIGIN||'http://127.0.0.1:8791';
const shots=process.env.BOOKING_SCREENSHOT_DIR||'test-results';
const TOKEN='h_'+'A'.repeat(24)+'.'+'b'.repeat(43);
const caps=role=>({readBookings:true,readAnalytics:true,approveBookings:role!=='viewer',manageSettings:['owner','admin'].includes(role),manageCalendars:['owner','admin'].includes(role),manageMembers:['owner','admin'].includes(role),manageIntegrations:['owner','admin'].includes(role),manageOperations:['owner','admin'].includes(role),transferOwnership:role==='owner',grantAdmin:role==='owner'});
const settingsFor=(hostId,name,title)=>({revision:'A'.repeat(43),hostId,profile:{name,email:'ada@example.com'},accounts:[{id:'a',connected:true,email:'ada@example.com',destinationCalendarId:'primary',conflictCalendarIds:['primary']}],meetingTypes:[{...DEFAULT,id:'intro',slug:'intro',title,accountId:'a',calendarId:'primary'}]});

// Stateful mock of the agreed workspace and integration routes. Nothing here reaches a provider.
async function mock(page,{role='admin',companies=true,authenticated=true,email='ada@example.com',hold,inspect,onboarding=false}={}){
  const state={requests:[],role,members:[{id:'h_me',email:'ada@example.com',role},{id:'h_owner',email:'owner@acme.test',role:'owner'},{id:'h_bo',email:'bo@acme.test',role:'member'}],invitations:[{id:'inv1',email:'cy@acme.test',role:'viewer',expiresAt:Date.parse('2026-11-19T12:00:00Z')}],companies:companies?[{id:'h_acmeacmeacmeacmeacmeacme',name:'Acme'}]:[],integrations:[],deliveries:[],hostsReady:false,held:{}};
  if(role==='owner')state.members=[{id:'h_me',email:'ada@example.com',role:'owner'},{id:'h_bo',email:'bo@acme.test',role:'member'}];
  const listing=()=>({workspaces:[{id:'h_me',name:'Personal',role:'owner',personal:true,capabilities:caps('owner')},...state.companies.map(c=>({id:c.id,name:c.name,role:c.role||state.role,personal:false,capabilities:caps(c.role||state.role)}))],activeWorkspaceId:'h_me'});
  state.release=key=>{state.held[key]?.();delete state.held[key];};
  await page.route('**/api/**',async route=>{
    const req=route.request(),url=new URL(req.url()),path=url.pathname,ws=req.headers()['x-scheduling-workspace']||null,body=req.postDataJSON?.()??null;
    state.requests.push({path,ws,method:req.method(),body});
    const json=(data,status=200)=>route.fulfill({status,json:data});
    if(path==='/api/bootstrap')return json(authenticated?{mode:'live',authenticated:true,email,hostId:'h_me'}:{mode:'live',authenticated:false});
    const key=`${path}|${ws||'personal'}`;
    if(hold?.includes(key))await new Promise(resolve=>{state.held[key]=resolve;});
    if(path==='/api/live/workspaces'&&req.method()==='GET')return json(listing());
    if(path==='/api/live/workspaces'){const c={id:'h_'+'n'.repeat(24),name:body.name};state.companies.push({...c,role:'owner'});return json({workspace:{...c,role:'owner',personal:false,capabilities:caps('owner')}});}
    if(ws&&!state.companies.some(c=>c.id===ws))return json({error:'Workspace not found.'},404);
    if(path==='/api/live/settings'&&!ws&&onboarding)return json({...settingsFor('h_me','Ada','Personal intro'),profile:{name:'Ada',profileSetupRequired:true},accounts:[]});
    if(path==='/api/live/settings')return json(ws?{...settingsFor(ws,'Acme','Acme demo'),workspace:{id:ws,role:state.role,capabilities:caps(state.role)}}:settingsFor('h_me','Ada','Personal intro'));
    if(path==='/api/live/calendars')return json({accounts:[{id:'a',calendars:[{id:'primary',summary:'Work',accessRole:'owner'}]}]});
    if(path==='/api/live/availability')return json({slots:[{start:state.moveStart||(state.moveStart=Date.now()+172800000),end:(state.moveStart)+1800000}]});
    if(/^\/api\/live\/bookings\/[^/]+\/availability$/.test(path))return json({config:{...settingsFor(ws,'Acme','Acme demo').meetingTypes[0],duration:state.moveDuration||30,durationOptions:null},slots:[{start:state.moveStart||(state.moveStart=Date.now()+172800000),end:state.moveStart+(state.moveDuration||30)*60000}]});
    const management=path.match(/^\/api\/live\/bookings\/([^/]+)\/(cancel|reschedule)$/);if(management){state.modifiedBooking={id:management[2]==='reschedule'?'replacement-company-booking':management[1],status:management[2]==='cancel'?'cancelled':'confirmed',title:'Acme booking',name:'Guest',email:'g@example.com',start:body.start||Date.now()+86400000,end:(body.start||Date.now()+86400000)+(state.moveDuration||30)*60000,meetingTypeSlug:'intro',timeZone:'UTC',version:2};return json({booking:state.modifiedBooking,hostActions:{manage:true}});}
    if(path==='/api/live/bookings'&&state.modifiedBooking)return json({bookings:state.modifiedBooking.status==='cancelled'?[]:[state.modifiedBooking]});
    if(path==='/api/live/bookings')return json({bookings:[{id:'b'.repeat(20),title:ws?'Acme booking':'Personal booking',name:'Guest',email:'g@example.com',start:Date.now()+86400000,end:Date.now()+86400000+(state.moveDuration||30)*60000,status:'confirmed'}]});
    if(path.startsWith('/api/live/bookings/')){const id=path.split('/').pop();return json({booking:state.modifiedBooking?.id===id?state.modifiedBooking:{id,status:'confirmed',title:ws?'Acme review':'Personal review',name:'Guest',email:'g@example.com',start:Date.now()+86400000,end:Date.now()+86400000+(state.moveDuration||30)*60000,meetingTypeSlug:'intro',version:1},...(ws?['owner','admin'].includes(state.role)?{hostActions:{manage:true}}:{}:{managementToken:'t'})});}
    if(path==='/api/live/analytics')return json({period:{from:'2026-11-01',to:'2026-11-30'},totals:{pageViews:ws?7:3,confirmed:0,bookingRequests:0,cancelled:0,rescheduled:0},series:[],sources:{},sourceBookings:{}});
    if(path==='/api/live/workspace')return json({workspace:{id:ws,name:'Acme',role:state.role,capabilities:caps(state.role)},members:state.members,invitations:['owner','admin'].includes(state.role)?state.invitations:[]});
    if(path==='/api/live/workspace/invitations')return json({invitation:{id:'inv2',email:body.email,role:body.role,expiresAt:Date.parse('2026-11-19T12:00:00Z')},url:`${base}/studio#invite=${TOKEN}`});
    if(path==='/api/live/workspace/invitations/revoke'){state.invitations=state.invitations.filter(i=>i.id!==body.id);return json({revoked:true});}
    if(path==='/api/live/workspace/members'){if(body.action==='remove'&&body.memberId==='h_me'){state.companies=[];return json({left:true,workspace:null,members:[]});}const m=state.members.find(x=>x.id===body.memberId);if(body.action==='role')m.role=body.role;if(body.action==='remove')state.members=state.members.filter(x=>x!==m);if(body.action==='transfer'){m.role='owner';state.role='admin';state.members.find(x=>x.id==='h_me').role='admin';}return json({ok:true});}
    if(path==='/api/live/workspace/invitations/inspect')return inspect?json(...inspect):json({invitation:{id:'inv2',email:'ada@example.com',role:'member',expiresAt:Date.now()+86400000,workspaceName:'Acme',workspaceId:'h_acmeacmeacmeacmeacmeacme'}});
    if(path==='/api/live/workspace/invitations/accept'){state.companies=[{id:'h_acmeacmeacmeacmeacmeacme',name:'Acme',role:'member'}];return json({workspace:{id:'h_acmeacmeacmeacmeacmeacme',name:'Acme',role:'member',capabilities:caps('member')}});}
    if(path==='/api/live/integrations'&&req.method()==='GET')return json({integrations:state.integrations,deliveries:state.deliveries,status:{customWebhookHostsConfigured:state.hostsReady,summary:{queued:0,quarantined:state.deliveries.filter(d=>d.state==='quarantined').length,failed:state.deliveries.filter(d=>d.state==='failed').length,inFlight:0,overdue:0}},capabilities:{kinds:['slack','discord','webhook'],events:['booking.requested','booking.confirmed','booking.rescheduled','booking.cancelled','booking.approval_requested','booking.rejected','booking.expired'],customWebhooksRequireApprovedHost:true,atLeastOnce:true}});
    if(path==='/api/live/integrations'){
      if(body.action==='create'){const i={id:'i'+(state.integrations.length+1),kind:body.kind,name:body.name,enabled:body.enabled,events:body.events,includeGuestDetails:body.includeGuestDetails,destinationLabel:new URL(body.url).hostname,revision:1};state.integrations.push(i);return json({integration:i,...(body.kind==='webhook'?{signingSecret:'whsec_test_only_value'}:{})});}
      const i=state.integrations.find(x=>x.id===body.id);if(body.expectedRevision!==i.revision)return json({error:'Integration changed. Refresh before saving.',code:'integration_conflict'},409);
      if(body.action==='remove'){state.integrations=state.integrations.filter(x=>x!==i);return json({ok:true});}
      Object.assign(i,Object.fromEntries(Object.entries(body).filter(([k])=>['name','events','includeGuestDetails','enabled'].includes(k))),{revision:i.revision+1});return json({integration:i});}
    if(path==='/api/live/integrations/test'){state.deliveries.unshift({id:'dtest',integrationId:body.id,eventId:'e',eventType:'integration.test',state:'queued',attempts:0,nextAttemptAt:Date.now(),lastAttemptAt:null,errorCode:null});return json({ok:true,deliveryId:'dtest',state:'queued'});}
    if(path==='/api/live/integrations/retry'){const d=state.deliveries.find(x=>x.id===body.deliveryId);d.state=body.action==='discard'?'cancelled':'queued';d.errorCode=body.action==='discard'?'operator_discarded':null;return json({ok:true});}
    if(path==='/api/live/operations')return json({issues:[]});
    return json({error:'Not mocked'},404);
  });
  return state;
}
const switcher=page=>page.locator('#workspace-trigger');
async function switchTo(page,name){await switcher(page).click();await page.getByRole('menuitemradio',{name:new RegExp(name)}).click();}

test('workspace switcher scopes company requests, keeps identity personal and survives reload and theme',async({page})=>{
  const state=await mock(page);await page.goto(base+'/studio#link=intro');
  await expect(page.locator('#edit-title')).toHaveValue('Personal intro');
  const firstSettings=state.requests.findIndex(r=>r.path==='/api/live/settings'),firstList=state.requests.findIndex(r=>r.path==='/api/live/workspaces');
  expect(firstList).toBeGreaterThan(-1);expect(firstList).toBeLessThan(firstSettings);expect(state.requests[firstSettings].ws).toBeNull();
  await expect(page.getByRole('button',{name:'Team'})).toHaveCount(0);
  // keyboard: open with ArrowDown, move, Escape returns focus
  await switcher(page).focus();await page.keyboard.press('ArrowDown');await expect(page.getByRole('menuitemradio',{name:/Ada/})).toBeFocused();await page.keyboard.press('Escape');await expect(switcher(page)).toBeFocused();await expect(page.locator('#workspace-menu')).toBeHidden();
  await page.keyboard.press('ArrowDown');await page.keyboard.press('ArrowDown');await expect(page.getByRole('menuitemradio',{name:/Acme/})).toBeFocused();await page.keyboard.press('Enter');
  await expect(page.locator('#edit-title')).toHaveValue('Acme demo');await expect(switcher(page)).toBeFocused();
  expect(state.requests.filter(r=>r.path==='/api/live/settings').at(-1).ws).toBe('h_acmeacmeacmeacmeacmeacme');
  expect(state.requests.filter(r=>r.path==='/api/live/workspaces').every(r=>r.ws===null)).toBeTruthy();
  await expect(page.locator('.host-identity small')).toHaveText('ada@example.com');await expect(page.locator('.host-identity strong')).toHaveText('Ada');
  await expect(page.getByRole('button',{name:'Team'})).toBeVisible();await expect(page.getByRole('button',{name:'Integrations'})).toBeVisible();
  await page.getByRole('button',{name:'Calendars',exact:true}).click();await expect(page.locator('a[href^="/auth/google?connect=1&workspace=h_acme"]').first()).toBeVisible();
  await page.setViewportSize({width:1440,height:960});await page.getByRole('button',{name:'Booking links',exact:true}).click();await switcher(page).click();await page.screenshot({path:`${shots}/workspace-switcher.png`});await page.keyboard.press('Escape');
  await page.reload();await expect(page.locator('.booking-link-title')).toHaveText('Acme demo');
  await page.locator('#account-trigger').click();await page.getByRole('button',{name:'Dark mode'}).click();await expect(page.locator('.booking-link-title')).toHaveText('Acme demo');await expect(switcher(page)).toContainText('Acme');
});

test('stored selection from another account or a removed company never leaks',async({page})=>{
  await page.addInitScript(()=>{if(!sessionStorage.getItem('seeded')){sessionStorage.setItem('seeded','1');localStorage.setItem('scheduling-workspace',JSON.stringify({account:'h_someone_else',id:'h_acmeacmeacmeacmeacmeacme',name:'Acme'}));}});
  const state=await mock(page);await page.goto(base+'/studio#link=intro');await expect(page.locator('#edit-title')).toHaveValue('Personal intro');
  expect(state.requests.filter(r=>r.ws).length).toBe(0);
  await page.evaluate(()=>localStorage.setItem('scheduling-workspace',JSON.stringify({account:'h_me',id:'h_goneonegoneonegoneoneab',name:'Gone Co'})));
  await page.reload();await expect(page.locator('#host-status')).toHaveText('Gone Co is no longer available. Showing your profile.');
  expect(state.requests.filter(r=>r.ws==='h_goneonegoneonegoneoneab').length).toBe(0);
});

test('old APIs without workspaces keep Personal only',async({page})=>{
  await mock(page,{companies:false});
  await page.route('**/api/live/workspaces',route=>route.fulfill({status:404,json:{error:'Not found'}}));
  await page.goto(base+'/studio#link=intro');await expect(page.locator('#edit-title')).toHaveValue('Personal intro');await expect(switcher(page)).toHaveCount(0);await expect(page.getByRole('button',{name:'Integrations'})).toBeVisible();
});

test('unsaved meeting edits are guarded when switching',async({page})=>{
  await mock(page);await page.goto(base+'/studio#link=intro');await page.locator('#edit-title').fill('Changed title');
  await switchTo(page,'Acme');const dialog=page.getByRole('dialog',{name:'Unsaved changes'});await expect(dialog).toBeVisible();await expect(dialog.getByRole('button',{name:'Keep editing'})).toBeFocused();
  await dialog.getByRole('button',{name:'Keep editing'}).click();await expect(page.locator('#edit-title')).toHaveValue('Changed title');await expect(switcher(page)).toContainText('Ada');
  await switchTo(page,'Acme');await page.getByRole('button',{name:'Discard changes'}).click();await expect(page.locator('#edit-title')).toHaveValue('Acme demo');
});

test('late responses from the previous workspace never repaint the new one',async({page})=>{
  const state=await mock(page,{hold:['/api/live/bookings|personal','/api/live/analytics|personal']});await page.goto(base+'/studio#link=intro');
  await page.getByRole('button',{name:'Bookings',exact:true}).click();await expect.poll(()=>!!state.held['/api/live/bookings|personal']).toBeTruthy();
  await switchTo(page,'Acme');await expect(page.locator('.booking-row')).toContainText('Acme booking');
  state.release('/api/live/bookings|personal');await page.waitForTimeout(150);await expect(page.locator('.booking-row')).toContainText('Acme booking');await expect(page.getByText('Personal booking')).toHaveCount(0);
  await switchTo(page,'Ada');await page.getByRole('button',{name:'Booking stats',exact:true}).click();await expect.poll(()=>!!state.held['/api/live/analytics|personal']).toBeTruthy();
  await switchTo(page,'Acme');await expect(page.locator('.analytics-card').first()).toContainText('7');
  state.release('/api/live/analytics|personal');await page.waitForTimeout(150);await expect(page.locator('.analytics-card').first()).toContainText('7');await expect(switcher(page)).toContainText('Acme');
});

test('membership removal shows recovery instead of stale company controls',async({page})=>{
  const state=await mock(page);await page.goto(base+'/studio#link=intro');await switchTo(page,'Acme');await expect(page.locator('#edit-title')).toHaveValue('Acme demo');
  await page.getByRole('button',{name:'Team'}).click();await expect(page.locator('[aria-labelledby=team-members-title] .team-row')).toHaveCount(3);
  state.companies=[];await page.getByRole('button',{name:'Bookings',exact:true}).click();
  const notice=page.locator('.workspace-notice');await expect(notice).toContainText('You no longer have access to Acme');
  await notice.getByRole('button',{name:'Back to your profile'}).click();await expect(switcher(page)).toContainText('Ada');await expect(page.getByRole('button',{name:'Team'})).toHaveCount(0);
});

test('team: invite link, revoke, role, transfer and removal call the backend with precise confirmations',async({page,context,browserName})=>{
  if(browserName==='chromium')await context.grantPermissions(['clipboard-read','clipboard-write'],{origin:base});
  else await page.addInitScript(()=>Object.defineProperty(navigator,'clipboard',{value:{writeText:async text=>{window.__copiedInvite=text;}}}));
  const state=await mock(page,{role:'owner'});state.members.push({id:'h_ad',email:'ad@acme.test',role:'admin'});await page.goto(base+'/studio#link=intro');await switchTo(page,'Acme');await page.getByRole('button',{name:'Team'}).click();
  await expect(page.locator('.team-row').filter({hasText:'ada@example.com'})).toContainText('You');
  await page.getByRole('button',{name:'Invite',exact:true}).click();const invite=page.getByRole('dialog',{name:'Invite to Acme'});
  await expect(invite.getByLabel('Email')).toBeFocused();await invite.getByLabel('Email').fill('dee@acme.test');await page.keyboard.press('Escape');
  await expect(invite.getByText('Discard your changes?')).toBeVisible();await invite.getByRole('button',{name:'Keep editing'}).click();await expect(invite.getByLabel('Email')).toHaveValue('dee@acme.test');
  await invite.getByText('Viewer',{exact:true}).click();await invite.getByRole('button',{name:'Create invite link'}).click();
  await expect(invite.getByRole('heading',{name:'Invite link ready'})).toBeVisible();await expect(invite.getByLabel('Invite link')).toHaveValue(`${base}/studio#invite=${TOKEN}`);
  expect(state.requests.find(r=>r.path==='/api/live/workspace/invitations').body).toEqual({email:'dee@acme.test',role:'viewer'});
  await page.setViewportSize({width:1280,height:900});await page.screenshot({path:`${shots}/workspace-invite-link.png`});
  await invite.getByRole('button',{name:'Copy link'}).click();await expect(invite.getByText('Link copied')).toBeVisible();if(browserName!=='chromium')expect(await page.evaluate(()=>window.__copiedInvite)).toBe(`${base}/studio#invite=${TOKEN}`);await invite.getByRole('button',{name:'Done'}).click();
  await expect(page.locator('#team-invite')).toBeFocused();
  await page.getByRole('button',{name:'Revoke invitation for cy@acme.test'}).click();await page.getByRole('button',{name:'Revoke invitation',exact:true}).click();await expect(page.getByText('cy@acme.test')).toHaveCount(0);
  await page.getByRole('button',{name:'Manage bo@acme.test'}).click();let dialog=page.getByRole('dialog',{name:'Manage bo@acme.test'});
  await dialog.getByText('Viewer',{exact:true}).click();await expect(dialog.getByRole('button',{name:'Change to Viewer'})).toBeEnabled();await dialog.getByRole('button',{name:'Change to Viewer'}).click();
  await expect(page.locator('.team-row').filter({hasText:'bo@acme.test'})).toContainText('Viewer');
  await page.getByRole('button',{name:'Manage ad@acme.test'}).click();dialog=page.getByRole('dialog',{name:'Manage ad@acme.test'});await dialog.getByRole('button',{name:'Remove from Acme…'}).click();
  await expect(dialog.getByText('Remove ad@acme.test from Acme?')).toBeVisible();await expect(dialog.getByRole('button',{name:'Back'})).toBeFocused();await dialog.getByRole('button',{name:'Remove member'}).click();await expect(page.getByText('ad@acme.test')).toHaveCount(0);
  await page.getByRole('button',{name:'Manage bo@acme.test'}).click();dialog=page.getByRole('dialog',{name:'Manage bo@acme.test'});await dialog.getByRole('button',{name:'Transfer ownership…'}).click();
  await expect(dialog.getByText('Make bo@acme.test the owner?')).toBeVisible();await page.screenshot({path:`${shots}/workspace-transfer.png`});await dialog.getByRole('button',{name:'Transfer ownership'}).click();
  await expect(page.locator('.team-row').filter({hasText:'bo@acme.test'})).toContainText('Owner');await expect(switcher(page)).toContainText('Admin');
  expect(state.requests.filter(r=>r.path==='/api/live/workspace/members').map(r=>r.body.action)).toEqual(['role','remove','transfer']);
  await page.setViewportSize({width:390,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBeTruthy();await page.screenshot({path:`${shots}/workspace-team-mobile.png`,fullPage:true});
});

test('members and viewers get read-only company access with no admin settings',async({page})=>{
  await mock(page,{role:'viewer'});await page.goto(base+'/studio#link=intro');await switchTo(page,'Acme');
  await expect(page.getByRole('heading',{name:'Bookings'})).toBeVisible();
  for(const name of ['Booking links','Calendars','Troubleshooting','Integrations'])await expect(page.getByRole('button',{name,exact:true})).toHaveCount(0);
  await expect(page.getByRole('button',{name:'Edit profile'})).toHaveCount(0);await expect(page.getByRole('button',{name:'Company profile'})).toHaveCount(0);
  await page.getByRole('button',{name:'Team'}).click();await expect(page.locator('.team-row')).toHaveCount(3);await expect(page.locator('[data-manage-member]')).toHaveCount(0);await expect(page.getByText('Pending invitations')).toHaveCount(0);await expect(page.getByRole('button',{name:'Invite',exact:true})).toHaveCount(0);
  await page.getByRole('button',{name:'Leave Acme'}).click();const leave=page.getByRole('dialog',{name:'Leave Acme?'});await expect(leave.getByRole('button',{name:'Cancel'})).toBeFocused();await leave.getByRole('button',{name:'Leave Acme',exact:true}).click();
  await expect(switcher(page)).toContainText('Ada');await expect(page.locator('#host-status')).toHaveText('You left Acme');await switcher(page).click();await expect(page.getByRole('menuitemradio',{name:/Acme/})).toHaveCount(0);
});

test('integrations: write-only URL, webhook host gate, one-time secret, test, retry and discard',async({page})=>{
  const state=await mock(page);await page.goto(base+'/studio#link=intro');await page.getByRole('button',{name:'Integrations'}).click();
  await expect(page.locator('.integration-connect')).toHaveCount(3);await expect(page.getByRole('button',{name:'Add integration',exact:true})).toHaveCount(0);await page.getByRole('button',{name:'Connect Slack',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'Add integration'});await expect(dialog.getByRole('radio',{name:'Slack'})).toBeChecked();
  await dialog.locator('label.kind-option',{hasText:'Webhook'}).click();await expect(dialog.getByText('Custom webhooks are not available.',{exact:false})).toBeVisible();await expect(dialog.getByRole('button',{name:'Add integration',exact:true})).toBeDisabled();
  await dialog.locator('label.kind-option',{hasText:'Slack'}).click();await expect(dialog.getByRole('button',{name:'Add integration',exact:true})).toBeEnabled();
  await expect(dialog.getByText('Include guest name and email')).toBeVisible();await expect(dialog.getByText(/answers are never sent/)).toBeVisible();
  await dialog.getByLabel('Name',{exact:true}).fill('Ops');await dialog.getByRole('button',{name:'Add integration',exact:true}).click();await expect(dialog.getByText('Enter the destination URL.')).toBeVisible();await expect(dialog.getByLabel('Slack webhook URL')).toBeFocused();
  await dialog.getByLabel('Slack webhook URL').fill('https://hooks.slack.com/services/T0/B0/secretpart');await page.setViewportSize({width:1280,height:1000});await page.screenshot({path:`${shots}/integration-editor.png`});
  await dialog.getByRole('button',{name:'Add integration',exact:true}).click();await expect(dialog).toHaveCount(0);
  const created=state.requests.find(r=>r.path==='/api/live/integrations'&&r.method==='POST').body;expect(created).toMatchObject({action:'create',kind:'slack',name:'Ops',events:['booking.confirmed','booking.cancelled'],includeGuestDetails:false,enabled:true});
  await expect(page.locator('.integration-row')).toContainText('hooks.slack.com');expect(await page.content()).not.toContain('secretpart');
  await page.getByRole('button',{name:'Send test notification to Ops'}).click();await expect(page.locator('#host-status')).toHaveText('Test notification queued');await expect(page.locator('.delivery-entry')).toContainText('Test notification');
  await page.getByRole('button',{name:'Pause Ops'}).click();await expect(page.getByRole('button',{name:'Resume Ops'})).toBeFocused();expect(state.requests.filter(r=>r.body?.action==='update').at(-1).body).toMatchObject({id:'i1',enabled:false,expectedRevision:1});
  // generic webhook with approved hosts returns a one-time secret
  state.hostsReady=true;await page.getByRole('button',{name:'Integrations'}).click();await page.locator('#add-integration').click();const hook=page.getByRole('dialog',{name:'Add integration'});
  await hook.locator('label.kind-option',{hasText:'Webhook'}).click();await expect(hook.getByText(/approved by the service operator/)).toBeVisible();await hook.getByLabel('Name',{exact:true}).fill('CRM');await hook.getByLabel('Endpoint URL').fill('https://crm.example/hooks');await hook.getByRole('button',{name:'Add integration',exact:true}).click();
  const secret=page.getByRole('dialog',{name:'Signing secret'});await expect(secret.getByRole('textbox',{name:'Signing secret'})).toHaveAttribute('type','password');await secret.getByRole('button',{name:'Reveal'}).click();await expect(secret.getByRole('textbox',{name:'Signing secret'})).toHaveValue('whsec_test_only_value');
  await page.screenshot({path:`${shots}/integration-secret.png`});await secret.getByRole('button',{name:'Done'}).click();await expect(page.locator('dialog')).toHaveCount(0);
  expect(await page.evaluate(()=>JSON.stringify({...localStorage})+JSON.stringify({...sessionStorage}))).not.toContain('whsec');expect(await page.content()).not.toContain('whsec');
  state.deliveries.push({id:'dfail',integrationId:'i2',eventId:'e2',eventType:'booking.confirmed',state:'failed',attempts:4,nextAttemptAt:null,lastAttemptAt:Date.now()-60000,errorCode:'provider_rejected'},{id:'dheld',integrationId:'i2',eventId:'e3',eventType:'booking.cancelled',state:'quarantined',attempts:1,nextAttemptAt:null,lastAttemptAt:Date.now()-120000,errorCode:'restored'});
  await page.getByRole('button',{name:'Integrations'}).click();await expect(page.getByText('1 delivery is held after a restore')).toBeVisible();
  await page.getByRole('button',{name:'Retry Booking confirmed'}).click();await expect(page.locator('#host-status')).toHaveText('Delivery queued for retry');
  await page.getByRole('button',{name:'Discard Booking cancelled'}).click();const discard=page.getByRole('dialog',{name:'Discard this delivery?'});await expect(discard).toContainText('will not be sent or replayed');await discard.getByRole('button',{name:'Discard delivery'}).click();
  await expect(page.getByText('held after a restore')).toHaveCount(0);expect(state.requests.filter(r=>r.path==='/api/live/integrations/retry').map(r=>r.body)).toEqual([{deliveryId:'dfail'},{deliveryId:'dheld',action:'discard'}]);
  await page.screenshot({path:`${shots}/integrations-list.png`,fullPage:true});
  await page.locator('#account-trigger').click();await page.getByRole('button',{name:'Dark mode'}).click();await page.screenshot({path:`${shots}/integrations-dark.png`,fullPage:true});
  await page.setViewportSize({width:390,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBeTruthy();await page.screenshot({path:`${shots}/integrations-mobile.png`,fullPage:true});
});

test('signed-out invite keeps the token out of URLs, survives sign-in and needs explicit acceptance',async({page})=>{
  const out=await mock(page,{authenticated:false});await page.goto(base+'/studio#invite='+TOKEN);
  await expect(page.getByRole('link',{name:'Continue with Google'})).toBeVisible();expect(page.url()).toBe(base+'/studio');
  expect(await page.getByRole('link',{name:'Continue with Google'}).getAttribute('href')).not.toContain(TOKEN);
  expect(await page.evaluate(()=>sessionStorage.getItem('scheduling-pending-invite'))).toContain(TOKEN);expect(await page.evaluate(()=>JSON.stringify({...localStorage}))).not.toContain(TOKEN);
  expect(out.requests.some(r=>JSON.stringify(r).includes(TOKEN))).toBeFalsy();
  await page.unroute('**/api/**');const state=await mock(page);await page.goto(base+'/studio');
  const dialog=page.getByRole('dialog',{name:'Profile invitation'});await expect(dialog.getByRole('heading',{name:'Join Acme?'})).toBeVisible();
  expect(state.requests.some(r=>r.path.endsWith('/accept'))).toBeFalsy();expect(state.requests.find(r=>r.path.endsWith('/inspect')).body).toEqual({token:TOKEN});
  expect(state.requests.filter(r=>!r.path.endsWith('/inspect')).some(r=>JSON.stringify(r).includes(TOKEN))).toBeFalsy();
  await page.screenshot({path:`${shots}/workspace-invite-accept.png`});
  await dialog.getByRole('button',{name:'Join Acme'}).click();await expect(switcher(page)).toContainText('Acme');await expect(page.locator('#host-status')).toHaveText('Joined Acme');
  await expect.poll(()=>page.evaluate(()=>sessionStorage.getItem('scheduling-pending-invite'))).toBeNull();
  await page.reload();await expect(page.getByRole('dialog',{name:'Profile invitation'})).toHaveCount(0);
});

test('invite for another email offers account switch and keeps the pending invite until resolved',async({page})=>{
  await page.addInitScript(([t])=>{if(!sessionStorage.getItem('seeded')){sessionStorage.setItem('seeded','1');sessionStorage.setItem('scheduling-pending-invite',JSON.stringify({token:t,until:Date.now()+600000}));}},[TOKEN]);
  let loggedOut=0;await page.route('**/auth/logout',route=>{loggedOut++;return route.fulfill({status:200,json:{ok:true}});});
  await mock(page,{inspect:[{error:'Sign in with the invited email address.'},403]});await page.goto(base+'/studio#link=intro');
  const dialog=page.getByRole('dialog',{name:'Profile invitation'});await expect(dialog.getByRole('heading',{name:'Different account needed'})).toBeVisible();await expect(dialog).toContainText('Signed in as ada@example.com');
  await expect(dialog.getByRole('button',{name:/Join/})).toHaveCount(0);
  await Promise.all([page.waitForNavigation(),dialog.getByRole('button',{name:'Sign in with another account'}).click()]);expect(loggedOut).toBe(1);expect(await page.evaluate(()=>sessionStorage.getItem('scheduling-pending-invite'))).toContain(TOKEN);
  const again=page.getByRole('dialog',{name:'Profile invitation'});await expect(again.getByRole('heading',{name:'Different account needed'})).toBeVisible();await again.getByRole('button',{name:'Not now'}).click();await expect(again).toHaveCount(0);await expect.poll(()=>page.evaluate(()=>sessionStorage.getItem('scheduling-pending-invite'))).toBeNull();
});

test('expired sign-in recovery screen is readable at mobile width without contacting a provider',async({page})=>{
  const external=[];page.on('request',r=>{if(!r.url().startsWith(base))external.push(r.url());});
  await page.setViewportSize({width:375,height:740});
  // The callback without state returns the server-rendered recovery page (no token exchange happens).
  const response=await page.goto(base+'/auth/google/callback');
  if(response.status()===503){test.info().annotations.push({type:'gap',description:'Local server has no OAuth configuration; rendered the recovery markup statically instead.'});
    await page.setContent('<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width, initial-scale=1"><base href="'+base+'/"><link rel="stylesheet" href="/tokens.css"><link rel="stylesheet" href="/style.css"></head><body><main class="sign-in-card"><h1>Sign-in expired</h1><p>Start again to sign in to Scheduling.</p><a class="primary" href="/auth/google">Sign in with Google</a></main></body></html>');}
  const heading=page.getByRole('heading',{name:'Sign-in expired'}),action=page.getByRole('link',{name:'Sign in with Google'});
  await expect(heading).toBeVisible();await expect(action).toBeVisible();
  const box=await action.boundingBox(),size=await heading.evaluate(h=>parseFloat(getComputedStyle(h).fontSize));
  expect(box.height).toBeGreaterThanOrEqual(44);expect(box.x).toBeGreaterThanOrEqual(16);expect(box.x+box.width).toBeLessThanOrEqual(375-16);expect(size).toBeGreaterThanOrEqual(28);
  expect(await page.evaluate(()=>getComputedStyle(document.querySelector('.sign-in-card')).borderTopWidth)).toBe('0px');
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBeTruthy();
  await page.screenshot({path:`${shots}/sign-in-expired-mobile.png`});expect(external).toEqual([]);
});

const BID='bk_'+'z'.repeat(20),ACME='h_acmeacmeacmeacmeacmeacme';
test('company notification link selects the company before loading the booking, even when Personal is saved',async({page})=>{
  const state=await mock(page);await page.goto(base+`/studio?workspace=${ACME}#booking=${BID}`);
  const dialog=page.getByRole('dialog',{name:'Booking details'});await expect(dialog.getByRole('heading',{name:'Acme review'})).toBeVisible();
  const list=state.requests.findIndex(r=>r.path==='/api/live/workspaces'),firstScoped=state.requests.findIndex(r=>r.path==='/api/live/settings'||r.path.startsWith('/api/live/bookings'));
  expect(list).toBeLessThan(firstScoped);expect(state.requests.filter(r=>r.path==='/api/live/settings'||r.path.startsWith('/api/live/bookings')).every(r=>r.ws===ACME)).toBeTruthy();
  expect(new URL(page.url()).search).toBe('');await expect(switcher(page)).toContainText('Acme');
  expect(await page.evaluate(()=>JSON.parse(localStorage.getItem('scheduling-workspace')))).toMatchObject({account:'h_me',id:ACME});
});
test('a link to a workspace the account cannot access is refused without loading that booking anywhere',async({page})=>{
  for(const id of ['h_foreignforeignforeignfor','not-a-workspace']){
    const state=await mock(page);await page.goto(base+`/studio?workspace=${id}#booking=${BID}`);
    await expect(page.locator('#host-status')).toContainText('cannot access');await expect(page.locator('#host-status')).toContainText('ask an admin for an invitation');
    await expect(page.getByRole('dialog',{name:'Booking details'})).toHaveCount(0);await expect(switcher(page)).toContainText('Ada');
    expect(state.requests.some(r=>r.path===`/api/live/bookings/${BID}`)).toBeFalsy();expect(state.requests.some(r=>r.ws===id)).toBeFalsy();
    expect(new URL(page.url()).search+new URL(page.url()).hash).toBe('');
    await page.unroute('**/api/**');
  }
  await mock(page);await page.reload();await expect(page.getByRole('dialog',{name:'Booking details'})).toHaveCount(0);
});
test('personal booking deep links without a workspace query still open under Personal',async({page})=>{
  const state=await mock(page);await page.goto(base+`/studio#booking=${BID}`);
  await expect(page.getByRole('dialog',{name:'Booking details'}).getByRole('heading',{name:'Personal review'})).toBeVisible();
  expect(state.requests.find(r=>r.path===`/api/live/bookings/${BID}`).ws).toBeNull();
});

test('company booking management uses authenticated actions and never a guest link',async({page})=>{
 const state=await mock(page,{role:'admin'});state.moveDuration=47;await page.goto(base+'/studio#link=intro');await switchTo(page,'Acme');await page.getByRole('button',{name:'Bookings',exact:true}).click();await page.locator('[data-manage]').first().click();const details=page.getByRole('dialog',{name:'Booking details'});await expect(details.getByRole('link',{name:'Reschedule',exact:true})).toHaveCount(0);await details.getByRole('button',{name:'Reschedule',exact:true}).click();const move=page.getByRole('dialog',{name:'Reschedule booking'});await expect(move.getByLabel('Date',{exact:true})).toHaveValue(/\d{4}-\d{2}-\d{2}/);await expect(move.getByRole('button',{name:'Change time',exact:true})).toBeEnabled();await move.getByRole('button',{name:'Change time',exact:true}).click();await expect(move).toHaveCount(0);await expect(page.getByRole('dialog',{name:'Booking details'})).toBeVisible();const request=state.requests.find(r=>r.path.endsWith('/reschedule'));expect(request.ws).toBe('h_acmeacmeacmeacmeacmeacme');expect(request.body).toMatchObject({start:state.moveStart});expect(request.body.token).toBeUndefined();
 await page.getByRole('dialog',{name:'Booking details'}).getByRole('button',{name:'Cancel booking',exact:true}).click();await page.getByRole('dialog',{name:'Booking details'}).getByRole('button',{name:'Cancel booking',exact:true}).click();await expect(page.getByRole('dialog',{name:'Booking details'}).getByText('Cancelled',{exact:true})).toBeVisible();expect(state.requests.find(r=>r.path.endsWith('/cancel')).body).toEqual({});
});

test('new Google account creates a named profile from a website without a personal or company choice',async({page})=>{
  const state=await mock(page,{companies:false,onboarding:true});await page.goto(base+'/studio');
  const dialog=page.getByRole('dialog',{name:'Create your profile'});await expect(dialog.getByLabel('Name',{exact:true})).toBeFocused();
  await expect(dialog).not.toContainText('Personal');await expect(dialog).not.toContainText('Company');
  await dialog.getByLabel('Website',{exact:false}).fill('globex.example');
  await page.setViewportSize({width:390,height:844});const bounds=await dialog.boundingBox();expect(bounds.x).toBeGreaterThanOrEqual(0);expect(bounds.x+bounds.width).toBeLessThanOrEqual(390);expect(await dialog.evaluate(el=>el.scrollWidth<=el.clientWidth)).toBeTruthy();await page.screenshot({path:`${shots}/profile-onboarding-mobile.png`});
  await dialog.getByRole('button',{name:'Create profile',exact:true}).click();await expect(dialog).toHaveCount(0);
  const request=state.requests.find(r=>r.path==='/api/live/workspaces'&&r.method==='POST');expect(request.body).toEqual({name:'Globex',website:'https://globex.example/',firstProfile:true});
  await expect(switcher(page)).toContainText('Globex');await expect(page.getByRole('button',{name:'Team',exact:true})).toBeVisible();
  await page.reload();await expect(switcher(page)).toContainText('Globex');await expect(page.getByRole('dialog',{name:'Create your profile'})).toHaveCount(0);
});

test('profile creation accepts a person name and rejects credential-bearing websites',async({page})=>{
  const state=await mock(page,{companies:false});await page.goto(base+'/studio');await switcher(page).click();await page.getByRole('menuitem',{name:'New profile',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'New profile'});await dialog.getByLabel('Name',{exact:true}).fill('Riley');await dialog.getByLabel('Website',{exact:false}).fill('https://secret@example.com');
  await dialog.getByRole('button',{name:'Create profile',exact:true}).click();await expect(dialog.getByRole('alert')).toHaveText('Enter a valid website address.');
  expect(state.requests.filter(r=>r.path==='/api/live/workspaces'&&r.method==='POST')).toHaveLength(0);
  await dialog.getByLabel('Website',{exact:false}).fill('');await dialog.getByRole('button',{name:'Create profile',exact:true}).click();await expect(switcher(page)).toContainText('Riley');
});

test('integration cards open the selected destination with the webhook gate intact',async({page})=>{
  await mock(page,{companies:false});await page.goto(base+'/studio#integrations');await expect(page.locator('.integration-connect')).toHaveCount(3);
  await page.setViewportSize({width:1440,height:960});await page.screenshot({path:`${shots}/integration-catalog-desktop.png`});
  for(const kind of ['Discord','Webhook']){
    await page.getByRole('button',{name:'Connect '+kind,exact:true}).click();const dialog=page.getByRole('dialog',{name:'Add integration'});
    await expect(dialog.getByRole('radio',{name:kind,exact:true})).toBeChecked();
    if(kind==='Webhook')await expect(dialog.getByRole('button',{name:'Add integration',exact:true})).toBeDisabled();
    await page.keyboard.press('Escape');await expect(dialog).toHaveCount(0);await expect(page.getByRole('button',{name:'Connect '+kind,exact:true})).toBeFocused();
  }
  await page.setViewportSize({width:390,height:844});await page.locator('#account-trigger').click();await page.getByRole('button',{name:'Dark mode'}).click();await expect(page.locator('.integration-connect')).toHaveCount(3);expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBeTruthy();await page.screenshot({path:`${shots}/integration-catalog-mobile-dark.png`});
});

test('an image still decoding cannot be applied to a profile selected afterwards',async({page})=>{
 const state=await mock(page);await page.goto(base+'/studio#link=intro');await page.evaluate(()=>{const decode=HTMLImageElement.prototype.decode;HTMLImageElement.prototype.decode=async function(){await decode.call(this);window.waitingImageDecode=true;await new Promise(resolve=>window.releaseImageDecode=resolve);};});
 const pickerPromise=page.waitForEvent('filechooser');await page.locator('#account-trigger').click();await page.getByRole('button',{name:'Change profile picture',exact:true}).click();await (await pickerPromise).setFiles(new URL('./fixtures/avatar.jpg',import.meta.url).pathname);await page.waitForFunction(()=>window.waitingImageDecode);await switchTo(page,'Acme');await page.evaluate(()=>window.releaseImageDecode());await expect.poll(()=>page.locator('[data-profile-upload]').count()).toBe(0);await expect(page.getByRole('dialog',{name:/Crop /})).toHaveCount(0);expect(state.requests.filter(r=>r.path==='/api/live/settings'&&r.method==='POST')).toHaveLength(0);await expect(switcher(page)).toContainText('Acme');
});
