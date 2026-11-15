// Where a link's bookings go. Links follow their account's "New bookings go to"
// calendar (chosen on Availability). A link that still has its own calendar
// shows "Bookings go to X for this link · Reset", and Reset returns it to the
// account default when saved. The per-link calendar picker is gone.
import {test,expect} from '@playwright/test';
import {DEFAULT} from '../public/policy.js';
const base=process.env.BOOKING_TEST_ORIGIN||'http://127.0.0.1:8791';
test.use({timezoneId:'Europe/Oslo'});
const lists={a:[{id:'primary',summary:'Personal',accessRole:'owner'},{id:'consulting',summary:'Consulting',accessRole:'writer'},{id:'holidays',summary:'Holidays',accessRole:'reader'},{id:'deleted',summary:'Deleted calendar',accessRole:'writer',deleted:true}],b:[{id:'team',summary:'Team',accessRole:'owner'},{id:'calls',summary:'Client calls',accessRole:'writer'}]};
async function setup(page,{type={},delay=false,noDefault=false}={}){
 let settings={revision:'A'.repeat(43),profile:{name:'Riley'},accounts:[{id:'a',connected:true,email:'personal@example.com',destinationCalendarId:noDefault?'':'primary',conflictCalendarIds:noDefault?[]:['primary']},{id:'b',connected:true,email:'work@example.com',destinationCalendarId:'team',conflictCalendarIds:['team']}],meetingTypes:[{...DEFAULT,id:'intro',slug:'intro',title:'Intro',published:true,accountId:'a',calendarId:'primary',useDefaultCalendar:true,useDefaultSchedule:true,scheduleId:null,...type}],availabilitySchedules:[{id:'availability',name:'Availability',zone:'Europe/Oslo',weeklyHours:Object.fromEntries([0,1,2,3,4,5,6].map(d=>[d,d>0&&d<6?[{start:540,end:1020}]:[]])),dateOverrides:{}}],defaultAvailabilityScheduleId:'availability'};
 const writes=[],calendarWrites=[];let release;const gate=new Promise(resolve=>release=resolve);
 await page.route('**/api/**',async route=>{const request=route.request(),path=new URL(request.url()).pathname,json=(data,status=200)=>route.fulfill({json:data,status});
  if(path==='/api/bootstrap')return json({mode:'live',authenticated:true,hostId:'h_abcdefghijklmnopqrstuvwx',email:'personal@example.com'});
  if(path==='/api/live/workspaces')return json({error:'Unsupported'},404);
  if(path==='/api/live/calendars'&&request.method()==='POST'){const body=request.postDataJSON();calendarWrites.push(body);settings={...settings,revision:'C'.repeat(43),accounts:settings.accounts.map(a=>{const c=body.accounts.find(x=>x.accountId===a.id);return c?{...a,destinationCalendarId:c.destinationCalendarId,conflictCalendarIds:c.conflictCalendarIds}:a;})};return json({ok:true});}
  if(path==='/api/live/calendars'){if(delay)await gate;return json({accounts:[{id:'a',calendars:lists.a},{id:'b',calendars:lists.b}]});}
  if(path==='/api/live/calendar-events')return json({events:[],calendars:settings.accounts.flatMap(a=>lists[a.id].filter(c=>!c.deleted).map(c=>({accountId:a.id,id:c.id,summary:c.summary,color:null,accessRole:c.accessRole,primary:false,busy:(a.conflictCalendarIds||[]).includes(c.id),destination:c.id===a.destinationCalendarId})))});
  if(path==='/api/live/settings'&&request.method()==='POST'){const body=request.postDataJSON();writes.push(body);settings={...settings,...body.patch,revision:'B'.repeat(43)};return json({settings,revision:settings.revision});}
  if(path==='/api/live/settings')return json(settings);
  if(path==='/api/live/bookings')return json({bookings:[]});
  if(path==='/api/live/calendar-contributions')return json({contributions:[]});
  return json({});});
 await page.goto(base+'/studio#link=intro');await page.locator('#meeting-form').waitFor();
 return {writes,calendarWrites,release};
}
const override=page=>page.locator('[data-calendar-override]');
const save=page=>page.getByRole('button',{name:'Save',exact:true});

test('a per-link calendar shows where bookings go, and Reset returns the link to the account default',async({page})=>{
 const {writes,calendarWrites}=await setup(page,{type:{useDefaultCalendar:false,calendarId:'consulting'}});
 await expect(page.getByLabel('Booking calendar',{exact:true})).toHaveCount(0);
 await expect(override(page)).toHaveText('Bookings go to Consulting for this link · Reset');
 await override(page).getByRole('button',{name:'Reset',exact:true}).click();
 await expect(override(page)).toHaveCount(0);await expect(page.locator('#editor-save-state')).toHaveText('Unsaved changes');
 await save(page).click();await expect(page.locator('#host-status')).toHaveText('Saved');
 expect(writes[0].patch.meetingTypes[0]).toMatchObject({accountId:'a',calendarId:'primary',useDefaultCalendar:true});
 await expect(override(page)).toHaveCount(0);
 // The account default itself is chosen on Availability, not per link.
 await page.getByRole('navigation',{name:'Scheduling'}).getByRole('button',{name:'Availability',exact:true}).click();
 const destination=page.getByLabel('New bookings go to for personal@example.com',{exact:true});await expect(destination).toHaveValue('primary');
 await expect(destination.locator('option'),'only writable, existing calendars').toHaveText(['Personal','Consulting']);
 await destination.selectOption('consulting');
 await expect.poll(()=>calendarWrites.map(w=>w.accounts)).toEqual([[{accountId:'a',destinationCalendarId:'consulting',conflictCalendarIds:['consulting','primary']}]]);
 expect(writes).toHaveLength(1);
});

test('a link that follows the account default has no override and keeps following it',async({page})=>{
 const {writes}=await setup(page);
 await expect(override(page)).toHaveCount(0);await expect(page.getByLabel('Booking calendar',{exact:true})).toHaveCount(0);
 await page.getByLabel('Meeting name',{exact:true}).fill('Title only');await save(page).click();await expect(page.locator('#host-status')).toHaveText('Saved');
 expect(writes[0].patch.meetingTypes[0]).toMatchObject({title:'Title only',accountId:'a',calendarId:'primary',useDefaultCalendar:true});
});

test('late calendar discovery preserves typing, focus and a saved custom destination',async({page})=>{
 const {writes,release}=await setup(page,{type:{useDefaultCalendar:false,calendarId:'consulting'},delay:true});
 const title=page.getByLabel('Meeting name',{exact:true});await title.fill('Unsent title edit');
 await expect(override(page)).toContainText('Bookings go to consulting for this link');
 release();
 await expect(override(page)).toHaveText('Bookings go to Consulting for this link · Reset');
 await expect(title).toHaveValue('Unsent title edit');await expect(title).toBeFocused();
 await save(page).click();await expect(page.locator('#host-status')).toHaveText('Saved');
 expect(writes[0].patch.meetingTypes[0]).toMatchObject({title:'Unsent title edit',calendarId:'consulting',useDefaultCalendar:false});
});

test('switching the calendar account drops the old account’s calendar and follows the new default',async({page})=>{
 const {writes}=await setup(page,{type:{useDefaultCalendar:false,calendarId:'consulting'}});
 await expect(override(page)).toContainText('Consulting');
 await page.getByLabel('Calendar account',{exact:true}).selectOption('b');
 await expect(override(page),'a calendar from the other account no longer applies').toHaveCount(0);
 await save(page).click();await expect(page.locator('#host-status')).toHaveText('Saved');
 expect(writes[0].patch.meetingTypes[0]).toMatchObject({accountId:'b',calendarId:'team',useDefaultCalendar:true});
});

test('an unavailable saved calendar stays visible and is not silently replaced',async({page})=>{
 const {writes}=await setup(page,{type:{useDefaultCalendar:false,calendarId:'removed'}});
 await expect(override(page)).toHaveText('Bookings go to removed for this link · Reset');
 await page.getByLabel('Meeting name',{exact:true}).fill('Title only');await save(page).click();await expect(page.locator('#host-status')).toHaveText('Saved');
 expect(writes[0].patch.meetingTypes[0]).toMatchObject({calendarId:'removed',useDefaultCalendar:false});
});

test('a per-link calendar is kept without an account default and the editor fits a phone',async({page})=>{
 const {writes}=await setup(page,{noDefault:true,type:{useDefaultCalendar:false,calendarId:'consulting'}});
 await expect(override(page)).toHaveText('Bookings go to Consulting for this link · Reset');
 await page.getByLabel('Meeting name',{exact:true}).fill('Client call');await save(page).click();await expect(page.locator('#host-status')).toHaveText('Saved');
 expect(writes[0].patch.meetingTypes[0]).toMatchObject({accountId:'a',calendarId:'consulting',useDefaultCalendar:false});
 await page.screenshot({path:`${process.env.BOOKING_SCREENSHOT_DIR||'test-results'}/email-per-link-calendar-desktop.png`});
 await page.setViewportSize({width:390,height:844});await override(page).scrollIntoViewIfNeeded();await expect(override(page)).toBeVisible();
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBeTruthy();
 const line=await override(page).boundingBox();expect(line.x).toBeGreaterThanOrEqual(0);expect(line.x+line.width).toBeLessThanOrEqual(390);
 await page.screenshot({path:`${process.env.BOOKING_SCREENSHOT_DIR||'test-results'}/email-per-link-calendar-mobile.png`});
});

test('keyboard order follows the visual groups and reaches the calendar override and account in place',async({page})=>{
 await setup(page,{type:{useDefaultCalendar:false,calendarId:'consulting'}});
 await page.getByLabel('Meeting name',{exact:true}).focus();
 const next=async target=>{await page.keyboard.press('Tab');await expect(target).toBeFocused();};
 for(const chip of await page.locator('[name=durationOption]:not(:disabled)').all())await next(chip);
 await next(page.getByRole('button',{name:'Other length',exact:true}));
 for(const name of ['Where','Meeting link or place','Link','About','Hours','Earliest someone can book','How far ahead','Free before each meeting','Free after each meeting'])await next(page.getByLabel(name,{exact:true}));
 await next(page.getByRole('switch',{name:'I approve each booking'}));
 await next(override(page).getByRole('button',{name:'Reset',exact:true}));
 await next(page.getByLabel('Calendar account',{exact:true}));
 await next(page.locator('#meeting-form details.le-row > summary').first());
 // Reset by keyboard keeps focus in the form.
 await override(page).getByRole('button',{name:'Reset',exact:true}).focus();await page.keyboard.press('Enter');
 await expect(override(page)).toHaveCount(0);await expect(page.locator('#meeting-form :focus')).toHaveCount(1);
});
