// Hours in the one-availability model: a person's availability is edited on
// the Availability week calendar and saved as you go; a link either uses it
// ("Any time I’m available") or keeps its own times ("Different times for
// this link…"). Named schedules, "Save hours" and shared-hours lists are gone.
import {test,expect} from '@playwright/test';
import {DEFAULT} from '../public/policy.js';
const base=process.env.BOOKING_TEST_ORIGIN||'http://127.0.0.1:8791';
test.use({timezoneId:'Europe/Oslo'});
const week=(ranges,days=[1,2,3,4,5])=>Object.fromEntries([0,1,2,3,4,5,6].map(d=>[d,days.includes(d)?ranges.map(r=>({...r})):[]]));
async function setup(page,{hash='#availability',conflict=false,fail=false,delay=false,custom=false}={}){
 const availability={id:'availability',name:'Availability',zone:'Europe/Oslo',weeklyHours:week([{start:600,end:720}],[1]),dateOverrides:{}};
 let settings={revision:'A'.repeat(43),hostId:'h_abcdefghijklmnopqrstuvwx',profile:{name:'Riley'},accounts:[{id:'google1',connected:true,email:'host@example.com',destinationCalendarId:'primary',conflictCalendarIds:['primary']}],availabilitySchedules:[availability],defaultAvailabilityScheduleId:'availability',meetingTypes:[{...DEFAULT,id:'intro',slug:'intro',title:'Intro',published:true,accountId:'google1',calendarId:'primary',useDefaultCalendar:true,scheduleId:null,useDefaultSchedule:true}]};
 if(custom){Object.assign(settings.meetingTypes[0],{useDefaultSchedule:false,zone:'Asia/Kathmandu',weeklyHours:{0:[],1:[],2:[{start:557,end:1091}],3:[],4:[],5:[],6:[]},dateOverrides:{'2026-12-24':[]}});settings.meetingTypes.push({...DEFAULT,id:'other',slug:'other',title:'Other link',published:true,accountId:'google1',calendarId:'primary',useDefaultCalendar:true,scheduleId:null,useDefaultSchedule:true});}
 let release;const gate=new Promise(resolve=>release=resolve);const writes=[];const state={writes,release,elsewhere:null,get settings(){return settings;}};
 await page.route('**/api/**',async route=>{const request=route.request(),path=new URL(request.url()).pathname,json=(data,status=200)=>route.fulfill({json:data,status});
  if(path==='/api/bootstrap')return json({mode:'live',authenticated:true,hostId:settings.hostId,email:'host@example.com',features:{reminders:true}});
  if(path==='/api/live/workspaces')return json({error:'Unsupported'},404);
  if(path==='/api/live/calendars')return json({accounts:[{id:'google1',calendars:[{id:'primary',summary:'Host',accessRole:'owner'}]}]});
  if(path==='/api/live/calendar-events')return json({events:[],calendars:[{accountId:'google1',id:'primary',summary:'Host',color:null,accessRole:'owner',primary:true,busy:true,destination:true}]});
  if(path==='/api/live/bookings')return json({bookings:[]});
  if(path==='/api/live/calendar-contributions')return json({contributions:[]});
  if(path==='/api/live/settings'&&request.method()==='POST'){const body=request.postDataJSON();writes.push(body);if(delay)await gate;
   if(conflict){conflict=false;settings={...settings,revision:'C'.repeat(43),availabilitySchedules:[{...settings.availabilitySchedules[0],weeklyHours:week([{start:480,end:540}],[1])}]};state.elsewhere=structuredClone(settings.availabilitySchedules);return json({error:'Settings changed. Reload them and review your changes before saving.',code:'settings_conflict'},409);}
   if(fail){fail=false;return json({error:'Settings are temporarily unavailable. Try again.',code:'settings_unavailable'},503);}
   if(body.expectedRevision!==settings.revision)return json({error:'Settings changed. Reload them and review your changes before saving.',code:'settings_conflict'},409);
   settings={...settings,...body.patch,revision:'B'.repeat(42)+writes.length%10};return json({settings,revision:settings.revision});}
  if(path==='/api/live/settings')return json(settings);
  return json({});});
 await page.goto(base+'/studio'+hash);
 if(hash==='#availability')await expect(page.locator('[data-week]')).toBeVisible();
 return state;
}
const status=page=>page.locator('[data-av-status]');
const sidebar=page=>page.getByRole('navigation',{name:'Scheduling'});
const block=(page,text)=>page.locator('[data-week] .wk-block').filter({hasText:text});
async function setTimes(page,day,from,to,root=page){
 await root.locator('[data-day]').nth(day).click();await page.getByRole('menuitemradio',{name:'Set times…'}).click();
 const editor=page.getByRole('dialog',{name:/^Times on/});await expect(editor).toBeVisible();if(!await editor.getByLabel('From 1',{exact:true}).count())await editor.getByRole('button',{name:'Add hours',exact:true}).click();await editor.getByLabel('From 1',{exact:true}).fill(from);await editor.getByLabel('To 1',{exact:true}).fill(to);await editor.getByRole('button',{name:'Save',exact:true}).click();await expect(editor).toHaveCount(0);
}

test('links use the availability or their own times and keep only booking rules locally',async({page})=>{
 const state=await setup(page,{hash:'#link=intro'});const form=page.locator('#meeting-form');
 const hours=form.getByLabel('Hours',{exact:true});await expect(hours).toHaveValue('__default__');
 await expect(hours.locator('option')).toHaveText(['Any time I’m available','Different times for this link…']);
 await expect(form.locator('[data-week],[data-weekday]')).toHaveCount(0);await expect(page.getByLabel('Saved hours',{exact:true})).toHaveCount(0);
 await form.getByLabel('Free before each meeting',{exact:true}).selectOption('30');
 await page.getByRole('button',{name:'Save',exact:true}).click();await expect(page.locator('#host-status')).toHaveText('Saved');
 expect(state.writes[0].patch.meetingTypes[0]).toMatchObject({useDefaultSchedule:true,scheduleId:null,bufferBefore:30});
 expect(state.writes[0].patch.availabilitySchedules).toBeUndefined();
});

test('availability hours save exactly as you go and links keep following them',async({page})=>{
 const state=await setup(page);
 await expect(page.getByRole('button',{name:'Save hours',exact:true})).toHaveCount(0);await expect(page.getByLabel('Saved hours',{exact:true})).toHaveCount(0);
 await expect(block(page,'10:00–12:00')).toHaveCount(1);
 await setTimes(page,0,'11:00','12:45');
 await expect.poll(()=>state.writes.length).toBe(1);await expect(status(page)).toHaveText('Saved');
 const patch=state.writes[0].patch;expect(Object.keys(patch)).toEqual(['availabilitySchedules']);
 expect(patch.availabilitySchedules).toHaveLength(1);
 expect(patch.availabilitySchedules[0]).toMatchObject({id:'availability',zone:'Europe/Oslo',dateOverrides:{}});
 expect(patch.availabilitySchedules[0].weeklyHours).toEqual(week([{start:660,end:765}],[1]));
 expect(state.writes[0].expectedRevision).toBe('A'.repeat(43));
 expect(state.settings.meetingTypes[0]).toMatchObject({useDefaultSchedule:true,scheduleId:null});
 await expect(block(page,'11:00–12:45')).toHaveCount(1);
 // A second change uses the new revision and keeps the first.
 await setTimes(page,2,'09:00','10:30');
 await expect.poll(()=>state.writes.length).toBe(2);await expect(status(page)).toHaveText('Saved');
 expect(state.writes[1].expectedRevision).toBe('B'.repeat(42)+'1');
 expect(state.settings.availabilitySchedules[0].weeklyHours).toEqual({...week([{start:660,end:765}],[1]),3:[{start:540,end:630}]});
 await page.reload();await expect(block(page,'11:00–12:45')).toHaveCount(1);await expect(block(page,'09:00–10:30')).toHaveCount(1);
});

test('a link’s own times keep minute precision, time zone and exceptions, and opening Availability converts nothing',async({page})=>{
 const state=await setup(page,{hash:'#link=intro',custom:true});const form=page.locator('#meeting-form');
 await expect(form.getByLabel('Hours',{exact:true})).toHaveValue('');await expect(form.locator('[data-own-hours-summary]')).toHaveText('Tue 09:17–18:11');
 await sidebar(page).getByRole('button',{name:'Availability',exact:true}).click();await expect(page.locator('[data-week]')).toBeVisible();await expect(block(page,'10:00–12:00')).toHaveCount(1);
 await page.waitForTimeout(500);expect(state.writes).toHaveLength(0);
 await sidebar(page).getByRole('button',{name:'Links',exact:true}).click();await page.locator('[data-type="0"]').click();
 await form.getByLabel('Meeting name',{exact:true}).fill('Intro, renamed');await page.getByRole('button',{name:'Save',exact:true}).click();await expect(page.locator('#host-status')).toHaveText('Saved');
 const [intro,other]=state.writes[0].patch.meetingTypes;
 expect(intro).toMatchObject({title:'Intro, renamed',useDefaultSchedule:false,scheduleId:null,zone:'Asia/Kathmandu',weeklyHours:{2:[{start:557,end:1091}]},dateOverrides:{'2026-12-24':[]}});
 expect(other).toMatchObject({id:'other',useDefaultSchedule:true,scheduleId:null});
 expect(state.writes[0].patch.availabilitySchedules).toBeUndefined();
});

async function drag(page,root,day,from,to){
 const col=root.locator('[data-col]').nth(day),box=await col.boundingBox(),first=Number(await root.locator('[data-week]').getAttribute('data-from')),y=hour=>box.y+(hour-first)*44,x=box.x+box.width/2;
 await page.mouse.move(x,y(from)+2);await page.mouse.down();await page.mouse.move(x,y((from+to)/2),{steps:4});await page.mouse.move(x,y(to),{steps:4});await page.mouse.up();
}

test('a link draft keeps its title while its own times are edited, and leaving asks first',async({page})=>{
 const state=await setup(page,{hash:'#link=intro'});const form=page.locator('#meeting-form');
 await form.getByLabel('Meeting name',{exact:true}).fill('Client calls');
 await form.getByLabel('Hours',{exact:true}).selectOption('');
 const dialog=page.getByRole('dialog',{name:'Times for Intro'});await expect(dialog).toBeVisible();await expect(dialog.getByRole('heading',{name:'Times for Client calls'})).toBeVisible();
 await drag(page,dialog,1,13,15.5);await expect(dialog.locator('.wk-block').filter({hasText:'13:00–15:30'})).toHaveCount(1);
 await dialog.getByRole('button',{name:'Done',exact:true}).click();await expect(dialog).toHaveCount(0);
 await expect(form.getByLabel('Meeting name',{exact:true})).toHaveValue('Client calls');await expect(form.locator('[data-own-hours-summary]')).toContainText('Tue 13:00–15:30');
 expect(state.writes).toHaveLength(0);
 await page.getByRole('button',{name:'Save',exact:true}).click();await expect(page.locator('#host-status')).toHaveText('Saved');
 expect(state.writes[0].patch.meetingTypes[0]).toMatchObject({title:'Client calls',useDefaultSchedule:false,weeklyHours:{2:[{start:780,end:930}]}});
 expect(state.writes[0].patch.availabilitySchedules).toBeUndefined();
 await form.getByLabel('Meeting name',{exact:true}).fill('Client calls, again');
 await sidebar(page).getByRole('button',{name:'Availability',exact:true}).click();
 const unsaved=page.getByRole('dialog',{name:'Unsaved changes'});await expect(unsaved).toBeVisible();await unsaved.getByRole('button',{name:'Save changes',exact:true}).click();
 await expect(page.getByRole('heading',{name:'Availability',level:1})).toBeVisible();
 expect(state.writes[1].patch.meetingTypes[0]).toMatchObject({title:'Client calls, again',useDefaultSchedule:false,weeklyHours:{2:[{start:780,end:930}]}});
});

test('the day menu works inside a link’s own times',async({page})=>{
 const state=await setup(page,{hash:'#link=intro'});const form=page.locator('#meeting-form');
 await form.getByLabel('Hours',{exact:true}).selectOption('');
 const dialog=page.getByRole('dialog',{name:'Times for Intro'});await expect(dialog).toBeVisible();
 await dialog.locator('[data-day]').nth(1).click();
 await expect(page.getByRole('menuitemradio',{name:'Off every Tuesday'}),'the menu takes focus above the dialog').toBeFocused();
 await setTimes(page,1,'13:00','15:30',dialog);
 await dialog.locator('[data-day]').nth(0).click();await page.getByRole('menuitemradio',{name:'Off every Monday'}).click();
 await dialog.getByRole('button',{name:'Done',exact:true}).click();await expect(form.locator('[data-own-hours-summary]')).toHaveText('Tue 13:00–15:30');
 await page.getByRole('button',{name:'Save',exact:true}).click();await expect(page.locator('#host-status')).toHaveText('Saved');
 expect(state.writes[0].patch.meetingTypes[0]).toMatchObject({useDefaultSchedule:false,weeklyHours:{1:[],2:[{start:780,end:930}]}});
});

test('a conflicting hours save never overwrites the other change and the next change saves on top of it',async({page})=>{
 const state=await setup(page,{conflict:true});
 await setTimes(page,0,'11:00','12:00');
 await expect(status(page)).toHaveText('Settings changed. Reload them and review your changes before saving.');
 // The page shows what is saved now, not a mix of the two.
 await expect(block(page,'08:00–09:00')).toHaveCount(1);await expect(block(page,'11:00–12:00')).toHaveCount(0);
 expect(state.settings.availabilitySchedules).toEqual(state.elsewhere);
 await setTimes(page,2,'09:00','10:00');
 await expect(status(page)).toHaveText('Saved');
 expect(state.settings.availabilitySchedules[0].weeklyHours).toEqual({...week([{start:480,end:540}],[1]),3:[{start:540,end:600}]});
});

test('a failed hours save keeps the edit on screen and the next save includes it',async({page})=>{
 const state=await setup(page,{fail:true});
 await setTimes(page,0,'11:00','12:00');
 await expect(status(page)).toHaveText('Settings are temporarily unavailable. Try again.');
 await expect(block(page,'11:00–12:00')).toHaveCount(1);expect(state.settings.availabilitySchedules[0].weeklyHours[1]).toEqual([{start:600,end:720}]);
 await setTimes(page,2,'09:00','10:00');
 await expect(status(page)).toHaveText('Saved');
 expect(state.settings.availabilitySchedules[0].weeklyHours).toEqual({...week([{start:660,end:720}],[1]),3:[{start:540,end:600}]});
});

test('an hours save still in flight when leaving Availability lands and shows on return',async({page})=>{
 const state=await setup(page,{delay:true});
 await setTimes(page,0,'11:00','12:00');await expect.poll(()=>state.writes.length).toBe(1);await expect(status(page)).toHaveText('Saving…');
 await sidebar(page).getByRole('button',{name:'Links',exact:true}).click();await expect(page.locator('.lk-row')).toHaveCount(1);
 state.release();await expect.poll(()=>state.settings.availabilitySchedules[0].weeklyHours[1]).toEqual([{start:660,end:720}]);
 await sidebar(page).getByRole('button',{name:'Availability',exact:true}).click();await expect(block(page,'11:00–12:00')).toHaveCount(1);
 expect(state.writes).toHaveLength(1);
});

test.describe('booking times',()=>{
 test.use({timezoneId:'America/New_York'});
 test('the bookings list uses the availability time zone, not the browser’s',async({page})=>{
  await setup(page,{hash:''});
  await expect(page.getByText(/^Times in Oslo \(GMT[+−-]?\d*\)$/)).toBeVisible();
 });
});

test.describe('phone',()=>{
 test.use({viewport:{width:390,height:844},hasTouch:true,isMobile:true});
 test('a tap on a day opens exact times, saves exactly, and the page never scrolls sideways',async({page})=>{
  const state=await setup(page);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.locator('[data-col]').nth(2).tap();
  const editor=page.getByRole('dialog',{name:/^Times on/});await expect(editor).toBeVisible();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await editor.getByRole('button',{name:'Add hours',exact:true}).click();
  await editor.getByLabel('From 1',{exact:true}).fill('08:30');await editor.getByLabel('To 1',{exact:true}).fill('11:15');await editor.getByRole('button',{name:'Save',exact:true}).click();
  await expect.poll(()=>state.writes.at(-1)?.patch?.availabilitySchedules?.[0]?.weeklyHours?.[3]).toEqual([{start:510,end:675}]);
  await expect(status(page)).toHaveText('Saved');await expect(block(page,'08:30–11:15')).toHaveCount(1);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:`${process.env.BOOKING_SCREENSHOT_DIR||'test-results'}/availability-phone.png`,fullPage:true});
 });
});
