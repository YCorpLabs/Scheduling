import {test,expect} from '@playwright/test';
import {DEFAULT} from '../public/policy.js';
// Coordinated run only: uses BOOKING_TEST_ORIGIN or the root-owned 8791 origin. All HTTP is intercepted.
const base=process.env.BOOKING_TEST_ORIGIN||'http://127.0.0.1:8791',hostId='h_abcdefghijklmnopqrstuvwx';
const account={id:'a',email:'ada@company.test',connected:true,destinationCalendarId:'ada@company.test',conflictCalendarIds:['ada@company.test']};
const day=Date.UTC(2030,0,7,9),slotsFor=d=>[0,1,2].map(i=>({start:day+i*d*60000,end:day+(i+1)*d*60000}));

async function fixture(page,{type={},guest=true,delays={},fail=[],reschedule=null}={}){
 let settings={hostId,revision:'A'.repeat(43),profile:{name:'Company'},accounts:[account],availabilitySchedules:[],defaultAvailabilityScheduleId:null,meetingTypes:[{...DEFAULT,id:'intro',slug:'intro',title:'Intro',host:'Company',published:true,accountId:'a',calendarId:account.destinationCalendarId,...type}]};
 const writes=[],availability=[],books=[];
 await page.route('**/api/**',async route=>{const req=route.request(),url=new URL(req.url()),path=url.pathname;let data;
  if(path==='/api/bootstrap')data={mode:'live',authenticated:!guest,hostId,email:'owner@company.test',features:{reminders:true}};
  else if(path==='/api/live/workspaces')return route.fulfill({status:404,json:{error:'Unsupported'}});
  else if(path==='/api/live/settings'){if(req.method()==='POST'){const body=req.postDataJSON();writes.push(body.patch);settings={...settings,...body.patch,revision:'B'.repeat(43)};data={settings,revision:settings.revision};}else data=settings;}
  else if(path==='/api/live/calendars')data={accounts:[{id:'a',calendars:[{id:account.destinationCalendarId,summary:'Work',accessRole:'owner'}]}]};
  else if(path.endsWith('/availability')){const t=settings.meetingTypes[0],raw=url.searchParams.get('duration'),d=raw==null?t.duration:Number(raw);availability.push(raw);
   if(delays[d])await new Promise(r=>setTimeout(r,delays[d]));
   if(fail.includes(d))return route.fulfill({status:500,json:{error:'Unavailable'}});
   const options=t.durationOptions??[t.duration];if(!options.includes(d))return route.fulfill({status:400,json:{error:'Choose an available meeting duration.'}});
   data={mode:'live',config:{...t,duration:d,durationOptions:t.durationOptions},slots:reschedule?slotsFor(reschedule.end-reschedule.start>0?(reschedule.end-reschedule.start)/60000:t.duration):slotsFor(d)};}
  else if(path.endsWith('/visit'))data={ok:true};
  else if(path.endsWith('/book')){const body=req.postDataJSON();books.push(body);const d=body.duration??settings.meetingTypes[0].duration;data={booking:{id:'booking_'+'1'.repeat(20),status:'confirmed',title:'Intro',start:body.start,end:body.start+d*60000,timeZone:'UTC'},managementToken:'fixture-token'};}
  else if(reschedule&&path.startsWith('/api/manage/')){const body=req.postDataJSON();books.push({manage:body});data=body.action==='view'?{booking:reschedule}:body.action==='availability'?{mode:'live',config:{...settings.meetingTypes[0],duration:(reschedule.end-reschedule.start)/60000},slots:slotsFor((reschedule.end-reschedule.start)/60000)}:{booking:{...reschedule,start:body.start,end:body.start+(reschedule.end-reschedule.start)}};}
  else return route.fulfill({status:404,json:{error:'Not mocked'}});
  return route.fulfill({json:data});
 });
 return {writes,availability,books,get settings(){return settings;}};
}
const lengths=page=>page.locator('.slot');

test('fixed link shows no chooser and explicitly books its displayed duration',async({page})=>{
 const state=await fixture(page);await page.goto(base+`/b/${hostId}/intro`);
 await expect(page.locator('.meeting-meta')).toContainText('30 minutes');await expect(page.locator('.guest-durations')).toHaveCount(0);
 await lengths(page).first().click();await page.getByLabel('Your name',{exact:true}).fill('Guest');await page.getByLabel('Email address',{exact:true}).fill('g@example.com');await page.getByRole('button',{name:'Confirm booking',exact:true}).click();
 await expect(page.getByRole('heading',{name:'You’re booked',exact:true})).toBeVisible();expect(state.books[0].duration).toBe(30);expect(state.availability).toEqual([null]);
});

test('guest length change loads actual times, hides old-length times while loading and books the chosen length',async({page})=>{
 const state=await fixture(page,{type:{durationOptions:[30,60]},delays:{60:500}});await page.goto(base+`/b/${hostId}/intro`);
 const thirty=page.getByRole('radio',{name:'30 min',exact:true}),hour=page.getByRole('radio',{name:'1 hr',exact:true});
 await expect(thirty).toBeChecked();await expect(lengths(page)).toHaveCount(3);
 await hour.check();await expect(hour).toBeFocused();await expect(page.locator('.booking')).toHaveAttribute('aria-busy','true');await expect(lengths(page)).toHaveCount(0);await expect(page.locator('.time-loading')).toBeVisible();
 await expect(page.locator('.booking')).toHaveAttribute('aria-busy','false');await expect(lengths(page)).toHaveCount(3);await expect(hour).toBeFocused();expect(state.availability).toEqual([null,'60']);
 await lengths(page).nth(1).click();await expect(page.locator('.slot-summary')).toContainText('10:00 – 11:00');await expect(page.locator('.guest-durations')).toHaveCount(0);
 await page.getByLabel('Your name',{exact:true}).fill('Guest');await page.getByLabel('Email address',{exact:true}).fill('g@example.com');await page.getByRole('button',{name:'Confirm booking',exact:true}).click();
 await expect(page.getByRole('heading',{name:'You’re booked',exact:true})).toBeVisible();expect(state.books[0]).toMatchObject({duration:60,start:slotsFor(60)[1].start});
});

test('delayed earlier length reply cannot replace the newer choice; going back restores instantly',async({page})=>{
 const state=await fixture(page,{type:{duration:30,durationOptions:[15,30,60]},delays:{60:800}});await page.goto(base+`/b/${hostId}/intro`);
 await page.getByRole('radio',{name:'1 hr',exact:true}).check();await page.getByRole('radio',{name:'15 min',exact:true}).check();
 await expect(page.getByRole('radio',{name:'15 min',exact:true})).toBeChecked();await expect(lengths(page)).toHaveCount(3);
 await page.waitForTimeout(1000);await expect(page.getByRole('radio',{name:'15 min',exact:true})).toBeChecked();await expect(lengths(page).first()).toHaveText(/^0?9:00$/);await expect(lengths(page).nth(1)).toHaveText(/^0?9:15$/);
 await page.getByRole('radio',{name:'1 hr',exact:true}).check();await page.getByRole('radio',{name:'15 min',exact:true}).check();await expect(lengths(page).nth(1)).toHaveText(/^0?9:15$/);
 expect(state.availability.filter(v=>v==='15')).toHaveLength(1);
});

test('failed length load keeps the previous length and its times with an actionable error',async({page})=>{
 await fixture(page,{type:{durationOptions:[30,60]},fail:[60]});await page.goto(base+`/b/${hostId}/intro`);
 await page.getByRole('radio',{name:'1 hr',exact:true}).click();
 await expect(page.locator('#availability-error')).toHaveText('Times for 1 hr could not load. Try again.');await expect(page.getByRole('radio',{name:'30 min',exact:true})).toBeChecked();await expect(lengths(page).nth(1)).toHaveText(/^0?9:30$/);
});

test('host choice and intake draft survive a length change',async({page})=>{
 await fixture(page,{type:{durationOptions:[30,60],questions:[{id:'topic',type:'text',label:'Topic',required:false}]}});await page.goto(base+`/b/${hostId}/intro`);
 await lengths(page).first().click();await page.getByLabel('Your name',{exact:true}).fill('Keep me');await page.getByLabel(/Topic/).fill('Roadmap');await page.getByRole('button',{name:'← Choose another time'}).click();
 await page.getByRole('radio',{name:'1 hr',exact:true}).check();await expect(lengths(page)).toHaveCount(3);await lengths(page).first().click();
 await expect(page.getByLabel('Your name',{exact:true})).toHaveValue('Keep me');await expect(page.getByLabel(/Topic/)).toHaveValue('Roadmap');
});

test('reschedule never offers or sends a length change',async({page})=>{
 const original={id:'booking_'+'2'.repeat(20),status:'confirmed',title:'Intro',name:'Guest',email:'g@example.com',start:day-86400000,end:day-86400000+60*60000,timeZone:'UTC'};
 const state=await fixture(page,{type:{durationOptions:[30,45]},reschedule:original});await page.goto(base+`/b/${hostId}/intro?reschedule=${original.id}#cap`);
 await expect(page.locator('.guest-durations')).toHaveCount(0);await expect(page.locator('.meeting-meta')).toContainText('60 minutes');expect(state.availability).toEqual([]);expect(state.books.filter(b=>b.manage?.action==='availability').map(b=>b.manage)).toEqual([{action:'availability',token:'cap'}]);await expect(lengths(page).nth(1)).toHaveText('10:00');
 await lengths(page).first().click();await page.getByRole('button',{name:'Confirm new time',exact:true}).click();
 await expect.poll(()=>state.books.filter(b=>b.manage?.action==='reschedule').length).toBe(1);const sent=state.books.find(b=>b.manage?.action==='reschedule').manage;expect(sent.duration).toBeUndefined();expect(Object.keys(sent).sort()).toEqual(['action','key','start','token']);
});

test('phone width and reduced motion keep the chooser usable',async({page})=>{
 await page.emulateMedia({reducedMotion:'reduce'});await page.setViewportSize({width:390,height:844});
 await fixture(page,{type:{durationOptions:[15,30,45,90]}});await page.goto(base+`/b/${hostId}/intro`);
 await expect(page.locator('html')).toHaveAttribute('data-motion','none');await expect(page.getByRole('radio')).toHaveCount(4);
 await page.getByRole('radio',{name:'30 min',exact:true}).focus();await page.keyboard.press('ArrowRight');await expect(page.getByRole('radio',{name:'45 min',exact:true})).toBeChecked();await expect(lengths(page).nth(1)).toHaveText(/^0?9:45$/);
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBeTruthy();await page.screenshot({path:`${process.env.BOOKING_SCREENSHOT_DIR||'test-results'}/duration-guest-phone.png`,fullPage:true,animations:'disabled'});
});

test('host sets a custom default and up to four guest lengths; one length stays fixed',async({page})=>{
 const state=await fixture(page,{guest:false});await page.goto(base+'/studio#link=intro');
 const duration=page.getByLabel('Duration',{exact:true});await duration.fill('37');await expect(page.getByRole('checkbox',{name:'37 min (default)'})).toBeChecked();await expect(page.getByRole('checkbox',{name:'37 min (default)'})).toBeDisabled();
 await page.getByRole('checkbox',{name:'1 hr',exact:true}).check();await page.getByLabel('Other length in minutes').fill('95');await page.getByRole('button',{name:'Add',exact:true}).click();
 await expect(page.getByRole('checkbox',{name:'1 hr 35 min',exact:true})).toBeChecked();await page.getByRole('checkbox',{name:'15 min',exact:true}).check();
 await expect(page.getByRole('checkbox',{name:'45 min',exact:true})).toBeDisabled();await expect(page.locator('[data-duration-error]')).toHaveText('Up to four lengths.');
 await page.getByLabel('Other length in minutes').fill('120');await page.getByRole('button',{name:'Add',exact:true}).click();await expect(page.locator('[data-duration-error]')).toHaveText('Up to four lengths. Remove one first.');
 await expect(page.locator('#editor-save-state')).toHaveText('Unsaved changes');await page.getByRole('button',{name:/Save changes/}).click();await expect(page.locator('#host-status')).toHaveText('Saved');
 expect(state.writes[0].meetingTypes[0]).toMatchObject({duration:37,durationOptions:[15,37,60,95]});
 for(const name of ['15 min','1 hr','1 hr 35 min'])await page.getByRole('checkbox',{name,exact:true}).uncheck();await page.getByRole('button',{name:/Save changes/}).click();await expect(page.locator('#host-status')).toHaveText('Saved');
 expect(state.writes[1].meetingTypes[0]).toMatchObject({duration:37,durationOptions:null});
 await duration.fill('3');await expect(duration).toHaveAttribute('aria-invalid','true');await page.getByRole('button',{name:/Save changes/}).click();expect(state.writes).toHaveLength(2);
 await page.setViewportSize({width:390,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBeTruthy();await page.screenshot({path:`${process.env.BOOKING_SCREENSHOT_DIR||'test-results'}/duration-host-phone.png`,fullPage:true,animations:'disabled'});
});

test('owner preview length change uses local draft preview only and keeps guest draft',async({page})=>{
 const requests=[],calls=[];await page.route('**/api/**',route=>{requests.push(route.request().url());return route.fulfill({status:500,json:{error:'Preview must not call APIs'}});});
 await page.route('**/__duration-test',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><html><head><link rel="stylesheet" href="/tokens.css"><link rel="stylesheet" href="/style.css"><link rel="stylesheet" href="/share-ui.css"><link rel="stylesheet" href="/durations-ui.css"></head><body><button id="trigger">Share</button><script type="module">import {showShare} from "/share-ui.js";window.calls=[];window.open1=()=>showShare({trigger:document.querySelector("#trigger"),title:"Draft",initialView:"preview",dirty:true,loadPreview:async duration=>{window.calls.push(duration??null);const d=duration??30;if(d===60)await new Promise(r=>setTimeout(r,300));const start=Date.UTC(2030,0,7,9);return {config:{host:"Ada",title:"Draft",duration:d,durationOptions:[30,60],zone:"UTC",location:"Studio",locationType:"custom",theme:"light",accent:"graphite",motion:"smooth",questions:[],extraGuestsLimit:0,accountId:"private-account"},slots:[0,1].map(i=>({start:start+i*d*60000,end:start+(i+1)*d*60000}))};}});</script></body></html>'}));
 await page.goto(base+'/__duration-test');await page.waitForFunction(()=>!!window.open1);await page.evaluate(()=>window.open1());
 const frame=page.frameLocator('iframe');await expect(frame.locator('.slot')).toHaveCount(2);
 await frame.locator('.slot').first().click();await frame.getByLabel('Your name',{exact:true}).fill('Draft guest');await frame.getByRole('button',{name:'← Choose another time'}).click();
 await frame.getByRole('radio',{name:'1 hr',exact:true}).check();await expect(frame.locator('.slot')).toHaveCount(0);await expect(frame.locator('.slot').nth(1)).toHaveText('10:00');
 await frame.locator('.slot').first().click();await expect(frame.getByLabel('Your name',{exact:true})).toHaveValue('Draft guest');await expect(frame.getByRole('button',{name:'Preview',exact:true})).toBeDisabled();
 expect(await page.evaluate(()=>window.calls)).toEqual([null,60]);expect(requests).toEqual([]);
 // A frame asking for a length outside the projected choices gets an error reply, not a preview load.
 await frame.getByRole('button',{name:'← Choose another time'}).click();
 await page.frames()[1].evaluate(()=>parent.postMessage({type:'email-booking:owner-duration',duration:45,request:999},location.origin));await page.waitForTimeout(100);expect(await page.evaluate(()=>window.calls)).toEqual([null,60]);
 // Closing right after a length request: any late reply is dropped and focus returns.
 await frame.getByRole('radio',{name:'30 min',exact:true}).check();await page.keyboard.press('Escape');await expect(page.locator('dialog')).toHaveCount(0);await expect(page.locator('#trigger')).toBeFocused();expect(requests).toEqual([]);
});

test('unapplied Other value does not block meeting save or dirty-navigation save',async({page})=>{const state=await fixture(page,{guest:false});await page.goto(base+'/studio#link=intro');await page.getByLabel('Other length in minutes').fill('999');await page.getByLabel('Meeting name',{exact:true}).fill('Changed title');await page.getByRole('button',{name:/Save changes/}).click();await expect(page.locator('#host-status')).toHaveText('Saved');expect(state.writes[0].meetingTypes[0]).toMatchObject({duration:30,durationOptions:null,title:'Changed title'});await page.getByLabel('Other length in minutes').fill('2.5');await page.getByLabel('Meeting name',{exact:true}).fill('Changed again');await page.getByRole('button',{name:'Bookings',exact:true}).click();await page.getByRole('dialog',{name:'Unsaved changes'}).getByRole('button',{name:'Save changes',exact:true}).click();await expect(page.getByRole('heading',{name:'Bookings',exact:true})).toBeVisible();expect(state.writes[1].meetingTypes[0].title).toBe('Changed again');});

test('uncertain fixed-length booking outcome retains original duration and idempotency key',async({page})=>{const state=await fixture(page);let changed=false;const submitted=[];await page.route('**/api/public/*/intro/availability',r=>r.fulfill({json:{config:{...DEFAULT,duration:changed?45:30,durationOptions:null},slots:slotsFor(changed?45:30)}}));await page.route('**/api/public/*/intro/book',r=>{submitted.push(r.request().postDataJSON());changed=true;return r.fulfill({status:503,json:{error:'Temporary failure'}});});await page.goto(base+`/b/${hostId}/intro`);await lengths(page).first().click();await page.getByLabel('Your name',{exact:true}).fill('Guest');await page.getByLabel('Email address',{exact:true}).fill('g@example.com');await page.getByRole('button',{name:'Confirm booking',exact:true}).click();await expect(page.getByRole('alert')).toContainText('Temporary failure');await expect(page.locator('.meeting-meta')).toContainText('30 minutes');await page.getByRole('button',{name:'Confirm booking',exact:true}).click();await expect.poll(()=>submitted.length).toBe(2);expect(submitted[0].duration).toBe(30);expect(submitted[1].duration).toBe(30);expect(submitted[1].idempotencyKey).toBe(submitted[0].idempotencyKey);});
test('duration and intake change together reconcile incompatible answers after a rejected admission',async({page})=>{
 const state=await fixture(page,{type:{questions:[{id:'same',type:'checkbox',label:'Old checkbox',required:false}]}});await page.route('**/api/public/*/intro/book',route=>{Object.assign(state.settings.meetingTypes[0],{duration:45,durationOptions:null,questions:[{id:'same',type:'text',label:'New details',required:false}]});return route.fulfill({status:409,json:{error:'Availability changed'}});});await page.goto(base+`/b/${hostId}/intro`);await lengths(page).first().click();await page.getByLabel('Your name',{exact:true}).fill('Guest');await page.getByLabel('Email address',{exact:true}).fill('g@example.com');await page.getByLabel('Old checkbox (optional)',{exact:true}).check();await page.getByRole('button',{name:'Confirm booking',exact:true}).click();await expect(page.locator('#availability-error')).toContainText('Booking form changed');await lengths(page).first().click();await expect(page.getByRole('textbox',{name:/New details/})).toHaveValue('');await expect(page.getByLabel('Your name',{exact:true})).toHaveValue('Guest');await expect(page.locator('.meeting-meta')).toContainText('45 minutes');
});
test('an accepted-key conflict never resets into a fresh booking at a newer length',async({page})=>{
 const state=await fixture(page),submitted=[];await page.route('**/api/public/*/intro/book',route=>{submitted.push(route.request().postDataJSON());Object.assign(state.settings.meetingTypes[0],{duration:45,durationOptions:null});return route.fulfill({status:submitted.length===1?503:409,json:{error:submitted.length===1?'Temporary failure':'Request already used',...(submitted.length>1?{code:'idempotency_conflict'}:{})}});});await page.goto(base+`/b/${hostId}/intro`);await lengths(page).first().click();await page.getByLabel('Your name',{exact:true}).fill('Guest');await page.getByLabel('Email address',{exact:true}).fill('g@example.com');await page.getByRole('button',{name:'Confirm booking',exact:true}).click();await expect(page.getByRole('alert')).toContainText('Temporary failure');await page.getByLabel('Your name',{exact:true}).fill('Edited guest');await page.getByRole('button',{name:'Confirm booking',exact:true}).click();await expect(page.getByRole('alert')).toContainText('Request already used');await expect(page.locator('#booking-form')).toBeVisible();await expect(page.locator('.meeting-meta')).toContainText('30 minutes');expect(submitted[0].idempotencyKey).toBe(submitted[1].idempotencyKey);expect(submitted[1].duration).toBe(30);
});
