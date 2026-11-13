import {test,expect} from '@playwright/test';
import {DEFAULT} from '../public/policy.js';
// Coordinated run only: uses BOOKING_TEST_ORIGIN or the root-owned 8791 origin. All HTTP is intercepted; no provider is called.
const base=process.env.BOOKING_TEST_ORIGIN||'http://127.0.0.1:8791',hostId='h_abcdefghijklmnopqrstuvwx',id='booking_'+'1'.repeat(20);
const account={id:'a',email:'ada@company.test',connected:true,destinationCalendarId:'ada@company.test',conflictCalendarIds:['ada@company.test']};
const day=Date.UTC(2030,0,7,9),slots=[0,1,2].map(i=>({start:day+i*30*60000,end:day+(i+1)*30*60000}));
const past=Date.UTC(2026,0,1,12),future=Date.UTC(2030,11,4,8,0)+30500;// future is 4 Dec 2030 09:00:30.500 Oslo (non-minute)
const closed=code=>({status:410,json:{error:code==='link_used'?'This booking link has been used.':'This booking link has expired.',code}});
test.use({timezoneId:'Europe/Oslo'});

async function fixture(page,{types=[{}],linkAccess={},guest=true,availability=null,book=null,view=null,omitAccessOnSave=false}={}){
 let settings={hostId,revision:'A'.repeat(43),profile:{name:'Company'},accounts:[account],availabilitySchedules:[],defaultAvailabilityScheduleId:null,linkAccess,
  meetingTypes:types.map((over,i)=>({...DEFAULT,id:i?'link'+i:'intro',slug:i?'link'+i:'intro',title:i?'Link '+i:'Intro',host:'Ada',published:true,accountId:'a',calendarId:account.destinationCalendarId,...over}))};
 const writes=[],books=[],manage=[],requests=[];
 await page.route('**/api/**',async route=>{const req=route.request(),url=new URL(req.url()),path=url.pathname,body=req.method()==='POST'?req.postDataJSON():null;requests.push({path,body});let data;
  if(path==='/api/bootstrap')data={mode:'live',authenticated:!guest,hostId,email:'owner@company.test',features:{reminders:true}};
  else if(path==='/api/live/workspaces')return route.fulfill({status:404,json:{error:'Unsupported'}});
  else if(path==='/api/live/settings'){if(req.method()==='POST'){writes.push(body.patch);settings={...settings,...body.patch,revision:'B'.repeat(43)};const {linkAccess:_readOnly,...saved}=settings;data={settings:omitAccessOnSave?saved:settings,revision:settings.revision};}else data=settings;}
  else if(path==='/api/live/calendars')data={accounts:[{id:'a',calendars:[{id:account.destinationCalendarId,summary:'Work',accessRole:'owner'}]}]};
  else if(path.startsWith('/api/manage/')){manage.push(body);
   if(body.action==='view')data={booking:view};
   else if(body.action==='availability')data={mode:'live',config:settings.meetingTypes[0],slots:slots.map(s=>({start:s.start+86400000,end:s.end+86400000}))};
   else if(body.action==='reschedule')data={booking:{...view,start:body.start,end:body.start+30*60000}};
   else return route.fulfill({status:400,json:{error:'Choose a booking action.'}});}
  else if(path.endsWith('/availability')){if(availability){const out=await availability();if(out)return route.fulfill(out);}data={mode:'live',config:{...settings.meetingTypes[0]},slots};}
  else if(path.endsWith('/visit'))data={ok:true};
  else if(path.endsWith('/book')){books.push(body);if(book){const out=await book(body,books.length);if(out)return route.fulfill(out);}data={booking:{id,status:'confirmed',title:'Intro',start:body.start,end:body.start+30*60000,timeZone:'Europe/Oslo'},managementToken:'fixture-token'};}
  else return route.fulfill({status:404,json:{error:'Not mocked'}});
  return route.fulfill({json:data});
 });
 return {writes,books,manage,requests,get settings(){return settings;}};
}
const rules=async page=>{await page.goto(base+'/studio#link=intro');await page.getByRole('tab',{name:'Booking rules',exact:true}).click();return page.locator('[data-link-access]');};
const save=async page=>{await page.getByRole('button',{name:/Save changes/}).click();await expect(page.locator('#host-status')).toHaveText('Saved');};

test('Link access is one collapsed disclosure; configuring single use and an expiry saves exact values',async({page})=>{
 const state=await fixture(page,{guest:false});const fold=await rules(page);
 await expect(fold).not.toHaveAttribute('open','');await expect(fold.locator('summary')).toHaveText(/Link access\s*Open/);
 await fold.locator('summary').click();
 await expect(page.getByLabel('Expiry date and time')).toBeHidden();await expect(fold.locator('[data-link-access-note]')).toBeHidden();
 await page.getByLabel('One booking only').check();await expect(fold.getByText('Closes after the first booking request.')).toBeVisible();
 await page.getByLabel('Expires',{exact:true}).selectOption('date');const at=page.getByLabel('Expiry date and time');await expect(at).toBeFocused();
 await expect(fold.getByText('Europe/Oslo · GMT+1')).toBeVisible();
 await at.fill('2030-12-04T09:00');await expect(fold.locator('summary small')).toHaveText('One booking · Until 4 Dec 2030, 09:00');
 await save(page);
 expect(state.writes[0].meetingTypes[0]).toMatchObject({singleUse:true,expiresAt:Date.UTC(2030,11,4,8,0),published:true});
 await page.getByRole('tab',{name:'Booking rules',exact:true}).click();await expect(page.locator('[data-link-access]')).toHaveAttribute('open','');
 await expect(page.getByLabel('Expiry date and time')).toHaveValue('2030-12-04T09:00');
});

test('a past or empty expiry is rejected inside the fold without saving',async({page})=>{
 const state=await fixture(page,{guest:false});const fold=await rules(page);await fold.locator('summary').click();
 await page.getByLabel('Expires',{exact:true}).selectOption('date');await page.getByRole('button',{name:/Save changes/}).click();
 await expect(fold.getByRole('alert')).toHaveText('Choose when this link expires.');
 await page.getByLabel('Expiry date and time').fill('2020-01-01T09:00');await page.getByRole('button',{name:/Save changes/}).click();
 await expect(fold.getByRole('alert')).toHaveText('Choose a future expiry time.');expect(state.writes).toHaveLength(0);
});

test('saved non-minute expiry and single use roundtrip unchanged through an unrelated edit',async({page})=>{
 const state=await fixture(page,{guest:false,types:[{expiresAt:future,singleUse:true}]});const fold=await rules(page);
 await expect(fold).toHaveAttribute('open','');await expect(page.getByLabel('Expiry date and time')).toHaveValue('2030-12-04T09:00');
 await expect(page.getByLabel('One booking only')).toBeChecked();
 await page.getByRole('tab',{name:'Details',exact:true}).click();await page.getByLabel('Meeting name',{exact:true}).fill('Renamed');await save(page);
 expect(state.writes[0].meetingTypes[0]).toMatchObject({title:'Renamed',expiresAt:future,singleUse:true});
 // Switching to Never clears only the expiry.
 await page.getByRole('tab',{name:'Booking rules',exact:true}).click();await page.getByLabel('Expires',{exact:true}).selectOption('never');await save(page);
 expect(state.writes[1].meetingTypes[0]).toMatchObject({expiresAt:null,singleUse:true});
});

test('owner list and editor show Expired/Used, keep the manual switch and re-enabling single use stays used',async({page})=>{
 const state=await fixture(page,{guest:false,omitAccessOnSave:true,types:[{singleUse:true},{expiresAt:past},{singleUse:false},{published:false,expiresAt:past}],linkAccess:{intro:{state:'used',used:true,expiresAt:null},link1:{state:'expired',used:false,expiresAt:past},link2:{state:'open',used:true,expiresAt:null}}});
 await page.goto(base+'/studio');
 const row=name=>page.locator('.booking-link-row',{has:page.getByRole('button',{name:`Edit ${name}`,exact:true})}).locator('[data-link-state]');
 await expect(row('Intro')).toHaveText('Used');await expect(row('Link 1')).toHaveText('Expired');await expect(row('Link 2')).toHaveText('Active');await expect(row('Link 3')).toHaveText('Paused');
 await page.getByRole('button',{name:'Edit Intro',exact:true}).click();
 await expect(page.locator('[data-publish-label]')).toHaveText('Used');await expect(page.getByRole('checkbox',{name:'Accept bookings'})).toBeChecked();
 await page.getByRole('tab',{name:'Booking rules',exact:true}).click();await expect(page.locator('[data-link-access] summary small')).toHaveText('Used');
 await expect(page.getByText('Already used. Closed to new bookings.')).toBeVisible();
 await page.getByLabel('One booking only').uncheck();await expect(page.locator('[data-link-access] summary small')).toHaveText('Open');await save(page);
 expect(state.writes[0].meetingTypes[0]).toMatchObject({singleUse:false,published:true});expect(state.writes[0].linkAccess).toBeUndefined();
 await page.getByRole('tab',{name:'Booking rules',exact:true}).click();await page.locator('[data-link-access] summary').click();await page.getByLabel('One booking only').check();
 await expect(page.getByText('Already used. Closed to new bookings.')).toBeVisible();await save(page);
 expect(state.writes[1].meetingTypes[0]).toMatchObject({singleUse:true});await expect(page.locator('[data-publish-label]')).toHaveText('Used');
 await page.locator('#back-to-links').click();await expect(row('Intro')).toHaveText('Used');
});

test('closed public link shows a minimal message with no times, form or visit',async({page})=>{
 const state=await fixture(page,{availability:()=>closed('link_expired')});await page.goto(base+`/b/${hostId}/intro`);
 await expect(page.getByRole('heading',{name:'This link has expired'})).toBeFocused();await expect(page.getByText('Ask the organizer for a new link.')).toBeVisible();
 await expect(page.locator('.slot,[data-slot],#booking-form,.date-grid')).toHaveCount(0);expect(state.requests.some(r=>r.path.endsWith('/visit'))).toBe(false);
});

test('a link closing at submit keeps the key and draft, and never claims an uncertain request failed',async({page})=>{
 let closeIt=false;const state=await fixture(page,{book:(_body,n)=>n===1?{status:503,json:{error:'Try again.'}}:closed('link_used'),availability:()=>closeIt?closed('link_used'):null});
 await page.goto(base+`/b/${hostId}/intro`);await page.locator('[data-slot]').first().click();
 await page.getByLabel('Your name',{exact:true}).fill('Guest');await page.getByLabel('Email address',{exact:true}).fill('guest@example.com');
 await page.getByRole('button',{name:/Confirm booking/}).click();await expect(page.locator('#form-error')).toBeVisible();closeIt=true;
 await page.getByRole('button',{name:/Confirm booking/}).click();
 await expect(page.getByRole('heading',{name:'This link has been used'})).toBeVisible();await expect(page.getByText('Ask Ada for a new link.')).toBeVisible();
 await expect(page.getByText('If you already sent a request, check your email.')).toBeVisible();
 await expect(page.locator('[data-slot],#booking-form')).toHaveCount(0);
 expect(state.books).toHaveLength(2);expect(state.books[1].idempotencyKey).toBe(state.books[0].idempotencyKey);
});

test('existing management and rescheduling stay usable after the public link closed',async({page})=>{
 const booking={id,status:'confirmed',title:'Intro',name:'Guest',email:'guest@example.com',start:day,end:day+30*60000,timeZone:'Europe/Oslo',location:'Studio',meetingTypeSlug:'intro'};
 const state=await fixture(page,{availability:()=>closed('link_used'),view:booking});
 await page.goto(base+`/manage/${hostId}/${id}#private-token`);await expect(page.getByRole('heading',{name:'Intro',exact:true})).toBeVisible();await expect(page.getByText('This link has been used')).toHaveCount(0);
 await page.goto(base+`/b/${hostId}/intro?reschedule=${id}#private-token`);await expect(page.locator('[data-slot]').first()).toBeVisible();await expect(page.getByText('This link has been used')).toHaveCount(0);
 expect(state.manage.some(b=>b.action==='availability')).toBe(true);expect(state.requests.some(r=>r.path.startsWith('/api/public/')&&r.path.endsWith('/availability'))).toBe(false);
});

test('owner preview of an expired, used link is local, shows example times and sends nothing',async({page})=>{
 const state=await fixture(page,{guest:false,types:[{expiresAt:past,singleUse:true}],linkAccess:{intro:{state:'expired',used:true,expiresAt:past}}});
 await page.goto(base+'/studio#link=intro');await expect(page.locator('#meeting-form')).toBeVisible();const before=state.requests.length;
 await page.locator('#preview-link').click();const frame=page.frameLocator('iframe');
 await expect(frame.getByRole('heading',{name:'Intro',exact:true})).toBeVisible();await expect(frame.locator('.slot,[data-slot]').first()).toBeVisible();
 await expect(frame.getByText(/This link has/)).toHaveCount(0);
 const after=state.requests.slice(before).map(r=>r.path);expect(after.filter(p=>/availability|visit|book|public/.test(p))).toEqual([]);
});

test('390px: Link access is keyboard operable and fits without horizontal scroll',async({page,browserName})=>{
 await page.setViewportSize({width:390,height:844});await page.emulateMedia({reducedMotion:'reduce'});
 const state=await fixture(page,{guest:false});const fold=await rules(page);
 await fold.locator('summary').focus();await page.keyboard.press('Enter');await expect(fold).toHaveAttribute('open','');
 await page.keyboard.press(browserName==='webkit'?'Alt+Tab':'Tab');await expect(page.getByLabel('One booking only')).toBeFocused();await page.keyboard.press('Space');await expect(page.getByLabel('One booking only')).toBeChecked();
 await page.keyboard.press(browserName==='webkit'?'Alt+Tab':'Tab');await expect(page.getByLabel('Expires',{exact:true})).toBeFocused();
 await page.getByLabel('Expires',{exact:true}).selectOption('date');await expect(page.getByLabel('Expiry date and time')).toBeFocused();
 await page.getByLabel('Expiry date and time').fill('2030-12-04T09:00');
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 const box=await page.getByLabel('Expiry date and time').boundingBox();expect(box.x+box.width).toBeLessThanOrEqual(390);
 await page.screenshot({path:'test-results/link-access-host-phone.png',fullPage:true});
 await page.keyboard.press('Meta+s');await expect(page.locator('#host-status')).toHaveText('Saved');expect(state.writes[0].meetingTypes[0]).toMatchObject({singleUse:true,expiresAt:Date.UTC(2030,11,4,8,0)});
});

test('390px guest closed view fits and focuses its heading',async({page})=>{
 await page.setViewportSize({width:390,height:844});await fixture(page,{availability:()=>closed('link_used')});await page.goto(base+`/b/${hostId}/intro`);
 await expect(page.getByRole('heading',{name:'This link has been used'})).toBeFocused();expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 await page.screenshot({path:'test-results/link-access-guest-phone.png',fullPage:true});
});


test('closed links cannot be copied or embedded from Share and offer access editing',async({page})=>{
 await fixture(page,{guest:false,types:[{expiresAt:past}]});await page.goto(base+'/studio');
 await page.getByRole('button',{name:'Share Intro',exact:true}).click();const dialog=page.getByRole('dialog',{name:'Share and preview booking link'});
 await expect(dialog.getByRole('heading',{name:'This link has expired'})).toBeVisible();await expect(dialog.locator('[data-copy-link],.share-code')).toHaveCount(0);
 await dialog.getByRole('button',{name:'Edit link access'}).click();await expect(dialog).toHaveCount(0);
 await expect(page.getByRole('tab',{name:'Booking rules',exact:true})).toHaveAttribute('aria-selected','true');await expect(page.locator('[data-link-access] summary')).toBeFocused();
 await expect(page.getByLabel('Expiry date and time')).toBeVisible();
});


test('a post-error availability refresh closes a consumed link without another booking write',async({page})=>{
 let submitted=false;const state=await fixture(page,{book:()=>{submitted=true;return {status:503,json:{error:'Response unavailable'}};},availability:()=>submitted?closed('link_used'):null});
 await page.goto(base+`/b/${hostId}/intro`);await page.locator('[data-slot]').first().click();await page.getByLabel('Your name',{exact:true}).fill('Guest');await page.getByLabel('Email address',{exact:true}).fill('guest@example.com');
 await page.getByRole('button',{name:/Confirm booking/}).click();await expect(page.getByRole('heading',{name:'This link has been used'})).toBeVisible();
 await expect(page.getByText('If you already sent a request, check your email.')).toBeVisible();await expect(page.locator('[data-slot],#booking-form')).toHaveCount(0);expect(state.books).toHaveLength(1);
});
