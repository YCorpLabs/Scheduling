import {test,expect} from '@playwright/test';
const base=process.env.BOOKING_TEST_ORIGIN||'http://127.0.0.1:8791',company='h_'+'C'.repeat(24),person='h_'+'P'.repeat(24);

// A stateful stand-in for /api/live/my-calendar with the server's rules:
// revision checks, the destination is always checked for busy time, and hours
// change only when a schedule is sent.
async function studio(page){
 let revision=1;const writes=[];
 const my={member:{id:person,email:'ada@example.com'},account:{id:'mine',email:'ada@example.com',connected:true,ownerMemberId:person,calendarId:'primary',conflictCalendarIds:['primary']},calendars:[{id:'primary',summary:'Ada work',accessRole:'owner',primary:true},{id:'team',summary:'Team',accessRole:'writer'},{id:'holidays',summary:'Holidays',accessRole:'reader'},{id:'family',summary:'Family',accessRole:'freeBusyReader'}],schedule:{zone:'UTC',weeklyHours:Object.fromEntries([0,1,2,3,4,5,6].map(d=>[d,d>0&&d<6?[{start:540,end:1020}]:[]])),dateOverrides:{}},scheduleConfigured:false,readiness:'ready',revision:'rev1'};
 await page.route('**/api/**',async r=>{const req=r.request(),path=new URL(req.url()).pathname,body=req.postDataJSON?.(),json=(data,status=200)=>r.fulfill({json:data,status});
  if(path==='/api/bootstrap')return json({mode:'live',authenticated:true,hostId:person,email:'ada@example.com'});
  if(path.endsWith('/workspaces'))return json({activeWorkspaceId:company,workspaces:[{id:person,personal:true,role:'owner',name:'Ada'},{id:company,name:'Acme',role:'owner',capabilities:{manageOwnCalendar:true,manageSettings:true,manageMembers:true,manageIntegrations:true}}]});
  if(path.endsWith('/settings'))return json({hostId:company,profile:{name:'Acme'},revision:'a',accounts:[{id:'mine',email:'ada@example.com',ownerMemberId:person,connected:true,destinationCalendarId:my.account.calendarId}],meetingTypes:[],availabilitySchedules:[]});
  if(path.endsWith('/my-calendar')){if(body){writes.push(body);if(body.expectedRevision!==my.revision)return json({error:'Your calendar changed. Reload before saving.'},409);my.account.calendarId=body.calendarId;my.account.conflictCalendarIds=[...new Set([body.calendarId,...body.conflictCalendarIds])];if(body.schedule){my.schedule=body.schedule;my.scheduleConfigured=true;}my.revision='rev'+(++revision);}return json(structuredClone(my));}
  if(path.endsWith('/calendars'))return json({accounts:[{id:'mine',email:'ada@example.com',ownerMemberId:person,calendars:[]}]});
  if(path.endsWith('/calendar-contributions'))return json({contributions:[]});
  if(path.endsWith('/bookings'))return json({bookings:[]});
  return json({});});
 return {my,writes};
}
const rowNames=page=>page.locator('[data-calendar-row] .calendar-setting-name').allTextContents();
async function openMyCalendar(page){await page.goto(base+'/studio#calendars');await page.getByRole('button',{name:'My calendar',exact:true}).click();await expect(page.getByLabel('Add bookings to Team',{exact:true})).toBeVisible();}

test('My calendar has one save flow that a reload agrees with',async({page})=>{
 const server=await studio(page);await openMyCalendar(page);
 const save=page.getByRole('button',{name:'Save changes',exact:true}),status=page.locator('[data-my-calendar-status]'),busy=name=>page.getByLabel(`Check busy time on ${name}`,{exact:true});
 await expect(page.locator('.my-hours-summary')).toContainText('Not set');await expect(page.locator('.my-hours-summary')).toContainText('Bookings use each link’s hours.');await expect(page.locator('.my-hours-summary')).not.toContainText('09:00');
 const order=await rowNames(page);expect(order).toEqual(['Ada work','Family','Holidays','Team']);
 await expect(save).toBeDisabled();await expect(status).toHaveText('');
 await page.getByLabel('Add bookings to Team',{exact:true}).check();await busy('Holidays').check();await busy('Family').check();
 await expect(save).toBeEnabled();await expect(status).toHaveText('Unsaved changes');await expect(busy('Team')).toBeDisabled();await expect(busy('Team')).toBeChecked();
 await save.click();await expect(status).toHaveText('Calendar saved');await expect(save).toBeDisabled();
 expect(server.writes.at(-1)).toMatchObject({calendarId:'team',expectedRevision:'rev1'});expect([...server.writes.at(-1).conflictCalendarIds].sort()).toEqual(['family','holidays','primary','team']);expect(server.writes.at(-1).schedule).toBeUndefined();
 expect(await rowNames(page)).toEqual(order);await expect(page.getByLabel('Add bookings to Team',{exact:true})).toBeChecked();for(const name of ['Holidays','Family'])await expect(busy(name)).toBeChecked();
 // A change after saving replaces the saved message; undoing it returns to the saved state.
 await busy('Holidays').uncheck();await expect(status).toHaveText('Unsaved changes');await expect(save).toBeEnabled();
 await busy('Holidays').check();await expect(status).toHaveText('');await expect(save).toBeDisabled();
 // Leaving with unsaved calendar changes asks first, then hours save on their own page.
 await busy('Ada work').uncheck();await page.getByRole('button',{name:'Set my hours',exact:true}).click();
 const dialog=page.getByRole('dialog',{name:'Unsaved changes'});await expect(dialog).toBeVisible();await dialog.getByRole('button',{name:'Save changes',exact:true}).click();
 await expect(page.locator('#availability-form')).toBeVisible();expect(server.writes.at(-1).conflictCalendarIds).not.toContain('primary');
 await page.locator('[name=zone]').fill('Europe/Oslo');await page.getByRole('button',{name:'Save hours',exact:true}).click();
 await expect(page.locator('[data-my-hours-status]')).toHaveText('Hours saved');expect(server.writes.at(-1)).toMatchObject({calendarId:'team',schedule:{zone:'Europe/Oslo'}});
 await page.getByRole('button',{name:'Calendars',exact:true}).click();await expect(page.getByLabel('Add bookings to Team',{exact:true})).toBeVisible();
 await expect(page.locator('.my-hours-summary')).toContainText('Mon, Tue, Wed, Thu, Fri 09:00-17:00');await expect(page.locator('.my-hours-summary')).toContainText('Europe/Oslo');await expect(page.getByRole('button',{name:'Edit hours',exact:true})).toBeVisible();
 const saved=JSON.stringify(server.my.account);
 await page.reload();await page.getByRole('button',{name:'My calendar',exact:true}).click();await expect(page.getByLabel('Add bookings to Team',{exact:true})).toBeChecked();
 expect(JSON.stringify(server.my.account)).toBe(saved);expect(await rowNames(page)).toEqual(order);
 for(const [name,checked] of [['Ada work',false],['Family',true],['Holidays',true],['Team',true]])await expect(busy(name)).toBeChecked({checked});
 await expect(page.locator('.my-hours-summary')).toContainText('Europe/Oslo');await expect(status).toHaveText('');await expect(save).toBeDisabled();
});

test('a failed save keeps the edits, the error and an enabled Save',async({page})=>{
 const server=await studio(page);await openMyCalendar(page);server.my.revision='changed-elsewhere';
 await page.getByLabel('Check busy time on Holidays',{exact:true}).check();await page.getByRole('button',{name:'Save changes',exact:true}).click();
 await expect(page.locator('[data-my-calendar-error]')).toHaveText('Your calendar changed. Reload before saving.');await expect(page.getByRole('button',{name:'Save changes',exact:true})).toBeEnabled();
 await expect(page.locator('[data-my-calendar-status]')).toHaveText('Unsaved changes');await expect(page.getByLabel('Check busy time on Holidays',{exact:true})).toBeChecked();
 await expect(page.getByRole('button',{name:'Reload my calendar',exact:true})).toBeVisible();
});
