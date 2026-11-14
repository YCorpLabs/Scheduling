// A company member's own calendar choices and hours on the Availability page.
// Every change saves to /api/live/my-calendar on its own; a calendar change
// never sends hours the member has not chosen, an hours change never drops the
// calendar choices, and a reload agrees with what was saved.
import {test,expect} from '@playwright/test';
const base=process.env.BOOKING_TEST_ORIGIN||'http://127.0.0.1:8791',company='h_'+'C'.repeat(24),person='h_'+'P'.repeat(24);
test.use({timezoneId:'UTC'});

// A stateful stand-in for /api/live/my-calendar with the server's rules:
// revision checks, the destination is always checked for busy time, and hours
// change only when a schedule is sent.
async function studio(page,{latency=0}={}){
 let revision=1,queue=Promise.resolve();const writes=[];let failNext=null;
 const my={member:{id:person,email:'ada@example.com'},account:{id:'mine',email:'ada@example.com',connected:true,ownerMemberId:person,calendarId:'primary',conflictCalendarIds:['primary']},calendars:[{id:'primary',summary:'Ada work',accessRole:'owner',primary:true},{id:'team',summary:'Team',accessRole:'writer'},{id:'holidays',summary:'Holidays',accessRole:'reader'},{id:'family',summary:'Family',accessRole:'freeBusyReader'}],schedule:{zone:'UTC',weeklyHours:Object.fromEntries([0,1,2,3,4,5,6].map(d=>[d,d>0&&d<6?[{start:540,end:1020}]:[]])),dateOverrides:{}},scheduleConfigured:false,readiness:'ready',revision:'rev1'};
 await page.route('**/api/**',async r=>{const req=r.request(),path=new URL(req.url()).pathname,body=req.postDataJSON?.(),json=(data,status=200)=>r.fulfill({json:data,status});
  if(path==='/api/bootstrap')return json({mode:'live',authenticated:true,hostId:person,email:'ada@example.com'});
  if(path==='/api/live/workspaces')return json({activeWorkspaceId:company,workspaces:[{id:person,personal:true,role:'owner',name:'Ada'},{id:company,name:'Acme',role:'owner',capabilities:{manageOwnCalendar:true,manageSettings:true,manageMembers:true,manageIntegrations:true}}]});
  if(path==='/api/live/settings'){if(body)writes.push({settings:body});return json({hostId:company,profile:{name:'Acme'},revision:'a',accounts:[{id:'mine',email:'ada@example.com',ownerMemberId:person,connected:true,destinationCalendarId:my.account.calendarId}],meetingTypes:[],availabilitySchedules:[]});}
  // Writes are handled one at a time in arrival order, like the server.
  if(path==='/api/live/my-calendar'&&body&&latency){const turn=queue.then(()=>new Promise(resolve=>setTimeout(resolve,latency)));queue=turn;await turn;}
  if(path==='/api/live/my-calendar'){if(body){writes.push(body);if(failNext){const fail=failNext;failNext=null;return json({error:fail.error},fail.status);}if(body.expectedRevision!==my.revision)return json({error:'Your calendar changed. Reload before saving.'},409);my.account.calendarId=body.calendarId;my.account.conflictCalendarIds=[...new Set([body.calendarId,...body.conflictCalendarIds])];if(body.schedule){my.schedule=body.schedule;my.scheduleConfigured=true;}my.revision='rev'+(++revision);}return json(structuredClone(my));}
  if(path==='/api/live/my-calendar/events')return json({events:[],calendars:my.calendars.map(c=>({accountId:'mine',id:c.id,summary:c.summary,color:null,accessRole:c.accessRole,primary:!!c.primary,busy:my.account.conflictCalendarIds.includes(c.id),destination:c.id===my.account.calendarId}))});
  if(path==='/api/live/calendars')return json({accounts:[{id:'mine',email:'ada@example.com',ownerMemberId:person,calendars:[]}]});
  if(path==='/api/live/calendar-contributions')return json({contributions:[]});
  if(path==='/api/live/bookings')return json({bookings:[]});
  return json({});});
 return {my,writes,fail:(status,error)=>failNext={status,error}};
}
const panel=page=>page.getByRole('complementary',{name:'Calendars'});
const busyNames=page=>panel(page).locator('.av-cal-name').allTextContents();
const busy=(page,name)=>panel(page).getByRole('checkbox',{name:new RegExp('^'+name+'\\b')});
// The checkbox sits under a drawn box, so people click its label.
const toggle=(page,name)=>panel(page).locator('label.av-check').filter({has:page.locator('.av-cal-name',{hasText:new RegExp('^'+name+'$')})}).click();
const destination=page=>page.getByLabel('New bookings go to',{exact:true});
const status=page=>page.locator('[data-av-status]');
const ownWrites=server=>server.writes.filter(w=>!w.settings);
async function openAvailability(page){await page.goto(base+'/studio#availability');await expect(busy(page,'Team')).toBeVisible();}
async function setMondayTimes(page,from,to){
 await page.locator('[data-day]').nth(0).click();await page.getByRole('menuitemradio',{name:'Set times…'}).click();
 const editor=page.getByRole('dialog',{name:/^Times on/});await editor.getByLabel('From 1',{exact:true}).fill(from);await editor.getByLabel('To 1',{exact:true}).fill(to);await editor.getByRole('button',{name:'Save',exact:true}).click();
}

test('own calendar choices and hours save to my-calendar without clobbering each other, and a reload agrees',async({page})=>{
 const server=await studio(page);await openAvailability(page);
 // Hours are not chosen yet: the page says so and nothing is saved on load.
 await expect(page.getByText('until you change them')).toBeVisible();expect(server.writes).toHaveLength(0);
 const order=await busyNames(page);expect(order).toEqual(['Ada work','Team','Holidays','Family']);
 await expect(destination(page)).toHaveValue('primary');await expect(destination(page).locator('option')).toHaveText(['Ada work','Team']);
 await expect(busy(page,'Ada work')).toBeChecked();await expect(busy(page,'Ada work')).toBeDisabled();
 // A calendar-only change sends no hours.
 await destination(page).selectOption('team');
 await expect.poll(()=>ownWrites(server).length).toBe(1);
 expect(ownWrites(server)[0]).toMatchObject({accountId:'mine',calendarId:'team',expectedRevision:'rev1'});expect(ownWrites(server)[0].conflictCalendarIds).toContain('team');expect(ownWrites(server)[0].schedule).toBeUndefined();
 await expect(status(page)).toHaveText('Saved');await expect(busy(page,'Team')).toBeDisabled();await expect(busy(page,'Team')).toBeChecked();await expect(busy(page,'Ada work')).toBeEnabled();
 for(const [name,want] of [['Holidays',true],['Family',true],['Ada work',false]]){
  const count=ownWrites(server).length;await expect(busy(page,name)).toBeChecked({checked:!want});await toggle(page,name);
  await expect.poll(()=>ownWrites(server).length).toBe(count+1);await expect(status(page)).toHaveText('Saved');await expect(busy(page,name)).toBeChecked({checked:want});
 }
 expect(ownWrites(server).every(w=>w.schedule===undefined)).toBe(true);
 expect(server.my.account.calendarId).toBe('team');expect([...server.my.account.conflictCalendarIds].sort()).toEqual(['family','holidays','team']);
 expect(await busyNames(page)).toEqual(order);
 // An hours change sends the hours exactly and keeps the saved calendar choices.
 await page.getByLabel('Time zone',{exact:true}).selectOption('Europe/Oslo');
 await expect.poll(()=>ownWrites(server).at(-1)?.schedule?.zone).toBe('Europe/Oslo');await expect(status(page)).toHaveText('Saved');
 await setMondayTimes(page,'10:15','16:45');
 await expect.poll(()=>ownWrites(server).at(-1)?.schedule?.weeklyHours?.[1]).toEqual([{start:615,end:1005}]);await expect(status(page)).toHaveText('Saved');
 const last=ownWrites(server).at(-1);expect(last).toMatchObject({accountId:'mine',calendarId:'team',schedule:{zone:'Europe/Oslo'}});expect([...last.conflictCalendarIds].sort()).toEqual(['family','holidays','team']);
 expect(last.schedule.weeklyHours[2]).toEqual([{start:540,end:1020}]);
 await expect(page.getByText('until you change them')).toHaveCount(0);
 expect(server.writes.filter(w=>w.settings)).toHaveLength(0);
 // A reload agrees with what was saved and saves nothing.
 const saved=JSON.stringify(server.my),writes=server.writes.length;
 await page.reload();await expect(busy(page,'Team')).toBeVisible();
 await expect(destination(page)).toHaveValue('team');expect(await busyNames(page)).toEqual(order);
 for(const [name,checked] of [['Ada work',false],['Team',true],['Holidays',true],['Family',true]])await expect(busy(page,name)).toBeChecked({checked});
 await expect(page.getByLabel('Time zone',{exact:true})).toHaveValue('Europe/Oslo');
 await expect(page.locator('[data-week] .wk-block').filter({hasText:'10:15–16:45'})).toHaveCount(1);
 await expect(status(page)).toHaveText('');await expect(page.getByText('until you change them')).toHaveCount(0);
 expect(JSON.stringify(server.my)).toBe(saved);expect(server.writes).toHaveLength(writes);
});

test('quick calendar changes all reach the server',async({page})=>{
 const server=await studio(page,{latency:300});await openAvailability(page);
 await toggle(page,'Holidays');await toggle(page,'Family');
 await expect.poll(()=>[...server.my.account.conflictCalendarIds].sort()).toEqual(['family','holidays','primary']);
 await expect(status(page)).toHaveText('Saved');
 for(const name of ['Holidays','Family'])await expect(busy(page,name)).toBeChecked();
});

test('a failed calendar save shows its error and the page shows what is actually saved',async({page})=>{
 const server=await studio(page);await openAvailability(page);server.my.revision='changed-elsewhere';
 await toggle(page,'Holidays');
 await expect.poll(()=>ownWrites(server).length).toBe(1);
 // The page goes back to the saved calendar and keeps the reason in view.
 await expect(busy(page,'Holidays')).not.toBeChecked();expect(server.my.account.conflictCalendarIds).toEqual(['primary']);
 await expect.soft(status(page),'the error stays in view').toHaveText('Your calendar changed. Reload before saving.');
 // The next change starts from the latest saved calendar and is saved.
 await toggle(page,'Holidays');
 await expect.poll(()=>server.my.account.conflictCalendarIds).toContain('holidays');await expect(status(page)).toHaveText('Saved');
});

test('a failed hours save keeps the edit on screen and the next save includes it',async({page})=>{
 const server=await studio(page);await openAvailability(page);
 server.fail(503,'Calendar is temporarily unavailable. Try again.');
 await setMondayTimes(page,'10:00','12:00');
 await expect(status(page)).toHaveText('Calendar is temporarily unavailable. Try again.');
 await expect(page.locator('[data-week] .wk-block').filter({hasText:'10:00–12:00'})).toHaveCount(1);
 expect(server.my.scheduleConfigured).toBe(false);
 await page.getByLabel('Time zone',{exact:true}).selectOption('Europe/Oslo');
 await expect(status(page)).toHaveText('Saved');
 expect(server.my.schedule).toMatchObject({zone:'Europe/Oslo',weeklyHours:{1:[{start:600,end:720}],2:[{start:540,end:1020}]}});
 expect(server.my.account).toMatchObject({calendarId:'primary',conflictCalendarIds:['primary']});
});

// Personal profiles keep the same rule: hours go to /api/live/settings and
// calendar choices to /api/live/calendars, and neither undoes the other.
async function personal(page){
 const me='h_'+'R'.repeat(24),writes=[];
 let settings={revision:'r1',hostId:me,profile:{name:'Riley'},accounts:[{id:'riley',email:'riley@example.com',connected:true,destinationCalendarId:'riley@example.com',conflictCalendarIds:['riley@example.com']}],meetingTypes:[],availabilitySchedules:[{id:'availability',name:'Availability',zone:'UTC',weeklyHours:Object.fromEntries([0,1,2,3,4,5,6].map(d=>[d,d>0&&d<6?[{start:540,end:1020}]:[]])),dateOverrides:{}}],defaultAvailabilityScheduleId:'availability'};
 const calendars=[{id:'riley@example.com',summary:'Riley',accessRole:'owner',primary:true},{id:'family',summary:'Family',accessRole:'reader'}];
 await page.route('**/api/**',async r=>{const req=r.request(),path=new URL(req.url()).pathname,body=req.postDataJSON?.(),json=(data,status=200)=>r.fulfill({json:data,status});
  if(path==='/api/bootstrap')return json({mode:'live',authenticated:true,hostId:me,email:'riley@example.com'});
  if(path==='/api/live/workspaces')return json({activeWorkspaceId:me,workspaces:[{id:me,personal:true,role:'owner',name:'Riley'}]});
  if(path==='/api/live/settings'&&body){writes.push({settings:body});if(body.expectedRevision!==settings.revision)return json({error:'Settings changed.',code:'settings_conflict'},409);await new Promise(resolve=>setTimeout(resolve,150));settings={...settings,...body.patch,revision:'r'+(writes.length+1)};return json({settings,revision:settings.revision});}
  if(path==='/api/live/settings')return json(settings);
  if(path==='/api/live/calendars'&&body){writes.push({calendars:body});const [change]=body.accounts;settings={...settings,revision:'r'+(writes.length+1),accounts:settings.accounts.map(a=>a.id===change.accountId?{...a,destinationCalendarId:change.destinationCalendarId,conflictCalendarIds:change.conflictCalendarIds}:a)};return json({ok:true});}
  if(path==='/api/live/calendars')return json({accounts:[{id:'riley',email:'riley@example.com',calendars}]});
  if(path==='/api/live/calendar-events'){const a=settings.accounts[0];return json({events:[],calendars:calendars.map(c=>({accountId:'riley',id:c.id,summary:c.summary,color:null,accessRole:c.accessRole,primary:!!c.primary,busy:a.conflictCalendarIds.includes(c.id),destination:c.id===a.destinationCalendarId}))});}
  if(path==='/api/live/calendar-contributions')return json({contributions:[]});
  if(path==='/api/live/bookings')return json({bookings:[]});
  return json({});});
 return {writes,get settings(){return settings;}};
}

test('personal: an hours change and a calendar change made together both stick',async({page})=>{
 const server=await personal(page);await page.goto(base+'/studio#availability');await expect(busy(page,'Family')).toBeVisible();
 await setMondayTimes(page,'10:00','12:00');await toggle(page,'Family');
 await expect.poll(()=>server.settings.accounts[0].conflictCalendarIds).toContain('family');
 await expect.poll(()=>server.settings.availabilitySchedules[0].weeklyHours[1]).toEqual([{start:600,end:720}]);
 await expect(status(page)).toHaveText('Saved');
 await expect(page.locator('[data-week] .wk-block').filter({hasText:'10:00–12:00'})).toHaveCount(1);await expect(busy(page,'Family')).toBeChecked();
 expect(server.writes.filter(w=>w.settings).every(w=>Object.keys(w.settings.patch).join()==='availabilitySchedules')).toBe(true);
 expect(server.writes.filter(w=>w.calendars).every(w=>w.calendars.accounts.length===1&&!('availabilitySchedules' in w.calendars))).toBe(true);
 await page.reload();await expect(busy(page,'Family')).toBeChecked();await expect(page.locator('[data-week] .wk-block').filter({hasText:'10:00–12:00'})).toHaveCount(1);
});
