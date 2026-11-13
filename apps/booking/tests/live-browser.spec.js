import {test,expect} from '@playwright/test';
import {DEFAULT} from '../public/policy.js';
const base=process.env.BOOKING_TEST_ORIGIN||'http://127.0.0.1:8791',host='h_abcdefghijklmnopqrstuvwx';
const start=Date.now()+86400000;
const settings={revision:'A'.repeat(43),hostId:host,profile:{id:host,name:'Riley',email:'host@example.com'},accounts:[{id:'google1',connected:true,email:'host@example.com',destinationCalendarId:'primary',conflictCalendarIds:['primary']}],meetingTypes:[{...DEFAULT,id:'intro',slug:'intro',title:'A conversation',host:'Riley',published:true,accountId:'google1',calendarId:'primary'}]};
test('live host settings and calendar connections remain usable',async({page})=>{
 await page.route('**/api/**',route=>{const path=new URL(route.request().url()).pathname;const data=path==='/api/live/settings'&&route.request().method()==='POST'?{settings,revision:settings.revision}:path==='/api/bootstrap'?{mode:'live',authenticated:true,hostId:host,email:'host@example.com'}:path==='/api/live/calendars'?{accounts:[{id:'google1',email:'host@example.com',calendars:[{id:'primary',summary:'Personal',accessRole:'owner'}]}]}:settings;return route.fulfill({json:data});});
 await page.goto(base+'/studio');await expect(page.getByRole('heading',{name:'Booking links',exact:true})).toBeVisible();await page.locator('[data-type]').first().click();
 await page.locator('[name=title]').fill('Product session');await page.getByRole('button',{name:'Save changes'}).click();await expect(page.locator('#host-status')).toHaveText('Saved');
 await page.screenshot({path:`${process.env.BOOKING_SCREENSHOT_DIR||'test-results'}/scheduling-live-host.png`,fullPage:true});
 await page.getByRole('button',{name:'Calendars',exact:true}).click();await expect(page.getByText('Check busy',{exact:true})).toBeVisible();await expect(page.locator('[data-destination]')).toHaveValue('primary');
 await page.setViewportSize({width:390,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBeTruthy();
});
test('live booking confirms and management escapes host copy',async({page})=>{
 const booking={id:'abcdefghijklmnop',status:'confirmed',start,end:start+1800000,name:'Guest',email:'guest@example.com',title:'<img src=x onerror=alert(1)>',meetingTypeSlug:'intro',timeZone:'Europe/London'};
 await page.route('**/api/**',route=>{const path=new URL(route.request().url()).pathname;return route.fulfill({json:path==='/api/bootstrap'?{mode:'live',authenticated:false}:path.endsWith('/availability')?{mode:'live',config:settings.meetingTypes[0],slots:[{start:booking.start,end:booking.end}]}:{booking,managementToken:'token'}});});
 await page.goto(base+`/b/${host}/intro`);await page.locator('[data-slot]').first().click();await page.getByLabel('Your name',{exact:true}).fill('Guest');await page.getByLabel('Email address',{exact:true}).fill('guest@example.com');await page.getByRole('button',{name:/Confirm booking/}).click();await expect(page.getByRole('heading',{name:'You’re booked'})).toBeVisible();
 await page.goto(base+`/manage/${host}/${booking.id}#token`);await expect(page.locator('.success h1')).toHaveText(booking.title);await expect(page.locator('.success h1 img')).toHaveCount(0);await page.getByRole('button',{name:'Cancel booking',exact:true}).click();await expect(page.getByLabel('Reason (optional)',{exact:true})).toBeFocused();
});

test('booking workspace filters, search and keyboard details work at desktop and mobile sizes',async({page})=>{
 const fixtures=[{id:'booking-future-001',title:'Product review',name:'Maya Chen',email:'maya@example.com',status:'confirmed',start,end:start+1800000,timeZone:'Europe/London',meetingTypeSlug:'intro',location:'Video call',answer:'Review the new onboarding.'},{id:'booking-cancel-001',title:'Introductory meeting',name:'Riley Quinn',email:'host@example.com',status:'cancelled',start:start-3600000,end:start-1800000,timeZone:'Europe/London',meetingTypeSlug:'intro'}];
 await page.route('**/api/**',route=>{const path=new URL(route.request().url()).pathname;let data=path==='/api/bootstrap'?{mode:'live',authenticated:true,hostId:host,email:'host@example.com'}:path==='/api/live/bookings'?{bookings:fixtures}:path.startsWith('/api/live/bookings/')?{booking:fixtures.find(b=>b.id===path.split('/').at(-1)),managementToken:'private-token'}:path==='/api/live/calendars'?{accounts:[]}:settings;return route.fulfill({json:data});});
 await page.goto(base+'/studio#link=intro');await page.getByRole('button',{name:'Bookings',exact:true}).click();
 await expect(page.getByRole('heading',{name:'Bookings',exact:true})).toHaveCount(1);
 await expect(page.getByRole('button',{name:/View booking: Product review/})).toBeVisible();
 await expect(page.getByRole('button',{name:/View booking: Introductory/})).toHaveCount(0);
 await page.screenshot({path:`${process.env.BOOKING_SCREENSHOT_DIR||'test-results'}/scheduling-workspace-desktop.png`,fullPage:true});
 const row=page.getByRole('button',{name:/View booking: Product review/});await row.focus();await page.keyboard.press('Enter');
 const dialog=page.getByRole('dialog',{name:'Booking details'});await expect(dialog.getByRole('heading',{name:'Product review'})).toBeVisible();await expect(dialog.getByText('Review the new onboarding.')).toBeVisible();
 await page.screenshot({path:`${process.env.BOOKING_SCREENSHOT_DIR||'test-results'}/scheduling-workspace-detail.png`,fullPage:true});
 await page.keyboard.press('Escape');await expect(dialog).toHaveCount(0);await expect(row).toBeFocused();
 await page.getByRole('button',{name:/Cancelled/}).click();await expect(page.getByRole('button',{name:/View booking: Introductory/})).toBeVisible();
 await page.getByRole('searchbox',{name:'Search bookings'}).fill('not there');await expect(page.getByRole('heading',{name:'No matching bookings'})).toBeVisible();await expect(page.getByRole('searchbox')).toBeFocused();
 await page.getByRole('searchbox').fill('Riley');await expect(page.getByRole('button',{name:/View booking: Introductory/})).toBeVisible();
 await page.setViewportSize({width:390,height:844});await page.screenshot({path:`${process.env.BOOKING_SCREENSHOT_DIR||'test-results'}/scheduling-workspace-mobile.png`,fullPage:true});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBeTruthy();
 await page.setViewportSize({width:1440,height:1000});await page.locator('#account-trigger').click();await page.getByRole('button',{name:'Dark mode'}).click();await expect(page.locator('html')).toHaveAttribute('data-theme','dark');await page.screenshot({path:`${process.env.BOOKING_SCREENSHOT_DIR||'test-results'}/scheduling-workspace-dark.png`,fullPage:true});
});

test('host cancellation requires confirmation and updates the booking without leaving the workspace',async({page})=>{
 let booking={id:'booking-future-001',title:'Review <script>',name:'Guest',email:'guest@example.com',status:'confirmed',start,end:start+1800000,timeZone:'Europe/London',meetingTypeSlug:'intro'};let cancels=0;
 await page.route('**/api/**',route=>{const path=new URL(route.request().url()).pathname;let data;if(path.startsWith('/api/manage/'))throw Error('staff must not use the guest capability');if(path.endsWith('/cancel')&&route.request().method()==='POST'){cancels++;booking={...booking,status:'cancelled'};data={booking};}else data=path==='/api/bootstrap'?{mode:'live',authenticated:true,hostId:host,email:'host@example.com'}:path==='/api/live/bookings'?{bookings:[booking]}:path.startsWith('/api/live/bookings/')?{booking,managementToken:'private-token'}:path==='/api/live/calendars'?{accounts:[]}:settings;return route.fulfill({json:data});});
 await page.goto(base+'/studio#link=intro');await page.getByRole('button',{name:'Bookings',exact:true}).click();await page.locator('[data-manage]').click();const dialog=page.getByRole('dialog');await expect(dialog.getByRole('heading',{level:2})).toHaveText('Review <script>');await expect(dialog.locator('script')).toHaveCount(0);
 await dialog.getByRole('button',{name:'Cancel booking',exact:true}).click();expect(cancels).toBe(0);await expect(dialog.getByRole('button',{name:'Keep booking'})).toBeFocused();await dialog.getByRole('button',{name:'Keep booking'}).click();expect(cancels).toBe(0);
 await dialog.getByRole('button',{name:'Cancel booking',exact:true}).click();await dialog.getByRole('button',{name:'Cancel booking',exact:true}).click();await expect(dialog.getByText('Cancelled',{exact:true})).toBeVisible();expect(cancels).toBe(1);await dialog.getByRole('button',{name:'Done',exact:true}).click();await expect(page.getByRole('heading',{name:'No upcoming bookings'})).toBeVisible();await expect(page).toHaveURL(base+'/studio');
});

test('aggregate analytics shows honest activity counts and stays usable on mobile',async({page})=>{
 const days=Array.from({length:30},(_,i)=>({day:new Date(Date.UTC(2026,10,i+1)).toISOString().slice(0,10),pageViews:i===29?24:0,bookingRequests:i===29?5:0,confirmed:i===29?4:0,cancelled:0,rescheduled:0,failed:0}));
 const analytics={period:{from:'2026-11-01',to:'2026-11-30',days:30,timeZone:'UTC'},trackingStartedAt:Date.UTC(2026,10,1),totals:{pageViews:24,bookingRequests:5,confirmed:4,cancelled:1,rescheduled:2,failed:1},sources:{direct:12,email:10,website:2},series:days};let reads=0;
 await page.route('**/api/**',route=>{const path=new URL(route.request().url()).pathname;let data;if(path==='/api/live/analytics'){reads++;data=analytics;}else data=path==='/api/bootstrap'?{mode:'live',authenticated:true,hostId:host,email:'host@example.com'}:path==='/api/live/calendars'?{accounts:[]}:settings;return route.fulfill({json:data});});
 await page.goto(base+'/studio#link=intro');await page.getByRole('button',{name:'Booking stats',exact:true}).click();await expect(page.getByRole('heading',{name:'Booking stats',exact:true})).toBeVisible();await expect(page.getByRole('heading',{name:'Page views',exact:true})).toBeVisible();await expect(page.getByText(/No visitor identifiers/)).toBeHidden();await page.getByText('About these counts',{exact:true}).click();await expect(page.getByText(/No visitor identifiers/)).toBeVisible();await page.getByText('About these counts',{exact:true}).click();
 expect(reads).toBe(1);await page.getByRole('button',{name:'Refresh',exact:true}).click();await expect.poll(()=>reads).toBe(2);await page.screenshot({path:`${process.env.BOOKING_SCREENSHOT_DIR||'test-results'}/scheduling-analytics-desktop.png`,fullPage:true});
 await page.setViewportSize({width:390,height:844});await page.getByText('Daily activity',{exact:true}).click();expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBeTruthy();await expect(page.getByRole('columnheader',{name:'Date',exact:true})).toBeVisible();await page.screenshot({path:`${process.env.BOOKING_SCREENSHOT_DIR||'test-results'}/scheduling-analytics-mobile.png`,fullPage:true});
});
test('public page records one explicit tagged view while interactions and preview do not record more',async({page})=>{
 const visits=[];await page.route('**/api/**',route=>{const path=new URL(route.request().url()).pathname;if(path.endsWith('/visit'))visits.push(route.request().postDataJSON());return route.fulfill({json:path==='/api/bootstrap'?{mode:'live',authenticated:false}:path.endsWith('/visit')?{ok:true}:{mode:'live',config:settings.meetingTypes[0],slots:[{start,end:start+1800000}]}});});
 await page.goto(base+`/b/${host}/intro?source=email`);await expect.poll(()=>visits.length).toBe(1);expect(visits[0]).toEqual({source:'email'});await page.locator('[data-slot]').first().click();await page.locator('#back').click();expect(visits.length).toBe(1);
 await page.goto(base+`/b/${host}/intro?preview=1&source=email`);await expect(page.locator('[data-slot]').first()).toBeVisible();expect(visits.length).toBe(1);
});

test('suggested-time links select only a slot returned by fresh availability and stale links fall back clearly',async({page})=>{
 await page.route('**/api/**',route=>{const path=new URL(route.request().url()).pathname;return route.fulfill({json:path==='/api/bootstrap'?{mode:'live',authenticated:false}:path.endsWith('/visit')?{ok:true}:{mode:'live',config:settings.meetingTypes[0],slots:[{start,end:start+1800000}]}});});
 await page.goto(base+`/b/${host}/intro?start=${start}`);await expect(page.getByLabel('Your name',{exact:true})).toBeVisible();await expect(page.getByRole('button',{name:/Confirm booking/})).toBeVisible();
 await page.goto(base+`/b/${host}/intro?start=${start+60000}`);await expect(page.getByText('That suggested time is no longer available. Choose another time.')).toBeVisible();await expect(page.locator('[data-slot]').first()).toBeVisible();await expect(page.locator('#booking-form')).toHaveCount(0);
});
test('native host handoff opens an authenticated booking detail using only its opaque ID',async({page})=>{
 const booking={id:'native-booking-id-001',title:'Native handoff meeting',name:'Guest',email:'guest@example.com',status:'confirmed',start,end:start+1800000,meetingTypeSlug:'intro'};
 await page.route('**/api/**',route=>{const path=new URL(route.request().url()).pathname;const data=path==='/api/bootstrap'?{mode:'live',authenticated:true,hostId:host,email:'host@example.com'}:path==='/api/live/bookings'?{bookings:[booking]}:path.startsWith('/api/live/bookings/')?{booking,managementToken:'server-capability'}:path==='/api/live/calendars'?{accounts:[]}:settings;return route.fulfill({json:data});});
 await page.goto(base+'/studio#booking='+booking.id);await expect(page.getByRole('heading',{name:'Bookings',exact:true})).toBeVisible();await expect(page.getByRole('dialog').getByRole('heading',{name:booking.title})).toBeVisible();expect(page.url()).not.toContain('server-capability');await expect(page.getByRole('dialog').getByRole('button',{name:'Cancel booking',exact:true})).toBeVisible();
});

test('Google Meet pending and ready states stay separate from booking confirmation',async({page})=>{
 const booking={id:'booking-meet-0001',status:'confirmed',start,end:start+1800000,name:'Guest',email:'guest@example.com',title:'A conversation',meetingTypeSlug:'intro',timeZone:'Europe/London',conferenceStatus:'pending'};let reads=0;
 await page.route('**/api/**',route=>{const path=new URL(route.request().url()).pathname;return route.fulfill({json:path==='/api/bootstrap'?{mode:'live',authenticated:false}:path.endsWith('/availability')?{mode:'live',config:{...settings.meetingTypes[0],locationType:'google_meet'},slots:[{start:booking.start,end:booking.end}]}:path.startsWith('/api/manage/')?{booking:{...booking,...(++reads>1?{conferenceStatus:'ready',meetingUrl:'https://meet.google.com/abc-defg-hij'}:{})}}:{booking,managementToken:'token'}});});
 await page.goto(base+`/b/${host}/intro`);await expect(page.locator('.meeting-meta')).toContainText('Google Meet');await page.locator('[data-slot]').first().click();await page.getByLabel('Your name',{exact:true}).fill('Guest');await page.getByLabel('Email address',{exact:true}).fill('guest@example.com');await page.getByRole('button',{name:/Confirm booking/}).click();await expect(page.getByRole('heading',{name:'You’re booked'})).toBeVisible();await expect(page.getByText('Creating your Google Meet link…')).toBeVisible();await expect(page.getByRole('link',{name:/Join Google Meet/})).toHaveCount(0);
 await page.goto(base+`/manage/${host}/${booking.id}#token`);await expect(page.getByRole('button',{name:'Refresh status'})).toBeVisible();await page.getByRole('button',{name:'Refresh status'}).click();await expect(page.getByRole('link',{name:/Join Google Meet/})).toHaveAttribute('href','https://meet.google.com/abc-defg-hij');await expect(page.getByText('Creating your Google Meet link…')).toHaveCount(0);
});

test('unsafe meeting URLs never become guest links',async({page})=>{
 const booking={id:'booking-meet-0002',status:'confirmed',start,end:start+1800000,name:'Guest',email:'guest@example.com',title:'A conversation',timeZone:'Europe/London',conferenceStatus:'ready',meetingUrl:'javascript:alert(1)'};
 await page.route('**/api/**',route=>route.fulfill({json:new URL(route.request().url()).pathname==='/api/bootstrap'?{mode:'live',authenticated:false}:{booking}}));await page.goto(base+`/manage/${host}/${booking.id}#token`);await expect(page.getByRole('link',{name:/Join Google Meet/})).toHaveCount(0);await expect(page.locator('a[href^="javascript:"]')).toHaveCount(0);
});

test('a pending meeting room refreshes automatically without resubmitting the booking',async({page})=>{
 await page.clock.install();let reads=0;const booking={id:'booking-meet-0003',status:'confirmed',start,end:start+1800000,name:'Guest',email:'guest@example.com',title:'A conversation',meetingTypeSlug:'intro',conferenceStatus:'pending'};
 await page.route('**/api/**',route=>{const path=new URL(route.request().url()).pathname;if(path==='/api/bootstrap')return route.fulfill({json:{mode:'live',authenticated:false}});expect(route.request().postDataJSON().action).toBe('view');reads++;return route.fulfill({json:{booking:{...booking,...(reads>1?{conferenceStatus:'ready',meetingUrl:'https://meet.google.com/abc-defg-hij'}:{})}}});});
 await page.goto(base+`/manage/${host}/${booking.id}#token`);await expect(page.getByText('Creating your Google Meet link…')).toBeVisible();await page.clock.runFor(10050);await expect(page.getByRole('link',{name:/Join Google Meet/})).toBeVisible();expect(reads).toBe(2);await page.clock.runFor(60000);expect(reads).toBe(2);
});


test('an asynchronous cancellation resumes status polling after the request finishes',async({page})=>{
 await page.clock.install();let cancelling=false,views=0;const booking={id:'booking-cancel-poll-01',status:'confirmed',start,end:start+1800000,name:'Guest',email:'guest@example.com',title:'A conversation',meetingTypeSlug:'intro'};
 await page.route('**/api/**',route=>{if(new URL(route.request().url()).pathname==='/api/bootstrap')return route.fulfill({json:{mode:'live',authenticated:false}});const action=route.request().postDataJSON().action;if(action==='cancel'){cancelling=true;return route.fulfill({json:{booking:{...booking,status:'cancelling'}}});}views++;return route.fulfill({json:{booking:{...booking,status:cancelling?'cancelled':'confirmed'}}});});
 await page.goto(base+`/manage/${host}/${booking.id}#token`);await page.getByRole('button',{name:'Cancel booking',exact:true}).click();await page.getByRole('button',{name:'Yes, cancel',exact:true}).click();await expect(page.getByText('Cancelling your booking…')).toBeVisible();await page.clock.runFor(10050);await expect(page.getByRole('heading',{name:'Booking cancelled'})).toBeVisible();expect(views).toBe(2);
});
