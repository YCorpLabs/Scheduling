import {test,expect} from '@playwright/test';
import {DEFAULT} from '../public/policy.js';
const base='http://127.0.0.1:8791',id='booking_abcdefghijklmnop';
async function setup(page,{legacy=false,failRefresh=false}={}){
 const now=Date.now(),b={id,status:'confirmed',version:1,title:'Product review',name:'Alex',email:'alex@example.com',start:now+86400000,end:now+88200000,meetingTypeSlug:'intro',timeZone:'Europe/London'};
 const notifications=[{id:'one',kind:'confirmed',recipientRole:'guest',status:'sent',sentAt:now-60000,dueAt:now-60000,updatedAt:now-60000},{id:'two',kind:'reminder',recipientRole:'guest',status:'needs_review',dueAt:now+60000,updatedAt:now},{id:'three',kind:'follow_up',recipientRole:'guest',status:'scheduled',dueAt:now+90000000,updatedAt:now}];
 if(!legacy)b.notifications=notifications;let reads=0;const writes=[];
 await page.route('**/api/**',async route=>{const path=new URL(route.request().url()).pathname;if(route.request().method()!=='GET')writes.push(path);
 if(path==='/api/bootstrap')return route.fulfill({json:{mode:'live',authenticated:true,hostId:'h_abcdefghijklmnopqrstuvwx',email:'host@example.com',features:{}}});
 if(path==='/api/live/settings')return route.fulfill({json:{profile:{name:'Riley'},accounts:[],meetingTypes:[{...DEFAULT,id:'intro',slug:'intro'}]}});
 if(path==='/api/live/calendars')return route.fulfill({json:{accounts:[]}});
 if(path==='/api/live/bookings')return route.fulfill({json:{bookings:[b],notificationIssues:legacy?[]:[{bookingId:id,kind:'reminder'}]}});
 if(path==='/api/live/bookings/'+id){reads++;if(failRefresh&&reads>1)return route.fulfill({status:503,json:{error:'Email activity could not refresh. Try again.'}});return route.fulfill({json:{booking:b,managementToken:'not-rendered-in-activity'}});}
 return route.fulfill({json:{}});});
 await page.goto(base+'/studio#bookings');return {writes};
}
test('delivery attention leads to the right booking and explains sent without claiming delivery',async({page})=>{
 const {writes}=await setup(page);await page.getByRole('button',{name:'Review emails',exact:true}).click();await expect(page.locator('[data-filter=attention]')).toHaveAttribute('aria-pressed','true');
 await page.locator('[data-manage]').click();const dialog=page.getByRole('dialog',{name:'Booking details'}),activity=dialog.getByRole('region',{name:'Email activity'});
 await expect(activity.getByText('Booking confirmation',{exact:true})).toBeVisible();await expect(activity.getByText('Sent',{exact:true})).toBeVisible();await expect(activity.getByText('Accepted by the email provider. Delivery and reading are not verified.')).toBeVisible();
 await expect(activity.getByText('Needs review',{exact:true})).toBeVisible();await expect(activity.getByText(/Automatic retries are paused/)).toBeVisible();await expect(activity.getByText('Scheduled',{exact:true})).toBeVisible();await expect(activity.getByRole('button',{name:/retry|resend/i})).toHaveCount(0);
 await activity.getByRole('button',{name:'Refresh emails'}).click();await expect(activity.getByRole('button',{name:'Refresh emails'})).toBeFocused();expect(writes).toEqual([]);
 await page.screenshot({path:`${process.env.BOOKING_SCREENSHOT_DIR||'test-results'}/scheduling-delivery-desktop.png`});await dialog.press('Escape');await expect(page.locator('[data-manage]')).toBeFocused();
});
test('configuration issues are distinguished from uncertain delivery',async({page})=>{
 await setup(page);await page.route('**/api/live/bookings/'+id,route=>route.fulfill({json:{booking:{id,status:'cancelled',title:'Earlier meeting',name:'Alex',email:'alex@example.com',start:Date.now()-86400000,end:Date.now()-84600000,notifications:[{kind:'confirmed',recipientRole:'guest',status:'needs_review',reason:'configuration',dueAt:null} ]}}}));await page.locator('[data-manage]').click();const activity=page.getByRole('region',{name:'Email activity'});await expect(activity.getByText('Email setup needs attention. Automatic retries are paused.')).toBeVisible();await expect(activity.getByText(/send could not be confirmed/)).toHaveCount(0);
});
test('owner-resolved delivery is clearly marked as an assertion rather than provider acceptance',async({page})=>{
 const {writes}=await setup(page);await page.route('**/api/live/bookings/'+id,route=>route.fulfill({json:{booking:{id,status:'confirmed',title:'Reviewed meeting',name:'Alex',start:Date.now()+86400000,end:Date.now()+88200000,notifications:[
  {kind:'confirmed',recipientRole:'guest',status:'sent',resolution:'operator_asserted_delivered',resolutionEvidence:'operator_assertion',resolvedAt:Date.now()},
  {kind:'reminder',recipientRole:'guest',status:'cancelled',resolution:'operator_asserted_not_sent',resolutionEvidence:'operator_assertion',resolvedAt:Date.now()}
 ]}}}));
 await page.locator('[data-manage]').click();const activity=page.getByRole('region',{name:'Email activity'});
 await expect(activity.getByText('Marked delivered',{exact:true})).toBeVisible();await expect(activity.getByText('Marked not sent',{exact:true})).toBeVisible();
 await expect(activity.getByText(/An owner marked this email as delivered/)).toBeVisible();await expect(activity.getByText(/This action did not resend/)).toBeVisible();
 await expect(activity.getByText(/Accepted by the email provider/)).toHaveCount(0);expect(writes).toEqual([]);
});
test('recent activity fits a dark mobile view and stays keyboard reachable',async({page})=>{
 await setup(page);await page.locator('#account-trigger').click();await page.getByRole('button',{name:'Dark mode',exact:true}).click();await page.locator('[data-manage]').click();await page.setViewportSize({width:390,height:844});const dialog=page.getByRole('dialog',{name:'Booking details'});await dialog.getByRole('button',{name:'Refresh emails'}).scrollIntoViewIfNeeded();await expect(dialog.getByText('Needs review',{exact:true})).toBeVisible();await expect(dialog.getByRole('button',{name:'Cancel booking',exact:true})).toBeVisible();const footer=await dialog.locator('.booking-detail-footer').boundingBox();expect(footer.y+footer.height).toBeLessThanOrEqual(844);expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBeTruthy();await page.screenshot({path:`${process.env.BOOKING_SCREENSHOT_DIR||'test-results'}/scheduling-delivery-mobile.png`});await dialog.press('Escape');await expect(page.locator('[data-manage]')).toBeFocused();
});
test('legacy bookings do not invent sent receipts and a failed refresh keeps visible history',async({page})=>{
 await setup(page,{legacy:true});await page.locator('[data-manage]').click();await expect(page.getByText('No recent email activity is recorded.')).toBeVisible();await expect(page.getByText('Sent',{exact:true})).toHaveCount(0);
 await page.goto('about:blank');await setup(page,{failRefresh:true});await page.locator('[data-manage]').click();const dialog=page.getByRole('dialog',{name:'Booking details'});await dialog.getByRole('button',{name:'Refresh emails'}).click();await expect(dialog.getByRole('alert')).toHaveText('Email activity could not refresh. Try again.');await expect(dialog.getByText('Sent',{exact:true})).toBeVisible();
});
