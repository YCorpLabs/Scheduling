// Company members manage their own calendar and hours on the Availability
// page (saved to /api/live/my-calendar in the company), see readiness on the
// Team page, and stop sharing from Calendar access in Settings → Sign-in & data.
import {test,expect} from '@playwright/test';
import {DEFAULT} from '../public/policy.js';
const base=process.env.BOOKING_TEST_ORIGIN||'http://127.0.0.1:8791',company='h_'+'C'.repeat(24),person='h_'+'P'.repeat(24);
test.use({timezoneId:'Europe/London'});
async function fixture(page,{role='member',connected=true}={}){
 const requests=[],caps={manageOwnCalendar:role!=='viewer',manageSettings:role==='admin',manageMembers:role==='admin',manageIntegrations:role==='admin'},my={member:{id:person,email:'ada@example.com'},account:connected?{id:'mine',email:'ada@example.com',connected:true,ownerMemberId:person,calendarId:'primary',conflictCalendarIds:['primary']}:null,calendars:[{id:'primary',summary:'My work',accessRole:'owner'},{id:'private',summary:'Private',accessRole:'reader'}],schedule:{zone:'Europe/London',weeklyHours:Object.fromEntries([0,1,2,3,4,5,6].map(d=>[d,d>0&&d<6?[{start:540,end:1020}]:[]])),dateOverrides:{}},scheduleConfigured:true,readiness:connected?'ready':'not_connected',revision:'rev1'};
 await page.route('**/api/**',async r=>{const req=r.request(),path=new URL(req.url()).pathname,body=req.postDataJSON?.(),ws=req.headers()['x-scheduling-workspace'];requests.push({path,body,ws});const json=data=>r.fulfill({json:data});
 if(path==='/api/bootstrap')return json({mode:'live',authenticated:true,hostId:person,email:'ada@example.com'});
 if(path==='/api/live/workspaces')return json({activeWorkspaceId:company,workspaces:[{id:person,personal:true,role:'owner',name:'Ada'},{id:company,name:'Acme',role,capabilities:caps}]});
 if(path==='/api/live/settings')return json({hostId:company,profile:{name:'Acme'},revision:'a',accounts:role==='admin'?[{id:'mine',email:'ada@example.com',ownerMemberId:person,connected:true,destinationCalendarId:'primary'}]:[],meetingTypes:role==='admin'?[{...DEFAULT,id:'intro',slug:'intro',published:false,title:'Intro',accountId:'mine',calendarId:'primary'}]:[],availabilitySchedules:[]});
 if(path==='/api/live/my-calendar/disconnect'){my.account.connected=false;my.readiness='withdrawn';return json({withdrawn:true,acceptedBookingsNeedReview:1});}
 if(path==='/api/live/my-calendar/readiness')return json({readiness:my.readiness});
 if(path==='/api/live/my-calendar/events')return json({events:[],calendars:my.account?.connected&&my.readiness!=='withdrawn'?my.calendars.map(c=>({accountId:'mine',id:c.id,summary:c.summary,color:null,accessRole:c.accessRole,primary:c.id==='primary',busy:my.account.conflictCalendarIds.includes(c.id),destination:c.id===my.account.calendarId})):[]});
 if(path==='/api/live/my-calendar'){if(body){my.account.calendarId=body.calendarId;my.account.conflictCalendarIds=body.conflictCalendarIds;if(body.schedule){my.schedule=body.schedule;my.scheduleConfigured=true;}if(my.readiness==='choose_calendar')my.readiness='ready';my.revision+='x';}return json(structuredClone(my));}
 if(path==='/api/live/calendar-contributions')return json({contributions:[{workspaceId:company,accountId:'mine',email:'ada@example.com',connected:my.readiness!=='withdrawn',withdrawn:my.readiness==='withdrawn'}]});
 if(path==='/api/live/calendar-contributions/withdraw'){my.readiness='withdrawn';return json({withdrawn:true,acceptedBookingsNeedReview:0});}
 if(path==='/api/live/workspace')return json({workspace:{id:company,name:'Acme',role},members:[{id:'h_'+'O'.repeat(24),email:'owner@example.com',role:'owner'},{id:person,email:'ada@example.com',role}],invitations:[]});
 if(path==='/api/live/member-calendars')return json({members:[{id:'h_'+'O'.repeat(24),readiness:'not_connected'},{id:person,readiness:my.readiness}]});
 if(path==='/api/live/calendars')return json({accounts:[]});
 if(path==='/api/live/bookings')return json({bookings:[]});
 return json({});});return {requests,my};
}
const panel=page=>page.getByRole('complementary',{name:'Calendars'});
const busy=(page,name)=>panel(page).getByRole('checkbox',{name:new RegExp('^'+name+'( Bookings)?$')});
// The checkbox sits under a drawn box, so people click its label.
const toggle=(page,name)=>panel(page).locator('label.av-check').filter({has:page.locator('.av-cal-name',{hasText:new RegExp('^'+name+'$')})}).click();
const sidebar=page=>page.getByRole('navigation',{name:'Scheduling'});
const status=page=>page.locator('[data-av-status]');
// Settings is reached from the name menu at the top of the sidebar.
async function openSettings(page,name){await page.locator('#account-trigger').click();await page.locator('#account-menu').getByRole('button',{name:'Settings',exact:true}).click();if(name)await page.getByRole('navigation',{name:'Settings'}).getByRole('button',{name}).click();}
// Home (the Bookings section) has your link on top and Upcoming below.
const expectHome=async page=>{await expect(page.getByRole('heading',{name:'Upcoming',level:2})).toBeVisible();await expect(page).toHaveTitle(/^Home · /);};
async function calendarAccess(page){
 await openSettings(page,'Sign-in & data');
 return page.getByRole('region',{name:'Calendar access'});
}
async function stopSharing(page){
 const access=await calendarAccess(page);await access.getByRole('button',{name:'Stop sharing ada@example.com with Acme',exact:true}).click();
 const confirm=page.getByRole('dialog',{name:'Stop sharing with Acme?'});await expect(confirm).toContainText('Existing Google meetings remain.');
 return {access,confirm};
}

test('member edits one availability, saves own calendar choices in the company, and stops sharing',async({page})=>{
 const state=await fixture(page);await page.goto(base+'/studio#availability');
 await expect(page.locator('[data-week]')).toBeVisible();await expect(busy(page,'Private')).toBeVisible();
 // One availability: no named schedules, schedule toolbar or Save hours.
 for(const gone of ['[data-new-availability]','[name=scheduleName]','.availability-toolbar','[data-delete-availability]'])await expect(page.locator(gone)).toHaveCount(0);
 await expect(page.getByRole('button',{name:'Save hours',exact:true})).toHaveCount(0);
 await expect(page.getByLabel('Time zone',{exact:true})).toHaveValue('Europe/London');
 await page.screenshot({path:`${process.env.BOOKING_SCREENSHOT_DIR||'test-results'}/scheduling-member-hours.png`,fullPage:true});
 await toggle(page,'Private');await expect(status(page)).toHaveText('Saved');
 const write=state.requests.find(r=>r.path==='/api/live/my-calendar'&&r.body);expect(write.ws).toBe(company);expect(write.body).toMatchObject({accountId:'mine',calendarId:'primary',expectedRevision:'rev1'});expect(write.body.conflictCalendarIds).toContain('private');
 expect(state.requests.filter(r=>r.path==='/api/live/settings'&&r.body)).toHaveLength(0);
 // Saved as you go: leaving asks nothing.
 await sidebar(page).getByRole('button',{name:/^Home/}).click();await expect(page.getByRole('dialog',{name:'Unsaved changes'})).toHaveCount(0);await expectHome(page);
 await sidebar(page).getByRole('button',{name:'Availability',exact:true}).click();await expect(busy(page,'Private')).toBeChecked();
 const {access,confirm}=await stopSharing(page);await confirm.getByRole('button',{name:'Cancel',exact:true}).click();
 expect(state.requests.filter(r=>r.path.endsWith('/withdraw'))).toHaveLength(0);
 await access.getByRole('button',{name:'Stop sharing ada@example.com with Acme',exact:true}).click();await page.getByRole('dialog',{name:'Stop sharing with Acme?'}).getByRole('button',{name:'Stop sharing',exact:true}).click();
 await expect(access.getByText(/Calendar sharing stopped/)).toBeVisible();
 expect(state.requests.filter(r=>r.path==='/api/live/calendar-contributions/withdraw').map(r=>r.body)).toEqual([{workspaceId:company,accountId:'mine'}]);
 await page.getByRole('button',{name:'Back',exact:true}).click();await sidebar(page).getByRole('button',{name:'Availability',exact:true}).click();
 // Availability now offers to connect again instead of calendar choices.
 await expect(page.locator('.setup-callout').getByRole('link',{name:'Continue with Google',exact:true})).toHaveAttribute('href',`/auth/google?connect=1&workspace=${company}&own=1`);
 await expect(panel(page).locator('[data-busy],[data-destination]')).toHaveCount(0);
});

test('a disconnected member is offered calendar setup from Availability; a viewer has no Availability',async({page})=>{
 await fixture(page,{connected:false});await page.goto(base+'/studio#availability');
 const connect=page.locator('.setup-callout').getByRole('link',{name:'Continue with Google',exact:true});
 await expect(connect).toHaveAttribute('href',`/auth/google?connect=1&workspace=${company}&own=1`);
 await expect(page.locator('[data-week]')).toHaveClass(/wk-readonly/);await expect(panel(page).locator('[data-busy],[data-destination]')).toHaveCount(0);
 await sidebar(page).getByRole('button',{name:'Team',exact:true}).click();
 const self=page.locator('.team-row').filter({hasText:'You'});await expect(self).toContainText('Calendar not connected');
 await self.getByRole('button',{name:'Set up my calendar',exact:true}).click();await expect(page.getByRole('heading',{name:'Availability',level:1})).toBeVisible();await expect(connect).toBeVisible();
 await page.unrouteAll({behavior:'ignoreErrors'});await fixture(page,{role:'viewer'});await page.goto('about:blank');await page.goto(base+'/studio#availability');
 await expectHome(page);await expect(sidebar(page).getByRole('button',{name:'Availability',exact:true})).toHaveCount(0);
});

test('admin’s own calendar stays private to them, draft preview makes no booking calls',async({page})=>{
 const state=await fixture(page,{role:'admin'});await page.goto(base+'/studio#links');
 await page.locator('.lk-row').getByRole('button',{name:/More for/}).click();await page.getByRole('menuitem',{name:'Preview'}).click();
 const dialog=page.getByRole('dialog',{name:'Share and preview booking link'});await expect(dialog).toBeVisible();const frame=page.frameLocator('iframe[title="Booking page preview"]');await expect(frame.getByText('Intro',{exact:true}).first()).toBeVisible();await expect(frame.getByRole('button',{name:/Confirm/})).toHaveCount(0);
 await dialog.getByRole('button',{name:'Close share and preview'}).click();
 await page.locator('[data-type="0"]').click();await expect(page.locator('[data-live-preview]')).not.toContainText('Loading times…');
 expect(state.requests.some(r=>/availability|visit|\/book$/.test(r.path))).toBe(false);
 // The Team page shows readiness, never the member's calendars, and no company calendar list for a member-owned account.
 await sidebar(page).getByRole('button',{name:'Links',exact:true}).click();await sidebar(page).getByRole('button',{name:'Team',exact:true}).click();
 await expect(page.locator('.team-row').filter({hasText:'You'})).toContainText('Ready for bookings');
 await expect(page.getByRole('heading',{name:'Company calendars'})).toHaveCount(0);for(const name of ['My work','Private'])await expect(page.getByText(name,{exact:true})).toHaveCount(0);
 // Availability shows the admin's own calendar only.
 await sidebar(page).getByRole('button',{name:'Availability',exact:true}).click();await expect(panel(page).locator('.av-account-block')).toHaveCount(1);await expect(panel(page).locator('.av-cal-name')).toHaveText(['My work','Private']);
 await page.setViewportSize({width:390,height:844});await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.screenshot({path:`${process.env.BOOKING_SCREENSHOT_DIR||'test-results'}/scheduling-member-calendar-phone.png`,fullPage:true});
});

test('former contribution withdrawal is account scoped even in a company',async({page})=>{
 const state=await fixture(page,{role:'viewer'});await page.goto(base+'/studio');const dialog=await calendarAccess(page);await dialog.getByRole('button',{name:/^Stop sharing ada@example\.com with /}).click();const stop=page.getByRole('dialog',{name:/^Stop sharing with /});await expect(stop.getByRole('button',{name:'Stop sharing',exact:true})).toHaveClass(/danger-button/);await stop.getByRole('button',{name:'Stop sharing',exact:true}).click();await expect.poll(()=>state.requests.filter(r=>r.path.endsWith('/calendar-contributions/withdraw')).length).toBe(1);expect(state.requests.filter(r=>r.path.includes('calendar-contributions')).every(r=>!r.ws)).toBe(true);await expect(page.getByRole('button',{name:'Availability',exact:true})).toHaveCount(0);await expect(dialog.getByText(/Calendar sharing stopped/)).toBeVisible();await expect(dialog.getByRole('button',{name:/^Stop sharing /})).toHaveCount(0);
});

test('a background calendars load cannot dismiss a pending withdrawal',async({page})=>{
 const state=await fixture(page,{role:'admin'});let releaseCalendars,releaseWithdrawal;await page.route('**/api/live/calendars',async r=>{await new Promise(resolve=>releaseCalendars=resolve);await r.fulfill({json:{accounts:[]}});});await page.route('**/api/live/calendar-contributions/withdraw',async r=>{await new Promise(resolve=>releaseWithdrawal=resolve);state.my.readiness='withdrawn';await r.fulfill({json:{withdrawn:true,acceptedBookingsNeedReview:2}});});
 await page.goto(base+`/studio?workspace=${company}&calendar=connected`);await expect(page.getByRole('heading',{name:'Availability',level:1})).toBeVisible();await expect(busy(page,'Private')).toBeVisible();
 const {confirm}=await stopSharing(page);await confirm.getByRole('button',{name:'Stop sharing',exact:true}).click();
 await expect.poll(()=>!!releaseWithdrawal&&!!releaseCalendars).toBe(true);releaseCalendars();await page.waitForTimeout(200);await expect(confirm).toBeVisible();await expect(confirm.getByRole('button',{name:'Working…'})).toBeDisabled();
 releaseWithdrawal();await expect(confirm).toHaveCount(0);
 const access=page.getByRole('region',{name:'Calendar access'});await expect(access.getByText(/Calendar sharing stopped/)).toBeVisible();await expect(page.getByText('2 accepted bookings in Acme need review.')).toBeVisible();
 await page.getByRole('button',{name:'Back',exact:true}).click();await sidebar(page).getByRole('button',{name:'Availability',exact:true}).click();
 await expect(panel(page).locator('[data-destination]')).toHaveCount(0);
});

test('hours wait for a booking calendar, and a calendar-only save does not choose hours',async({page})=>{
 const state=await fixture(page);Object.assign(state.my,{readiness:'choose_calendar',scheduleConfigured:false});Object.assign(state.my.account,{calendarId:'',conflictCalendarIds:[]});
 await page.goto(base+'/studio#availability');await expect(busy(page,'Private')).toBeVisible();
 await expect(page.getByText('until you change them')).toBeVisible();
 const destination=page.getByLabel('New bookings go to',{exact:true});
 await expect.soft(destination,'no calendar is shown as chosen before the member picks one').toHaveValue('');
 await destination.selectOption('primary');
 await expect.poll(()=>state.requests.some(r=>r.path==='/api/live/my-calendar'&&r.body)).toBe(true);await expect(status(page)).toHaveText('Saved');
 const write=state.requests.find(r=>r.path==='/api/live/my-calendar'&&r.body);expect(write.body).toMatchObject({accountId:'mine',calendarId:'primary',conflictCalendarIds:['primary']});expect(write.body.schedule).toBeUndefined();
 await expect(page.getByText('until you change them')).toBeVisible();await expect(busy(page,'My work')).toBeDisabled();
});

test('an hours change before a booking calendar is chosen is not saved and says why',async({page})=>{
 const state=await fixture(page);Object.assign(state.my,{readiness:'choose_calendar',scheduleConfigured:false});Object.assign(state.my.account,{calendarId:'',conflictCalendarIds:[]});
 await page.goto(base+'/studio#availability');await expect(busy(page,'Private')).toBeVisible();
 await page.getByLabel('Time zone',{exact:true}).selectOption('Europe/Oslo');
 await expect(status(page)).toHaveText('Choose a calendar for bookings.');
 await page.waitForTimeout(500);expect(state.requests.filter(r=>r.path==='/api/live/my-calendar'&&r.body)).toHaveLength(0);
});
test('unavailable contribution state offers retry, never a misleading withdrawal action',async({page})=>{
 await fixture(page,{role:'viewer'});let failed=true;await page.route('**/api/live/calendar-contributions',r=>r.fulfill({json:{contributions:[{workspaceId:company,accountId:'mine',email:'ada@example.com',...(failed?{unavailable:true}:{withdrawn:true,connected:false})}]}}));await page.goto(base+'/studio');const dialog=await calendarAccess(page);await expect(dialog.getByRole('button',{name:/^Stop sharing /})).toHaveCount(0);failed=false;await dialog.getByRole('button',{name:'Retry',exact:true}).click();await expect(dialog.getByText(/Calendar sharing stopped/)).toBeVisible();
});
