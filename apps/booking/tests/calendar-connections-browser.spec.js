// Calendar choices for a personal profile live in the Availability side panel:
// "Busy from" checkboxes and "New bookings go to", saved per account to
// /api/live/calendars as soon as they change.
import {test,expect} from '@playwright/test';
import {DEFAULT} from '../public/policy.js';
const base=process.env.BOOKING_TEST_ORIGIN||'http://127.0.0.1:8791';
test.use({timezoneId:'Europe/Oslo'});
const hours=Object.fromEntries([0,1,2,3,4,5,6].map(d=>[d,d>0&&d<6?[{start:540,end:1020}]:[]]));
const lists={a:[{id:'personal',summary:'Personal',accessRole:'owner'},{id:'work',summary:'Work',accessRole:'writer'},{id:'holiday',summary:'Public holidays',accessRole:'reader'}],b:[{id:'team',summary:'Company',accessRole:'owner'},{id:'board',summary:'Board calendar',accessRole:'reader'}]};
async function setup(page,{noDestination=false}={}){
 let settings={revision:'A'.repeat(43),hostId:'h_abcdefghijklmnopqrstuvwx',profile:{name:'Riley'},accounts:[{id:'a',email:'riley@company.test',connected:true,destinationCalendarId:noDestination?'':'work',conflictCalendarIds:noDestination?[]:['work']},{id:'b',email:'other@company.test',connected:true,destinationCalendarId:'team',conflictCalendarIds:['team']}],meetingTypes:[{...DEFAULT,id:'intro',slug:'intro',title:'Intro',published:true,accountId:'a',calendarId:'work',useDefaultSchedule:true}],availabilitySchedules:[{id:'availability',name:'Availability',zone:'Europe/Oslo',weeklyHours:hours,dateOverrides:{}}],defaultAvailabilityScheduleId:'availability'};
 const writes=[];let fail=false,gate=null,release;
 await page.route('**/api/**',async route=>{const request=route.request(),path=new URL(request.url()).pathname,json=(data,status=200)=>route.fulfill({json:data,status});
  if(path==='/api/bootstrap')return json({mode:'live',authenticated:true,hostId:settings.hostId,email:'riley@company.test'});
  if(path==='/api/live/workspaces')return json({error:'Unsupported'},404);
  if(path==='/api/live/settings'&&request.method()==='POST')return json({error:'Hours were not expected to change'},500);
  if(path==='/api/live/settings')return json(settings);
  if(path==='/api/live/calendars'&&request.method()==='POST'){const payload=request.postDataJSON();writes.push(payload);if(fail){fail=false;return json({error:'Could not save calendars'},500);}if(gate)await gate;settings={...settings,revision:'B'.repeat(42)+writes.length%10,accounts:settings.accounts.map(a=>{const c=payload.accounts.find(x=>(x.accountId??x.id)===a.id);return c?{...a,destinationCalendarId:c.destinationCalendarId,conflictCalendarIds:c.conflictCalendarIds}:a;})};return json({ok:true});}
  if(path==='/api/live/calendars')return json({accounts:[{id:'a',calendars:lists.a},{id:'b',calendars:{items:lists.b}}]});
  if(path==='/api/live/calendar-events')return json({events:[],calendars:settings.accounts.flatMap(a=>lists[a.id].map(c=>({accountId:a.id,id:c.id,summary:c.summary,color:null,accessRole:c.accessRole,primary:false,busy:a.conflictCalendarIds.includes(c.id),destination:c.id===a.destinationCalendarId})))});
  if(path==='/api/live/bookings')return json({bookings:[]});
  if(path==='/api/live/calendar-contributions')return json({contributions:[]});
  return json({});});
 await page.goto(base+'/studio#availability');await expect(page.locator('.av-check')).toHaveCount(5);
 return {writes,get settings(){return settings;},fail:()=>fail=true,delay:()=>gate=new Promise(r=>release=r),release:()=>{gate=null;release();}};
}
const panel=page=>page.getByRole('complementary',{name:'Calendars'});
const block=(page,i)=>panel(page).locator('.av-account-block').nth(i);
const busy=(page,name)=>panel(page).getByRole('checkbox',{name:new RegExp('^'+name+'( Bookings)?$')});
// The checkbox sits under a drawn box, so people click its label.
const toggle=(page,name)=>panel(page).locator('label.av-check').filter({has:page.locator('.av-cal-name',{hasText:new RegExp('^'+name+'$')})}).click();
const destination=(page,email)=>page.getByLabel('New bookings go to for '+email,{exact:true});
const status=page=>page.locator('[data-av-status]');
const sidebar=page=>page.getByRole('navigation',{name:'Scheduling'});

test('the side panel chooses the booking destination and busy checks without changing another account',async({page})=>{
 const state=await setup(page),order=['Personal','Work','Public holidays'];
 await expect(block(page,0).locator('.av-cal-name')).toHaveText(order);await expect(block(page,1).locator('.av-cal-name')).toHaveText(['Company','Board calendar']);
 const dest=destination(page,'riley@company.test');await expect(dest).toHaveValue('work');
 await expect(dest.locator('option'),'only writable calendars can take bookings').toHaveText(['Personal','Work']);
 await expect(busy(page,'Work')).toBeChecked();await expect(busy(page,'Work')).toBeDisabled();
 await dest.selectOption('personal');
 await expect.poll(()=>state.writes.length).toBe(1);await expect(status(page)).toHaveText('Saved');
 await expect(busy(page,'Personal')).toBeDisabled();await expect(busy(page,'Work')).toBeEnabled();await expect(busy(page,'Work')).toBeChecked();
 await toggle(page,'Work');await expect.poll(()=>state.writes.length).toBe(2);await expect(status(page)).toHaveText('Saved');await expect(busy(page,'Work')).not.toBeChecked();
 await toggle(page,'Public holidays');await expect.poll(()=>state.writes.length).toBe(3);await expect(status(page)).toHaveText('Saved');await expect(busy(page,'Public holidays')).toBeChecked();
 expect(state.writes.map(w=>w.accounts)).toEqual([[{accountId:'a',destinationCalendarId:'personal',conflictCalendarIds:['personal','work']}],[{accountId:'a',destinationCalendarId:'personal',conflictCalendarIds:['personal']}],[{accountId:'a',destinationCalendarId:'personal',conflictCalendarIds:['personal','holiday']}]]);
 expect(state.settings.accounts[1]).toMatchObject({destinationCalendarId:'team',conflictCalendarIds:['team']});
 await expect(block(page,0).locator('.av-cal-name')).toHaveText(order);await expect(dest).toHaveValue('personal');
 await expect(destination(page,'other@company.test')).toHaveValue('team');await expect(busy(page,'Company')).toBeDisabled();await expect(busy(page,'Company')).toBeChecked();
 await page.screenshot({path:`${process.env.BOOKING_SCREENSHOT_DIR||'test-results'}/calendar-connections-desktop.png`,fullPage:true});
});

test('a failed save shows its error and the panel shows what is actually saved',async({page})=>{
 const state=await setup(page);state.fail();
 await toggle(page,'Public holidays');
 await expect.poll(()=>state.writes.length).toBe(1);
 await expect(busy(page,'Public holidays')).not.toBeChecked();expect(state.settings.accounts[0].conflictCalendarIds).toEqual(['work']);
 await expect.soft(status(page),'the error stays in view').toHaveText('Could not save calendars');
 await toggle(page,'Public holidays');await expect.poll(()=>state.settings.accounts[0].conflictCalendarIds).toEqual(['work','holiday']);await expect(status(page)).toHaveText('Saved');
});

test('a save still in flight when leaving Availability lands and shows on return',async({page})=>{
 const state=await setup(page);state.delay();
 await toggle(page,'Public holidays');await expect(status(page)).toHaveText('Saving…');
 await sidebar(page).getByRole('button',{name:'Links',exact:true}).click();await expect(page.locator('.lk-row')).toHaveCount(1);
 state.release();await expect.poll(()=>state.settings.accounts[0].conflictCalendarIds).toEqual(['work','holiday']);
 await sidebar(page).getByRole('button',{name:'Availability',exact:true}).click();
 await expect(busy(page,'Public holidays')).toBeChecked();await expect(busy(page,'Work')).toBeDisabled();
 expect(state.writes).toHaveLength(1);
});

test('calendar controls fit a phone and remain readable in dark mode',async({page})=>{
 await setup(page);await page.setViewportSize({width:390,height:844});
 await expect(panel(page)).toBeVisible();expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 await page.screenshot({path:`${process.env.BOOKING_SCREENSHOT_DIR||'test-results'}/calendar-connections-mobile.png`,fullPage:true});
 await page.evaluate(()=>localStorage.setItem('scheduling-theme','dark'));await page.reload();await expect(panel(page)).toBeVisible();
 await expect(page.locator('html')).toHaveAttribute('data-theme','dark');expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 await expect(destination(page,'riley@company.test')).toHaveValue('work');await expect(busy(page,'Work')).toBeChecked();
 const colors=await busy(page,'Personal').locator('xpath=..').evaluate(label=>{const s=getComputedStyle(label);return [s.color,getComputedStyle(document.body).backgroundColor];});expect(colors[0]).not.toBe(colors[1]);
 await page.screenshot({path:`${process.env.BOOKING_SCREENSHOT_DIR||'test-results'}/calendar-connections-dark.png`,fullPage:true});
});

test('a missing booking destination is not shown as chosen, choosing one saves it, and another account stays locked',async({page})=>{
 const state=await setup(page,{noDestination:true});const dest=destination(page,'riley@company.test');
 await expect.soft(dest,'no calendar is shown as the destination before one is chosen').toHaveValue('');
 await expect(busy(page,'Company')).toBeDisabled();
 await dest.selectOption('work');
 await expect.poll(()=>state.writes.length).toBe(1);await expect(status(page)).toHaveText('Saved');
 expect(state.writes[0].accounts).toEqual([{accountId:'a',destinationCalendarId:'work',conflictCalendarIds:['work']}]);
 await expect(dest).toHaveValue('work');await expect(busy(page,'Work')).toBeDisabled();await expect(busy(page,'Company')).toBeDisabled();await expect(busy(page,'Company')).toBeChecked();
});
