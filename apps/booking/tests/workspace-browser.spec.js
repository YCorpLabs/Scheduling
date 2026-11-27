import {test,expect} from '@playwright/test';
import {DEFAULT} from '../public/policy.js';
const base=process.env.BOOKING_TEST_ORIGIN||'http://127.0.0.1:8791';
const shots=process.env.BOOKING_SCREENSHOT_DIR||'test-results';
const TOKEN='h_'+'A'.repeat(24)+'.'+'b'.repeat(43);
const caps=role=>({readBookings:true,readAnalytics:true,approveBookings:role!=='viewer',manageSettings:['owner','admin'].includes(role),manageCalendars:['owner','admin'].includes(role),manageMembers:['owner','admin'].includes(role),manageIntegrations:['owner','admin'].includes(role),manageOperations:['owner','admin'].includes(role),transferOwnership:role==='owner',grantAdmin:role==='owner'});
const settingsFor=(hostId,name,title)=>({revision:'A'.repeat(43),hostId,profile:{name,email:'ada@example.com'},accounts:[{id:'a',connected:true,email:'ada@example.com',destinationCalendarId:'primary',conflictCalendarIds:['primary']}],meetingTypes:[{...DEFAULT,id:'intro',slug:'intro',title,accountId:'a',calendarId:'primary'}]});

// Stateful mock of the agreed workspace and integration routes. Nothing here reaches a provider.
async function mock(page,{role='admin',companies=true,authenticated=true,email='ada@example.com',hold,inspect}={}){
  const state={requests:[],role,members:[{id:'h_me',email:'ada@example.com',role},{id:'h_owner',email:'owner@acme.test',role:'owner'},{id:'h_bo',email:'bo@acme.test',role:'member'}],invitations:[{id:'inv1',email:'cy@acme.test',role:'viewer',expiresAt:Date.parse('2026-11-19T12:00:00Z')}],companies:companies?[{id:'h_acmeacmeacmeacmeacmeacme',name:'Acme'}]:[],integrations:[],deliveries:[],hostsReady:false,twentyHostsReady:false,held:{}};
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
    if(path==='/api/live/integrations'&&req.method()==='GET')return json({integrations:state.integrations,deliveries:state.deliveries,status:{customWebhookHostsConfigured:state.hostsReady,customTwentyHostsConfigured:state.twentyHostsReady,summary:{queued:0,quarantined:state.deliveries.filter(d=>d.state==='quarantined').length,failed:state.deliveries.filter(d=>d.state==='failed').length,inFlight:0,overdue:0}},capabilities:{kinds:['slack','discord','twenty','webhook'],events:['booking.requested','booking.confirmed','booking.rescheduled','booking.cancelled','booking.approval_requested','booking.rejected','booking.expired'],customWebhooksRequireApprovedHost:true,customTwentyRequiresApprovedHost:true,atLeastOnce:true}});
    if(path==='/api/live/integrations'){
      if(body.action==='create'){const i={id:'i'+(state.integrations.length+1),kind:body.kind,name:body.name,enabled:body.enabled,events:body.events,includeGuestDetails:body.includeGuestDetails,destinationLabel:new URL(body.url).hostname,revision:1};state.integrations.push(i);return json({integration:i,...(body.kind==='webhook'?{signingSecret:'whsec_test_only_value'}:{})});}
      const i=state.integrations.find(x=>x.id===body.id);if(body.expectedRevision!==i.revision)return json({error:'Integration changed. Refresh before saving.',code:'integration_conflict'},409);
      if(body.action==='remove'){state.integrations=state.integrations.filter(x=>x!==i);return json({ok:true});}
      Object.assign(i,Object.fromEntries(Object.entries(body).filter(([k])=>['name','events','includeGuestDetails','enabled'].includes(k))),{revision:i.revision+1});return json({integration:i});}
    if(path==='/api/live/integrations/test'){state.deliveries.unshift({id:'dtest',integrationId:body.id,eventId:'e',eventType:'integration.test',state:'queued',attempts:0,nextAttemptAt:Date.now(),lastAttemptAt:null,errorCode:null});return json({ok:true,deliveryId:'dtest',state:'queued'});}
    if(path==='/api/live/integrations/retry'){const d=state.deliveries.find(x=>x.id===body.deliveryId);d.state=body.action==='discard'?'cancelled':'queued';d.errorCode=body.action==='discard'?'operator_discarded':null;return json({ok:true});}
    if(path==='/api/live/operations')return json({issues:[]});
    if(path==='/api/live/activity')return json({activity:state.activity||[]});
    if(path==='/api/device/sessions')return json({sessions:state.apps||[]});
    if(path==='/api/device/revoke'){state.apps=(state.apps||[]).filter(a=>a.id!==body.sessionId);return route.fulfill({status:204});}
    if(path==='/api/live/my-calendar')return json({member:{id:'h_me',email:'ada@example.com'},account:null,calendars:[],schedule:{zone:'UTC',weeklyHours:{},dateOverrides:{}},scheduleConfigured:false,readiness:'not_connected',revision:'rev1'});
    if(path.startsWith('/api/live/my-calendar/events'))return json({events:[],calendars:[]});
    return json({error:'Not mocked'},404);
  });
  return state;
}
// The name menu at the top of the sidebar: its button names the open profile (the person, or the team),
// and it holds the profiles ("Switch to", only with more than one), Settings and Sign out.
const switcher=page=>page.locator('#account-trigger');
const nav=page=>page.getByRole('navigation',{name:'Scheduling'});
const accountMenu=page=>page.getByRole('dialog',{name:'Account',exact:true});
const profiles=page=>accountMenu(page).getByRole('group',{name:'Switch to'}).getByRole('button');
async function openMenu(page){if(!await accountMenu(page).isVisible())await switcher(page).click();await expect(accountMenu(page)).toBeVisible();return accountMenu(page);}
async function switchTo(page,name){await openMenu(page);await profiles(page).filter({hasText:new RegExp(name)}).click();}
async function openSettings(page,name){const pages=page.getByRole('navigation',{name:'Settings'});if(!await pages.isVisible())await (await openMenu(page)).getByRole('button',{name:'Settings',exact:true}).click();if(name){await pages.getByRole('button',{name,exact:true}).click();await expect(page.getByRole('heading',{name,level:1})).toBeVisible();}}
// Settings → Notifications (the Integrations page before).
const notifications=page=>openSettings(page,'Notifications');
// Theme and New team live in Settings → Sign-in & data.
async function setTheme(page,choice){await openSettings(page,'Sign-in & data');await page.getByRole('group',{name:'Theme'}).getByRole('button',{name:choice,exact:true}).click();await expect(page.locator('html')).toHaveAttribute('data-theme',choice.toLowerCase());}
async function newTeam(page){await openSettings(page,'Sign-in & data');await page.getByRole('button',{name:'New team',exact:true}).click();}
const upcoming=page=>expect(page.getByRole('heading',{name:'Upcoming',level:2})).toBeVisible();

test('the name menu switches profile, scopes company requests, keeps identity personal and survives reload and theme',async({page})=>{
  const state=await mock(page);await page.goto(base+'/studio#link=intro');
  await expect(page.locator('#edit-title')).toHaveValue('Personal intro');
  const firstSettings=state.requests.findIndex(r=>r.path==='/api/live/settings'),firstList=state.requests.findIndex(r=>r.path==='/api/live/workspaces');
  expect(firstList).toBeGreaterThan(-1);expect(firstList).toBeLessThan(firstSettings);expect(state.requests[firstSettings].ws).toBeNull();
  await expect(page.getByRole('button',{name:'Team'})).toHaveCount(0);
  await expect(switcher(page)).toHaveAccessibleName('Ada, account menu');
  // keyboard: open with ArrowDown on the active profile, Escape returns focus, move and Enter switches
  await switcher(page).focus();await page.keyboard.press('ArrowDown');await expect(profiles(page).filter({hasText:'Ada'})).toBeFocused();await expect(profiles(page).filter({hasText:'Ada'})).toHaveAttribute('aria-pressed','true');
  await page.keyboard.press('Escape');await expect(switcher(page)).toBeFocused();await expect(page.locator('#account-menu')).toBeHidden();
  await page.keyboard.press('ArrowDown');await page.keyboard.press('ArrowDown');await expect(profiles(page).filter({hasText:'Acme'})).toBeFocused();await page.keyboard.press('Enter');
  await expect(page.locator('#edit-title')).toHaveValue('Acme demo');await expect(switcher(page)).toBeFocused();
  expect(state.requests.filter(r=>r.path==='/api/live/settings').at(-1).ws).toBe('h_acmeacmeacmeacmeacmeacme');
  expect(state.requests.filter(r=>r.path==='/api/live/workspaces').every(r=>r.ws===null)).toBeTruthy();
  // The button names the team; the person stays the signed-in identity inside the menu.
  await expect(switcher(page).locator('strong')).toHaveText('Acme');await expect(switcher(page)).toHaveAccessibleName('Acme, account menu');
  await openMenu(page);await expect(accountMenu(page).locator('.account-who')).toContainText('Ada');await expect(accountMenu(page).locator('.account-who')).toContainText('ada@example.com');
  await expect(profiles(page)).toHaveText([/Ada/,/Acme/]);await expect(profiles(page).filter({hasText:'Acme'})).toHaveAttribute('aria-pressed','true');await expect(profiles(page).filter({hasText:'Ada'})).toHaveAttribute('aria-pressed','false');
  await expect(accountMenu(page).getByRole('button',{name:'Settings',exact:true})).toBeVisible();await page.keyboard.press('Escape');
  await expect(nav(page).getByRole('button')).toHaveText(['Home','Links','Availability','Team']);
  await nav(page).getByRole('button',{name:'Availability',exact:true}).click();await expect(page.locator('a[href^="/auth/google?connect=1&workspace=h_acme"]').first()).toBeVisible();
  await page.setViewportSize({width:1440,height:960});await nav(page).getByRole('button',{name:'Links',exact:true}).click();await openMenu(page);await page.screenshot({path:`${shots}/workspace-switcher.png`});await page.keyboard.press('Escape');
  await page.reload();await expect(page.getByRole('button',{name:'Edit Acme demo',exact:true})).toBeVisible();
  await setTheme(page,'Dark');await page.getByRole('button',{name:'Back',exact:true}).click();await expect(switcher(page)).toContainText('Acme');
  await nav(page).getByRole('button',{name:'Links',exact:true}).click();await expect(page.getByRole('button',{name:'Edit Acme demo',exact:true})).toBeVisible();
});

test('after a reload in a team the name menu names the team and, inside, the signed-in person, never "Your account"',async({page})=>{
  await page.addInitScript(()=>localStorage.setItem('scheduling-workspace',JSON.stringify({account:'h_me',id:'h_acmeacmeacmeacmeacmeacme',name:'Acme'})));
  const state=await mock(page);let releasePersonal;
  // Hold the personal profile so the first paint in the team is checked too.
  let held=false;await page.route('**/api/live/settings',async route=>{if(!held&&!route.request().headers()['x-scheduling-workspace']){held=true;await new Promise(resolve=>releasePersonal=resolve);}return route.fallback();});
  await page.goto(base+'/studio');await expect(switcher(page)).toContainText('Acme');
  const trigger=switcher(page),who=page.locator('#account-menu .account-who');
  await expect(trigger).not.toContainText('Your account');await expect(trigger.locator('strong')).toHaveText('Acme');await expect(trigger.locator('.me-mark')).toHaveText('A');
  await expect(who.locator('strong')).toHaveText('ada@example.com');await expect(who.locator('.host-avatar')).toHaveText('A');await expect(page.locator('#account-menu')).not.toContainText('Your account');
  await expect.poll(()=>!!releasePersonal).toBe(true);releasePersonal();
  await expect(who.locator('strong')).toHaveText('Ada');await expect(who.locator('.host-avatar')).toHaveText('A');await expect(trigger.locator('strong')).toHaveText('Acme');
  expect(state.requests.filter(r=>r.path==='/api/live/settings').map(r=>r.ws)).toContain(null);
  await page.reload();await expect(trigger.locator('strong')).toHaveText('Acme');await openMenu(page);await expect(who).toContainText('Ada');await expect(who).toContainText('ada@example.com');
  await expect(profiles(page)).toHaveText([/Ada/,/Acme/]);await expect(profiles(page).first()).not.toContainText('Personal');
});

test('in a team, Profile and Notifications say "For <team>" 4px under the heading; personal pages show nothing extra',async({page})=>{
  await mock(page);await page.setViewportSize({width:1440,height:900});await page.goto(base+'/studio#settings/profile');
  await expect(page.locator('h1')).toHaveText('Profile');await expect(page.locator('.st-for')).toHaveCount(0);
  await page.goto('about:blank');await page.goto(base+'/studio#link=intro');await switchTo(page,'Acme');await expect(page.locator('#edit-title')).toHaveValue('Acme demo');
  await openSettings(page);await expect(page.locator('h1')).toHaveText('Profile');
  await expect(page.locator('.st-for')).toHaveText('For Acme');
  const gap=await page.evaluate(()=>{const r=s=>document.querySelector(s).getBoundingClientRect();return {underHeading:r('.st-for').top-r('#main h1').bottom,leadAfter:r('.st-lead').top-r('.st-for').bottom,toContent:r('.pf-grid').top-r('.st-lead').bottom};});
  expect(gap).toEqual({underHeading:4,leadAfter:0,toContent:32});await expect(page.locator('.st-for + .st-lead')).toHaveText('Guests see this on your booking pages.');
  const pages=page.getByRole('navigation',{name:'Settings'});
  await pages.getByRole('button',{name:'Notifications',exact:true}).click();await expect(page.locator('h1')).toHaveText('Notifications');await expect(page.locator('.st-for')).toHaveText('For Acme');await expect(page.locator('.st-for + .st-lead')).toHaveText('Post new and changed bookings where your team will see them.');
  for(const name of ['Connected apps','Sign-in & data']){await pages.getByRole('button',{name,exact:true}).click();await expect(page.locator('h1')).toHaveText(name);await expect(page.locator('.st-for')).toHaveCount(0);}
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
  await page.goto(base+'/studio#link=intro');await expect(page.locator('#edit-title')).toHaveValue('Personal intro');
  // The name menu is still there, with nothing to switch to and no way to make a team.
  await expect(switcher(page)).toHaveText(/Ada/);const menu=await openMenu(page);await expect(menu.getByRole('button')).toHaveText(['Settings','Sign out']);await expect(menu.locator('[data-workspace]')).toHaveCount(0);
  await openSettings(page,'Sign-in & data');await expect(page.getByRole('button',{name:'New team',exact:true})).toHaveCount(0);await expect(page.locator('[data-create-workspace]')).toHaveCount(0);
});

test('unsaved meeting edits are guarded when switching',async({page})=>{
  await mock(page);await page.goto(base+'/studio#link=intro');await page.locator('#edit-title').fill('Changed title');
  await switchTo(page,'Acme');const dialog=page.getByRole('dialog',{name:'Unsaved changes'});await expect(dialog).toBeVisible();await expect(dialog.getByRole('button',{name:'Keep editing'})).toBeFocused();
  await dialog.getByRole('button',{name:'Keep editing'}).click();await expect(page.locator('#edit-title')).toHaveValue('Changed title');await expect(switcher(page)).toContainText('Ada');
  await switchTo(page,'Acme');await page.getByRole('button',{name:'Discard changes'}).click();await expect(page.locator('#edit-title')).toHaveValue('Acme demo');
});

test('late responses from the previous workspace never repaint the new one',async({page})=>{
  const state=await mock(page,{hold:['/api/live/bookings|personal','/api/live/analytics|personal']});await page.goto(base+'/studio#link=intro');
  await nav(page).getByRole('button',{name:'Home',exact:true}).click();await expect.poll(()=>!!state.held['/api/live/bookings|personal']).toBeTruthy();
  await switchTo(page,'Acme');await expect(page.locator('.hm-row')).toContainText('Acme booking');
  state.release('/api/live/bookings|personal');await page.waitForTimeout(150);await expect(page.locator('.hm-row')).toContainText('Acme booking');await expect(page.getByText('Personal booking')).toHaveCount(0);
  await switchTo(page,'Ada');await nav(page).getByRole('button',{name:'Links',exact:true}).click();await page.getByRole('button',{name:'Stats',exact:true}).click();await expect.poll(()=>!!state.held['/api/live/analytics|personal']).toBeTruthy();
  await switchTo(page,'Acme');await expect(page.locator('.analytics-card').first()).toContainText('7');
  state.release('/api/live/analytics|personal');await page.waitForTimeout(150);await expect(page.locator('.analytics-card').first()).toContainText('7');await expect(switcher(page)).toContainText('Acme');
});

test('membership removal shows recovery instead of stale company controls',async({page})=>{
  const state=await mock(page);await page.goto(base+'/studio#link=intro');await switchTo(page,'Acme');await expect(page.locator('#edit-title')).toHaveValue('Acme demo');
  await page.getByRole('button',{name:'Team'}).click();await expect(page.locator('[aria-labelledby=team-members-title] .team-row')).toHaveCount(3);
  state.companies=[];await nav(page).getByRole('button',{name:'Home',exact:true}).click();
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
  await expect(page.locator('.team-row').filter({hasText:'bo@acme.test'})).toContainText('Owner');await expect(page.locator('.team-row').filter({hasText:'ada@example.com'})).toContainText('Admin');
  expect(state.requests.filter(r=>r.path==='/api/live/workspace/members').map(r=>r.body.action)).toEqual(['role','remove','transfer']);
  await page.setViewportSize({width:390,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBeTruthy();await page.screenshot({path:`${shots}/workspace-team-mobile.png`,fullPage:true});
});

test('members and viewers get read-only company access with no admin settings',async({page})=>{
  await mock(page,{role:'viewer'});await page.goto(base+'/studio#link=intro');await switchTo(page,'Acme');
  await upcoming(page);
  await expect(nav(page).getByRole('button')).toHaveText(['Home','Team']);
  for(const name of ['Links','Availability','Integrations'])await expect(page.getByRole('button',{name,exact:true})).toHaveCount(0);
  const menu=await openMenu(page);await expect(menu.getByRole('button')).toHaveText([/Ada/,/Acme/,'Settings','Sign out']);
  for(const name of [/Troubleshooting/,'Edit profile','Change profile picture','Company profile'])await expect(menu.getByRole('button',{name})).toHaveCount(0);
  await page.keyboard.press('Escape');
  // Settings keeps the account-level pages; the team's Profile and Notifications need admin rights.
  await openSettings(page);await expect(page.getByRole('navigation',{name:'Settings'}).getByRole('button')).toHaveText(['Connected apps','Sign-in & data']);await page.getByRole('button',{name:'Back',exact:true}).click();
  await page.getByRole('button',{name:'Team'}).click();await expect(page.locator('.team-row')).toHaveCount(3);await expect(page.locator('[data-manage-member]')).toHaveCount(0);await expect(page.getByText('Pending invitations')).toHaveCount(0);await expect(page.getByRole('button',{name:'Invite',exact:true})).toHaveCount(0);
  await page.getByRole('button',{name:'Leave Acme'}).click();const leave=page.getByRole('dialog',{name:'Leave Acme?'});await expect(leave.getByRole('button',{name:'Cancel'})).toBeFocused();await leave.getByRole('button',{name:'Leave Acme',exact:true}).click();
  await expect(switcher(page)).toContainText('Ada');await expect(page.locator('#host-status')).toHaveText('You left Acme');await openMenu(page);await expect(accountMenu(page).locator('[data-workspace]')).toHaveCount(0);await expect(accountMenu(page)).not.toContainText('Acme');
});

test('integrations: write-only URL, webhook host gate, one-time secret, test, retry and discard',async({page})=>{
  const state=await mock(page);await page.goto(base+'/studio#link=intro');await notifications(page);
  await expect(page.locator('.integration-choice')).toHaveCount(4);await expect(page.getByRole('button',{name:'Add integration',exact:true})).toHaveCount(0);
  await expect(page.getByRole('button',{name:'Connect Webhook',exact:true})).toHaveCount(0);await expect(page.locator('.integration-choice.is-unavailable')).toContainText('Not available on this service');
  await page.getByRole('button',{name:'Connect Slack',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'Connect Slack'});await expect(dialog.getByLabel('Slack webhook URL')).toBeFocused();await expect(dialog.getByLabel('Name',{exact:true})).toHaveValue('Slack');
  await expect(dialog.getByText('Include guest name and email')).toBeVisible();
  await expect(dialog.locator('[data-events-summary]')).toHaveText('Confirmed, cancelled');await expect(dialog.getByRole('checkbox',{name:'Confirmed'})).toBeHidden();
  await expect(dialog.getByRole('link',{name:'Create an incoming webhook in Slack'})).toHaveAttribute('rel','noopener noreferrer');
  await dialog.getByLabel('Name',{exact:true}).fill('Ops');await dialog.getByRole('button',{name:'Connect',exact:true}).click();
  await expect(dialog.getByText('Paste the Slack webhook URL.')).toBeVisible();await expect(dialog.getByLabel('Slack webhook URL')).toBeFocused();await expect(dialog.getByLabel('Slack webhook URL')).toHaveAttribute('aria-invalid','true');
  await dialog.getByLabel('Slack webhook URL').fill('https://hooks.slack.com/services/T0/B0/secretpart');await expect(dialog.getByLabel('Slack webhook URL')).not.toHaveAttribute('aria-invalid','true');
  await dialog.getByRole('button',{name:'Connect',exact:true}).click();await expect(dialog.getByText('This isn’t a Slack incoming webhook URL.')).toBeVisible();
  expect(state.requests.some(r=>r.path==='/api/live/integrations'&&r.method==='POST')).toBe(false);
  await dialog.getByLabel('Slack webhook URL').fill('https://hooks.slack.com/services/T0123456/B0123456/secretpartsecretpart');await page.setViewportSize({width:1280,height:1000});await page.screenshot({path:`${shots}/integration-editor.png`});
  await dialog.getByRole('button',{name:'Connect',exact:true}).click();await expect(dialog).toHaveCount(0);
  const connected=page.getByRole('dialog',{name:'Ops is connected'});await expect(connected.getByRole('button',{name:'Send test'})).toBeFocused();await connected.getByRole('button',{name:'Done'}).click();await expect(connected).toHaveCount(0);await expect(page.getByRole('button',{name:'Edit Ops'})).toBeFocused();
  const created=state.requests.find(r=>r.path==='/api/live/integrations'&&r.method==='POST').body;expect(created).toMatchObject({action:'create',kind:'slack',name:'Ops',events:['booking.confirmed','booking.cancelled'],includeGuestDetails:false,enabled:true});
  await expect(page.locator('.integration-row')).toContainText('Slack · Confirmed, cancelled');await expect(page.getByRole('button',{name:'Add integration',exact:true})).toBeVisible();expect(await page.content()).not.toContain('secretpart');
  await expect(page.locator('.integration-row .pill')).toHaveCount(0);
  await page.getByRole('button',{name:'More for Ops'}).click();await expect(page.getByRole('menuitem')).toHaveText(['Send test','Edit','Turn off','Remove…']);await page.getByRole('menuitem',{name:'Send test'}).click();
  await expect(page.locator('#host-status')).toHaveText('Test notification queued');await expect(page.locator('.delivery-entry')).toContainText('Test notification');await expect(page.getByRole('button',{name:'More for Ops'})).toBeFocused();
  await page.getByRole('button',{name:'More for Ops'}).click();await page.getByRole('menuitem',{name:'Turn off'}).click();
  await expect(page.getByRole('button',{name:'More for Ops'})).toBeFocused();expect(state.requests.filter(r=>r.body?.action==='update').at(-1).body).toMatchObject({id:'i1',enabled:false,expectedRevision:1});
  await expect(page.locator('.integration-row.off .st-line')).toHaveText(/^Off · Slack/);await expect(page.locator('#host-status')).toHaveText('Ops is off');
  await page.getByRole('button',{name:'More for Ops'}).click();await expect(page.getByRole('menuitem')).toHaveText(['Turn on','Edit','Remove…']);await page.keyboard.press('Escape');
  // generic webhook with approved hosts returns a one-time secret
  state.hostsReady=true;await notifications(page);await page.getByRole('button',{name:'Add integration',exact:true}).click();await expect(page.getByRole('menuitem')).toHaveText(['Slack','Discord','Twenty CRM','Webhook']);await page.getByRole('menuitem',{name:'Webhook'}).click();const hook=page.getByRole('dialog',{name:'Connect Webhook'});
  await hook.getByLabel('Name',{exact:true}).fill('CRM');await hook.getByLabel('Endpoint URL').fill('https://crm.example/hooks');await hook.getByRole('button',{name:'Connect',exact:true}).click();
  const secret=page.getByRole('dialog',{name:'Signing secret'});await expect(secret.getByRole('textbox',{name:'Signing secret'})).toHaveAttribute('type','password');await expect(secret.getByRole('button',{name:'Copy'})).toBeFocused();await secret.getByRole('button',{name:'Reveal'}).click();await expect(secret.getByRole('textbox',{name:'Signing secret'})).toHaveValue('whsec_test_only_value');
  await page.screenshot({path:`${shots}/integration-secret.png`});await secret.getByRole('button',{name:'Done'}).click();await expect(page.locator('dialog')).toHaveCount(0);await expect(page.getByRole('button',{name:'Edit CRM'})).toBeFocused();
  expect(await page.evaluate(()=>JSON.stringify({...localStorage})+JSON.stringify({...sessionStorage}))).not.toContain('whsec');expect(await page.content()).not.toContain('whsec');
  state.deliveries.push({id:'dfail',integrationId:'i2',eventId:'e2',eventType:'booking.confirmed',state:'failed',attempts:4,nextAttemptAt:null,lastAttemptAt:Date.now()-60000,errorCode:'provider_rejected'},{id:'dheld',integrationId:'i2',eventId:'e3',eventType:'booking.cancelled',state:'quarantined',attempts:1,nextAttemptAt:null,lastAttemptAt:Date.now()-120000,errorCode:'restored'});
  await notifications(page);await expect(page.getByText('1 delivery is held after a restore')).toBeVisible();
  const crm=page.locator('.integration-row',{hasText:'CRM'});await expect(crm.locator('.st-line-problem')).toHaveText('Failing · Rejected by the destination. Check the URL.');
  await crm.getByRole('button',{name:'More for CRM'}).click();await expect(page.getByRole('menuitem',{name:'Send test'})).toBeVisible();await page.keyboard.press('Escape');await expect(page.locator('.integration-row',{hasText:'Ops'}).locator('.st-line-problem')).toHaveCount(0);
  await expect(page.locator('.integration-log > summary')).toContainText('2 need attention');
  await page.getByRole('button',{name:'Retry Booking confirmed'}).click();await expect(page.locator('#host-status')).toHaveText('Delivery queued for retry');
  await page.getByRole('button',{name:'Discard Booking cancelled'}).click();const discard=page.getByRole('dialog',{name:'Discard this delivery?'});await expect(discard).toContainText('will not be sent or replayed');await discard.getByRole('button',{name:'Discard delivery'}).click();
  await expect(page.getByText('held after a restore')).toHaveCount(0);expect(state.requests.filter(r=>r.path==='/api/live/integrations/retry').map(r=>r.body)).toEqual([{deliveryId:'dfail'},{deliveryId:'dheld',action:'discard'}]);
  await page.screenshot({path:`${shots}/integrations-list.png`,fullPage:true});
  await setTheme(page,'Dark');await notifications(page);await page.screenshot({path:`${shots}/integrations-dark.png`,fullPage:true});
  await page.setViewportSize({width:390,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBeTruthy();await page.screenshot({path:`${shots}/integrations-mobile.png`,fullPage:true});
});

test('integration edits keep the saved URL unless replaced, and removal needs a confirmation',async({page})=>{
  const state=await mock(page,{companies:false});state.hostsReady=true;
  state.integrations=[{id:'i1',kind:'webhook',name:'CRM',enabled:true,events:['booking.confirmed'],includeGuestDetails:false,destinationLabel:'crm.example',revision:3}];
  await page.goto(base+'/studio#integrations');await page.getByRole('button',{name:'Edit CRM'}).click();
  const edit=page.getByRole('dialog',{name:'Edit CRM'});await expect(edit.getByLabel('Name',{exact:true})).toBeFocused();await expect(edit.getByText('crm.example')).toBeVisible();await expect(edit.getByLabel('New URL')).toBeHidden();
  await edit.getByRole('button',{name:'Replace URL'}).click();await expect(edit.getByLabel('New URL')).toBeFocused();await edit.getByRole('button',{name:'Keep current URL'}).click();await expect(edit.getByLabel('New URL')).toBeHidden();
  await edit.getByLabel('Name',{exact:true}).fill('CRM sync');await edit.locator('summary',{hasText:'Send when'}).click();await edit.getByRole('checkbox',{name:'Confirmed'}).click();await expect(edit.locator('[data-events-summary]')).toHaveText('No events');
  await edit.locator('summary',{hasText:'Send when'}).click();await edit.getByRole('button',{name:'Save changes'}).click();await expect(edit.getByText('Choose at least one event.')).toBeVisible();await expect(edit.getByRole('checkbox',{name:'Requested'})).toBeFocused();
  await edit.getByRole('checkbox',{name:'Confirmed'}).click();await edit.getByRole('checkbox',{name:'Rescheduled'}).click();await expect(edit.locator('[data-events-summary]')).toHaveText('Confirmed, rescheduled');await edit.getByRole('button',{name:'Save changes'}).click();await expect(edit).toHaveCount(0);
  const saved=state.requests.filter(r=>r.body?.action==='update').at(-1).body;expect(saved).toMatchObject({id:'i1',name:'CRM sync',events:['booking.confirmed','booking.rescheduled'],enabled:true,expectedRevision:3});expect('url' in saved).toBe(false);
  await expect(page.locator('.integration-row')).toContainText('Webhook · crm.example · Confirmed, rescheduled');await expect(page.getByRole('button',{name:'Edit CRM sync'})).toBeFocused();
  await page.getByRole('button',{name:'More for CRM sync'}).click();await expect(page.getByRole('menuitem')).toHaveText(['Send test','Edit','Turn off','Remove…']);await page.getByRole('menuitem',{name:'Remove…'}).click();
  const remove=page.getByRole('dialog',{name:'Remove CRM sync'});await expect(remove).toContainText('CRM sync stops receiving booking updates.');await remove.getByRole('button',{name:'Cancel'}).click();await expect(remove).toHaveCount(0);
  expect(state.requests.some(r=>r.body?.action==='remove')).toBe(false);
  await page.getByRole('button',{name:'More for CRM sync'}).click();await page.getByRole('menuitem',{name:'Remove…'}).click();await page.getByRole('dialog',{name:'Remove CRM sync'}).getByRole('button',{name:'Remove integration'}).click();
  await expect(page.locator('.integration-row:not(.integration-choice)')).toHaveCount(0);await expect(page.locator('.integration-choice')).toHaveCount(4);expect(state.requests.filter(r=>r.body?.action==='remove').at(-1).body).toMatchObject({id:'i1',expectedRevision:4});await expect(page.getByRole('button',{name:'Connect Slack'})).toBeFocused();
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
  expect(list).toBeLessThan(firstScoped);expect(state.requests.filter(r=>r.path.startsWith('/api/live/bookings')).every(r=>r.ws===ACME)).toBeTruthy();
  // Besides the company's settings, only the person's own profile is read, after the listing, for their name on the account button.
  const reads=state.requests.filter(r=>r.path==='/api/live/settings');expect(reads.filter(r=>r.ws!==ACME)).toHaveLength(1);expect(reads.find(r=>r.ws!==ACME).ws).toBeNull();expect(state.requests.indexOf(reads.find(r=>r.ws===null))).toBeGreaterThan(list);
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
 const state=await mock(page,{role:'admin'});state.moveDuration=47;await page.goto(base+'/studio#link=intro');await switchTo(page,'Acme');await nav(page).getByRole('button',{name:'Home',exact:true}).click();await page.locator('[data-manage]').first().click();const details=page.getByRole('dialog',{name:'Booking details'});await expect(details.getByRole('link',{name:'Reschedule',exact:true})).toHaveCount(0);await details.getByRole('button',{name:'Reschedule',exact:true}).click();const move=page.getByRole('dialog',{name:'Reschedule booking'});await expect(move.getByLabel('Date',{exact:true})).toHaveValue(/\d{4}-\d{2}-\d{2}/);await expect(move.getByRole('button',{name:'Change time',exact:true})).toBeEnabled();await move.getByRole('button',{name:'Change time',exact:true}).click();await expect(move).toHaveCount(0);await expect(page.getByRole('dialog',{name:'Booking details'})).toBeVisible();const request=state.requests.find(r=>r.path.endsWith('/reschedule'));expect(request.ws).toBe('h_acmeacmeacmeacmeacmeacme');expect(request.body).toMatchObject({start:state.moveStart});expect(request.body.token).toBeUndefined();
 await page.getByRole('dialog',{name:'Booking details'}).getByRole('button',{name:'Cancel booking',exact:true}).click();await page.getByRole('dialog',{name:'Booking details'}).getByRole('button',{name:'Cancel booking',exact:true}).click();await expect(page.getByRole('dialog',{name:'Booking details'}).getByText('Cancelled',{exact:true})).toBeVisible();expect(state.requests.find(r=>r.path.endsWith('/cancel')).body).toEqual({});
});

test('a new team from Settings is named from its website alone, the dialog fits a phone, and the team opens on Home',async({page})=>{
  const state=await mock(page,{companies:false});await page.goto(base+'/studio');await expect(switcher(page)).toHaveText(/Ada/);await newTeam(page);
  const dialog=page.getByRole('dialog',{name:'New team'});await expect(dialog.getByLabel('Name',{exact:true})).toBeFocused();
  await dialog.getByLabel('Website',{exact:false}).fill('globex.example');
  await page.setViewportSize({width:390,height:844});const bounds=await dialog.boundingBox();expect(bounds.x).toBeGreaterThanOrEqual(0);expect(bounds.x+bounds.width).toBeLessThanOrEqual(390);expect(await dialog.evaluate(el=>el.scrollWidth<=el.clientWidth)).toBeTruthy();await page.screenshot({path:`${shots}/team-create-mobile.png`});
  await page.setViewportSize({width:1280,height:900});await dialog.getByRole('button',{name:'Create team',exact:true}).click();await expect(dialog).toHaveCount(0);
  const request=state.requests.find(r=>r.path==='/api/live/workspaces'&&r.method==='POST');expect(request.body).toEqual({name:'Globex',website:'https://globex.example/'});
  await expect(switcher(page)).toContainText('Globex');await upcoming(page);await expect(page).toHaveTitle(/^Home · /);await expect(nav(page).getByRole('button',{name:'Team',exact:true})).toBeVisible();
  await openMenu(page);await expect(profiles(page)).toHaveText([/Ada/,/Globex/]);await page.keyboard.press('Escape');
  await page.reload();await expect(switcher(page)).toContainText('Globex');
});

test('profile creation accepts a person name and rejects credential-bearing websites',async({page})=>{
  const state=await mock(page,{companies:false});await page.goto(base+'/studio');await expect(switcher(page)).toHaveText(/Ada/);await newTeam(page);
  const dialog=page.getByRole('dialog',{name:'New team'});await dialog.getByLabel('Name',{exact:true}).fill('Riley');await dialog.getByLabel('Website',{exact:false}).fill('https://secret@example.com');
  await dialog.getByRole('button',{name:'Create team',exact:true}).click();await expect(dialog.getByRole('alert')).toHaveText('Enter a valid website address.');
  expect(state.requests.filter(r=>r.path==='/api/live/workspaces'&&r.method==='POST')).toHaveLength(0);
  await dialog.getByLabel('Website',{exact:false}).fill('');await dialog.getByRole('button',{name:'Create team',exact:true}).click();await expect(switcher(page)).toContainText('Riley');
});

test('a test notification reports its outcome without a manual refresh and keeps focus',async({page})=>{
  const state=await mock(page,{companies:false});state.integrations=[{id:'i1',kind:'slack',name:'Ops',enabled:true,events:['booking.confirmed'],includeGuestDetails:false,destinationLabel:'hooks.slack.com',revision:1}];
  await page.goto(base+'/studio#integrations');await page.getByRole('button',{name:'More for Ops'}).click();await page.getByRole('menuitem',{name:'Send test'}).click();await expect(page.locator('#host-status')).toHaveText('Test notification queued');
  Object.assign(state.deliveries[0],{state:'delivered',attempts:1,lastAttemptAt:Date.now()});
  await expect(page.locator('#host-status')).toHaveText('Test delivered to Ops',{timeout:8000});await expect(page.locator('.delivery-entry .booking-badge')).toHaveText('Delivered');
  await expect(page.getByRole('button',{name:'More for Ops'})).toBeFocused();
  const reads=()=>state.requests.filter(r=>r.path==='/api/live/integrations'&&r.method==='GET').length,before=reads();
  await page.locator('summary',{hasText:'Recent deliveries'}).click();await expect.poll(reads).toBe(before+1);await expect(page.locator('.delivery-entry').first()).toBeVisible();await expect(page.locator('#deliveries-title')).toBeFocused();
});

test('right after connecting, a test message reports delivery in the dialog and Escape still closes it',async({page})=>{
  const state=await mock(page,{companies:false});await page.goto(base+'/studio#integrations');await page.getByRole('button',{name:'Connect Discord',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'Connect Discord'});await dialog.getByLabel('Discord webhook URL').fill('https://discord.com/api/webhooks/123456789/abcdefghijklmnopqrstuvwxyz');await dialog.getByRole('button',{name:'Connect',exact:true}).click();
  const connected=page.getByRole('dialog',{name:'Discord is connected'});await connected.getByRole('button',{name:'Send test'}).click();await expect(connected.getByRole('status')).toHaveText('Sending…');
  await expect.poll(()=>state.deliveries.length).toBe(1);Object.assign(state.deliveries[0],{state:'failed',attempts:1,lastAttemptAt:Date.now(),errorCode:'provider_rejected'});
  await expect(connected.getByRole('status')).toHaveText('Not delivered: Rejected by the destination. Check the URL.',{timeout:8000});await expect(connected.getByRole('button',{name:'Send again'})).toBeEnabled();
  await page.screenshot({path:`${shots}/integration-connected-test.png`});
  await expect(page.locator('.integration-row .st-line-problem')).toHaveText('Failing · Rejected by the destination. Check the URL.');
  // While the result is still pending, Escape closes the dialog.
  await connected.getByRole('button',{name:'Send again'}).click();await expect.poll(()=>state.deliveries.length).toBe(2);
  await expect(async()=>{await page.keyboard.press('Escape');await expect(connected).toHaveCount(0,{timeout:250});}).toPass({timeout:5000});
});

test('connected apps list Email and AI apps; an app page shows its recent changes, opens a booking and disconnects it',async({page})=>{
  const state=await mock(page,{companies:false});const now=Date.now();
  state.activity=[{id:'a1',at:now-60000,actor:{kind:'mcp',name:'Claude',sessionId:'s1'},action:'decide_booking',summary:'Approved Personal booking with Guest on 2026-11-18 10:00',target:{type:'booking',id:'b'.repeat(20)}},{id:'a2',at:now-3600000,actor:{kind:'mcp',name:'Claude',sessionId:'s1'},action:'update_hours',summary:'Updated availability: weekly hours',target:{type:'hours',id:'default'}},{id:'a3',at:now-7200000,actor:{kind:'mcp',name:'Cursor',sessionId:'gone'},action:'update_link',summary:'Updated link Intro (/intro)'}];
  state.apps=[{id:'s1',name:'Claude',kind:'mcp',scope:'booking:read booking:settings booking:manage',createdAt:now-86400000,expiresAt:now+86400000},{id:'s2',name:"Email on Ada's Mac",scope:'booking:read email:tracking',createdAt:now-172800000,expiresAt:now+86400000},{id:'s3',name:'Tasks app',kind:'mcp',scope:'booking:read',createdAt:now-259200000,expiresAt:now+86400000}];
  await page.setViewportSize({width:1280,height:900});await page.goto(base+'/studio#activity');
  await expect(page.locator('h1')).toHaveText('Connected apps');await expect(page).toHaveURL(/#settings\/apps$/);
  await expect(page.getByRole('navigation',{name:'Settings'}).getByRole('button',{name:'Connected apps'})).toHaveAttribute('aria-current','page');
  const rows=page.locator('[data-app]');await expect(rows.locator('.st-name')).toHaveText(['Claude','Email','Tasks app']);
  await expect(rows.locator('.st-line')).toHaveText(['Can make changes · 2 this week',"Ada's Mac · Read only",'Read only']);
  await expect(rows.nth(0).locator('.st-tile svg path')).toHaveAttribute('fill','#D97757');await expect(rows.nth(1).locator('img')).toHaveAttribute('src','/email-app-icon.png');await expect(rows.nth(2).locator('.st-tile svg rect')).toHaveCount(1);
  await page.screenshot({path:`${shots}/activity.png`,fullPage:true});
  await rows.nth(0).click();await expect(page).toHaveURL(/#settings\/apps\/s1$/);
  await expect(page.locator('h1')).toHaveText('Claude');await expect(page.locator('.st-lead')).toHaveText(/^Can change your links, hours and bookings\. Connected /);
  // An entry stored before structured detail keeps its words; its machine time reads like the Studio.
  await expect(page.locator('.st-change-what')).toHaveText([/^Approved Personal booking with Guest on Wed,? (Nov 18|18 Nov), 10:00$/,'Updated availability: weekly hours']);
  await page.getByRole('button',{name:/Approved Personal booking/}).click();await expect(page.getByRole('dialog')).toBeVisible();await page.keyboard.press('Escape');
  await page.getByRole('button',{name:'Disconnect Claude'}).click();const confirm=page.getByRole('dialog',{name:'Disconnect Claude?'});await expect(confirm).toContainText('It loses access right away.');await confirm.getByRole('button',{name:'Disconnect'}).click();
  await expect(page.locator('h1')).toHaveText('Connected apps');await expect(page.locator('#host-status')).toHaveText('Claude disconnected');await expect(rows).toHaveCount(2);
  expect(state.requests.filter(r=>r.path==='/api/device/revoke').map(r=>r.body)).toEqual([{sessionId:'s1'}]);
  await rows.nth(0).click();await page.getByRole('button',{name:'Connected apps',exact:true}).first().click();await expect(page.locator('h1')).toHaveText('Connected apps');
  await page.setViewportSize({width:390,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBeTruthy();await expect(page.getByRole('button',{name:'Settings',exact:true}).first()).toBeVisible();await page.screenshot({path:`${shots}/activity-mobile.png`,fullPage:true});
});

test('Add AI app shows the three steps and copies the full address; with nothing connected the steps are the page',async({page,context})=>{
  await context.grantPermissions(['clipboard-read','clipboard-write']);
  const state=await mock(page,{companies:false});state.apps=[{id:'s2',name:'Email on Mac',scope:'booking:read email:tracking',createdAt:Date.now()-86400000,expiresAt:Date.now()+86400000}];
  await page.goto(base+'/studio#settings/apps');const add=page.getByRole('button',{name:'Add AI app',exact:true});await add.click();
  const pop=page.getByRole('dialog',{name:'Add an AI app'});await expect(pop).toBeVisible();
  await expect(pop.locator('li')).toHaveText(['In Claude, open Settings, then Connectors, then Add custom connector. Other AI apps have a similar option.',/^Paste this address:\s*127\.0\.0\.1:8791\/mcp\s*Copy$/,'Sign in to Scheduling and approve it. It shows up here.']);
  await expect(pop.getByRole('button',{name:'Copy '+base+'/mcp'})).toBeFocused();await page.keyboard.press('Enter');
  expect(await page.evaluate(()=>navigator.clipboard.readText())).toBe(base+'/mcp');await expect(page.locator('#host-status')).toHaveText('Address copied');
  await page.keyboard.press('Escape');await expect(pop).toBeHidden();await expect(add).toBeFocused();
  await add.click();await page.locator('h1').click();await expect(pop).toBeHidden();
  state.apps=[];await page.goto('about:blank');await page.goto(base+'/studio#settings/apps');
  await expect(page.locator('h1')).toHaveText('Connected apps');await expect(page.getByRole('button',{name:'Add AI app'})).toHaveCount(0);await expect(page.locator('[data-app]')).toHaveCount(0);
  await expect(page.locator('main .st-steps li')).toHaveCount(3);await expect(page.locator('main .st-steps code')).toHaveText('127.0.0.1:8791/mcp');
});

test('integration cards open the selected destination with the webhook gate intact',async({page})=>{
  await mock(page,{companies:false});await page.goto(base+'/studio#integrations');await expect(page.locator('.integration-choice')).toHaveCount(4);
  await page.setViewportSize({width:1440,height:960});await page.screenshot({path:`${shots}/integration-catalog-desktop.png`});
  for(const kind of ['Slack','Discord']){
    await page.getByRole('button',{name:'Connect '+kind,exact:true}).click();const dialog=page.getByRole('dialog',{name:'Connect '+kind});
    await expect(dialog.getByLabel(kind+' webhook URL')).toBeFocused();await expect(dialog.getByRole('link',{name:new RegExp(kind)})).toHaveAttribute('target','_blank');
    await page.keyboard.press('Escape');await expect(dialog).toHaveCount(0);await expect(page.getByRole('button',{name:'Connect '+kind,exact:true})).toBeFocused();
  }
  await expect(page.getByRole('button',{name:'Connect Webhook',exact:true})).toHaveCount(0);await expect(page.locator('.integration-choice.is-unavailable')).toContainText('Webhook');
  await setTheme(page,'Dark');await notifications(page);await page.setViewportSize({width:390,height:844});await expect(page.locator('.integration-choice')).toHaveCount(4);expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBeTruthy();await page.screenshot({path:`${shots}/integration-catalog-mobile-dark.png`});
});

test('Twenty CRM integration: write-only API key, cloud default, connection test and edit flow',async({page})=>{
  const state=await mock(page,{companies:false});await page.goto(base+'/studio#integrations');
  await page.getByRole('button',{name:'Connect Twenty CRM',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'Connect Twenty CRM'});
  await expect(dialog.getByLabel('Twenty API key')).toBeFocused();
  await expect(dialog.getByLabel('Twenty API URL')).toHaveValue('https://api.twenty.com');
  await expect(dialog.getByLabel('Name',{exact:true})).toHaveValue('Twenty CRM');
  await expect(dialog.getByRole('checkbox',{name:/Sync guest name and email/})).toBeChecked();
  // Missing API key is caught at the field without submitting.
  await dialog.getByRole('button',{name:'Connect',exact:true}).click();
  await expect(dialog.getByText('Paste your Twenty API key.')).toBeVisible();
  expect(state.requests.some(r=>r.path==='/api/live/integrations'&&r.method==='POST')).toBe(false);
  // Unapproved self-hosted host is caught when custom Twenty hosts are not enabled.
  await dialog.getByLabel('Twenty API key').fill('twenty_browser_secret_key_123456');
  await dialog.getByLabel('Twenty API URL').fill('https://crm.acme.org');
  await dialog.getByRole('button',{name:'Connect',exact:true}).click();
  await expect(dialog.getByText(/Self-hosted Twenty hosts are not enabled/)).toBeVisible();
  // Restore cloud URL and connect.
  await dialog.getByLabel('Twenty API URL').fill('https://api.twenty.com');
  await dialog.getByLabel('Name',{exact:true}).fill('Sales Twenty');
  await dialog.getByRole('button',{name:'Connect',exact:true}).click();
  const connected=page.getByRole('dialog',{name:'Sales Twenty is connected'});
  await expect(connected.getByRole('button',{name:'Test connection'})).toBeFocused();
  await connected.getByRole('button',{name:'Test connection'}).click();
  await expect.poll(()=>state.deliveries.length).toBe(1);
  Object.assign(state.deliveries[0],{state:'delivered',attempts:1,lastAttemptAt:Date.now()});
  await expect(connected.getByRole('status')).toHaveText('Connected to Twenty.',{timeout:8000});
  await connected.getByRole('button',{name:'Done'}).click();
  await expect(connected).toHaveCount(0);
  // API key never appears in DOM or storage.
  expect(await page.content()).not.toContain('twenty_browser_secret_key');
  expect(await page.evaluate(()=>JSON.stringify({...localStorage})+JSON.stringify({...sessionStorage}))).not.toContain('twenty_browser_secret_key');
  await expect(page.locator('.integration-row')).toContainText('Twenty CRM · api.twenty.com · Confirmed, cancelled · Shares guest details');
  const created=state.requests.find(r=>r.path==='/api/live/integrations'&&r.method==='POST').body;
  expect(created).toMatchObject({action:'create',kind:'twenty',name:'Sales Twenty',url:'https://api.twenty.com',apiKey:'twenty_browser_secret_key_123456',includeGuestDetails:true,enabled:true});
  // Edit preserves URL and API key unless explicitly replaced.
  await page.getByRole('button',{name:'Edit Sales Twenty'}).click();
  const edit=page.getByRole('dialog',{name:'Edit Sales Twenty'});
  await expect(edit.getByText('api.twenty.com',{exact:true})).toBeVisible();
  await expect(edit.getByText('Saved API key')).toBeVisible();
  await expect(edit.getByLabel('New API key')).toBeHidden();
  await edit.getByRole('button',{name:'Replace API key'}).click();
  await expect(edit.getByLabel('New API key')).toBeFocused();
  await edit.getByRole('button',{name:'Keep current key'}).click();
  await expect(edit.getByLabel('New API key')).toBeHidden();
  await edit.getByLabel('Name',{exact:true}).fill('CRM Pipeline');
  await edit.getByRole('button',{name:'Save changes'}).click();
  await expect(edit).toHaveCount(0);
  const updated=state.requests.filter(r=>r.body?.action==='update').at(-1).body;
  expect(updated).toMatchObject({id:'i1',name:'CRM Pipeline',expectedRevision:1});
  expect('apiKey' in updated).toBe(false);expect('url' in updated).toBe(false);
  // Unauthorized delivery shows API key guidance.
  state.deliveries.unshift({id:'dunauth',integrationId:'i1',eventId:'e2',eventType:'booking.confirmed',state:'failed',attempts:1,nextAttemptAt:null,lastAttemptAt:Date.now(),errorCode:'provider_unauthorized'});
  await notifications(page);
  await expect(page.locator('.integration-row .st-line-problem')).toHaveText('Failing · Rejected by the destination. Check the API key.');
});

test('an image still decoding cannot be applied to a profile selected afterwards',async({page})=>{
 const state=await mock(page);await page.goto(base+'/studio#settings/profile');await expect(page.locator('h1')).toHaveText('Profile');await page.evaluate(()=>{const decode=HTMLImageElement.prototype.decode;HTMLImageElement.prototype.decode=async function(){await decode.call(this);window.waitingImageDecode=true;await new Promise(resolve=>window.releaseImageDecode=resolve);};});
 const pickerPromise=page.waitForEvent('filechooser');await page.getByRole('button',{name:'Change photo',exact:true}).click();await (await pickerPromise).setFiles(new URL('./fixtures/avatar.jpg',import.meta.url).pathname);await page.waitForFunction(()=>window.waitingImageDecode);await page.getByRole('button',{name:'Back',exact:true}).click();await switchTo(page,'Acme');await page.evaluate(()=>window.releaseImageDecode());await expect.poll(()=>page.locator('[data-profile-upload]').count()).toBe(0);await expect(page.getByRole('dialog',{name:/Crop /})).toHaveCount(0);expect(state.requests.filter(r=>r.path==='/api/live/settings'&&r.method==='POST')).toHaveLength(0);await expect(switcher(page)).toContainText('Acme');
});
