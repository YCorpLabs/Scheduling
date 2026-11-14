import {test,expect} from '@playwright/test';
import {DEFAULT} from '../public/policy.js';
const base=process.env.BOOKING_TEST_ORIGIN||'http://127.0.0.1:8791',hostId='h_abcdefghijklmnopqrstuvwx',owner='h_'+'O'.repeat(24);
const a={id:'a',email:'ada@company.test',connected:true,destinationCalendarId:'ada@company.test',conflictCalendarIds:['ada@company.test']},b={id:'b',email:'bo@company.test',connected:true,destinationCalendarId:'bo@company.test',conflictCalendarIds:['bo@company.test']};
async function fixture(page,{team=null,guest=false}={}){
 let settings={hostId,revision:'A'.repeat(43),profile:{name:'Company'},accounts:[a,b],availabilitySchedules:[{id:'work',name:'Work hours',zone:'UTC',weeklyHours:{1:[{start:540,end:1020}]},dateOverrides:{}}],defaultAvailabilityScheduleId:null,meetingTypes:[{...DEFAULT,id:'intro',slug:'intro',title:'Intro',host:'Company',published:true,accountId:'a',calendarId:a.destinationCalendarId,teamScheduling:team}]};const writes=[];let booked;
 const publicTeam=team?{mode:team.mode,hosts:team.hosts.map(({id,name})=>({id,name})),revision:'reviewed-team'}:null,start=Date.now()+172800000;
 const slots=[{start,end:start+1800000,hostIds:['ada']},{start:start+3600000,end:start+5400000,hostIds:['bo']},{start:start+7200000,end:start+9000000,hostIds:['ada','bo']}];
 await page.route('**/api/**',route=>{const req=route.request(),path=new URL(req.url()).pathname;let data;
 if(path==='/api/bootstrap')data={mode:'live',authenticated:!guest,hostId:owner,email:'owner@company.test',features:{reminders:true}};
 // Hosts are a team feature: the Studio runs in the company profile.
 else if(path==='/api/live/workspaces')data={activeWorkspaceId:hostId,workspaces:[{id:owner,personal:true,role:'owner',name:'Owner'},{id:hostId,name:'Company',role:'owner',capabilities:{manageSettings:true,manageMembers:true,manageIntegrations:true}}]};
 else if(path==='/api/live/bookings')data={bookings:[]};
 else if(path==='/api/live/calendar-contributions')data={contributions:[]};
 else if(path==='/api/live/calendar-events'||path==='/api/live/my-calendar/events')data={events:[],calendars:[]};
 else if(path==='/api/live/settings'){if(req.method()==='POST'){const body=req.postDataJSON();expect(body.expectedRevision).toBe(settings.revision);writes.push(body.patch);settings={...settings,...body.patch,revision:'B'.repeat(43)};data={settings,revision:settings.revision};}else data=settings;}
 else if(path==='/api/live/calendars')data={accounts:[a,b].map(account=>({id:account.id,calendars:[{id:account.destinationCalendarId,summary:account.id==='a'?'Ada work':'Bo work',accessRole:'owner'},{id:'holidays',summary:'Holidays',accessRole:'reader'}]}))};
 else if(path.endsWith('/availability')){const {teamScheduling,...config}=settings.meetingTypes[0];data={mode:'live',config:{...config,...(publicTeam?{team:publicTeam}:{})},slots};}
 else if(path.endsWith('/visit'))data={ok:true};
 else if(path.endsWith('/book')){booked=req.postDataJSON();data={booking:{id:'booking_'+'1'.repeat(20),status:'confirmed',title:'Intro',start:booked.start,end:booked.start+1800000,timeZone:'UTC',teamMode:team.mode,assignedHosts:publicTeam.hosts.filter(h=>team.mode==='all'||h.id===(booked.teamHostId||'ada'))},managementToken:'fixture-token'};}
 else return route.fulfill({status:404,json:{error:'Not mocked'}});
 return route.fulfill({json:data});
 });return {writes,slots,get booked(){return booked;},get settings(){return settings;}};
}
const hosts=[{id:'ada',name:'Ada',accountId:'a',useDefaultCalendar:true,calendarId:'',conflictCalendarIds:null,scheduleId:null},{id:'bo',name:'Bo',accountId:'b',useDefaultCalendar:true,calendarId:'',conflictCalendarIds:null,scheduleId:null}];

test('each team link configures any, guest choice or everyone with explicit host calendars',async({page})=>{
 const state=await fixture(page);await page.goto(base+'/studio#link=intro');await page.locator('#meeting-form').waitFor();
 await expect(page.locator('#meeting-form').getByRole('heading',{name:'Hosts'})).toBeVisible();
 await expect(page.getByRole('radio',{name:'One host',exact:true})).toBeChecked();await page.getByRole('radio',{name:'Any available host',exact:true}).check();
 const ada=page.locator('[data-team-host][data-account=a]'),bo=page.locator('[data-team-host][data-account=b]');await expect(ada.locator('[data-host-selected]')).toBeChecked();await bo.locator('[data-host-selected]').check();await ada.locator('[data-host-name]').fill('Ada');await bo.locator('[data-host-name]').fill('Bo');
 // Hours come from each host's availability; there is no per-host hours choice.
 await expect(page.locator('#meeting-form select[data-host-schedule]')).toHaveCount(0);await expect(page.locator('[data-host-own-hours]')).toHaveCount(0);
 await expect(bo.getByLabel('Booking calendar for bo@company.test')).toHaveValue('__default__');
 await page.getByRole('button',{name:'Save',exact:true}).click();await expect(page.locator('#host-status')).toHaveText('Saved');
 expect(state.writes[0].meetingTypes[0].teamScheduling).toMatchObject({mode:'any',hosts:[{name:'Ada',accountId:'a',useDefaultCalendar:true,conflictCalendarIds:null,scheduleId:null},{name:'Bo',accountId:'b',useDefaultCalendar:true,conflictCalendarIds:null,scheduleId:null}]});
 for(const [label,mode] of [['Guest chooses a host','choose'],['All selected hosts','all']]){await page.getByRole('radio',{name:label,exact:true}).check();await page.getByRole('button',{name:'Save',exact:true}).click();await expect(page.locator('#host-status')).toHaveText('Saved');expect(state.settings.meetingTypes[0].teamScheduling.mode).toBe(mode);}
 await page.setViewportSize({width:390,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBeTruthy();await page.screenshot({path:`${process.env.BOOKING_SCREENSHOT_DIR||'test-results'}/team-hosts-mobile.png`,fullPage:true,animations:'disabled'});
});

test('a host with different times on a link keeps them until Reset',async({page})=>{
 const state=await fixture(page,{team:{mode:'any',hosts:[hosts[0],{...hosts[1],scheduleId:'work'}]}});await page.goto(base+'/studio#link=intro');await page.locator('#meeting-form').waitFor();
 const bo=page.locator('[data-team-host][data-account=b]'),note=bo.locator('[data-host-own-hours]');
 await expect(note).toHaveText('Bo has different times on this link · Reset');await expect(page.locator('[data-team-host][data-account=a] [data-host-own-hours]')).toHaveCount(0);
 await page.getByLabel('Meeting name',{exact:true}).fill('Intro call');await page.getByRole('button',{name:'Save',exact:true}).click();await expect(page.locator('#host-status')).toHaveText('Saved');
 expect(state.writes[0].meetingTypes[0].teamScheduling.hosts.map(h=>[h.id,h.scheduleId])).toEqual([['ada',null],['bo','work']]);
 await expect(page.locator('[data-team-host][data-account=b] [data-host-own-hours]')).toHaveCount(1);
 await page.locator('[data-team-host][data-account=b]').getByRole('button',{name:'Reset',exact:true}).click();
 await expect(page.locator('[data-host-own-hours]')).toHaveCount(0);await expect(page.locator('#editor-save-state')).toHaveText('Unsaved changes');
 await page.getByRole('button',{name:'Save',exact:true}).click();await expect(page.locator('#host-status')).toHaveText('Saved');
 expect(state.writes[1].meetingTypes[0].teamScheduling.hosts.map(h=>[h.id,h.scheduleId])).toEqual([['ada',null],['bo',null]]);
});

test('guest selects a host, sees only that host times and submits only public host identity',async({page})=>{
 const state=await fixture(page,{guest:true,team:{mode:'choose',hosts}});await page.goto(base+`/b/${hostId}/intro`);await expect(page.getByRole('heading',{name:'Choose a host',exact:true})).toBeVisible();await expect(page.locator('.slot')).toHaveCount(0);await page.locator('[data-choose-host=bo]').click();await expect(page.getByLabel('Meet with',{exact:true})).toHaveValue('bo');await expect(page.locator('.slot')).toHaveCount(2);await page.locator(`[data-slot="${state.slots[1].start}"]`).click();await page.getByLabel('Your name',{exact:true}).fill('Guest');await page.getByLabel('Email address',{exact:true}).fill('guest@example.com');await page.getByRole('button',{name:'Confirm booking',exact:true}).click();await expect(page.getByRole('heading',{name:'You’re booked',exact:true})).toBeVisible();expect(state.booked).toMatchObject({teamHostId:'bo',teamRevision:'reviewed-team',start:state.slots[1].start});expect(state.booked.accountId).toBeUndefined();expect(state.booked.calendarId).toBeUndefined();await expect(page.locator('.success')).toContainText('With Bo');
});

test('collective guests see everyone attending without a host selector',async({page})=>{
 await fixture(page,{guest:true,team:{mode:'all',hosts}});await page.goto(base+`/b/${hostId}/intro`);await expect(page.locator('.host-intro')).toContainText('With Ada, Bo');await expect(page.locator('#guest-team-host')).toHaveCount(0);await page.setViewportSize({width:390,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBeTruthy();await page.screenshot({path:`${process.env.BOOKING_SCREENSHOT_DIR||'test-results'}/team-guest-mobile.png`,fullPage:true,animations:'disabled'});
});

test('a team link can publish through its selected host when the hidden legacy account has no destination',async({page})=>{
 const state=await fixture(page);state.settings.accounts[0].destinationCalendarId='';await page.goto(base+'/studio#link=intro');await page.locator('#meeting-form').waitFor();await page.getByRole('radio',{name:'Any available host',exact:true}).check();await page.locator('[data-account=a] [data-host-selected]').uncheck();await page.locator('[data-account=b] [data-host-selected]').check();await page.getByRole('button',{name:'Save',exact:true}).click();await expect(page.locator('#host-status')).toHaveText('Saved');expect(state.settings.meetingTypes[0]).toMatchObject({accountId:'b',calendarId:b.destinationCalendarId,teamScheduling:{mode:'any'}});
});

test('changed team policy is explained and requires a fresh host choice without losing guest details',async({page})=>{
 const state=await fixture(page,{guest:true,team:{mode:'choose',hosts}});await page.goto(base+`/b/${hostId}/intro`);await page.locator('[data-choose-host=bo]').click();await page.locator(`[data-slot="${state.slots[1].start}"]`).click();await page.getByLabel('Your name',{exact:true}).fill('Guest');await page.getByLabel('Email address',{exact:true}).fill('guest@example.com');await page.route('**/api/**/book',route=>route.fulfill({status:409,json:{error:'Hosts changed'}}));await page.route('**/api/**/availability',route=>{const {teamScheduling,...config}=state.settings.meetingTypes[0];return route.fulfill({json:{config:{...config,duration:60,location:'Office',team:{mode:'choose',hosts:[{id:'ada',name:'Ada'}],revision:'new-team'}},slots:state.slots.map(slot=>({...slot,end:slot.start+3600000}))}});});await page.getByRole('button',{name:'Confirm booking',exact:true}).click();await expect(page.getByRole('alert')).toHaveText('Hosts changed. Choose a host and time again.');await expect(page.getByRole('alert')).toBeFocused();await expect(page.locator('.meeting-meta')).toContainText('60 minutes');await expect(page.locator('.meeting-meta')).toContainText('Office');await expect(page.locator('[data-choose-host=bo]')).toHaveCount(0);await page.locator('[data-choose-host=ada]').click();await page.locator(`[data-slot="${state.slots[0].start}"]`).click();await expect(page.getByLabel('Your name',{exact:true})).toHaveValue('Guest');await expect(page.getByLabel('Email address',{exact:true})).toHaveValue('guest@example.com');
});
