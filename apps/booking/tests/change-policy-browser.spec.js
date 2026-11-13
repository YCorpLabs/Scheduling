import {test,expect} from '@playwright/test';
import {DEFAULT} from '../public/policy.js';
// Coordinated run only: uses BOOKING_TEST_ORIGIN or the root-owned 8791 origin. All HTTP is intercepted; no provider is called.
const base=process.env.BOOKING_TEST_ORIGIN||'http://127.0.0.1:8791',hostId='h_abcdefghijklmnopqrstuvwx',id='booking_'+'1'.repeat(20);
const account={id:'a',email:'ada@company.test',connected:true,destinationCalendarId:'ada@company.test',conflictCalendarIds:['ada@company.test']};
const H=3600000,day=Date.UTC(2030,0,7,9),slots=[0,1,2].map(i=>({start:day+i*30*60000,end:day+(i+1)*30*60000}));
test.use({timezoneId:'Europe/Oslo'});
const policy=(start,c,r)=>({cancellationNoticeMinutes:c,rescheduleNoticeMinutes:r,cancelUntil:c?start-c*60000:null,rescheduleUntil:r?start-r*60000:null});
const confirmed=(over={})=>({id,status:'confirmed',title:'Intro',name:'Guest',email:'guest@example.com',start:day,end:day+30*60000,timeZone:'UTC',location:'Studio',meetingTypeSlug:'intro',changePolicy:policy(day,1440,120),...over});

async function fixture(page,{type={},guest=true,view=null,cancel=null,detail=null}={}){
 let settings={hostId,revision:'A'.repeat(43),profile:{name:'Company'},accounts:[account],availabilitySchedules:[],defaultAvailabilityScheduleId:null,meetingTypes:[{...DEFAULT,id:'intro',slug:'intro',title:'Intro',host:'Company',published:true,accountId:'a',calendarId:account.destinationCalendarId,...type}]};
 const writes=[],manage=[],books=[],requests=[];let booking=view;
 await page.route('**/api/**',async route=>{const req=route.request(),url=new URL(req.url()),path=url.pathname;requests.push({path,method:req.method(),body:req.method()==='POST'?req.postDataJSON():null});let data;
  if(path==='/api/bootstrap')data={mode:'live',authenticated:!guest,hostId,email:'owner@company.test',features:{reminders:true}};
  else if(path==='/api/live/workspaces')return route.fulfill({status:404,json:{error:'Unsupported'}});
  else if(path==='/api/live/settings'){if(req.method()==='POST'){const body=req.postDataJSON();writes.push(body.patch);settings={...settings,...body.patch,revision:'B'.repeat(43)};data={settings,revision:settings.revision};}else data=settings;}
  else if(path==='/api/live/calendars')data={accounts:[{id:'a',calendars:[{id:account.destinationCalendarId,summary:'Work',accessRole:'owner'}]}]};
  else if(path==='/api/live/bookings')data={bookings:[detail]};
  else if(path===`/api/live/bookings/${id}`)data={booking:detail,managementToken:'private-capability'};
  else if(path===`/api/live/bookings/${id}/availability`)data={mode:'live',config:settings.meetingTypes[0],slots:slots.map(s=>({start:s.start+86400000,end:s.end+86400000}))};
  else if(path===`/api/live/bookings/${id}/cancel`){detail={...detail,status:'cancelled',...(req.postDataJSON().reason?{cancellationReason:req.postDataJSON().reason}:{})};data={booking:detail};}
  else if(path.endsWith('/availability'))data={mode:'live',config:{...settings.meetingTypes[0]},slots};
  else if(path.endsWith('/visit'))data={ok:true};
  else if(path.endsWith('/book')){const body=req.postDataJSON();books.push(body);const t=settings.meetingTypes[0];data={booking:{id,status:'confirmed',title:'Intro',start:body.start,end:body.start+30*60000,timeZone:'Europe/Oslo',changePolicy:policy(body.start,t.cancellationNoticeMinutes,t.rescheduleNoticeMinutes)},managementToken:'fixture-token'};}
  else if(path.startsWith('/api/manage/')){const body=req.postDataJSON();manage.push(body);
   if(body.action==='view')data={booking};
   else if(body.action==='cancel'){if(cancel){const out=await cancel(body,booking);if(out.status)return route.fulfill(out);}booking={...booking,status:'cancelled',...(body.reason?{cancellationReason:body.reason}:{})};data={booking};}
   else if(body.action==='availability')data={mode:'live',config:settings.meetingTypes[0],slots};
   else return route.fulfill({status:400,json:{error:'Choose a booking action.'}});}
  else return route.fulfill({status:404,json:{error:'Not mocked'}});
  return route.fulfill({json:data});
 });
 return {writes,manage,books,requests,setView:b=>{booking=b;},get settings(){return settings;}};
}

test('host configures both guest change cutoffs, defaults to anytime and preserves custom values',async({page})=>{
 const state=await fixture(page,{guest:false});await page.goto(base+'/studio#link=intro');
 await page.getByRole('tab',{name:'Booking rules',exact:true}).click();
 const cancel=page.getByLabel('Cancel',{exact:true}),move=page.getByLabel('Reschedule',{exact:true});
 await expect(cancel).toHaveValue('0');await expect(move).toHaveValue('0');await expect(cancel.locator('option:checked')).toHaveText('Anytime');
 await cancel.selectOption('1440');await move.selectOption('custom');
 const amount=page.getByLabel('Reschedule cutoff amount');await expect(amount).toBeVisible();await expect(amount).toBeFocused();
 await amount.fill('90');await page.getByLabel('Reschedule cutoff unit').selectOption('1');
 await page.getByRole('button',{name:/Save changes/}).click();await expect(page.locator('#host-status')).toHaveText('Saved');
 expect(state.writes[0].meetingTypes[0]).toMatchObject({cancellationNoticeMinutes:1440,rescheduleNoticeMinutes:90});
 await expect(page.getByLabel('Reschedule',{exact:true}).locator('option:checked')).toHaveText('1 hr 30 min before');
 await page.getByLabel('Reschedule',{exact:true}).selectOption('custom');await page.getByLabel('Reschedule cutoff amount').fill('0');await page.getByRole('button',{name:/Save changes/}).click();expect(state.writes).toHaveLength(1);
 await expect(page.getByText('Enter a reschedule cutoff as a whole number.').first()).toBeVisible();
});

test('a saved custom cutoff stays selected and unchanged when other fields are edited',async({page})=>{
 const state=await fixture(page,{guest:false,type:{cancellationNoticeMinutes:4320,rescheduleNoticeMinutes:0}});await page.goto(base+'/studio#link=intro');
 await page.getByRole('tab',{name:'Booking rules',exact:true}).click();
 await expect(page.getByLabel('Cancel',{exact:true}).locator('option:checked')).toHaveText('3 days before');
 await page.getByRole('tab',{name:'Details',exact:true}).click();await page.getByLabel('Meeting name',{exact:true}).fill('Changed title');
 await page.getByRole('button',{name:/Save changes/}).click();await expect(page.locator('#host-status')).toHaveText('Saved');
 expect(state.writes[0].meetingTypes[0]).toMatchObject({title:'Changed title',cancellationNoticeMinutes:4320,rescheduleNoticeMinutes:0});
});

test('guest sees a concise local deadline before confirming and on the receipt; zero adds no text',async({page})=>{
 const state=await fixture(page,{type:{cancellationNoticeMinutes:1440,rescheduleNoticeMinutes:1440}});await page.goto(base+'/b/'+hostId+'/intro');
 await page.locator('.slot').first().click();
 await expect(page.locator('.guest-form .change-note')).toHaveText('Cancel or reschedule by Sun 6 Jan, 10:00 GMT+1.');
 await page.getByLabel('Your name').fill('Ada');await page.getByLabel('Email address').fill('ada@example.com');await page.getByRole('button',{name:/Confirm booking/}).click();
 await expect(page.getByRole('heading',{name:'You’re booked'})).toBeVisible();await expect(page.locator('.success .change-note')).toHaveText('Cancel or reschedule by Sun 6 Jan, 10:00 GMT+1.');
 expect(state.books[0]).toMatchObject({duration:30});expect(state.books[0].cancellationNoticeMinutes).toBeUndefined();
});

test('zero cutoffs keep the legacy guest page free of policy text',async({page})=>{
 await fixture(page);await page.goto(base+'/b/'+hostId+'/intro');await page.locator('.slot').first().click();
 await expect(page.locator('.change-note')).toHaveCount(0);await expect(page.locator('.guest-form')).not.toContainText(/cancel|reschedule/i);
});

test('manage: optional reason survives keep, is sent trimmed and read back escaped',async({page})=>{
 const state=await fixture(page,{view:confirmed()});await page.goto(base+`/manage/${hostId}/${id}#cap`);
 await expect(page.locator('.manage-change-note')).toHaveText('Cancel by Sun 6 Jan, 09:00 GMT. Reschedule by Mon 7 Jan, 07:00 GMT.');
 await expect(page.getByRole('link',{name:'Change time'})).toBeVisible();
 await page.getByRole('button',{name:'Cancel booking'}).click();const reason=page.getByLabel(/Reason/);await expect(reason).toBeFocused();
 await reason.fill('  <b>Travel</b>  ');await page.getByRole('button',{name:'Keep booking'}).click();expect(state.manage.filter(b=>b.action==='cancel')).toHaveLength(0);
 await page.getByRole('button',{name:'Cancel booking'}).click();await expect(page.getByLabel(/Reason/)).toHaveValue('  <b>Travel</b>  ');
 await page.getByRole('button',{name:'Yes, cancel'}).click();await expect(page.getByRole('heading',{name:'Booking cancelled'})).toBeVisible();
 expect(state.manage.find(b=>b.action==='cancel')).toEqual({action:'cancel',token:'cap',reason:'<b>Travel</b>'});
 await expect(page.locator('[data-cancel-reason-readback]')).toHaveText('Reason: <b>Travel</b>');await expect(page.locator('.success b')).toHaveCount(0);
});

test('manage: an empty reason is omitted from the cancel request',async({page})=>{
 const state=await fixture(page,{view:confirmed({changePolicy:policy(day,0,0)})});await page.goto(base+`/manage/${hostId}/${id}#cap`);
 await expect(page.locator('.change-note')).toHaveCount(0);
 await page.getByRole('button',{name:'Cancel booking'}).click();await page.getByLabel(/Reason/).fill('   ');await page.getByRole('button',{name:'Yes, cancel'}).click();
 await expect(page.getByRole('heading',{name:'Booking cancelled'})).toBeVisible();expect(state.manage.find(b=>b.action==='cancel')).toEqual({action:'cancel',token:'cap'});
});

test('manage after both cutoffs: honest closed copy and no change controls',async({page})=>{
 const now=Date.now(),start=now+2*H;const state=await fixture(page,{view:confirmed({start,end:start+30*60000,changePolicy:policy(start,1440,180)})});
 await page.goto(base+`/manage/${hostId}/${id}#cap`);
 await expect(page.locator('[data-change-closed]')).toContainText(/^Online changes closed .+\. Reply to your invitation to reach the organizer\.$/);
 await expect(page.getByRole('button',{name:'Cancel booking'})).toHaveCount(0);await expect(page.getByRole('link',{name:'Change time'})).toHaveCount(0);
 expect(state.manage.map(b=>b.action)).toEqual(['view']);
});

test('manage: a pending approval request can still be withdrawn after cutoffs',async({page})=>{
 const start=Date.now()+2*H;const state=await fixture(page,{view:confirmed({status:'awaiting_approval',start,end:start+30*60000,changePolicy:policy(start,1440,1440)})});
 await page.goto(base+`/manage/${hostId}/${id}#cap`);await expect(page.locator('[data-change-closed]')).toHaveCount(0);
 await page.getByRole('button',{name:'Withdraw request'}).click();await page.getByRole('button',{name:'Yes, withdraw'}).click();
 await expect(page.getByRole('heading',{name:'Booking cancelled'})).toBeVisible();expect(state.manage.filter(b=>b.action==='cancel')).toHaveLength(1);
});

test('stale open manage page: a late 409 keeps the typed reason and shows the closed state',async({page})=>{
 const start=Date.now()+30*H,open=confirmed({start,end:start+30*60000,changePolicy:policy(start,1440,0)});
 let state;state=await fixture(page,{view:open,cancel:async()=>{state.setView({...open,changePolicy:{...open.changePolicy,cancelUntil:Date.now()-1000}});return {status:409,json:{error:'The time window for this booking change has closed. Contact the organizer.',code:'change_window_closed'}};}});
 await page.goto(base+`/manage/${hostId}/${id}#cap`);await page.getByRole('button',{name:'Cancel booking'}).click();
 const reason=page.getByLabel(/Reason/);await reason.fill('Flight moved');await reason.evaluate(el=>{el.dataset.same='1';el.setSelectionRange(0,6);});await page.getByRole('button',{name:'Yes, cancel'}).click();
 await expect(page.getByText('Not cancelled.')).toBeVisible();await expect(reason).toHaveValue('Flight moved');await expect(reason).toBeFocused();
 expect(await reason.evaluate(el=>[el.dataset.same,el.selectionStart,el.selectionEnd,el.readOnly])).toEqual(['1',0,6,false]);
 await expect(page.getByRole('button',{name:'Yes, cancel'})).toHaveCount(0);await expect(page.locator('[data-change-closed]')).toHaveText(/^Online cancellation closed .+\. Reply to your invitation to reach the organizer\.$/);
 await page.getByRole('button',{name:'Done'}).click();await expect(page.getByRole('button',{name:'Cancel booking'})).toHaveCount(0);await expect(page.getByRole('link',{name:'Change time'})).toBeVisible();
});

test('guest reschedule page after the reschedule cutoff is closed without requesting times',async({page})=>{
 const start=Date.now()+H;const state=await fixture(page,{view:confirmed({start,end:start+30*60000,changePolicy:policy(start,0,120)})});
 await page.goto(base+`/b/${hostId}/intro?reschedule=${id}#cap`);
 await expect(page.getByRole('heading',{name:'Online rescheduling closed'})).toBeVisible();await expect(page.getByRole('link',{name:'Back to booking'})).toBeFocused();
 expect(state.manage.map(b=>b.action)).toEqual(['view']);
});

test('guest reschedule shows the accepted snapshot deadline for the new time',async({page})=>{
 const state=await fixture(page,{type:{cancellationNoticeMinutes:0,rescheduleNoticeMinutes:0},view:confirmed({start:day+7*86400000,end:day+7*86400000+30*60000,changePolicy:policy(day+7*86400000,60,0)})});
 await page.goto(base+`/b/${hostId}/intro?reschedule=${id}#cap`);await page.locator('.slot').first().click();
 await expect(page.locator('.guest-form .change-note')).toHaveText('Cancel by Mon 7 Jan, 08:00 GMT.');
 expect(state.manage.map(b=>b.action)).toEqual(['view','availability']);
});

test('staff actions ignore guest cutoffs and use only private owner routes',async({page})=>{
 const start=Date.now()+H,b=confirmed({start,end:start+30*60000,changePolicy:policy(start,1440,1440),meetingTypeSlug:'intro'});
 const state=await fixture(page,{guest:false,detail:b});await page.goto(base+'/studio#link=intro');
 await page.getByRole('button',{name:'Bookings',exact:true}).click();await page.locator('[data-manage]').click();const dialog=page.getByRole('dialog',{name:'Booking details'});
 await expect(dialog.getByRole('link',{name:'Reschedule'})).toHaveCount(0);await expect(dialog.getByRole('button',{name:'Reschedule',exact:true})).toBeEnabled();
 await dialog.getByRole('button',{name:'Reschedule',exact:true}).click();const move=page.getByRole('dialog',{name:'Reschedule booking'});await expect(move.getByRole('button',{name:'Change time'})).toBeEnabled();await move.getByRole('button',{name:'Cancel',exact:true}).click();
 await dialog.getByRole('button',{name:'Cancel booking',exact:true}).click();await dialog.getByLabel(/Reason/).fill(' Host unavailable ');await dialog.getByRole('button',{name:'Cancel booking',exact:true}).click();
 await expect(dialog.getByText('Cancelled',{exact:true})).toBeVisible();await expect(dialog.locator('dd.cancel-reason')).toHaveText('Host unavailable');
 const cancel=state.requests.find(r=>r.path.endsWith('/cancel'));expect(cancel.path).toBe(`/api/live/bookings/${id}/cancel`);expect(cancel.body).toEqual({reason:'Host unavailable'});
 expect(state.requests.some(r=>r.path.startsWith('/api/manage/'))).toBe(false);expect(JSON.stringify(state.requests.map(r=>r.body))).not.toMatch(/bypass|force|private-capability/);
});

test('phone width, reduced motion and keyboard keep the manage page usable',async({page,browserName})=>{
 await page.setViewportSize({width:360,height:780});await page.emulateMedia({reducedMotion:'reduce'});
 await fixture(page,{view:confirmed()});await page.goto(base+`/manage/${hostId}/${id}#cap`);
 await page.getByRole('button',{name:'Cancel booking'}).focus();await page.keyboard.press('Enter');await expect(page.getByLabel(/Reason/)).toBeFocused();
 await page.keyboard.type('Late');await page.keyboard.press(browserName==='webkit'?'Alt+Tab':'Tab');await expect(page.getByRole('button',{name:'Yes, cancel'})).toBeFocused();
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 await page.screenshot({path:'test-results/change-policy-manage-phone.png',fullPage:true});
});

test('host change rules stack at phone width without horizontal scroll',async({page})=>{
 await page.setViewportSize({width:360,height:780});await fixture(page,{guest:false});await page.goto(base+'/studio#link=intro');
 await page.getByRole('tab',{name:'Booking rules',exact:true}).click();await page.getByLabel('Cancel',{exact:true}).selectOption('custom');
 const [a,b]=await Promise.all(['Cancel','Reschedule'].map(n=>page.getByLabel(n,{exact:true}).boundingBox()));expect(b.y).toBeGreaterThan(a.y);
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 await page.screenshot({path:'test-results/change-policy-host-phone.png',fullPage:true});
});

test('owner preview computes the deadline locally from public notice minutes with zero API calls',async({page})=>{
 const requests=[];await page.route('**/api/**',route=>{requests.push(route.request().url());return route.fulfill({status:500,json:{error:'Preview must not call APIs'}});});
 await page.route('**/__change-policy-test',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><html><head><link rel="stylesheet" href="/tokens.css"><link rel="stylesheet" href="/style.css"><link rel="stylesheet" href="/share-ui.css"><link rel="stylesheet" href="/change-policy-ui.css"></head><body><button id="trigger">Share</button><script type="module">import {showShare} from "/share-ui.js";window.open1=()=>showShare({trigger:document.querySelector("#trigger"),title:"Draft",initialView:"preview",dirty:true,loadPreview:async()=>{const start=Date.UTC(2030,0,7,9);return {config:{host:"Ada",title:"Draft",duration:30,zone:"UTC",location:"Studio",locationType:"custom",theme:"light",accent:"graphite",motion:"smooth",questions:[],extraGuestsLimit:0,cancellationNoticeMinutes:120,rescheduleNoticeMinutes:120,cancelUntil:1,cancellationReason:"private",accountId:"private-account"},slots:[{start,end:start+1800000}]};}});</script></body></html>'}));
 await page.goto(base+'/__change-policy-test');await page.waitForFunction(()=>!!window.open1);await page.evaluate(()=>window.open1());
 const frame=page.frameLocator('iframe');await frame.locator('.slot').first().click();
 await expect(frame.locator('.guest-form .change-note')).toHaveText(/^Cancel or reschedule by Mon 7 Jan, \d{2}:00 GMT(\+1)?\.$/);
 await expect(frame.locator('body')).not.toContainText('private');expect(requests).toEqual([]);
});

test('a cutoff passing during confirmation patches controls in place and never blankets an open reschedule',async({page})=>{
 const now=Date.UTC(2029,11,1,8),start=now+1440*60000+2*60000;await page.clock.install({time:now});
 const state=await fixture(page,{view:confirmed({start,end:start+30*60000,timeZone:'UTC',changePolicy:policy(start,1440,60)})});
 await page.goto(base+`/manage/${hostId}/${id}#cap`);
 await expect(page.locator('.manage-change-note')).toHaveText('Cancel by Sat 1 Dec, 08:02 GMT. Reschedule by Sun 2 Dec, 07:02 GMT.');
 await page.getByRole('button',{name:'Cancel booking'}).click();const reason=page.getByLabel(/Reason/);await reason.type('Half typed');await reason.evaluate(el=>{el.dataset.same='1';el.setSelectionRange(4,4);});
 await page.clock.fastForward('03:00');
 await expect(page.getByText('Not cancelled.')).toBeVisible();await expect(page.getByRole('button',{name:'Yes, cancel'})).toHaveCount(0);
 expect(await reason.evaluate(el=>[el.dataset.same,el.value,el.selectionStart,document.activeElement===el])).toEqual(['1','Half typed',4,true]);
 await expect(page.locator('[data-change-closed]')).toHaveText('Online cancellation closed Sat 1 Dec, 08:02 GMT. Reply to your invitation to reach the organizer.');
 await expect(page.locator('.manage-change-note')).toHaveText('Reschedule by Sun 2 Dec, 07:02 GMT.');await expect(page.locator('body')).not.toContainText('can’t be changed online');
 await page.getByRole('button',{name:'Done'}).click();await expect(page.getByRole('link',{name:'Change time'})).toBeVisible();await expect(page.getByRole('button',{name:'Cancel booking'})).toHaveCount(0);
 expect(state.manage.filter(b=>b.action==='cancel')).toHaveLength(0);
});

test('an already in-flight status poll cannot replace an open reason confirmation',async({page})=>{
 const now=Date.UTC(2029,11,1,8);await page.clock.install({time:now});const pending=confirmed({status:'awaiting_approval',changePolicy:policy(day,0,0)});await fixture(page,{view:pending});let views=0,release,entered=false;await page.route('**/api/manage/**',async route=>{if(route.request().postDataJSON().action!=='view')return route.fulfill({status:400,json:{error:'Unexpected action'}});views++;if(views===2){entered=true;await new Promise(resolve=>release=resolve);}return route.fulfill({json:{booking:pending}});});
 await page.goto(base+`/manage/${hostId}/${id}#cap`);await expect(page.getByRole('button',{name:'Withdraw request'})).toBeVisible();await page.clock.fastForward(10000);await expect.poll(()=>entered).toBe(true);await page.getByRole('button',{name:'Withdraw request'}).click();const reason=page.getByLabel(/Reason/);await reason.fill('Typed during poll');await reason.evaluate(el=>{el.dataset.retained='yes';el.setSelectionRange(3,8);el.focus();});const response=page.waitForResponse(r=>r.url().includes('/api/manage/'));release();await response;await page.clock.runFor(50);expect(await reason.evaluate(el=>[el.dataset.retained,el.value,el.selectionStart,el.selectionEnd,document.activeElement===el])).toEqual(['yes','Typed during poll',3,8,true]);
});

test('failed cancellation crossing its cutoff preserves reason, resumes timers and verifies uncertain outcome explicitly',async({page})=>{
 const now=Date.UTC(2029,11,1,8),start=now+2*H+1000;await page.clock.install({time:now});const original=confirmed({start,end:start+30*60000,changePolicy:policy(start,120,60)});let release,entered=false;const state=await fixture(page,{view:original,cancel:async()=>{entered=true;await new Promise(resolve=>release=resolve);return {status:503,json:{error:'Cancellation response unavailable'}};}});
 await page.goto(base+`/manage/${hostId}/${id}#cap`);await page.getByRole('button',{name:'Cancel booking'}).click();const reason=page.getByLabel(/Reason/);await reason.fill('Kept reason');await reason.evaluate(el=>{el.dataset.retained='yes';el.setSelectionRange(2,6);});await page.getByRole('button',{name:'Yes, cancel'}).click();await expect.poll(()=>entered).toBe(true);await reason.focus();await page.clock.fastForward(2000);release();await expect(page.getByText('Cancellation not confirmed.',{exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'Yes, cancel'})).toHaveCount(0);expect(await reason.evaluate(el=>[el.dataset.retained,el.value,el.selectionStart,el.selectionEnd,document.activeElement===el])).toEqual(['yes','Kept reason',2,6,true]);await expect(page.locator('[data-change-closed]')).toContainText('Online cancellation closed');await page.clock.fastForward(H);await expect(page.locator('[data-change-closed]')).toContainText('Online changes closed');expect(await reason.evaluate(el=>el.dataset.retained)).toBe('yes');state.setView({...original,status:'cancelled',cancellationReason:'Kept reason'});await page.getByRole('button',{name:'Check booking',exact:true}).click();await expect(page.getByRole('heading',{name:'Booking cancelled'})).toBeVisible();await expect(page.locator('[data-cancel-reason-readback]')).toHaveText('Reason: Kept reason');expect(state.manage.filter(b=>b.action==='cancel')).toHaveLength(1);
});


test('pending provider confirmation can be withdrawn after the guest cutoff',async({page})=>{
 await page.clock.install({time:day-H});const state=await fixture(page,{view:confirmed({status:'pending'})});
 await page.goto(base+`/manage/${hostId}/${id}#cap`);await page.getByRole('button',{name:'Withdraw request'}).click();
 await page.getByRole('button',{name:'Yes, withdraw'}).click();await expect(page.getByRole('heading',{name:'Booking cancelled'})).toBeVisible();
 expect(state.manage.filter(b=>b.action==='cancel')).toHaveLength(1);
});

test('a late refusal reconciles another actor cancellation without losing the unsent reason',async({page})=>{
 let state;state=await fixture(page,{view:confirmed(),cancel:async()=>{state.setView(confirmed({status:'cancelled'}));return {status:409,json:{error:'Closed',code:'change_window_closed'}};}});
 await page.goto(base+`/manage/${hostId}/${id}#cap`);await page.getByRole('button',{name:'Cancel booking'}).click();
 const reason=page.getByLabel(/Reason/);await reason.fill('Unsent note');const field=await reason.elementHandle();
 await page.getByRole('button',{name:'Yes, cancel'}).click();await expect(page.getByRole('heading',{name:'Booking cancelled'})).toBeVisible();
 await expect(page.locator('#cancel-form strong')).toHaveText('Booking cancelled.');await expect(reason).toHaveValue('Unsent note');
 expect(await field.evaluate(el=>el===document.querySelector('#cancel-reason'))).toBeTruthy();await expect(page.getByRole('button',{name:'Done',exact:true})).toBeVisible();
});
