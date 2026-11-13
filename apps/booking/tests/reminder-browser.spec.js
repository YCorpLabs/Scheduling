import {test,expect} from '@playwright/test';
import {DEFAULT} from '../public/policy.js';
const base=process.env.BOOKING_TEST_ORIGIN||'http://127.0.0.1:8791';
async function setup(page,{configured=true,type={}}={}){
 let settings={revision:'A'.repeat(43),hostId:'h_abcdefghijklmnopqrstuvwx',profile:{name:'Riley'},accounts:[{id:'google1',connected:true,email:'host@example.com',destinationCalendarId:'primary'}],meetingTypes:[{...DEFAULT,id:'intro',slug:'intro',published:true,accountId:'google1',calendarId:'primary',reminder:true,...type}]};const writes=[];
 await page.route('**/api/**',async route=>{const path=new URL(route.request().url()).pathname;let value=settings;if(path==='/api/bootstrap')value={mode:'live',authenticated:true,hostId:settings.hostId,email:'host@example.com',notificationSender:configured?'Email Scheduling <notifications@example.com>':null,features:{reminders:configured}};if(path==='/api/live/calendars')value={accounts:[]};if(path==='/api/live/settings'&&route.request().method()==='POST'){const body=route.request().postDataJSON();writes.push(body);settings={...settings,...body.patch,revision:'B'.repeat(43)};value={settings,revision:settings.revision};}await route.fulfill({json:value});});await page.goto(base+'/studio#link=intro');await page.getByRole('tab',{name:'Emails',exact:true}).click();return writes;
}
test('legacy reminder becomes an explicit readable timing and multiple reminders save',async({page})=>{
 const writes=await setup(page);await expect(page.getByLabel('Reminder 1 timing')).toHaveValue('1440');await expect(page.getByLabel('Reminder 1 timing').locator('option:checked')).toHaveText('1 day before');await page.getByRole('button',{name:'Add reminder',exact:false}).click();await page.getByLabel('Reminder 2 timing').selectOption('120');await page.getByRole('button',{name:'Add reminder',exact:false}).click();await expect(page.getByRole('button',{name:'Add reminder',exact:false})).toBeDisabled();await page.getByLabel('Reminder 3 timing').selectOption('15');await page.getByRole('button',{name:/Save changes/}).click();await expect(page.locator('#host-status')).toHaveText('Saved');expect(writes[0].patch.meetingTypes[0].reminderMinutes).toEqual([1440,120,15]);await page.screenshot({path:`${process.env.BOOKING_SCREENSHOT_DIR||'test-results'}/scheduling-reminders-desktop.png`,fullPage:true});await page.setViewportSize({width:390,height:844});await page.screenshot({path:`${process.env.BOOKING_SCREENSHOT_DIR||'test-results'}/scheduling-reminders-mobile.png`,fullPage:true});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBeTruthy();
});
test('removing the last reminder switches it off and keeps focus reachable',async({page})=>{
 const writes=await setup(page);await page.getByRole('button',{name:'Remove reminder 1',exact:true}).click();await expect(page.getByLabel('Send email reminders')).not.toBeChecked();await expect(page.getByLabel('Send email reminders')).toBeFocused();await page.getByRole('button',{name:/Save changes/}).click();await expect(page.locator('#host-status')).toHaveText('Saved');expect(writes[0].patch.meetingTypes[0]).toMatchObject({reminder:false,reminderMinutes:[]});
});
test('unconfigured delivery is explicit and unrelated saves retain reminder policy',async({page})=>{
 const writes=await setup(page,{configured:false,type:{reminderMinutes:[2880,30]}});await expect(page.getByText('Email delivery is not connected. Calendar invitations still go out.')).toBeVisible();await expect(page.getByLabel('Send email reminders')).toBeDisabled();await page.getByRole('tab',{name:'Details',exact:true}).click();await page.getByLabel('Meeting name',{exact:true}).fill('New name');await page.getByRole('button',{name:/Save changes/}).click();await expect(page.locator('#host-status')).toHaveText('Saved');expect(writes[0].patch.meetingTypes[0].reminderMinutes).toEqual([2880,30]);
});

test('follow-up is opt-in and has a matching personalized text preview',async({page})=>{
 const writes=await setup(page);
 await page.getByText('Delivery details',{exact:true}).click();await expect(page.getByText('From Email Scheduling <notifications@example.com>',{exact:true})).toBeVisible();await page.getByText('Delivery details',{exact:true}).click();
 const toggle=page.getByLabel('Send a follow-up email',{exact:true});
 await expect(toggle).not.toBeChecked();await expect(page.getByLabel('After the meeting ends',{exact:true})).toBeHidden();await expect(page.getByLabel('After the meeting ends',{exact:true})).toBeDisabled();
 await toggle.check();await page.getByLabel('After the meeting ends',{exact:true}).selectOption('1440');
 await page.getByLabel('Subject',{exact:true}).fill('Next steps for {guest_name}');
 await page.getByLabel('Message',{exact:true}).fill('Hello {guest_name},\n\nNotes for {meeting_title} from {host_name}. <b>Text only</b>');
 await page.getByText('Preview email',{exact:true}).click();
 await expect(page.locator('[data-followup-preview-subject]')).toHaveText('Next steps for Alex');
 await expect(page.locator('[data-followup-preview-body]')).toContainText('Notes for Product demo from Alex Morgan. <b>Text only</b>');
 await expect(page.locator('[data-followup-preview-body] b')).toHaveCount(0);
 await page.getByRole('button',{name:/Save changes/}).click();await expect(page.locator('#host-status')).toHaveText('Saved');
 expect(writes[0].patch.meetingTypes[0]).toMatchObject({followUpMinutes:1440,followUpSubject:'Next steps for {guest_name}'});
 await page.getByText('Preview email',{exact:true}).click();
 await page.screenshot({path:`${process.env.BOOKING_SCREENSHOT_DIR||'test-results'}/scheduling-followup-desktop.png`,fullPage:true});
 await page.setViewportSize({width:390,height:844});
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBeTruthy();
 await page.screenshot({path:`${process.env.BOOKING_SCREENSHOT_DIR||'test-results'}/scheduling-followup-mobile.png`,fullPage:true});
});
test('follow-up tokens insert at the caret and disabling retains the draft template',async({page})=>{
 const writes=await setup(page,{type:{followUpMinutes:60,followUpSubject:'Hi ',followUpBody:'Saved note'}});
 const subject=page.getByLabel('Subject',{exact:true});await subject.fill('Hi ');
 await page.getByRole('button',{name:'Guest name',exact:true}).click();
 await expect(subject).toHaveValue('Hi {guest_name}');await expect(subject).toBeFocused();
 await page.getByLabel('Send a follow-up email',{exact:true}).uncheck();
 await page.getByRole('button',{name:/Save changes/}).click();await expect(page.locator('#host-status')).toHaveText('Saved');
 expect(writes[0].patch.meetingTypes[0]).toMatchObject({followUpMinutes:null,followUpSubject:'Hi {guest_name}',followUpBody:'Saved note'});
});
test('unavailable delivery preserves existing follow-up policy during unrelated saves',async({page})=>{
 const writes=await setup(page,{configured:false,type:{followUpMinutes:120,followUpSubject:'Thanks {guest_name}',followUpBody:'A link'}});
 await expect(page.getByLabel('Send a follow-up email',{exact:true})).toBeDisabled();
 await page.getByRole('tab',{name:'Details',exact:true}).click();await page.getByLabel('Meeting name',{exact:true}).fill('Still preserve');
 await page.getByRole('button',{name:/Save changes/}).click();await expect(page.locator('#host-status')).toHaveText('Saved');
 expect(writes[0].patch.meetingTypes[0]).toMatchObject({followUpMinutes:120,followUpSubject:'Thanks {guest_name}',followUpBody:'A link'});
});
test('invalid personalization has an actionable preview and blocks saving',async({page})=>{
 const writes=await setup(page,{type:{followUpMinutes:60}});
 await page.getByLabel('Message',{exact:true}).fill('Hi {password}');await page.getByText('Preview email',{exact:true}).click();
 await expect(page.locator('[data-followup-preview-error]')).toBeVisible();
 await page.getByRole('button',{name:/Save changes/}).click();
 await expect(page.locator('#host-status')).not.toHaveText('Saved');expect(writes).toHaveLength(0);
});

test('disabled email options stay out of the way and reveal only what is enabled',async({page})=>{
 await setup(page,{type:{reminder:false,reminderMinutes:[],followUpMinutes:null}});await expect(page.getByRole('tab',{name:'Emails',exact:true})).toHaveAttribute('aria-selected','true');await expect(page.getByRole('tab',{name:'Emails',exact:true})).toHaveClass(/active/);await expect(page.getByRole('tab',{name:'Details',exact:true})).not.toHaveClass(/active/);await expect(page.getByRole('tab',{name:'Details',exact:true})).toHaveAttribute('aria-selected','false');await expect(page.locator('[data-reminder-controls]')).toBeHidden();await expect(page.locator('[data-followup-controls]')).toBeHidden();await page.screenshot({path:`${process.env.BOOKING_SCREENSHOT_DIR||'test-results'}/email-options-settled.png`,animations:'disabled'});
 await page.getByLabel('Send email reminders',{exact:true}).check();await expect(page.getByLabel('Reminder 1 timing')).toBeVisible();await expect(page.locator('[data-followup-controls]')).toBeHidden();await page.getByLabel('Send a follow-up email',{exact:true}).check();await expect(page.getByLabel('Message',{exact:true})).toBeVisible();await page.getByLabel('Send email reminders',{exact:true}).uncheck();await expect(page.locator('[data-reminder-controls]')).toBeHidden();await expect(page.getByLabel('Message',{exact:true})).toBeVisible();await page.setViewportSize({width:390,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBeTruthy();await page.screenshot({path:`${process.env.BOOKING_SCREENSHOT_DIR||'test-results'}/email-options-mobile.png`,fullPage:true});
});
