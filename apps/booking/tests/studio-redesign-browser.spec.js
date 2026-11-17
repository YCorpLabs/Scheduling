// The redesigned Studio: Bookings, Links, the one-page link editor, the
// Availability week calendar, first run, phone layout and reconnect.
import {test,expect} from '@playwright/test';
import {DEFAULT} from '../public/policy.js';
const base=process.env.BOOKING_TEST_ORIGIN||'http://127.0.0.1:8791';
const H=3600000,D=24*H,zone='Europe/Oslo',me='h_'+'R'.repeat(24);
test.use({timezoneId:zone});

const week=(from,to,days=[1,2,3,4,5])=>Object.fromEntries([0,1,2,3,4,5,6].map(d=>[d,days.includes(d)?[{start:from*60,end:to*60}]:[]]));
const link=(id,title,extra={})=>({...DEFAULT,id,slug:id,title,host:'Riley Park',company:'',description:'',zone,accountId:'riley',calendarId:'riley@example.com',useDefaultCalendar:true,useDefaultSchedule:true,scheduleId:null,published:true,...extra});

function world({firstRun=false,reconnect=false}={}){
 const now=Date.now(),soon=now+2*H-(now%(15*60000));
 const state={writes:[],decisions:[],settings:firstRun?{revision:'A'.repeat(43),hostId:me,profile:{name:'Riley Park',email:'riley@example.com'},accounts:[],meetingTypes:[link('intro','Intro call',{accountId:null,published:false})],availabilitySchedules:[{id:'availability',name:'Availability',zone,weeklyHours:week(9,17),dateOverrides:{}}],defaultAvailabilityScheduleId:'availability'}:{
  revision:'A'.repeat(43),hostId:me,profile:{name:'Riley Park',email:'riley@example.com'},
  accounts:[{id:'riley',email:'riley@example.com',connected:true,destinationCalendarId:'riley@example.com',conflictCalendarIds:['riley@example.com'],...(reconnect?{reconnectRequired:true}:{})}],
  meetingTypes:[link('intro','Intro call',{duration:30,locationType:'google_meet'}),link('consultation','Project consultation',{duration:60,durationOptions:[45,60,90],locationType:'google_meet',requiresApproval:true,approvalExpiryMinutes:1440}),link('coffee','Coffee chat',{duration:15,location:'Café',published:false,useDefaultSchedule:false,weeklyHours:week(15,17,[2,4]),dateOverrides:{}})],
  availabilitySchedules:[{id:'availability',name:'Availability',zone,weeklyHours:week(9,17),dateOverrides:{}}],defaultAvailabilityScheduleId:'availability'},
  bookings:firstRun?[]:[
   {id:'b_req_'+'1'.repeat(16),title:'Project consultation',name:'Sara Lind',email:'sara@example.org',start:now+2*D,end:now+2*D+H,status:'awaiting_approval',version:1,approvalExpiresAt:now+20*H,meetingTypeSlug:'consultation'},
   {id:'b_now_'+'2'.repeat(16),title:'Intro call',name:'Maya Chen',email:'maya@example.com',start:soon,end:soon+30*60000,status:'confirmed',version:1,meetingTypeSlug:'intro',conferenceStatus:'ready',meetingUrl:'https://meet.google.com/abc-defg-hij'},
   {id:'b_old_'+'3'.repeat(16),title:'Intro call',name:'Priya Shah',email:'priya@example.com',start:now-3*D,end:now-3*D+30*60000,status:'confirmed',version:1,meetingTypeSlug:'intro'},
   {id:'b_gone_'+'4'.repeat(15),title:'Intro call',name:'Leo Martin',email:'leo@example.org',start:now+4*D,end:now+4*D+30*60000,status:'cancelled',version:2,meetingTypeSlug:'intro'}]};
 const handler=async route=>{
  const req=route.request(),url=new URL(req.url()),path=url.pathname,body=req.postDataJSON?.()??null,json=(data,status=200)=>route.fulfill({json:data,status});
  if(path==='/api/bootstrap')return json({mode:'live',authenticated:true,hostId:me,email:'riley@example.com'});
  if(path==='/api/live/workspaces')return json({activeWorkspaceId:me,workspaces:[{id:me,name:'Riley Park',personal:true,role:'owner'}]});
  if(path==='/api/live/settings'&&req.method()==='GET')return json(state.settings);
  if(path==='/api/live/settings'){state.writes.push(body.patch);state.settings={...state.settings,...body.patch,revision:'B'.repeat(42)+state.writes.length%10};return json({settings:state.settings,revision:state.settings.revision});}
  if(path==='/api/live/calendars')return json({accounts:state.settings.accounts.map(a=>({id:a.id,email:a.email,...(reconnect?{reconnectRequired:true,calendars:[]}:{calendars:[{id:'riley@example.com',summary:'Riley Park',primary:true,accessRole:'owner',backgroundColor:'#3a7afe'},{id:'family',summary:'Family',accessRole:'reader',backgroundColor:'#e0763a'}]})}))});
  if(path==='/api/live/calendar-events')return json({events:[],calendars:reconnect||!state.settings.accounts.length?[]:[{accountId:'riley',id:'riley@example.com',summary:'Riley Park',color:'#3a7afe',accessRole:'owner',primary:true,busy:true,destination:true},{accountId:'riley',id:'family',summary:'Family',color:'#e0763a',accessRole:'reader',primary:false,busy:false,destination:false}]});
  if(path==='/api/live/bookings')return json({bookings:state.bookings});
  if(/^\/api\/live\/bookings\/[^/]+\/decision$/.test(path)){const id=path.split('/').at(-2);state.decisions.push({id,...body});state.bookings=state.bookings.map(b=>b.id===id?{...b,status:body.action==='approve'?'confirmed':'rejected',version:2}:b);return json({booking:state.bookings.find(b=>b.id===id)});}
  if(/^\/api\/live\/bookings\/[^/]+$/.test(path)){const b=state.bookings.find(x=>x.id===path.split('/').pop());return json({booking:b,hostActions:{manage:true}});}
  if(path==='/api/live/analytics')return json({period:{from:'2026-10-16',to:'2026-11-14',timeZone:'UTC',days:30},totals:{pageViews:12,bookingRequests:2,confirmed:2,cancelled:0,rescheduled:0},series:[],sources:{direct:12},links:{intro:{views:41,confirmed:9},consultation:{views:18,confirmed:3}}});
  if(path==='/api/live/operations')return json({healthy:true,issues:[],attention:[],bookings:{awaitingApproval:1}});
  return json({});
 };
 return {handler,state};
}
async function open(page,hash='',opts){
 const w=world(opts);await page.route('**/api/**',w.handler);await page.goto(base+'/studio'+hash);return w.state;
}
const sidebar=page=>page.getByRole('navigation',{name:'Scheduling'});

test('navigation is Bookings, Links, Availability, Activity, then Setup; Bookings is the default page',async({page})=>{
 await open(page);
 await expect(page.getByRole('heading',{name:'Bookings',level:1})).toBeVisible();
 await expect(sidebar(page).getByRole('button')).toHaveText([/^Bookings\s*1$/,'Links','Availability','Activity','Integrations']);
 await expect(page.locator('.nav-group')).toHaveText('Setup');
 for(const gone of ['Hours','Calendars','Booking stats','Troubleshooting'])await expect(sidebar(page).getByRole('button',{name:gone,exact:true})).toHaveCount(0);
 await page.locator('#account-trigger').click();
 await expect(page.getByRole('button',{name:'Troubleshooting'})).toBeVisible();
 await expect(page.getByRole('button',{name:'Calendar access'})).toHaveCount(0);
});

test('bookings: requests on top with Approve and Decline, Join today, ••• menu, past and cancelled',async({page})=>{
 const state=await open(page);
 const request=page.locator('.bk-card.req .bk-row');
 await expect(request).toContainText('Sara Lind');
 await expect(request).toContainText('Expires in 20 h');
 await expect(page.getByText('Waiting for your OK')).toBeVisible();
 await expect(page.locator('.bk-row').filter({hasText:'Maya Chen'}).getByRole('link',{name:'Join'})).toHaveAttribute('href','https://meet.google.com/abc-defg-hij');
 await page.locator('.bk-row').filter({hasText:'Maya Chen'}).getByRole('button',{name:/More for/}).click();
 await expect(page.getByRole('menuitem')).toHaveText(['Reschedule','Cancel','Details']);
 await page.keyboard.press('Escape');
 await request.getByRole('button',{name:'Decline'}).click();
 await expect(request).toContainText('Decline?');
 await request.getByRole('button',{name:'Keep'}).click();
 expect(state.decisions).toEqual([]);
 await request.getByRole('button',{name:'Approve'}).click();
 await expect.poll(()=>state.decisions.map(d=>d.action)).toEqual(['approve']);
 await expect(page.getByText('Waiting for your OK')).toHaveCount(0);
 await expect(sidebar(page).getByRole('button',{name:/^Bookings/})).toHaveText('Bookings');
 await page.getByRole('button',{name:'Past (1)'}).click();
 await expect(page.getByRole('heading',{name:'Past'})).toBeVisible();
 await expect(page.locator('.bk-row')).toContainText(['Priya Shah']);
 await page.getByRole('button',{name:'← Bookings'}).click();
 await page.getByRole('button',{name:'Cancelled (1)'}).click();
 await expect(page.locator('.bk-row')).toContainText(['Leo Martin']);
 await page.getByRole('button',{name:'← Bookings'}).click();
 await expect(page.getByText(/^Times in Oslo/)).toBeVisible();
 await page.getByRole('button',{name:'Search'}).click();
 await page.locator('#booking-search').fill('maya');
 await expect(page.locator('.bk-row')).toHaveCount(1);
});

test('links: Copy link first, Turn on for off links, the ••• menu, and Stats in the header',async({page,context})=>{
 await context.grantPermissions(['clipboard-read','clipboard-write'],{origin:base});
 const state=await open(page,'#links');
 const rows=page.locator('.lk-row');
 await expect(rows).toHaveCount(3);
 await expect(rows.nth(0)).toContainText('30 min · Google Meet · /intro');
 await expect(rows.nth(0)).toContainText('9booked');
 await expect(rows.nth(0)).toContainText('41views');
 await expect(rows.nth(1)).toContainText('45, 60 or 90 min');
 await rows.nth(0).getByRole('button',{name:/Copy link/}).click();
 await expect(rows.nth(0).getByRole('button',{name:/Copy link|Copied/})).toHaveText('Copied');
 expect(await page.evaluate(()=>navigator.clipboard.readText())).toMatch(/\/intro$/);
 await expect(rows.nth(2).getByRole('button',{name:'Turn on Coffee chat'})).toBeVisible();
 await rows.nth(0).getByRole('button',{name:/More for/}).click();
 await expect(page.getByRole('menuitem')).toHaveText(['Preview','Embed','Duplicate','Turn off','Delete']);
 await page.getByRole('menuitem',{name:'Turn off'}).click();
 await expect.poll(()=>state.writes.at(-1)?.meetingTypes?.find(t=>t.id==='intro')?.published).toBe(false);
 await rows.nth(2).getByRole('button',{name:'Turn on Coffee chat'}).click();
 await expect.poll(()=>state.writes.at(-1)?.meetingTypes?.find(t=>t.id==='coffee')?.published).toBe(true);
 await page.getByRole('button',{name:'Stats',exact:true}).click();
 await expect(page.getByRole('heading',{name:'Stats'})).toBeVisible();
 const period=await page.locator('.analytics-period').innerText();
 expect(period).not.toMatch(/\d{4}-\d{2}-\d{2}|UTC/);
});

test('link editor: one page, length chips, sentences, no hosts for a solo link, and Save sends the change',async({page})=>{
 const state=await open(page,'#link=consultation');
 const form=page.locator('#meeting-form');
 await expect(form.getByRole('heading',{name:'Hosts'})).toHaveCount(0);
 await expect(form.locator('[data-hours-mode]')).toHaveValue('__default__');
 await expect(form.locator('#edit-notice')).toHaveValue('120');
 await expect(form.locator('#edit-notice option:checked')).toHaveText('2 hours');
 await expect(form.locator('#edit-approvalExpiryMinutes option:checked')).toHaveText('1 day');
 await expect(form.getByText('At least')).toBeVisible();
 for(const row of ['Questions','Reminder emails','Cancelling and rescheduling','Limits','Look'])await expect(form.locator('.le-row > summary',{hasText:row})).toBeVisible();
 await expect(page.locator('[data-live-preview] .mini-chips .chip.on')).toHaveText('60 min');
 await expect(page.locator('#editor-save-state')).toHaveText('');
 await form.locator('.len-chip',{hasText:'90 min'}).click();
 await expect(page.locator('#editor-save-state')).toHaveText('Unsaved changes');
 await form.locator('.len-chip',{hasText:'45 min'}).click();
 await form.locator('.len-chip',{hasText:'60 min'}).click();
 await expect(form.locator('input[name=duration]')).toHaveValue('60','the last length cannot be turned off');
 await expect(form.locator('[data-len-note]')).toHaveText('');
 await page.getByRole('button',{name:'Save',exact:true}).click();
 await expect.poll(()=>state.writes.at(-1)?.meetingTypes?.find(t=>t.id==='consultation')).toMatchObject({duration:60,durationOptions:null,useDefaultSchedule:true});
});

test('link editor: "Different times for this link…" keeps own hours and Reset clears a per-link calendar',async({page})=>{
 const w=world();w.state.settings.meetingTypes[0]={...w.state.settings.meetingTypes[0],useDefaultCalendar:false,calendarId:'family'};
 await page.route('**/api/**',w.handler);await page.goto(base+'/studio#link=coffee');
 const form=page.locator('#meeting-form');
 await expect(form.locator('[data-hours-mode]')).toHaveValue('');
 await expect(form.locator('[data-own-hours-summary]')).toHaveText('Tue 15:00–17:00, Thu 15:00–17:00');
 await page.goto('about:blank');await page.goto(base+'/studio#link=intro');
 await expect(page.locator('[data-calendar-override]')).toContainText('Bookings go to Family for this link');
 await page.getByRole('button',{name:'Reset'}).click();
 await page.getByRole('button',{name:'Save',exact:true}).click();
 await expect.poll(()=>w.state.writes.at(-1)?.meetingTypes?.find(t=>t.id==='intro')?.useDefaultCalendar).toBe(true);
});

async function columnBox(page,index){
 const col=page.locator('[data-col]').nth(index),box=await col.boundingBox(),from=Number(await page.locator('[data-week]').getAttribute('data-from'));
 return {x:box.x+box.width/2,y:hour=>box.y+(hour-from)*44};
}

test('availability: drag to add, click to remove, one-week day off, past days locked, saved as you go',async({page})=>{
 const state=await open(page,'#availability');
 await expect(page.locator('[data-week]')).toBeVisible();
 await expect(page.getByText('Busy from')).toBeVisible();
 await expect(page.getByLabel('New bookings go to')).toHaveValue('riley@example.com');
 await expect(page.locator('.av-sum')).toContainText('open next week');
 const sat=await columnBox(page,5);
 await page.mouse.move(sat.x,sat.y(10)+2);await page.mouse.down();await page.mouse.move(sat.x,sat.y(11.5),{steps:4});
 await expect(page.locator('.wk-ghost')).toBeVisible();
 await page.mouse.move(sat.x,sat.y(13),{steps:4});await page.mouse.up();
 await expect.poll(()=>state.writes.at(-1)?.availabilitySchedules?.[0]?.weeklyHours?.[6]).toEqual([{start:600,end:780}]);
 await expect(page.getByText('Saved')).toBeVisible();
 await page.locator('[data-col]').nth(5).locator('.wk-block').click();
 await expect.poll(()=>state.writes.at(-1)?.availabilitySchedules?.[0]?.weeklyHours?.[6]).toEqual([]);
 await page.getByRole('button',{name:'This week only'}).click();
 const past=await page.locator('.wk-col.past').evaluateAll(cols=>cols.map(c=>c.dataset.col));
 const today=await page.evaluate(()=>new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Oslo'}).format(new Date()));
 expect(past.every(key=>key<today)).toBe(true);
 await expect(page.locator('[data-day][disabled]')).toHaveCount(past.length);
 await page.getByRole('button',{name:'Next week'}).click();
 await expect(page.locator('.wk-col.past')).toHaveCount(0);
 const friday=page.locator('[data-day]').nth(4),key=await friday.getAttribute('data-day');
 await friday.click();
 await page.getByRole('menuitemradio',{name:'Off all day'}).click();
 await expect.poll(()=>state.writes.at(-1)?.availabilitySchedules?.[0]?.dateOverrides?.[key]).toEqual([]);
 await expect(page.locator('.av-sum')).toContainText('1 change');
 const weeklyBefore=state.writes.at(-1).availabilitySchedules[0].weeklyHours[5];
 expect(weeklyBefore).toEqual([{start:540,end:1020}]);
 await page.getByRole('button',{name:'Every week'}).click();
 await expect(page.locator(`[data-day="${key}"]`)).toHaveClass(/chg/);
});

test('availability: drag a block to a new time or day, in either view; Escape puts it back',async({page})=>{
 const state=await open(page,'#availability');
 await expect(page.locator('.av-sum')).toContainText('open next week');
 const hours=day=>state.writes.at(-1)?.availabilitySchedules?.[0]?.weeklyHours?.[day];
 const mon=await columnBox(page,0),tue=await columnBox(page,1),wed=await columnBox(page,2),sat=await columnBox(page,5);
 await page.mouse.move(mon.x,mon.y(12));await page.mouse.down();await page.mouse.move(mon.x,mon.y(12.5),{steps:4});
 await expect(page.locator('.wk-ghost')).toHaveText('09:30–17:30');
 await expect(page.locator('.wk-block.lifted')).toHaveCount(1);
 await page.mouse.move(mon.x,mon.y(13),{steps:4});await page.mouse.up();
 await expect.poll(()=>hours(1)).toEqual([{start:600,end:1080}]);
 await expect(page.locator('[data-col]').nth(0).locator('.wk-block')).toHaveText('10:00–18:00');
 await page.mouse.move(tue.x,tue.y(12));await page.mouse.down();await page.mouse.move(sat.x,sat.y(12),{steps:8});await page.mouse.up();
 await expect.poll(()=>hours(6)).toEqual([{start:540,end:1020}]);
 expect(hours(2)).toEqual([]);
 await expect(page.getByText('Saved')).toBeVisible();
 const writes=state.writes.length;
 await page.mouse.move(wed.x,wed.y(12));await page.mouse.down();await page.mouse.move(wed.x,wed.y(14),{steps:4});
 await expect(page.locator('.wk-ghost')).toBeVisible();
 await page.keyboard.press('Escape');
 await expect(page.locator('.wk-ghost')).toHaveCount(0);
 await page.mouse.up();
 await expect(page.locator('[data-av-status]')).toHaveText('Saved');
 await expect(page.locator('[data-col]').nth(2).locator('.wk-block')).toHaveText('09:00–17:00');
 expect(state.writes.length).toBe(writes);
 await page.getByRole('button',{name:'This week only'}).click();
 const loaded=page.waitForResponse(r=>r.url().includes('/api/live/calendar-events'));
 await page.getByRole('button',{name:'Next week'}).click();await loaded;
 await expect(page.locator('.wk-col.past')).toHaveCount(0);
 const [thu,fri]=await page.locator('[data-day]').evaluateAll(days=>days.slice(3,5).map(d=>d.dataset.day));
 const thuBox=await columnBox(page,3),friBox=await columnBox(page,4);
 await page.mouse.move(thuBox.x,thuBox.y(12));await page.mouse.down();await page.mouse.move(friBox.x,friBox.y(13),{steps:8});await page.mouse.up();
 await expect.poll(()=>state.writes.at(-1)?.availabilitySchedules?.[0]?.dateOverrides).toEqual({[thu]:[],[fri]:[{start:540,end:1080}]});
 expect(hours(4)).toEqual([{start:540,end:1020}]);
 await expect(page.locator('.av-sum')).toContainText('2 changes');
});

test('first run: Continue with Google, hours pre-filled Mon–Fri 9–5, then Your link is ready',async({page})=>{
 await open(page,'',{firstRun:true});
 const steps=page.locator('.setup-steps');
 await expect(steps.getByRole('heading',{name:'Get your booking link ready'})).toBeVisible();
 await expect(steps.getByRole('link',{name:'Continue with Google'})).toBeVisible();
 await expect(steps).toContainText('Mon–Fri 09:00–17:00');
 await expect(page.getByText('Create your profile')).toHaveCount(0);
 await page.unrouteAll({behavior:'ignoreErrors'});
 const w=world({firstRun:true});w.state.settings.accounts=[{id:'riley',email:'riley@example.com',connected:true,destinationCalendarId:'riley@example.com',conflictCalendarIds:['riley@example.com']}];w.state.settings.meetingTypes[0]={...w.state.settings.meetingTypes[0],accountId:'riley',published:true};
 await page.route('**/api/**',w.handler);await page.reload();
 await expect(steps.locator('.step.done')).toHaveCount(1);
 await steps.getByRole('button',{name:'Looks good'}).click();
 await expect(steps).toContainText('Your link is ready');
 await expect(steps.getByRole('button',{name:'Copy link'})).toBeVisible();
});

test('phone: bottom tab bar instead of the sidebar, More holds setup and account, no sideways scroll',async({page})=>{
 await page.setViewportSize({width:390,height:844});
 await open(page);
 const tabs=page.getByRole('navigation',{name:'Sections'});
 await expect(tabs).toBeVisible();
 await expect(tabs.getByRole('button')).toHaveText([/Bookings/,'Links','Availability','More']);
 await expect(sidebar(page)).toBeHidden();
 await expect(page.locator('#account-trigger')).toBeHidden();
 const heading=await page.getByRole('heading',{name:'Bookings',level:1}).boundingBox();
 expect(heading.y).toBeLessThan(140);
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 await tabs.getByRole('button',{name:'More'}).click();
 await expect(page.locator('#account-menu').getByRole('button',{name:'Integrations'})).toBeVisible();
 await expect(page.locator('#account-menu').getByRole('button',{name:'Stats'})).toBeVisible();
 await page.locator('#account-menu').getByRole('button',{name:'Integrations'}).click();
 await expect(page.getByRole('heading',{name:'Integrations',level:1})).toBeVisible();
 await tabs.getByRole('button',{name:'Availability'}).click();
 await expect(page.locator('[data-week]')).toBeVisible();
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});

test('reconnect: a rejected Google grant shows one Reconnect action instead of an error',async({page})=>{
 await open(page,'',{reconnect:true});
 await expect(page.getByRole('link',{name:'Reconnect Google Calendar'}).first()).toBeVisible();
 await expect(page.getByText(/Google request failed/)).toHaveCount(0);
});
