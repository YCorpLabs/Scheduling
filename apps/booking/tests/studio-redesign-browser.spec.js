// The redesigned Studio: Home, Links, the one-page link editor, the
// Availability week calendar, first run, phone layout and reconnect.
import {test,expect} from '@playwright/test';
import {DEFAULT} from '../public/policy.js';
import {mondayOf,todayKey,addDays,zonedEpoch} from '../public/week-calendar.js';
const base=process.env.BOOKING_TEST_ORIGIN||'http://127.0.0.1:8791';
const H=3600000,D=24*H,zone='Europe/Oslo',me='h_'+'R'.repeat(24);
test.use({timezoneId:zone});

const week=(from,to,days=[1,2,3,4,5])=>Object.fromEntries([0,1,2,3,4,5,6].map(d=>[d,days.includes(d)?[{start:from*60,end:to*60}]:[]]));
const link=(id,title,extra={})=>({...DEFAULT,id,slug:id,title,host:'Riley Park',company:'',description:'',zone,accountId:'riley',calendarId:'riley@example.com',useDefaultCalendar:true,useDefaultSchedule:true,scheduleId:null,published:true,...extra});

function world({firstRun=false,reconnect=false,events=[]}={}){
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
  if(path==='/api/live/calendar-events')return json({events,calendars:reconnect||!state.settings.accounts.length?[]:[{accountId:'riley',id:'riley@example.com',summary:'Riley Park',color:'#3a7afe',accessRole:'owner',primary:true,busy:true,destination:true},{accountId:'riley',id:'family',summary:'Family',color:'#e0763a',accessRole:'reader',primary:false,busy:false,destination:false}]});
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
// One name menu at the top of the sidebar (phones: top of the screen) holds the profiles, Settings and Sign out.
const openMenu=async page=>{await page.locator('#account-trigger').click();const menu=page.getByRole('dialog',{name:'Account',exact:true});await expect(menu).toBeVisible();return menu;};
const openSettings=async page=>(await openMenu(page)).getByRole('button',{name:'Settings',exact:true}).click();
// Home (the Bookings section) has no page heading of its own: the link is the h1 and Upcoming follows.
async function expectHome(page){await expect(page.locator('.hm-hero')).toBeVisible();await expect(page.getByRole('heading',{name:'Upcoming',level:2})).toBeVisible();await expect(page).toHaveTitle(/^Home · /);}

test('navigation is Home, Links and Availability; the name menu sits at the top and holds Settings; Home is the default page',async({page})=>{
 await open(page);
 await expectHome(page);
 await expect(sidebar(page).getByRole('button')).toHaveText([/^Home\s*1$/,'Links','Availability']);
 for(const gone of ['Activity','Integrations','Hours','Calendars','Booking stats','Troubleshooting','Team','Settings','Bookings'])await expect(sidebar(page).getByRole('button',{name:gone,exact:true})).toHaveCount(0);
 await expect(page.locator('.nav-group')).toHaveCount(0);await expect(page.locator('.host-nav .sb-bottom')).toHaveCount(0);await expect(page.locator('.host-nav .sb-brand')).toHaveCount(0);
 // Every row is 32px and starts its label 24px from the edge; the name menu sits above them.
 const rows=await page.locator('.host-nav .sb-row').evaluateAll(els=>els.map(e=>{const r=e.getBoundingClientRect();return {h:r.height,pad:parseFloat(getComputedStyle(e).paddingLeft)+r.left};}));
 expect(rows).toHaveLength(3);for(const row of rows)expect(row).toEqual({h:32,pad:24});
 const trigger=page.locator('#account-trigger'),own=await trigger.boundingBox(),first=await page.locator('.host-nav .sb-row').first().boundingBox();
 await expect(trigger).toHaveText(/Riley Park/);await expect(trigger).toHaveAccessibleName('Riley Park, account menu');expect(own.y+own.height).toBeLessThanOrEqual(first.y);expect((await page.locator('.host-nav').boundingBox()).width).toBe(240);
 // The menu opens below the name; with only a personal profile there is nothing to switch to.
 const menu=await openMenu(page);expect((await menu.boundingBox()).y).toBeGreaterThanOrEqual(own.y+own.height);
 await expect(menu.getByRole('button')).toHaveText(['Settings','Sign out']);await expect(menu).toContainText('riley@example.com');
 await page.keyboard.press('Escape');await expect(menu).toBeHidden();await expect(trigger).toBeFocused();
 // Settings swaps the sidebar to Back and the Settings pages; the heading names the page and there are no tabs.
 await openSettings(page);
 const pages=page.getByRole('navigation',{name:'Settings'});
 await expect(pages.getByRole('button')).toHaveText(['Profile','Connected apps','Notifications','Sign-in & data']);
 await expect(page.getByRole('heading',{level:1})).toHaveText('Profile');await expect(page).toHaveURL(/#settings\/profile$/);await expect(page.getByRole('tab')).toHaveCount(0);
 for(const [name,heading] of [['Connected apps','Connected apps'],['Notifications','Notifications'],['Sign-in & data','Sign-in & data']]){await pages.getByRole('button',{name,exact:true}).click();await expect(page.getByRole('heading',{level:1})).toHaveText(heading);await expect(pages.getByRole('button',{name,exact:true})).toHaveAttribute('aria-current','page');}
 // Theme sits in Sign-in & data on every size; the extra Sign out there is for phones only.
 await expect(page.getByRole('group',{name:'Theme'}).getByRole('button')).toHaveText(['Light','Dark','Auto']);await expect(page.locator('main').getByRole('button',{name:'Sign out',exact:true})).toBeHidden();
 await page.getByRole('button',{name:'Back',exact:true}).click();
 await expectHome(page);await expect(sidebar(page).getByRole('button',{name:/^Home/})).toHaveAttribute('aria-current','page');
 // Stats stays one click away in the Links header; the old addresses still open their new homes.
 await sidebar(page).getByRole('button',{name:'Links',exact:true}).click();await page.locator('#main .host-heading').getByRole('button',{name:'Stats',exact:true}).click();await expect(page.getByRole('heading',{name:'Stats',level:1})).toBeVisible();
 await page.goto('about:blank');await page.goto(base+'/studio#activity');await expect(page.getByRole('heading',{name:'Connected apps',level:1})).toBeVisible();
 await page.goto('about:blank');await page.goto(base+'/studio#integrations');await expect(page.getByRole('heading',{name:'Notifications',level:1})).toBeVisible();
 await page.goto('about:blank');await page.goto(base+'/studio#status');await expect(page.getByRole('heading',{name:'Troubleshooting',level:1})).toBeVisible();await expect(page.getByRole('button',{name:'← Home',exact:true})).toBeVisible();
});

test('home: your link with Copy link and Share, then Upcoming by day with Approve on requests and Join today; Past and Cancelled keep the fuller list',async({page,context})=>{
 await context.grantPermissions(['clipboard-read','clipboard-write'],{origin:base});
 const state=await open(page);await expectHome(page);
 // The hero: the first live link without https://, its title and length, Copy link and Share.
 const hero=page.locator('.hm-hero'),url=`${new URL(base).host}/b/${me}/intro`;
 await expect(hero).toContainText('Your link');await expect(hero.getByRole('heading',{level:1})).toHaveText(url);await expect(hero).toContainText('Intro call · 30 min');
 await expect(hero.getByRole('button')).toHaveText(['Copy link','Share']);
 await hero.getByRole('button',{name:'Copy link',exact:true}).click();await expect(hero.getByRole('button',{name:'Copied',exact:true})).toBeFocused();
 expect(await page.evaluate(()=>navigator.clipboard.readText())).toBe(`${base}/b/${me}/intro`);
 const shareButton=hero.getByRole('button',{name:'Share',exact:true});await shareButton.click();
 const share=page.getByRole('dialog',{name:'Share',exact:true});await expect(share).toBeVisible();
 await expect(share.getByRole('heading',{level:3})).toHaveText(['Send the link','Put it on your website']);await expect(share.getByRole('button',{name:'Copy',exact:true})).toHaveCount(2);
 await expect(share.getByRole('button',{name:'Copy',exact:true}).first()).toBeFocused();await expect(share.getByRole('textbox',{name:'Send the link'})).toHaveValue(url);
 await page.keyboard.press('Escape');await expect(share).toHaveCount(0);await expect(shareButton).toBeFocused();
 await shareButton.click();await page.getByRole('dialog',{name:'Share',exact:true}).getByRole('button',{name:'More options',exact:true}).click();
 const full=page.getByRole('dialog',{name:'Share and preview booking link'});await expect(full).toBeVisible();await full.getByRole('button',{name:'Close share and preview'}).click();await expect(full).toHaveCount(0);
 // Upcoming: one list by day; a request is a row with Approve only, Decline is in its details.
 await expect(page.getByRole('heading',{name:'Upcoming',level:2})).toBeVisible();await expect(page.locator('.hm-day').first()).toHaveText(/^Today · /);
 await expect(page.getByText('Waiting for your OK')).toHaveCount(0);await expect(page.locator('.setup-steps')).toHaveCount(0);
 const request=page.locator('.hm-row').filter({hasText:'Sara Lind'}),maya=page.locator('.hm-row').filter({hasText:'Maya Chen'});
 await expect(request.getByRole('button')).toHaveText([/Sara Lind/,'Approve']);await expect(request.getByRole('button',{name:'Details: Project consultation with Sara Lind, needs your approval',exact:true})).toBeVisible();
 await expect(maya.getByRole('link',{name:'Join'})).toHaveAttribute('href','https://meet.google.com/abc-defg-hij');await expect(maya.getByRole('button',{name:'Details: Intro call with Maya Chen',exact:true})).toBeVisible();
 await expect(page.locator('.hm-row').filter({hasText:'Priya Shah'})).toHaveCount(0);await expect(page.locator('.hm-row').filter({hasText:'Leo Martin'})).toHaveCount(0);
 // No ••• menus, search or time zone label on Home when the zone is the browser's.
 await expect(page.locator('.hm-row').getByRole('button',{name:/^More for/})).toHaveCount(0);await expect(page.getByRole('button',{name:'Search',exact:true})).toHaveCount(0);await expect(page.getByText(/^Times in/)).toHaveCount(0);
 const details=request.getByRole('button',{name:/^Details:/});await details.click();const dialog=page.getByRole('dialog',{name:'Booking details'});
 await expect(dialog.getByRole('button',{name:'Decline request',exact:true})).toBeVisible();await page.keyboard.press('Escape');await expect(dialog).toHaveCount(0);await expect(details).toBeFocused();
 expect(state.decisions).toEqual([]);
 await request.getByRole('button',{name:'Approve',exact:true}).click();
 await expect.poll(()=>state.decisions.map(d=>d.action)).toEqual(['approve']);
 await expect(request.getByRole('button',{name:'Approve'})).toHaveCount(0);await expect(request.getByRole('button',{name:'Details: Project consultation with Sara Lind',exact:true})).toBeVisible();
 await expect(sidebar(page).getByRole('button',{name:/^Home/})).toHaveText('Home');
 // Past and Cancelled open the fuller list: ← Home, ••• menus, the time zone and search.
 await page.getByRole('button',{name:'Past (1)'}).click();
 await expect(page.getByRole('heading',{name:'Past'})).toBeVisible();
 await expect(page.locator('.bk-row')).toContainText(['Priya Shah']);
 await page.locator('.bk-row').filter({hasText:'Priya Shah'}).getByRole('button',{name:/More for/}).click();
 await expect(page.getByRole('menuitem')).toHaveText(['Details']);
 await page.keyboard.press('Escape');
 await page.getByRole('button',{name:'← Home'}).click();await expectHome(page);
 await page.getByRole('button',{name:'Cancelled (1)'}).click();
 await expect(page.locator('.bk-row')).toContainText(['Leo Martin']);
 await expect(page.getByText(/^Times in Oslo/)).toBeVisible();
 await page.getByRole('button',{name:'Search'}).click();
 await page.locator('#booking-search').fill('maya');await expect(page.getByText('No matches.',{exact:true})).toBeVisible();
 await page.locator('#booking-search').fill('leo');await expect(page.locator('.bk-row')).toHaveCount(1);
 await page.getByRole('button',{name:'← Home'}).click();await expectHome(page);
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

test('availability: events never hide a block\'s time label at any width, titles end in an ellipsis, and a press on an event reaches the block',async({page})=>{
 const mon=mondayOf(todayKey(zone)),wed=addDays(mon,2),thu=addDays(mon,3),long='Weekly planning with the Fernhill leadership team and partners';
 const ev=(key,from,to,title)=>({title,start:zonedEpoch(key,from,zone),end:zonedEpoch(key,to,zone),allDay:false,booking:false,accountId:'riley',calendarId:'riley@example.com'});
 await page.setViewportSize({width:1440,height:900});
 const state=await open(page,'#availability',{events:[ev(wed,540,555,'Team standup'),ev(wed,600,660,long),ev(thu,510,1050,'Offsite')]});
 const wedCol=page.locator(`[data-col="${wed}"]`),thuCol=page.locator(`[data-col="${thu}"]`);
 await expect(wedCol.locator('.wk-event')).toHaveCount(2);
 // Labels that are not drawn over events never touch one.
 const hidden=()=>page.locator('.wk-col').evaluateAll(cols=>cols.flatMap(col=>{const events=[...col.querySelectorAll('.wk-event')].map(e=>e.getBoundingClientRect());return [...col.querySelectorAll('.wk-label:not(.over)')].filter(label=>{const r=label.getBoundingClientRect();return events.some(e=>e.top<r.bottom&&e.bottom>r.top&&e.left<r.right&&e.right>r.left);}).map(label=>label.closest('[data-col]').dataset.col);}));
 const onTop=locator=>locator.evaluate(el=>{const r=el.getBoundingClientRect();return el.contains(document.elementFromPoint(r.left+r.width/2,r.top+r.height/2));});
 expect(await hidden()).toEqual([]);
 await expect(wedCol.locator('.wk-label')).not.toHaveClass(/over/);
 // Covered all day: the label sits over the event, below its title, and is what you see there.
 await expect(thuCol.locator('.wk-label')).toHaveClass(/over/);
 expect(await onTop(thuCol.locator('.wk-label'))).toBe(true);
 // A long title stays inside its event and is clamped; the tooltip and the accessible text have all of it.
 const planning=wedCol.locator('.wk-event').nth(1);
 await expect(planning).toHaveAttribute('title',long+' 10:00–11:00');
 await expect(planning).toHaveText(long+', 10:00–11:00');
 expect(await planning.locator('.wk-event-title').evaluate(el=>{const r=el.getBoundingClientRect(),box=el.parentElement.getBoundingClientRect();return {clamped:el.scrollHeight>el.clientHeight,inside:r.bottom<=box.bottom};})).toEqual({clamped:true,inside:true});
 expect(await onTop(planning)).toBe(true);
 // Narrower: the label wraps onto two lines and is placed again clear of the events.
 await page.setViewportSize({width:1180,height:900});
 await expect.poll(hidden).toEqual([]);
 await expect.poll(()=>wedCol.locator('.wk-label').evaluate(el=>el.offsetHeight)).toBeGreaterThan(20);
 // Pressing the standup acts on the block under it: a click removes Wednesday's hours.
 const standup=await wedCol.locator('.wk-event').first().boundingBox();
 await page.mouse.click(standup.x+standup.width/2,standup.y+standup.height/2);
 await expect.poll(()=>state.writes.at(-1)?.availabilitySchedules?.[0]?.weeklyHours?.[3]).toEqual([]);
});

test('first run: Home asks to connect the calendar, then says no link is on, then shows the link with Copy link',async({page})=>{
 await open(page,'',{firstRun:true});
 const hero=page.locator('.hm-hero');
 await expect(hero.getByRole('heading',{level:1})).toHaveText('Connect your calendar');
 await expect(hero.getByRole('link',{name:'Continue with Google'})).toHaveAttribute('href','/auth/google?connect=1');
 await expect(hero.getByRole('button',{name:'Copy link'})).toHaveCount(0);
 // The old three-step card is gone from Home.
 for(const gone of ['Get your booking link ready','Looks good','Create your profile','Waiting for your OK'])await expect(page.getByText(gone)).toHaveCount(0);
 await expect(page.locator('.setup-steps')).toHaveCount(0);
 const connected=[{id:'riley',email:'riley@example.com',connected:true,destinationCalendarId:'riley@example.com',conflictCalendarIds:['riley@example.com']}];
 await page.unrouteAll({behavior:'ignoreErrors'});
 let w=world({firstRun:true});w.state.settings.accounts=connected;w.state.settings.meetingTypes[0]={...w.state.settings.meetingTypes[0],accountId:'riley'};
 await page.route('**/api/**',w.handler);await page.reload();
 await expect(hero.getByRole('heading',{level:1})).toHaveText('No link is on yet');await hero.getByRole('button',{name:'Open Links',exact:true}).click();await expect(page.getByRole('heading',{name:'Links',level:1})).toBeVisible();
 await page.unrouteAll({behavior:'ignoreErrors'});
 w=world({firstRun:true});w.state.settings.accounts=connected;w.state.settings.meetingTypes[0]={...w.state.settings.meetingTypes[0],accountId:'riley',published:true};
 await page.route('**/api/**',w.handler);await page.goto(base+'/studio');
 await expect(hero.getByRole('heading',{level:1})).toHaveText(`${new URL(base).host}/b/${me}/intro`);await expect(hero).toContainText('Intro call · 30 min');
 await expect(hero.getByRole('button',{name:'Copy link'})).toBeVisible();await expect(page.getByText('No upcoming bookings.',{exact:true})).toBeVisible();
});

test('phone: tab bar without Settings, the name menu at the top opens Settings as a list, each page with ‹ Settings, no sideways scroll',async({page})=>{
 await page.setViewportSize({width:390,height:844});
 await open(page);
 const tabs=page.getByRole('navigation',{name:'Sections'});
 await expect(tabs).toBeVisible();
 await expect(tabs.getByRole('button')).toHaveText([/Home/,'Links','Availability']);
 await expect(sidebar(page)).toBeHidden();
 const trigger=page.locator('#account-trigger');await expect(trigger).toBeVisible();const own=await trigger.boundingBox();expect(own.y).toBeLessThan(80);
 const hero=await page.locator('.hm-hero').boundingBox();expect(hero.y).toBeGreaterThanOrEqual(own.y+own.height);expect(hero.y).toBeLessThan(200);
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 // The menu opens under the name, fits the screen and closes with Escape.
 const menu=await openMenu(page);const box=await menu.boundingBox();expect(box.y).toBeGreaterThanOrEqual(own.y+own.height);expect(box.x+box.width).toBeLessThanOrEqual(390);
 await page.keyboard.press('Escape');await expect(menu).toBeHidden();await expect(trigger).toBeFocused();
 await openSettings(page);
 await expect(page.getByRole('heading',{name:'Settings',level:1})).toBeVisible();await expect(tabs.locator('[aria-current=page]')).toHaveCount(0);
 const list=page.locator('.st-list-row');await expect(list).toHaveCount(4);
 await expect(list.nth(0)).toContainText('Profile');await expect(list.nth(0)).toContainText('Riley Park');await expect(list.nth(3)).toContainText('riley@example.com');
 await list.filter({hasText:'Notifications'}).click();
 await expect(page.getByRole('heading',{name:'Notifications',level:1})).toBeVisible();
 await page.getByRole('button',{name:'Settings',exact:true}).first().click();await expect(page.getByRole('heading',{name:'Settings',level:1})).toBeVisible();
 await list.filter({hasText:'Sign-in & data'}).click();await expect(page.getByRole('group',{name:'Theme'})).toBeVisible();await expect(page.locator('main').getByRole('button',{name:'Sign out',exact:true})).toBeVisible();
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 await tabs.getByRole('button',{name:'Availability'}).click();
 await expect(page.locator('[data-week]')).toBeVisible();
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});

test('reconnect: a rejected Google grant shows one Reconnect action instead of an error',async({page})=>{
 await open(page,'',{reconnect:true});
 await expect(page.getByRole('link',{name:'Reconnect Google Calendar'}).first()).toBeVisible();
 await expect(page.getByText(/Google request failed/)).toHaveCount(0);
});
