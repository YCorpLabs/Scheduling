// A member's own calendar on the Availability page of a company: the same
// "Busy from" and "New bookings go to" controls as a personal profile, saved
// only through the member's own /api/live/my-calendar contract, and never
// applied to another profile after a switch.
import {test,expect} from '@playwright/test';
const base=process.env.BOOKING_TEST_ORIGIN||'http://127.0.0.1:8791';
const company='h_'+'C'.repeat(24),person='h_'+'P'.repeat(24);
test.use({timezoneId:'Europe/London'});
const weekdays=Object.fromEntries([0,1,2,3,4,5,6].map(d=>[d,d>0&&d<6?[{start:540,end:1020}]:[]]));
async function setup(page,{configured=true}={}){
 const requests=[];let gate=null,release;
 const my={member:{id:person,email:'ada@example.com'},account:{id:'account-own',email:'ada@example.com',connected:true,ownerMemberId:person,calendarId:'work',conflictCalendarIds:['work']},calendars:[{id:'work',summary:'Work',accessRole:'owner',primary:true},{id:'other',summary:'Other',accessRole:'writer'},{id:'busy',summary:'Read only',accessRole:'reader'}],schedule:{zone:'UTC',weeklyHours:{0:[],1:[{start:540,end:1020}],2:[],3:[],4:[],5:[],6:[]},dateOverrides:{}},scheduleConfigured:configured,readiness:'ready',revision:'revision-1'};
 const personal={revision:'P'.repeat(43),hostId:person,profile:{name:'Ada'},accounts:[{id:'ada-personal',email:'ada@example.com',connected:true,destinationCalendarId:'home',conflictCalendarIds:['home']}],meetingTypes:[],availabilitySchedules:[{id:'availability',name:'Availability',zone:'Europe/London',weeklyHours:weekdays,dateOverrides:{}}],defaultAvailabilityScheduleId:'availability'};
 await page.route('**/api/**',async r=>{const req=r.request(),path=new URL(req.url()).pathname,body=req.postDataJSON?.(),ws=req.headers()['x-scheduling-workspace']||null,json=(data,status=200)=>r.fulfill({json:data,status});requests.push({path,body,ws,method:req.method()});
  if(path==='/api/bootstrap')return json({mode:'live',authenticated:true,hostId:person,email:'ada@example.com'});
  if(path==='/api/live/workspaces')return json({activeWorkspaceId:company,workspaces:[{id:person,personal:true,role:'owner',name:'Ada'},{id:company,name:'Acme',role:'member',capabilities:{manageOwnCalendar:true}}]});
  const inCompany=ws===company;
  if(path==='/api/live/settings'&&!body)return json(inCompany?{hostId:company,profile:{name:'Acme'},revision:'a',accounts:[],meetingTypes:[],availabilitySchedules:[]}:personal);
  if(path==='/api/live/settings')return json({error:'Not expected'},500);
  if(path==='/api/live/my-calendar'&&inCompany){if(body){if(gate)await gate;if(body.expectedRevision!==my.revision)return json({error:'Your calendar changed. Reload before saving.'},409);my.account.calendarId=body.calendarId;my.account.conflictCalendarIds=body.conflictCalendarIds;if(body.schedule){my.schedule=body.schedule;my.scheduleConfigured=true;}my.revision='revision-'+(Number(my.revision.split('-')[1])+1);}return json(structuredClone(my));}
  if(path==='/api/live/my-calendar/events'&&inCompany)return json({events:[],calendars:my.calendars.map(c=>({accountId:'account-own',id:c.id,summary:c.summary,color:null,accessRole:c.accessRole,primary:!!c.primary,busy:my.account.conflictCalendarIds.includes(c.id),destination:c.id===my.account.calendarId}))});
  if(path==='/api/live/calendar-events'&&!inCompany)return json({events:[],calendars:[{accountId:'ada-personal',id:'home',summary:'Home',color:null,accessRole:'owner',primary:true,busy:true,destination:true}]});
  if(path==='/api/live/calendars')return json({accounts:inCompany?[]:[{id:'ada-personal',calendars:[{id:'home',summary:'Home',accessRole:'owner'}]}]});
  if(path==='/api/live/calendar-contributions')return json({contributions:[]});
  if(path==='/api/live/bookings')return json({bookings:[]});
  return json({});});
 await page.goto(base+'/studio#availability');await expect(panel(page).getByRole('checkbox',{name:/^Other/})).toBeVisible();
 return {requests,my,writes:()=>requests.filter(r=>r.body&&r.path!=='/api/bootstrap'),delay:()=>gate=new Promise(resolve=>release=resolve),release:()=>{gate=null;release();}};
}
const panel=page=>page.getByRole('complementary',{name:'Calendars'});
const busy=(page,name)=>panel(page).getByRole('checkbox',{name:new RegExp('^'+name+'( Bookings)?$')});
// The checkbox sits under a drawn box, so people click its label.
const toggle=(page,name)=>panel(page).locator('label.av-check').filter({has:page.locator('.av-cal-name',{hasText:new RegExp('^'+name+'$')})}).click();
const destination=page=>page.getByLabel('New bookings go to',{exact:true});
const status=page=>page.locator('[data-av-status]');

test('own calendar uses the shared destination and busy controls and saves only the member’s own contract',async({page})=>{
 const state=await setup(page);
 await expect(page.getByRole('button',{name:'Disconnect',exact:true})).toHaveCount(0);await expect(page.getByRole('heading',{name:'Company calendars'})).toHaveCount(0);
 await expect(destination(page).locator('option')).toHaveText(['Work','Other']);
 await destination(page).selectOption('other');await expect(status(page)).toHaveText('Saved');
 await expect(busy(page,'Other')).toBeDisabled();await expect(busy(page,'Other')).toBeChecked();
 await toggle(page,'Read only');await expect(status(page)).toHaveText('Saved');await expect(busy(page,'Read only')).toBeChecked();
 const writes=state.writes();expect(writes.map(w=>[w.path,w.ws])).toEqual([['/api/live/my-calendar',company],['/api/live/my-calendar',company]]);
 // Only the member's own contract: no settings patch, and the saved hours are sent back unchanged.
 for(const w of writes){expect(['accountId','calendarId','conflictCalendarIds','expectedRevision','schedule']).toEqual(expect.arrayContaining(Object.keys(w.body)));expect(w.body.accountId).toBe('account-own');expect(w.body.schedule).toEqual({zone:'UTC',weeklyHours:{0:[],1:[{start:540,end:1020}],2:[],3:[],4:[],5:[],6:[]},dateOverrides:{}});}
 expect(writes[0].body).toMatchObject({calendarId:'other',expectedRevision:'revision-1'});expect(writes[0].body.conflictCalendarIds).toContain('other');
 expect(writes[1].body).toMatchObject({calendarId:'other',expectedRevision:'revision-2'});expect(writes[1].body.conflictCalendarIds).toEqual(expect.arrayContaining(['other','busy']));
});

test('hours are one editor without company or named-schedule controls and save through my-calendar',async({page})=>{
 const state=await setup(page,{configured:false});
 // Hours the member has not chosen yet start in their own time zone.
 await expect(page.getByLabel('Time zone',{exact:true})).toHaveValue('Europe/London');
 for(const gone of ['[data-new-availability]','[name=scheduleName]','.availability-links','[data-delete-availability]'])await expect(page.locator(gone)).toHaveCount(0);
 await expect(page.getByRole('button',{name:'Save hours',exact:true})).toHaveCount(0);
 await page.getByLabel('Time zone',{exact:true}).selectOption('America/New_York');await expect(status(page)).toHaveText('Saved');
 const write=state.writes().at(-1);expect(write.path).toBe('/api/live/my-calendar');expect(write.ws).toBe(company);
 expect(write.body).toMatchObject({accountId:'account-own',calendarId:'work',schedule:{zone:'America/New_York',weeklyHours:{1:[{start:540,end:1020}]}}});expect(write.body.availabilitySchedules).toBeUndefined();expect(write.body.patch).toBeUndefined();
 await expect(page.getByText('until you change them')).toHaveCount(0);
 await page.getByLabel('Time zone',{exact:true}).selectOption('UTC');await expect(status(page)).toHaveText('Saved');
 expect(state.writes().filter(w=>w.path==='/api/live/my-calendar').map(w=>w.body.schedule.zone)).toEqual(['America/New_York','UTC']);
});

async function switchToPersonal(page){
 await page.locator('#workspace-trigger').click();await page.locator(`#workspace-menu [data-workspace="${person}"]`).click();
 await expect(page.locator('#workspace-trigger')).toHaveAccessibleName(/^Profile: (Ada|ada@example\.com)$/);
}

test('a late calendar save after switching profile changes nothing in the new profile',async({page})=>{
 const state=await setup(page);state.delay();
 await destination(page).selectOption('other');await expect(status(page)).toHaveText('Saving…');
 await switchToPersonal(page);await expect(panel(page).getByRole('checkbox',{name:/^Home/})).toBeVisible();
 const before=state.requests.length;state.release();
 await expect.poll(()=>state.my.account.calendarId).toBe('other');await page.waitForTimeout(500);
 await expect(status(page)).toHaveText('');await expect(panel(page).locator('.av-cal-name')).toHaveText(['Home']);
 expect(state.requests.slice(before).filter(r=>r.ws===company)).toEqual([]);
 expect(state.writes().filter(w=>w.ws!==company)).toEqual([]);
});

test('an hours change made just before switching profile is saved to the company, never to the new profile',async({page})=>{
 const state=await setup(page);
 await page.getByLabel('Time zone',{exact:true}).selectOption('America/New_York');await switchToPersonal(page);
 await expect(panel(page).getByRole('checkbox',{name:/^Home/})).toBeVisible();await page.waitForTimeout(800);
 expect(state.writes().filter(w=>w.ws!==company),'nothing is written to the personal profile').toEqual([]);
 expect(state.my.schedule.zone,'the company change is not lost').toBe('America/New_York');
 await expect(status(page)).not.toHaveText(/Cannot|undefined|null/);
});

test('own calendar choices remain usable on phone without page overflow',async({page})=>{
 await page.setViewportSize({width:390,height:844});const state=await setup(page);
 await destination(page).selectOption('other');await expect(status(page)).toHaveText('Saved');expect(state.my.account.calendarId).toBe('other');
 await toggle(page,'Read only');await expect(busy(page,'Read only')).toBeChecked();
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 await page.screenshot({path:`${process.env.BOOKING_SCREENSHOT_DIR||'test-results'}/scheduling-my-calendar-phone.png`,fullPage:true});
});
