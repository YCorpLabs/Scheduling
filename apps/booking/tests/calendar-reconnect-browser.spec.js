import {test,expect} from '@playwright/test';
import {DEFAULT} from '../public/policy.js';
const base=process.env.BOOKING_TEST_ORIGIN||'http://127.0.0.1:8791',company='h_'+'C'.repeat(24),person='h_'+'P'.repeat(24);
const hours=Object.fromEntries([0,1,2,3,4,5,6].map(d=>[d,d>0&&d<6?[{start:540,end:1020}]:[]]));
async function routes(page,handler){
 const requests=[];
 await page.route('**/api/**',async r=>{const req=r.request(),path=new URL(req.url()).pathname,body=req.postDataJSON?.();requests.push({path,body});let done=false;const json=(data,status=200)=>{done=true;return r.fulfill({json:data,status});};await handler(path,body,json);if(done)return;if(path.endsWith('/calendar-contributions'))return json({contributions:[]});if(path.endsWith('/bookings'))return json({bookings:[]});return json({});});
 return requests;
}
function boxesOverlap(a,b){return a.x<b.x+b.width&&b.x<a.x+a.width&&a.y<b.y+b.height&&b.y<a.y+a.height;}

test('a rejected Google grant shows one reconnect action instead of a raw provider error',async({page})=>{
 await routes(page,(path,body,json)=>{
  if(path==='/api/bootstrap')return json({mode:'live',authenticated:true,hostId:person,email:'host@example.com'});
  if(path.endsWith('/workspaces'))return json({activeWorkspaceId:person,workspaces:[{id:person,personal:true,role:'owner',name:'Host'}]});
  // Settings loaded before Google refused the grant: the listing reveals it.
  if(path.endsWith('/settings'))return json({hostId:person,profile:{name:'Host'},revision:'a',accounts:[{id:'host@example.com',email:'host@example.com',connected:true,destinationCalendarId:'host@example.com',conflictCalendarIds:['host@example.com']}],meetingTypes:[{...DEFAULT,id:'intro',slug:'intro',published:true,title:'Intro call',accountId:'host@example.com',calendarId:'host@example.com'}],availabilitySchedules:[]});
  if(path.endsWith('/calendars'))return json({accounts:[{id:'host@example.com',email:'host@example.com',reconnectRequired:true,calendars:[]}]});
 });
 await page.goto(base+'/studio');
 const notice=page.getByRole('alert').filter({hasText:'Your Google Calendar connection stopped working'});
 await expect(notice).toBeVisible();await expect(notice).toContainText('Booking links that use host@example.com can’t take new bookings until you reconnect.');
 await expect(page.getByText('Google request failed',{exact:false})).toHaveCount(0);
 const reconnect=notice.getByRole('link',{name:'Reconnect Google Calendar',exact:true});await expect(reconnect).toHaveAttribute('href','/auth/google?connect=1');
 await expect(page.getByRole('link',{name:'Reconnect Google Calendar'})).toHaveCount(1);
 await page.setViewportSize({width:390,height:844});await expect(notice).toBeVisible();await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 await page.setViewportSize({width:1280,height:800});await page.getByRole('button',{name:'Calendars',exact:true}).click();
 const card=page.locator('.calendar-account[data-account="host@example.com"]');await expect(card.getByText('Reconnect needed',{exact:true})).toBeVisible();
 await expect(card.getByRole('link',{name:'Reconnect Google Calendar',exact:true})).toHaveAttribute('href','/auth/google?connect=1');
 await expect(page.getByRole('link',{name:'Reconnect Google Calendar'})).toHaveCount(1);await expect(card.locator('[data-calendar-destination]')).toHaveCount(0);
 await page.waitForURL(/#calendars$/);await page.getByRole('button',{name:'Booking links',exact:true}).click();await expect(notice).toBeVisible();
 await page.route('**/auth/google?connect=1',route=>route.fulfill({contentType:'text/html',body:'consent'}));await page.getByRole('link',{name:'Reconnect Google Calendar'}).click();await expect(page).toHaveURL(/\/auth\/google\?connect=1$/);
});

test('member calendar rows keep email and state apart at desktop and phone width',async({page})=>{
 await routes(page,(path,body,json)=>{
  if(path==='/api/bootstrap')return json({mode:'live',authenticated:true,hostId:person,email:'ada@example.com'});
  if(path.endsWith('/workspaces'))return json({activeWorkspaceId:company,workspaces:[{id:person,personal:true,role:'owner',name:'Ada'},{id:company,name:'Acme',role:'owner',capabilities:{manageOwnCalendar:true,manageSettings:true,manageMembers:true,manageIntegrations:true}}]});
  if(path.endsWith('/settings'))return json({hostId:company,profile:{name:'Acme'},revision:'a',accounts:[{id:'ada',email:'ada.lovelace.with-a-long-address@example.com',ownerMemberId:person,connected:true,reconnectRequired:true,destinationCalendarId:'primary'},{id:'grace',email:'grace@example.com',ownerMemberId:'h_'+'G'.repeat(24),connected:true,destinationCalendarId:'primary'},{id:'linus',email:'linus@example.com',ownerMemberId:'h_'+'L'.repeat(24),connected:false}],meetingTypes:[],availabilitySchedules:[]});
  if(path.endsWith('/calendars'))return json({accounts:[]});
 });
 await page.setViewportSize({width:1280,height:800});await page.goto(base+'/studio#calendars');await expect(page.getByRole('heading',{name:'Member calendars'})).toBeVisible();
 const rows=page.locator('.member-calendar-row');await expect(rows).toHaveCount(3);
 await expect(rows.nth(0).locator('.connection-state')).toHaveText('Reconnect needed');await expect(rows.nth(1).locator('.connection-state')).toHaveText('Connected');await expect(rows.nth(2).locator('.connection-state')).toHaveText('Not connected');
 for(const [width,stacked] of [[1280,false],[390,true]]){
  await page.setViewportSize({width,height:844});
  for(let i=0;i<3;i++){
   const email=await rows.nth(i).locator('strong').boundingBox(),state=await rows.nth(i).locator('.connection-state').boundingBox();
   expect(boxesOverlap(email,state),`row ${i} at ${width}px`).toBe(false);
   if(stacked)expect(state.y).toBeGreaterThanOrEqual(email.y+email.height-1);else{expect(Math.abs((state.y+state.height/2)-(email.y+email.height/2))).toBeLessThan(4);expect(state.x).toBeGreaterThan(email.x+email.width);}
  }
  await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 }
 await page.setViewportSize({width:1280,height:800});await page.getByRole('button',{name:'Booking links',exact:true}).click();
 await expect(page.getByRole('alert').filter({hasText:'Your Google Calendar connection stopped working'}).getByRole('link',{name:'Reconnect Google Calendar'})).toHaveAttribute('href',`/auth/google?connect=1&workspace=${company}&own=1`);
});

test('My calendar shows reconnect needed while keeping hours and stop sharing',async({page})=>{
 await routes(page,(path,body,json)=>{
  if(path==='/api/bootstrap')return json({mode:'live',authenticated:true,hostId:person,email:'ada@example.com'});
  if(path.endsWith('/workspaces'))return json({activeWorkspaceId:company,workspaces:[{id:person,personal:true,role:'owner',name:'Ada'},{id:company,name:'Acme',role:'member',capabilities:{manageOwnCalendar:true}}]});
  if(path.endsWith('/settings'))return json({hostId:company,profile:{name:'Acme'},revision:'a',accounts:[],meetingTypes:[],availabilitySchedules:[]});
  if(path.endsWith('/my-calendar'))return json({member:{id:person,email:'ada@example.com'},account:{id:'mine',email:'ada@example.com',connected:true,ownerMemberId:person,calendarId:'primary',conflictCalendarIds:['primary']},calendars:[],schedule:{zone:'Europe/London',weeklyHours:hours,dateOverrides:{}},scheduleConfigured:true,readiness:'reconnect',revision:'rev1'});
 });
 await page.goto(base+'/studio#calendars');
 const card=page.locator('.calendar-account');await expect(card.getByText('Reconnect needed',{exact:true})).toBeVisible();
 await expect(card.getByRole('link',{name:'Reconnect Google Calendar',exact:true})).toHaveAttribute('href',`/auth/google?connect=1&workspace=${company}&own=1`);
 await expect(page.getByRole('button',{name:'Save changes'})).toBeHidden();await expect(page.getByText('Europe/London',{exact:true})).toBeVisible();
 await card.locator('summary').click();await expect(page.getByRole('button',{name:'Stop sharing',exact:true})).toBeVisible();
});
