import {test,expect} from '@playwright/test';
import {DEFAULT} from '../public/policy.js';
const base=process.env.BOOKING_TEST_ORIGIN||'http://127.0.0.1:8791';
async function setup(page,{connected=true,bookings=[]}={}){
 let saved={revision:'A'.repeat(43),hostId:'h_abcdefghijklmnopqrstuvwx',profile:{name:'Riley',email:'host@example.com'},accounts:connected?[{id:'google1',connected:true,email:'host@example.com',destinationCalendarId:'primary',conflictCalendarIds:['primary']}]:[],meetingTypes:[{...DEFAULT,id:'intro',slug:'intro',title:'A conversation',published:connected,host:'Riley',accountId:connected?'google1':'',calendarId:connected?'primary':''}]};const writes=[];
 await page.route('**/api/**',async route=>{const path=new URL(route.request().url()).pathname;let data=saved;if(path==='/api/bootstrap')data={mode:'live',authenticated:true,hostId:saved.hostId,email:'host@example.com'};if(path==='/api/live/settings'&&route.request().method()==='POST'){const payload=route.request().postDataJSON();expect(payload.expectedRevision).toBe(saved.revision);writes.push(payload.patch);saved={...saved,...payload.patch,revision:'B'.repeat(43)};data={settings:saved,revision:saved.revision};}if(path==='/api/live/bookings')data={bookings};if(path.startsWith('/api/live/bookings/'))data={booking:bookings.find(booking=>booking.id===path.split('/').at(-1)),managementToken:'mock-management-token'};if(path==='/api/live/calendars')data={accounts:connected?[{id:'google1',calendars:[{id:'primary',summary:'Personal',accessRole:'owner'}]}]:[]};await route.fulfill({json:data});});await page.goto(base+'/studio#link=intro');await page.locator('.calendar-routing').evaluate(el=>el.open=true);return writes;
}
test('booking rules preserve existing hours without another hour editor',async({page})=>{
 const writes=await setup(page);await page.getByRole('tab',{name:'Booking rules',exact:true}).click();await expect(page.getByRole('tab',{name:'Availability',exact:true})).toHaveCount(0);await expect(page.locator('#meeting-form [data-weekday]')).toHaveCount(0);await expect(page.getByLabel('Working hours',{exact:true})).toHaveValue('');await page.locator('.capacity-limits>summary').click();await page.getByLabel('Bookings per day').selectOption('3');await page.getByRole('button',{name:/Save changes/}).click();await expect(page.locator('#host-status')).toHaveText('Saved');expect(writes[0].meetingTypes[0]).toMatchObject({startHour:9,endHour:17,dailyBookingLimit:3});await page.screenshot({path:`${process.env.BOOKING_SCREENSHOT_DIR||'test-results'}/unified-hours-link-desktop.png`,fullPage:true});await page.setViewportSize({width:390,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.screenshot({path:`${process.env.BOOKING_SCREENSHOT_DIR||'test-results'}/unified-hours-link-mobile.png`,fullPage:true});
});

test('unsaved edits are protected and keyboard save works',async({page})=>{
 const writes=await setup(page);await page.getByLabel('Meeting name',{exact:true}).fill('A better conversation');await page.getByRole('button',{name:'Bookings',exact:true}).click();const dialog=page.getByRole('dialog',{name:'Unsaved changes'});await expect(dialog).toBeVisible();await expect(dialog.getByRole('button',{name:'Keep editing'})).toBeFocused();await page.keyboard.press('Escape');await expect(dialog).toHaveCount(0);await expect(page.getByLabel('Meeting name',{exact:true})).toHaveValue('A better conversation');await page.keyboard.press('Control+s');await expect(page.locator('#host-status')).toHaveText('Saved');expect(writes[0].meetingTypes[0].title).toBe('A better conversation');
});
test('first-run setup points to calendars and invalid hours never save in Availability',async({page})=>{
 const writes=await setup(page,{connected:false});await expect(page.getByRole('button',{name:/Set up calendar/})).toBeVisible();await page.getByRole('tab',{name:'Booking rules',exact:true}).click();await page.getByRole('button',{name:'Edit hours ↗',exact:true}).click();await page.getByRole('button',{name:'Exact hours',exact:true}).click();await page.getByLabel('Monday start 1',{exact:true}).fill('oops');await page.getByRole('button',{name:'Save hours',exact:true}).click();await expect(page.locator('[data-availability-error]')).toContainText('Use a time');expect(writes).toHaveLength(0);
});

test('calendar search keeps selected conflicts and disconnect requires confirmation',async({page})=>{
 await setup(page);await page.getByRole('button',{name:'Calendars',exact:true}).click();await expect(page.locator('[data-destination]')).toHaveValue('primary');await page.getByRole('button',{name:'Search calendars for host@example.com',exact:true}).click();await page.getByRole('searchbox',{name:'Search calendars for host@example.com'}).fill('missing');await expect(page.locator('.conflict-row')).toBeHidden();expect(await page.locator('[data-conflict]').isChecked()).toBe(true);await page.getByRole('searchbox').fill('');await page.getByRole('button',{name:'Account options for host@example.com',exact:true}).click();await page.getByRole('button',{name:'Disconnect',exact:true}).click();await expect(page.getByRole('dialog',{name:'Disconnect calendar'})).toBeVisible();await expect(page.getByRole('button',{name:'Keep connected'})).toBeFocused();await page.keyboard.press('Escape');await expect(page.locator('[data-destination]')).toHaveValue('primary');
});
test('link rules save independent buffers, interval and cap without replacing working hours',async({page})=>{
 const writes=await setup(page);await page.getByLabel('Meeting name',{exact:true}).fill('A custom week');await page.getByRole('tab',{name:'Booking rules',exact:true}).click();await page.getByLabel('Before each meeting').selectOption('5');await page.getByLabel('After each meeting').selectOption('30');await page.getByLabel('Offer start times every').selectOption('20');await page.locator('.capacity-limits>summary').click();await page.getByLabel('Bookings per week').selectOption('5');await page.keyboard.press('Control+s');await expect(page.locator('#host-status')).toHaveText('Saved');expect(writes[0].meetingTypes[0]).toMatchObject({title:'A custom week',buffer:15,bufferBefore:5,bufferAfter:30,slotInterval:20,weeklyBookingLimit:5,startHour:9,endHour:17,dateOverrides:{}});
});

test('opening central hours protects unsaved link edits',async({page})=>{
 const writes=await setup(page);await page.getByLabel('Meeting name',{exact:true}).fill('Unsaved title');await page.getByRole('tab',{name:'Booking rules',exact:true}).click();await page.getByRole('button',{name:'Edit hours ↗',exact:true}).click();await page.getByRole('dialog',{name:'Unsaved changes',exact:true}).getByRole('button',{name:'Keep editing',exact:true}).click();await expect(page.getByRole('tab',{name:'Booking rules',exact:true})).toHaveAttribute('aria-selected','true');expect(writes).toHaveLength(0);
});

test('location controls retain custom text while choosing generated Google Meet and keep legacy buffers inherited',async({page})=>{
 const writes=await setup(page);await expect(page.getByLabel('Where',{exact:true})).toHaveValue('custom');await page.getByLabel('Meeting link or location',{exact:true}).fill('https://example.com/our-call');await page.getByLabel('Where',{exact:true}).selectOption('google_meet');await expect(page.getByText('A unique Google Meet link is added to each booking.')).toBeVisible();await expect(page.getByLabel('Meeting link or location',{exact:true})).toBeHidden();await page.getByLabel('Where',{exact:true}).selectOption('custom');await expect(page.getByLabel('Meeting link or location',{exact:true})).toHaveValue('https://example.com/our-call');await page.getByLabel('Where',{exact:true}).selectOption('google_meet');await page.getByRole('button',{name:/Save changes/}).click();await expect(page.locator('#host-status')).toHaveText('Saved');expect(writes[0].meetingTypes[0].locationType).toBe('google_meet');expect(writes[0].meetingTypes[0].location).toBe('https://example.com/our-call');expect(writes[0].meetingTypes[0].bufferBefore).toBeNull();expect(writes[0].meetingTypes[0].bufferAfter).toBeNull();
});
test('host booking details only link ready Google Meet URLs and show safe calendar status',async({page})=>{
 const start=Date.now()+86400000,baseBooking={status:'confirmed',name:'Guest',email:'guest@example.com',start,end:start+1800000,timeZone:'Europe/London',meetingTypeSlug:'intro',lastError:'private refresh_token secret'};
 const bookings=[{...baseBooking,id:'meet-ready-0000001',title:'Ready meeting',conferenceStatus:'ready',meetingUrl:'https://meet.google.com/abc-defg-hij',calendarSyncStatus:'pending',calendarChange:'updated'},{...baseBooking,id:'meet-invalid-0001',title:'Invalid meeting',conferenceStatus:'ready',meetingUrl:'https://evil.example/abc-defg-hij'},{...baseBooking,id:'meet-pending-0001',title:'Pending meeting',conferenceStatus:'pending'},{...baseBooking,id:'meet-failed-00001',title:'Failed meeting',conferenceStatus:'failed',calendarChange:'cancelled'}];await setup(page,{bookings});await page.getByRole('button',{name:'Bookings',exact:true}).click();
 for(const booking of bookings){await page.getByRole('button',{name:new RegExp('View booking: '+booking.title)}).click();const dialog=page.getByRole('dialog',{name:'Booking details'});if(booking.conferenceStatus==='ready'&&booking.title==='Ready meeting'){await expect(dialog.getByRole('link',{name:'Join meeting',exact:false})).toHaveAttribute('href',booking.meetingUrl);await expect(dialog.getByText('Calendar updates are delayed. Check the calendar connection.')).toBeVisible();await expect(dialog.getByText('Updated in Google Calendar')).toBeVisible();}else{await expect(dialog.getByRole('link',{name:'Join meeting',exact:false})).toHaveCount(0);await expect(dialog.getByText(booking.conferenceStatus==='pending'?'Creating Google Meet link…':'Meeting link needs attention. Check Google Calendar.')).toBeVisible();}if(booking.calendarChange==='cancelled')await expect(dialog.getByText('Cancelled in Google Calendar')).toBeVisible();await expect(dialog).not.toContainText('refresh_token');await dialog.getByRole('button',{name:'Close booking details',exact:true}).click();}
});

test('stale saves keep edits and require an explicit reload before replacing them',async({page})=>{
 await setup(page);await expect(page.getByLabel('Meeting name',{exact:true})).toHaveValue('A conversation');let posts=0;
 await page.route('**/api/live/settings',route=>{if(route.request().method()==='POST'){posts++;expect(route.request().postDataJSON().expectedRevision).toBe('A'.repeat(43));return route.fulfill({status:409,json:{error:'Settings changed. Review a new preview before applying.',code:'settings_conflict'}});}return route.fulfill({json:{revision:'C'.repeat(43),profile:{name:'Riley'},accounts:[],meetingTypes:[{...DEFAULT,id:'intro',slug:'intro',title:'Changed through MCP',published:false}]}});});
 await page.getByLabel('Meeting name',{exact:true}).fill('My unsaved edit');await page.getByRole('button',{name:/Save changes/}).click();await expect(page.getByRole('button',{name:'Review latest settings'})).toBeVisible();await expect(page.getByLabel('Meeting name',{exact:true})).toHaveValue('My unsaved edit');
 await page.getByRole('button',{name:'Review latest settings'}).click();const dialog=page.getByRole('dialog',{name:'Settings changed',exact:true});await expect(dialog.getByRole('button',{name:'Keep editing'})).toBeFocused();await page.keyboard.press('Escape');await expect(page.getByLabel('Meeting name',{exact:true})).toHaveValue('My unsaved edit');expect(posts).toBe(1);
 await page.getByRole('button',{name:'Review latest settings'}).click();await dialog.getByRole('button',{name:'Load latest settings'}).click();await expect(page.getByLabel('Meeting name',{exact:true})).toHaveValue('Changed through MCP');await expect(page.getByLabel('Meeting name',{exact:true})).toBeFocused();await expect(page.locator('#host-status')).toHaveText('Latest settings loaded');expect(posts).toBe(1);
});

test('browser session controls are explicit, keyboard dismissible and preserve provider connections',async({page})=>{
 await setup(page);let mutations=0;const now=Date.now();let sessions=[{id:'current',label:'This browser',current:true,createdAt:now,expiresAt:now+86400000},{id:'other',label:'Browser session',current:false,createdAt:now,expiresAt:now+86400000}];
 await page.route('**/api/live/sessions**',route=>{if(route.request().method()==='POST'){expect(new URL(route.request().url()).pathname).toBe('/api/live/sessions/revoke-others');mutations++;sessions=sessions.filter(s=>s.current);return route.fulfill({json:{revokedCount:1}});}return route.fulfill({json:{sessions}});});
 await page.locator('#account-trigger').click();await page.getByRole('button',{name:'Manage account',exact:true}).click();const trigger=page.getByRole('dialog',{name:'Account',exact:true}).getByRole('button',{name:'Manage signed-in browsers',exact:true});await trigger.click();const dialog=page.getByRole('dialog',{name:'Signed-in browsers',exact:true});await expect(dialog.getByText('Browser session',{exact:true})).toBeVisible();await dialog.getByRole('button',{name:'Sign out other browsers',exact:true}).click();await expect(dialog.getByRole('button',{name:'Keep signed in',exact:true})).toBeFocused();expect(mutations).toBe(0);await dialog.getByRole('button',{name:'Sign out',exact:true}).last().click();await expect(dialog.getByText('Browser session',{exact:true})).toHaveCount(0);expect(mutations).toBe(1);await page.screenshot({path:`${process.env.BOOKING_SCREENSHOT_DIR||'test-results'}/scheduling-sessions-desktop.png`,fullPage:true});await page.setViewportSize({width:390,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBeTruthy();await page.screenshot({path:`${process.env.BOOKING_SCREENSHOT_DIR||'test-results'}/scheduling-sessions-mobile.png`,fullPage:true});await page.keyboard.press('Escape');await expect(trigger).toBeFocused();await page.keyboard.press('Escape');await expect(page.locator('#account-trigger')).toBeFocused();await expect(page.getByLabel('Calendar account',{exact:true})).toHaveValue('google1');
});

test('removing a meeting link is explicit, guarded and preserves other links',async({page})=>{
 const writes=await setup(page);
 await page.locator('#back-to-links').click();await page.getByRole('button',{name:'+ New booking link',exact:true}).click();
 await page.getByLabel('Meeting name',{exact:true}).fill('Temporary link');
 await page.getByRole('button',{name:/Save changes/}).click();
 await expect(page.locator('#host-status')).toHaveText('Saved');
 await page.getByText('Link and host details',{exact:true}).click();
 const trigger=page.getByRole('button',{name:'Remove meeting link…',exact:true});await trigger.click();
 const dialog=page.getByRole('dialog',{name:'Remove meeting link',exact:true});
 await expect(dialog.getByRole('button',{name:'Keep link',exact:true})).toBeFocused();
 await dialog.press('Escape');await expect(trigger).toBeFocused();expect(writes).toHaveLength(1);
 await trigger.click();await dialog.getByRole('button',{name:'Remove link',exact:true}).click();
 await expect(page.locator('#host-status')).toHaveText('Meeting link removed');
 expect(writes).toHaveLength(2);expect(writes[1].meetingTypes).toHaveLength(1);expect(writes[1].meetingTypes[0].slug).toBe('intro');
 await expect(page.getByRole('button',{name:/Temporary link.*Paused/})).toHaveCount(0);
});

test('closing a delayed settings reload preserves the current edits',async({page})=>{
 await setup(page);await expect(page.getByLabel('Meeting name',{exact:true})).toHaveValue('A conversation');let release;const gate=new Promise(resolve=>release=resolve);
 await page.route('**/api/live/settings',async route=>{
  if(route.request().method()==='POST')return route.fulfill({status:409,json:{error:'Settings changed.',code:'settings_conflict'}});
  await gate;return route.fulfill({json:{revision:'C'.repeat(43),profile:{name:'Riley'},accounts:[],meetingTypes:[{...DEFAULT,id:'intro',slug:'intro',title:'Remote edit',published:false}]}});
 });
 await page.getByLabel('Meeting name',{exact:true}).fill('Keep my draft');
 await page.getByRole('button',{name:/Save changes/}).click();
 await page.getByRole('button',{name:'Review latest settings'}).click();
 const dialog=page.getByRole('dialog',{name:'Settings changed',exact:true});
 await dialog.getByRole('button',{name:'Load latest settings'}).click();
 await expect(dialog.getByRole('button',{name:'Load latest settings'})).toBeDisabled();
 await dialog.getByRole('button',{name:'Keep editing'}).click();
 const response=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/live/settings'&&r.request().method()==='GET');release();await response;
 await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
 await expect(page.getByLabel('Meeting name',{exact:true})).toHaveValue('Keep my draft');
 await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('appearance saves the transition preference with the meeting',async({page})=>{
 const writes=await setup(page);await page.getByRole('tab',{name:'Appearance',exact:true}).click();
 await page.getByRole('radio',{name:'Instant',exact:true}).check();await page.getByRole('button',{name:/Save changes/}).click();
 await expect(page.locator('#host-status')).toHaveText('Saved');expect(writes[0].meetingTypes[0].motion).toBe('none');
 await expect(page.getByRole('radio',{name:'Instant',exact:true})).toBeChecked();
});

test('appearance controls preview changes, support keyboard selection and fit narrow screens',async({page})=>{
 const writes=await setup(page);await page.getByRole('tab',{name:'Appearance',exact:true}).click();
 const card=page.locator('.profile-brand-preview');await expect(card).toContainText('A conversation');
 await page.getByRole('radio',{name:'Light',exact:true}).focus();await page.keyboard.press('ArrowRight');await expect(page.getByRole('radio',{name:'Dark',exact:true})).toBeChecked();await expect(card).toHaveAttribute('data-theme','dark');
 await page.getByRole('radio',{name:'Sage',exact:true}).check();await expect(card).toHaveAttribute('data-accent','sage');expect(writes).toHaveLength(0);
 await page.getByRole('button',{name:/Save changes/}).click();const pickerPromise=page.waitForEvent('filechooser');await page.getByRole('button',{name:'Add banner',exact:true}).click();const picker=await pickerPromise;await picker.setFiles([]);await expect(page.getByRole('dialog',{name:'Edit profile',exact:true})).toHaveCount(0);await expect(page.getByRole('button',{name:'Add banner',exact:true})).toBeFocused();
 await page.evaluate(()=>scrollTo(0,0));await page.screenshot({path:`${process.env.BOOKING_SCREENSHOT_DIR||'test-results'}/scheduling-appearance-desktop.png`,fullPage:true});await page.setViewportSize({width:390,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBeTruthy();await page.screenshot({path:`${process.env.BOOKING_SCREENSHOT_DIR||'test-results'}/scheduling-appearance-mobile.png`,fullPage:true});await page.setViewportSize({width:1440,height:1000});await page.locator('#account-trigger').click();await page.getByRole('button',{name:'Dark mode',exact:true}).click();await expect(page.locator('html')).toHaveAttribute('data-theme','dark');await page.evaluate(()=>scrollTo(0,0));await page.screenshot({path:`${process.env.BOOKING_SCREENSHOT_DIR||'test-results'}/scheduling-appearance-dark.png`,fullPage:true});await page.getByRole('radio',{name:'Light',exact:true}).check();await expect(card).toHaveCSS('background-color','rgb(255, 255, 255)');
});

test('meeting workspace keeps main fields compact and calendar routing together',async({page})=>{
 const writes=await setup(page);await page.setViewportSize({width:1440,height:1000});
 await expect(page.getByLabel('Meeting name',{exact:true})).toBeVisible();await expect(page.getByLabel('Calendar account',{exact:true})).toBeVisible();
 const account=await page.getByLabel('Calendar account',{exact:true}).boundingBox(),calendar=await page.getByLabel('Booking calendar',{exact:true}).boundingBox();expect(Math.abs(account.y-calendar.y)).toBeLessThan(2);expect(account.height).toBeGreaterThanOrEqual(40);expect(calendar.height).toBeGreaterThanOrEqual(40);
 await page.screenshot({path:`${process.env.BOOKING_SCREENSHOT_DIR||'test-results'}/studio-workspace-desktop.png`,fullPage:true});await page.getByLabel('Meeting name',{exact:true}).fill('Weekly catch-up');await page.getByLabel('Duration',{exact:true}).fill('45');await page.getByRole('button',{name:/Save changes/}).click();expect(writes[0].meetingTypes[0].title).toBe('Weekly catch-up');expect(writes[0].meetingTypes[0].duration).toBe(45);
 await page.setViewportSize({width:390,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBeTruthy();await page.screenshot({path:`${process.env.BOOKING_SCREENSHOT_DIR||'test-results'}/studio-workspace-mobile.png`,fullPage:true});
 await page.setViewportSize({width:1440,height:1000});await page.locator('#account-trigger').click();await page.getByRole('button',{name:'Dark mode',exact:true}).click();await page.screenshot({path:`${process.env.BOOKING_SCREENSHOT_DIR||'test-results'}/studio-workspace-dark.png`,fullPage:true});
});

test('booking links opens as a collection with direct sharing and a separate editor',async({page,context,browserName})=>{
 await setup(page);await page.goto(base+'/studio');await expect(page.getByRole('heading',{name:'Booking links',exact:true})).toBeVisible();await expect(page.locator('#meeting-form')).toHaveCount(0);
 await expect(page.locator('.booking-link-row')).toHaveCount(1);await expect(page.locator('.booking-link-meta')).toContainText('30 min');await expect(page.locator('.booking-link-state')).toHaveText('Active');
 if(browserName==='chromium')await context.grantPermissions(['clipboard-read','clipboard-write'],{origin:base});else await page.evaluate(()=>Object.defineProperty(navigator,'clipboard',{value:{writeText:async text=>{window.__copiedLink=text;}}}));
 await page.getByRole('button',{name:'Share A conversation',exact:true}).click();const share=page.getByRole('dialog',{name:'Share and preview booking link'});await share.getByRole('button',{name:'Copy link',exact:true}).click();await expect(share.getByText('Link copied',{exact:true})).toBeVisible();await share.getByRole('button',{name:'Close share and preview'}).click();await expect(page.locator('#host-status')).toBeEmpty();expect(await page.evaluate(browserName==='chromium'?()=>navigator.clipboard.readText():()=>window.__copiedLink)).toBe(base+'/b/h_abcdefghijklmnopqrstuvwx/intro');
 await page.setViewportSize({width:1440,height:960});await page.screenshot({path:`${process.env.BOOKING_SCREENSHOT_DIR||'test-results'}/booking-links-list-desktop.png`});
 await page.getByRole('button',{name:'Edit settings for A conversation',exact:true}).focus();await page.keyboard.press('Enter');await expect(page.locator('#back-to-links')).toBeFocused();await expect(page.getByRole('heading',{level:1,name:'A conversation',exact:true})).toBeVisible();await expect(page.locator('.type-list')).toHaveCount(0);await expect(page.locator('.booking-links-list')).toHaveCount(0);
 await page.getByLabel('Meeting name',{exact:true}).fill('Changed');await page.locator('#back-to-links').click();const discard=page.getByRole('dialog',{name:'Unsaved changes'});await expect(discard).toBeVisible();await discard.getByRole('button',{name:'Keep editing'}).click();await expect(page.getByLabel('Meeting name',{exact:true})).toHaveValue('Changed');await page.locator('#back-to-links').click();await discard.getByRole('button',{name:'Discard changes',exact:true}).click();await expect(page.locator('#meeting-form')).toHaveCount(0);await expect(page.getByRole('button',{name:'Edit A conversation',exact:true})).toBeFocused();
 await page.setViewportSize({width:390,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBeTruthy();await page.screenshot({path:`${process.env.BOOKING_SCREENSHOT_DIR||'test-results'}/booking-links-list-mobile.png`});
});

test('new links start from profile defaults and update only draft URLs automatically',async({page})=>{
 const writes=await setup(page);await page.locator('#back-to-links').click();await page.locator('#add-type').click();await expect(page.getByLabel('Meeting name',{exact:true})).toHaveValue('30 minute meeting');await expect(page.getByLabel('Your name',{exact:true})).toHaveValue('Riley');await expect(page.getByLabel('Where',{exact:true})).toHaveValue('google_meet');await expect(page.locator('.calendar-routing')).not.toHaveAttribute('open');await expect(page.getByLabel('Calendar account',{exact:true})).toHaveValue('google1');await page.setViewportSize({width:1440,height:960});await page.screenshot({path:`${process.env.BOOKING_SCREENSHOT_DIR||'test-results'}/meeting-defaults-final.png`,animations:'disabled'});
 await page.getByLabel('Meeting name',{exact:true}).fill('Quick intro');await expect(page.getByLabel('Link address',{exact:true})).toHaveValue('quick-intro');await page.getByRole('button',{name:/Save changes/}).click();await expect(page.locator('#host-status')).toHaveText('Saved');expect(writes[0].meetingTypes[1]).toMatchObject({host:'Riley',accountId:'google1',locationType:'google_meet',slug:'quick-intro'});
 await page.getByLabel('Meeting name',{exact:true}).fill('Another name');await expect(page.getByLabel('Link address',{exact:true})).toHaveValue('quick-intro');
});
