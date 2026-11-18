// A rejected Google grant: one "Reconnect Google Calendar" action and a
// "Reconnect needed" state on Availability and the Team page, never a raw
// provider error, and the member keeps their hours and stop-sharing.
import {test,expect} from '@playwright/test';
import {DEFAULT} from '../public/policy.js';
const base=process.env.BOOKING_TEST_ORIGIN||'http://127.0.0.1:8791',company='h_'+'C'.repeat(24),person='h_'+'P'.repeat(24);
test.use({timezoneId:'Europe/Oslo'});
const hours=Object.fromEntries([0,1,2,3,4,5,6].map(d=>[d,d>0&&d<6?[{start:540,end:1020}]:[]]));
async function routes(page,handler){
 const requests=[];
 await page.route('**/api/**',async r=>{const req=r.request(),path=new URL(req.url()).pathname,body=req.postDataJSON?.();requests.push({path,body,method:req.method()});let done=false;const json=(data,status=200)=>{done=true;return r.fulfill({json:data,status});};await handler(path,body,json);if(done)return;if(path==='/api/live/calendar-contributions')return json({contributions:[]});if(path==='/api/live/bookings')return json({bookings:[]});return json({});});
 return requests;
}
function boxesOverlap(a,b){return a.x<b.x+b.width&&b.x<a.x+a.width&&a.y<b.y+b.height&&b.y<a.y+a.height;}
const noSideways=page=>expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
const sidebar=page=>page.getByRole('navigation',{name:'Scheduling'});
// Settings is reached from the name menu at the top of the sidebar.
async function openSettings(page,name){await page.locator('#account-trigger').click();await page.locator('#account-menu').getByRole('button',{name:'Settings',exact:true}).click();if(name)await page.getByRole('navigation',{name:'Settings'}).getByRole('button',{name}).click();}

test('a rejected Google grant shows one reconnect action instead of a raw provider error',async({page})=>{
 await routes(page,(path,body,json)=>{
  if(path==='/api/bootstrap')return json({mode:'live',authenticated:true,hostId:person,email:'host@example.com'});
  if(path==='/api/live/workspaces')return json({activeWorkspaceId:person,workspaces:[{id:person,personal:true,role:'owner',name:'Host'}]});
  // Settings loaded before Google refused the grant: the listing reveals it.
  if(path==='/api/live/settings')return json({hostId:person,profile:{name:'Host'},revision:'a',accounts:[{id:'host@example.com',email:'host@example.com',connected:true,destinationCalendarId:'host@example.com',conflictCalendarIds:['host@example.com']}],meetingTypes:[{...DEFAULT,id:'intro',slug:'intro',published:true,title:'Intro call',accountId:'host@example.com',calendarId:'host@example.com',useDefaultSchedule:true}],availabilitySchedules:[{id:'availability',name:'Availability',zone:'Europe/Oslo',weeklyHours:hours,dateOverrides:{}}],defaultAvailabilityScheduleId:'availability'});
  if(path==='/api/live/calendars')return json({accounts:[{id:'host@example.com',email:'host@example.com',reconnectRequired:true,calendars:[]}]});
  if(path==='/api/live/calendar-events')return json({events:[],calendars:[]});
 });
 await page.goto(base+'/studio');
 const notice=page.getByRole('alert').filter({hasText:'Your Google Calendar connection stopped working'});
 await expect(notice).toBeVisible();await expect(notice).toContainText('Booking links that use host@example.com can’t take new bookings until you reconnect.');
 await expect(page.getByText('Google request failed',{exact:false})).toHaveCount(0);
 const reconnect=notice.getByRole('link',{name:'Reconnect Google Calendar',exact:true});await expect(reconnect).toHaveAttribute('href','/auth/google?connect=1');
 await expect(page.getByRole('link',{name:'Reconnect Google Calendar'})).toHaveCount(1);
 await page.setViewportSize({width:390,height:844});await expect(notice).toBeVisible();await noSideways(page);
 // Availability shows the state in its side panel instead of the banner: still one action, no destination choice.
 await page.setViewportSize({width:1280,height:800});await sidebar(page).getByRole('button',{name:'Availability',exact:true}).click();
 await page.waitForURL(/#availability$/);
 const panel=page.getByRole('complementary',{name:'Calendars'});
 await expect(panel.getByText('Reconnect needed',{exact:true})).toBeVisible();
 await expect(panel.getByRole('link',{name:'Reconnect Google Calendar',exact:true})).toHaveAttribute('href','/auth/google?connect=1');
 await expect(page.getByRole('link',{name:'Reconnect Google Calendar'})).toHaveCount(1);await expect(panel.locator('[data-destination]')).toHaveCount(0);
 await expect(page.getByText('Google request failed',{exact:false})).toHaveCount(0);
 // The person's hours stay visible while the grant is broken.
 await expect(page.locator('[data-week] .wk-block')).toHaveCount(5);await expect(page.locator('[data-week] .wk-block').first()).toContainText('09:00–17:00');
 await sidebar(page).getByRole('button',{name:'Links',exact:true}).click();await expect(notice).toBeVisible();
 await page.route('**/auth/google?connect=1',route=>route.fulfill({contentType:'text/html',body:'consent'}));await page.getByRole('link',{name:'Reconnect Google Calendar'}).click();await expect(page).toHaveURL(/\/auth\/google\?connect=1$/);
});

test('member calendar status and email stay apart on the Team page at desktop and phone width',async({page})=>{
 const long='ada.lovelace.with-a-long-address@example.com';
 await routes(page,(path,body,json)=>{
  if(path==='/api/bootstrap')return json({mode:'live',authenticated:true,hostId:person,email:long});
  if(path==='/api/live/workspaces')return json({activeWorkspaceId:company,workspaces:[{id:person,personal:true,role:'owner',name:'Ada'},{id:company,name:'Acme',role:'owner',capabilities:{manageOwnCalendar:true,manageSettings:true,manageMembers:true,manageIntegrations:true}}]});
  if(path==='/api/live/settings')return json({hostId:company,profile:{name:'Acme'},revision:'a',accounts:[{id:'ada',email:long,ownerMemberId:person,connected:true,reconnectRequired:true,destinationCalendarId:'primary'},{id:'grace',email:'grace@example.com',ownerMemberId:'h_'+'G'.repeat(24),connected:true,destinationCalendarId:'primary'},{id:'linus',email:'linus@example.com',ownerMemberId:'h_'+'L'.repeat(24),connected:false}],meetingTypes:[],availabilitySchedules:[]});
  if(path==='/api/live/calendars')return json({accounts:[]});
  if(path==='/api/live/workspace')return json({workspace:{id:company,name:'Acme',role:'owner'},members:[{id:person,email:long,role:'owner'},{id:'h_'+'G'.repeat(24),email:'grace@example.com',role:'admin'},{id:'h_'+'L'.repeat(24),email:'linus@example.com',role:'member'}],invitations:[]});
  if(path==='/api/live/member-calendars')return json({members:[{id:person,readiness:'reconnect'},{id:'h_'+'G'.repeat(24),readiness:'ready'},{id:'h_'+'L'.repeat(24),readiness:'not_connected'}]});
 });
 await page.setViewportSize({width:1280,height:800});await page.goto(base+'/studio#team');await expect(page.getByRole('heading',{name:'Members'})).toBeVisible();
 const rows=page.locator('.team-row');await expect(rows).toHaveCount(3);
 const states=['Reconnect needed','Ready for bookings','Calendar not connected'];
 for(let i=0;i<3;i++)await expect(rows.nth(i).locator('.team-person small').last()).toHaveText(states[i]);
 await expect(page.getByText('Google request failed',{exact:false})).toHaveCount(0);
 for(const width of [1280,390]){
  await page.setViewportSize({width,height:844});
  for(let i=0;i<3;i++){
   const email=await rows.nth(i).locator('.team-person strong').boundingBox(),state=await rows.nth(i).locator('.team-person small').last().boundingBox(),role=await rows.nth(i).locator('.team-role').boundingBox();
   expect(boxesOverlap(email,state),`row ${i} email and state at ${width}px`).toBe(false);
   expect(state.y,`row ${i} state sits under the email at ${width}px`).toBeGreaterThanOrEqual(email.y+email.height-1);
   expect(boxesOverlap(email,role),`row ${i} email and role at ${width}px`).toBe(false);
   expect(boxesOverlap(state,role),`row ${i} state and role at ${width}px`).toBe(false);
  }
  await noSideways(page);
 }
 await page.setViewportSize({width:1280,height:800});await sidebar(page).getByRole('button',{name:'Links',exact:true}).click();
 await expect(page.getByRole('alert').filter({hasText:'Your Google Calendar connection stopped working'}).getByRole('link',{name:'Reconnect Google Calendar'})).toHaveAttribute('href',`/auth/google?connect=1&workspace=${company}&own=1`);
});

test('Availability shows reconnect needed while keeping the member’s hours and stop sharing',async({page})=>{
 const requests=await routes(page,(path,body,json)=>{
  if(path==='/api/bootstrap')return json({mode:'live',authenticated:true,hostId:person,email:'ada.lovelace.with-a-long-address@example.com'});
  if(path==='/api/live/workspaces')return json({activeWorkspaceId:company,workspaces:[{id:person,personal:true,role:'owner',name:'Ada'},{id:company,name:'Acme',role:'member',capabilities:{manageOwnCalendar:true}}]});
  if(path==='/api/live/settings')return json({hostId:company,profile:{name:'Acme'},revision:'a',accounts:[],meetingTypes:[],availabilitySchedules:[]});
  if(path==='/api/live/my-calendar')return json({member:{id:person,email:'ada.lovelace.with-a-long-address@example.com'},account:{id:'mine',email:'ada.lovelace.with-a-long-address@example.com',connected:true,ownerMemberId:person,calendarId:'primary',conflictCalendarIds:['primary']},calendars:[],schedule:{zone:'Europe/London',weeklyHours:hours,dateOverrides:{}},scheduleConfigured:true,readiness:'reconnect',revision:'rev1'});
  if(path==='/api/live/my-calendar/events')return json({events:[],calendars:[]});
  if(path==='/api/live/my-calendar/readiness')return json({readiness:'reconnect'});
  if(path==='/api/live/workspace')return json({workspace:{id:company,name:'Acme',role:'member'},members:[{id:'h_'+'O'.repeat(24),email:'owner@example.com',role:'owner'},{id:person,email:'ada.lovelace.with-a-long-address@example.com',role:'member'}],invitations:[]});
  if(path==='/api/live/calendar-contributions')return json({contributions:[{workspaceId:company,accountId:'mine',email:'ada.lovelace.with-a-long-address@example.com',connected:true}]});
 });
 await page.goto(base+'/studio#availability');
 const panel=page.getByRole('complementary',{name:'Calendars'});
 await expect(panel.getByText('Reconnect needed',{exact:true})).toBeVisible();
 await expect(panel.getByRole('link',{name:'Reconnect Google Calendar',exact:true})).toHaveAttribute('href',`/auth/google?connect=1&workspace=${company}&own=1`);
 await expect(page.getByRole('link',{name:'Reconnect Google Calendar'})).toHaveCount(1);await expect(page.getByText('Google request failed',{exact:false})).toHaveCount(0);
 // Hours are kept and shown, but cannot change until the calendar is reconnected.
 await expect(page.getByLabel('Time zone',{exact:true})).toHaveValue('Europe/London');
 const blocks=page.locator('[data-week] .wk-block');await expect(blocks).toHaveCount(5);await expect(blocks.first()).toContainText('09:00–17:00');for(const block of await blocks.all())await expect(block).toBeDisabled();
 await expect(page.locator('[data-week]')).toHaveClass(/wk-readonly/);await expect(panel.locator('[data-destination]')).toHaveCount(0);
 expect(requests.filter(r=>r.method==='POST'&&/my-calendar|settings/.test(r.path))).toHaveLength(0);
 // The email and the state do not overlap, even on a phone.
 for(const width of [1280,390]){
  await page.setViewportSize({width,height:844});
  const state=await panel.locator('.connection-state').boundingBox(),email=await panel.locator('.av-accounts').boundingBox();
  expect(boxesOverlap(state,email),`state and email at ${width}px`).toBe(false);
  await noSideways(page);
 }
 await page.setViewportSize({width:1280,height:800});
 // Stop sharing stays available in Settings → Sign-in & data → Calendar access.
 await openSettings(page,'Sign-in & data');
 const access=page.getByRole('region',{name:'Calendar access'});await expect(access.getByRole('button',{name:'Stop sharing ada.lovelace.with-a-long-address@example.com with Acme',exact:true})).toBeVisible();
 await noSideways(page);await page.getByRole('button',{name:'Back',exact:true}).click();
 // The Team page shows the same state for the member.
 await sidebar(page).getByRole('button',{name:'Team',exact:true}).click();
 const self=page.locator('.team-row').filter({hasText:'You'});await expect(self.locator('.team-person small').last()).toHaveText('Reconnect needed');
 const email=await self.locator('.team-person strong').boundingBox(),state=await self.locator('.team-person small').last().boundingBox();expect(boxesOverlap(email,state)).toBe(false);
});
