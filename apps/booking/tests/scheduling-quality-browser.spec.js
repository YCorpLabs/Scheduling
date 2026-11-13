import {test,expect} from '@playwright/test';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DEFAULT} from '../public/policy.js';

const base=process.env.BOOKING_TEST_ORIGIN||'http://127.0.0.1:8791';
const shots=process.env.BOOKING_SHOTS||tmpdir();
const host='h_'+'Q'.repeat(24);
const settings={revision:'A'.repeat(43),hostId:host,profile:{id:host,name:'Riley',email:'host@example.com'},accounts:[{id:'google1',connected:true,email:'host@example.com',destinationCalendarId:'primary',conflictCalendarIds:['primary']}],meetingTypes:[{...DEFAULT,id:'intro',slug:'intro',title:'A conversation',host:'Riley',published:true,accountId:'google1',calendarId:'primary'}]};
const now=Date.now();
const critical={schemaVersion:1,generatedAt:now,healthy:false,
  issues:[{code:'delivery_review',severity:'critical',count:1,message:'Emails are parked because their delivery outcome could not be confirmed.',action:'Reconcile each parked email with provider activity before resolving it. Never resend under a new key.'},{code:'pending_stale',severity:'warning',count:1,message:'Bookings have waited longer than expected for calendar confirmation.',action:'Check calendar authorization, then run repair.'}],
  bookings:{awaitingApproval:2,pending:{count:1,oldestAgeMs:25*60000,stale:1},cancelling:{count:0,oldestAgeMs:null},failedLast7Days:{count:0}},
  calendarSync:{tracked:4,pending:0,overdue:0},accounts:{connected:1,disconnected:0,coolingDown:0},
  deliveries:{queued:3,scanned:3,truncated:false,byStatus:{},review:{count:1,oldestAgeMs:3*3600000,truncated:false,items:[{jobId:'booking-parked-01:2:confirmed',bookingId:'booking-parked-01',kind:'confirmed',recipientRole:'guest',reason:'timeout',provider:'cloudflare',attempts:1,firstAttemptAt:now-3*3600000,updatedAt:now-3*3600000+5,bookingStatus:'confirmed',releasable:false,resolvable:true}]}},
  outbound:{frozen:false,epoch:3,reason:null,changedAt:now-86400000,inFlight:{calendar:0,deliveries:0},lastRestoreDetected:null},
  maintenance:{nextAlarmAt:now+60000,lastAlarm:{state:'completed',startedAt:now-120000,finishedAt:now-110000},lastWatchdogAt:now-240000,lastRepairAt:null},
  storage:{bookmark:null},attention:[{bookingId:'booking-pending-01',status:'pending',code:'pending_stale'}],attentionTruncated:false};
const healthy={...critical,healthy:true,issues:[],bookings:{...critical.bookings,awaitingApproval:0,pending:{count:0,oldestAgeMs:null}},deliveries:{...critical.deliveries,queued:0,review:{count:0,items:[],truncated:false}},attention:[]};
const detail={id:'booking-parked-01',title:'A conversation',name:'Maya Chen',email:'maya@example.com',status:'confirmed',start:now+86400000,end:now+88200000,timeZone:'Europe/London',meetingTypeSlug:'intro'};

async function studio(page,{status=critical,resolve=()=>({json:{ok:true}}),theme='light',repair}={}){
  const calls=[];let current=status;
  await page.addInitScript(t=>{try{localStorage.setItem('scheduling-theme',t);}catch{}},theme);
  await page.route('**/api/**',async route=>{
    const req=route.request(),path=new URL(req.url()).pathname;
    if(req.method()==='POST')calls.push({path,body:req.postDataJSON()});
    if(path==='/api/bootstrap')return route.fulfill({json:{mode:'live',authenticated:true,hostId:host,email:'host@example.com'}});
    if(path==='/api/live/operations')return route.fulfill(typeof current==='function'?current():{json:current});
    if(path==='/api/live/operations/deliveries/resolve'){const r=resolve(req.postDataJSON());if(r.next)current=r.next;return route.fulfill({status:r.status||200,json:r.json});}
    if(path==='/api/live/repair'){const r=repair?.()||{json:{ok:true}};if(r.next)current=r.next;return route.fulfill({status:r.status||200,json:r.json});}
    if(path==='/api/live/calendars')return route.fulfill({json:{accounts:[]}});
    if(path.startsWith('/api/live/bookings/'))return route.fulfill({json:{booking:detail}});
    return route.fulfill({json:settings});
  });
  await page.goto(base+'/studio#status');
  await expect(page.getByRole('heading',{name:'Troubleshooting',exact:true})).toBeVisible();await expect(page.getByRole('navigation',{name:'Scheduling'}).getByRole('button',{name:/Troubleshooting/})).toHaveCount(0);await expect(page.locator('.host-account [data-section=Status]')).toBeHidden();
  return {calls,set:s=>{current=s;}};
}

test.describe('owner status',()=>{
  test('shows issues, counts and parked emails without guest data, and records an outcome by keyboard',async({page})=>{
    const {calls}=await studio(page,{resolve:body=>({json:{ok:true},next:healthy})});
    await expect(page.getByText('2 issues need attention')).toBeVisible();
    await expect(page.locator('#account-trigger .account-issue-count')).toHaveText('2');
    await expect(page.getByRole('list',{name:'Issues'}).getByRole('listitem')).toHaveCount(2);
    await expect(page.locator('.ops-card').filter({hasText:'Requests to approve'})).toContainText('2');
    await expect(page.getByText('To the person who booked · Provider timed out · Cloudflare')).toBeVisible();
    await expect(page.locator('main')).not.toContainText('maya@example.com');
    await page.screenshot({path:join(shots,'scheduling-status-light.png'),fullPage:true});

    const record=page.getByRole('button',{name:'Record outcome'});
    await record.focus();await page.keyboard.press('Enter');
    const dialog=page.getByRole('dialog',{name:'Record email outcome'});
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('radio',{name:/Provider accepted it/})).toBeFocused();
    const submit=dialog.getByRole('button',{name:'Record outcome'});
    await expect(submit).toBeDisabled();
    await page.keyboard.press('Space');
    await expect(submit).toBeDisabled();
    await dialog.getByRole('checkbox',{name:'I checked provider activity for this send.'}).check();
    await expect(submit).toBeEnabled();
    await submit.click();
    await expect(dialog).toHaveCount(0);
    await expect(page.locator('#host-status')).toHaveText('Marked delivered');
    await expect(page.getByText('Nothing needs attention')).toBeVisible();
    const posts=calls.filter(c=>c.path!=='/api/live/settings');
    expect(posts).toEqual([{path:'/api/live/operations/deliveries/resolve',body:{jobId:'booking-parked-01:2:confirmed',outcome:'delivered',expectedUpdatedAt:critical.deliveries.review.items[0].updatedAt}}]);
    await expect(page.getByRole('button',{name:'Run maintenance'})).toHaveCount(0);
  });

  test('a changed parked email is refused and cannot be resubmitted from the stale dialog',async({page})=>{
    const {calls}=await studio(page,{resolve:()=>({status:409,json:{error:'This email changed since it was reviewed. Refresh and review it again.'}})});
    await page.getByRole('button',{name:'Record outcome'}).click();
    const dialog=page.getByRole('dialog',{name:'Record email outcome'});
    await dialog.getByRole('radio',{name:/No provider record/}).check();
    await dialog.getByRole('checkbox').check();
    await dialog.getByRole('button',{name:'Record outcome'}).click();
    await expect(dialog.getByRole('alert')).toHaveText('This email changed since it was reviewed. Refresh and review it again.');
    await expect(dialog.getByRole('button',{name:'Record outcome'})).toBeHidden();
    await expect(dialog.getByRole('radio',{name:/No provider record/})).toBeDisabled();
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    expect(calls.filter(c=>c.path.includes('resolve'))).toHaveLength(1);
  });

  test('maintenance runs only on request, and open booking keeps focus return',async({page})=>{
    const {calls}=await studio(page,{status:{...critical,issues:[critical.issues[1]],deliveries:healthy.deliveries},repair:()=>({json:{ok:true},next:healthy})});
    expect(calls.filter(c=>c.path==='/api/live/repair')).toHaveLength(0);
    const open=page.getByRole('button',{name:'Open booking'});
    await open.click();
    const details=page.getByRole('dialog',{name:'Booking details'});
    await expect(details).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(open).toBeFocused();
    await page.getByRole('button',{name:'Run maintenance'}).click();
    await expect(page.locator('#host-status')).toHaveText('Maintenance finished');
    await expect(page.getByText('Nothing needs attention')).toBeVisible();
    expect(calls.filter(c=>c.path==='/api/live/repair')).toHaveLength(1);
  });

  test('paused hosts are explained, hide maintenance, and fit dark mobile layouts',async({page})=>{
    await studio(page,{theme:'dark',status:{...critical,issues:[{code:'outbound_paused',severity:'warning',count:1,message:'Calendar changes, email sends and guest booking changes are paused for maintenance.',action:'Finish the maintenance or restore procedure.'},critical.issues[1]],outbound:{...critical.outbound,frozen:true,reason:'operator',inFlight:{calendar:0,deliveries:1}}}});
    await expect(page.getByText('Paused for maintenance',{exact:true})).toBeVisible();
    await expect(page.getByText(/Paused by you · since .* · 1 provider call in flight/)).toBeVisible();
    await expect(page.getByRole('button',{name:'Run maintenance'})).toHaveCount(0);
    await expect(page.getByRole('button',{name:/resume|release/i})).toHaveCount(0);
    await page.screenshot({path:join(shots,'scheduling-status-dark.png'),fullPage:true});
    await page.setViewportSize({width:390,height:844});
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBeTruthy();
    await page.screenshot({path:join(shots,'scheduling-status-dark-mobile.png'),fullPage:true});
  });

  test('status errors are reported and retried from Refresh',async({page})=>{
    let fail=true;
    await studio(page,{status:()=>fail?{status:401,json:{error:'Sign in again to continue.'}}:{json:healthy}});
    await expect(page.getByRole('alert')).toHaveText('Sign in again to continue.');
    fail=false;await page.getByRole('button',{name:'Refresh'}).click();
    await expect(page.getByText('Nothing needs attention')).toBeVisible();
    await expect(page.getByRole('button',{name:'Refresh'})).toBeFocused();
  });
});

// Guest time zone, focus and status behaviour run against mocked live APIs.
const at=(iso)=>Date.parse(iso);
function guestRoutes(page,{slots,book,view}){
  const posts=[];
  return page.route('**/api/**',route=>{
    const req=route.request(),path=new URL(req.url()).pathname;
    if(req.method()==='POST')posts.push({path,body:req.postDataJSON()});
    if(path==='/api/bootstrap')return route.fulfill({json:{mode:'live',authenticated:false}});
    if(path.endsWith('/availability'))return route.fulfill({json:{mode:'live',config:{...settings.meetingTypes[0],question:'',questions:[],locationType:'google_meet'},slots}});
    if(path.endsWith('/visit'))return route.fulfill({json:{ok:true}});
    if(path.endsWith('/book'))return route.fulfill({json:book});
    if(path.startsWith('/api/manage/'))return view(route);
    return route.fulfill({json:{}});
  }).then(()=>posts);
}

test.describe('guest time zones',()=>{
  test.use({timezoneId:'America/New_York'});
  test('slot offsets distinguish a half-hour clock change within one UTC hour',async({page})=>{
    const slots=['2027-04-03T16:15:00Z','2027-04-03T16:45:00Z'].map(iso=>({start:at(iso),end:at(iso)+900000}));
    await guestRoutes(page,{slots,book:{},view:r=>r.fulfill({json:{}})});
    await page.goto(base+`/b/${host}/intro`);
    await page.locator('#timezone').selectOption('Australia/Adelaide');
    await page.locator('[data-slot]').first().click();
    await expect(page.locator('.slot-summary small')).toContainText('GMT+10:30');
    await page.getByRole('button',{name:'← Choose another time'}).click();
    await page.locator('[data-slot]').nth(1).click();
    await expect(page.locator('.slot-summary small')).toContainText('GMT+9:30');
  });
  test('labels offsets and flags clock changes for the chosen day',async({page})=>{
    // US clocks move forward at 02:00 on 14 March 2027.
    const slots=[at('2027-03-14T05:00:00Z'),at('2027-03-14T08:00:00Z'),at('2027-03-15T13:00:00Z')].map(start=>({start,end:start+1800000}));
    await guestRoutes(page,{slots,book:{},view:r=>r.fulfill({json:{}})});
    await page.goto(base+`/b/${host}/intro`);
    await expect(page.locator('#timezone option:checked')).toHaveText('America/New York (GMT-5)');
    await expect(page.getByRole('note')).toHaveText('Clocks change on this day. Times after the change are GMT-4.');
    await expect(page.locator('[data-slot]')).toHaveText(['0:00','4:00']);
    await page.getByRole('button',{name:/^Monday,? 15 March$/}).click();
    await expect(page.getByRole('note')).toHaveText('Times on this day are GMT-4, after the clock change.');
    await expect(page.locator('#timezone option:checked')).toHaveText('America/New York (GMT-4)');
    await page.locator('#timezone').selectOption('Europe/London');
    await expect(page.locator('#timezone option:checked')).toHaveText('Europe/London (GMT)');
    await expect(page.getByRole('note')).toHaveCount(0);
  });
});

test.describe('guest details',()=>{
  test('back and Escape keep input and return focus to the chosen time',async({page})=>{
    const start=now-(now%86400000)+2*86400000+12*3600000;const slots=[0,1,2].map(i=>({start:start+i*3600000,end:start+i*3600000+1800000}));
    await guestRoutes(page,{slots,book:{},view:r=>r.fulfill({json:{}})});
    await page.goto(base+`/b/${host}/intro`);
    const second=page.locator('[data-slot]').nth(1);const label=await second.textContent();
    await second.focus();await page.keyboard.press('Enter');
    await expect(page.getByLabel('Your name',{exact:true})).toBeFocused();
    await page.keyboard.type('Ana Ribeiro');
    await page.getByLabel('Email address',{exact:true}).fill('ana@example.com');
    await page.getByRole('button',{name:'← Choose another time'}).click();
    const chosen=page.locator('.slot.chosen');
    await expect(chosen).toHaveText(label);await expect(chosen).toBeFocused();await expect(chosen).toHaveAttribute('aria-current','true');
    await page.keyboard.press('Enter');
    await expect(page.getByLabel('Your name',{exact:true})).toHaveValue('Ana Ribeiro');
    await expect(page.getByLabel('Email address',{exact:true})).toHaveValue('ana@example.com');
    await page.keyboard.press('Escape');
    await expect(page.locator('.slot.chosen')).toBeFocused();
    await page.setViewportSize({width:360,height:740});
    await page.keyboard.press('Enter');
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBeTruthy();
    await page.screenshot({path:join(shots,'scheduling-guest-details-mobile.png'),fullPage:true});
  });
});

test.describe('guest status after booking',()=>{
  const start=now+3*86400000-(now%3600000),slots=[{start,end:start+1800000}];
  const booking={id:'booking-settle-0001',status:'pending',start,end:start+1800000,name:'Ana Ribeiro',email:'ana@example.com',title:'A conversation',meetingTypeSlug:'intro',timeZone:'Europe/London',conferenceStatus:'pending'};
  async function book(page){
    await page.goto(base+`/b/${host}/intro`);
    await page.locator('[data-slot]').first().click();
    await page.getByLabel('Your name',{exact:true}).fill('Ana Ribeiro');
    await page.getByLabel('Email address',{exact:true}).fill('ana@example.com');
    await page.getByRole('button',{name:/Confirm booking/}).click();
    await expect(page.getByRole('heading',{name:'Confirming your booking'})).toBeVisible();
  }
  test('pending booking and Meet link update in place with the guest capability',async({page})=>{
    const states=[{...booking,status:'confirmed',conferenceStatus:'pending'},{...booking,status:'confirmed',conferenceStatus:'ready',meetingUrl:'https://meet.google.com/abc-defg-hij'}];
    const posts=await guestRoutes(page,{slots,book:{booking,managementToken:'guest-capability'},view:route=>route.fulfill({json:{booking:states.shift()||states.at(-1)||{...booking,status:'confirmed',conferenceStatus:'ready',meetingUrl:'https://meet.google.com/abc-defg-hij'}}})});
    await book(page);
    await page.getByRole('button',{name:'Refresh status'}).click();
    await expect(page.getByRole('heading',{name:'You’re booked'})).toBeVisible();
    await expect(page.getByText('Creating your Google Meet link…')).toBeVisible();
    await expect(page.getByRole('button',{name:'Refresh status'})).toBeFocused();
    await expect(page.getByRole('link',{name:'Join Google Meet ↗'})).toBeVisible({timeout:12000});
    await expect(page.getByRole('link',{name:'Join Google Meet ↗'})).toBeFocused();
    await expect(page.getByRole('button',{name:'Refresh status'})).toHaveCount(0);
    const views=posts.filter(p=>p.path.startsWith('/api/manage/'));
    expect(views.length).toBeGreaterThanOrEqual(2);
    for(const v of views){expect(v.path).toBe(`/api/manage/${host}/${booking.id}`);expect(v.body).toEqual({action:'view',token:'guest-capability'});}
    await page.emulateMedia({colorScheme:'dark'});
    await page.screenshot({path:join(shots,'scheduling-guest-meet-ready.png'),fullPage:true});
  });
  test('a failed status read keeps the pending state honest',async({page})=>{
    await guestRoutes(page,{slots,book:{booking,managementToken:'guest-capability'},view:route=>route.fulfill({status:500,json:{error:'Unavailable'}})});
    await book(page);
    await page.getByRole('button',{name:'Refresh status'}).click();
    await expect(page.getByText('Status could not refresh. Your booking has been kept.')).toBeVisible();
    await expect(page.getByRole('heading',{name:'Confirming your booking'})).toBeVisible();
    await expect(page.getByRole('link',{name:'Join Google Meet ↗'})).toHaveCount(0);
  });
  test('a recovered status read clears the error even while the booking remains pending',async({page})=>{
    let fail=true;
    await guestRoutes(page,{slots,book:{booking,managementToken:'guest-capability'},view:route=>route.fulfill(fail?{status:500,json:{error:'Unavailable'}}:{json:{booking}})});
    await book(page);
    await page.getByRole('button',{name:'Refresh status'}).click();
    await expect(page.getByText('Status could not refresh. Your booking has been kept.')).toBeVisible();
    fail=false;
    await page.getByRole('button',{name:'Refresh status'}).click();
    await expect(page.getByText('Status could not refresh. Your booking has been kept.')).toHaveCount(0);
    await expect(page.getByRole('heading',{name:'Confirming your booking'})).toBeVisible();
  });
});
