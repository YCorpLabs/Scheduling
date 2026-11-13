import {test,expect} from '@playwright/test';
import {handleDevice} from '../src/device.js';
const base=process.env.BOOKING_TEST_ORIGIN||'http://127.0.0.1:8791';
async function mockDevice(page,{signedIn=true,name='Email on My Mac',accountEmail='me@example.com',scope='booking:read email:tracking',vars={}}={}){
 const env={PUBLIC_ORIGIN:'https://booking.example',...vars},markup=await(await handleDevice(new Request(env.PUBLIC_ORIGIN+'/device'),env)).text(),script=await(await handleDevice(new Request(env.PUBLIC_ORIGIN+'/device-ui.js'),env)).text();
 const state={approved:0,approvals:[],revoked:0,inspected:[],sessions:0,signedIn};
 await page.route('**/device',route=>route.fulfill({contentType:'text/html',body:markup}));await page.route('**/device-ui.js',route=>route.fulfill({contentType:'text/javascript',body:script}));
 await page.route('**/api/device/**',route=>{
  const path=new URL(route.request().url()).pathname;
  if(path.endsWith('/approve')){state.approved++;state.approvals.push(route.request().postDataJSON());return route.fulfill({status:204});}
  if(path.endsWith('/revoke')){state.revoked++;return route.fulfill({status:204});}
  if(path.endsWith('/inspect')){state.inspected.push(route.request().postDataJSON());return route.fulfill(state.signedIn?{json:{name,accountEmail,scope,expiresAt:Date.now()+600000}}:{status:401,json:{error:'Sign in to approve a desktop.'}});}
  state.sessions++;return route.fulfill({json:{sessions:state.revoked?[]:[{id:'opaque-session-id',name:'My own desktop',expiresAt:Date.now()+86400000}]}});
 });return state;
}
test('a fragment handoff reviews the device automatically, clears the code, and waits for explicit approval',async({page})=>{
 const state=await mockDevice(page),code='ABCD-EFGH-JKLM';await page.goto(base+'/device#code='+code);
 await expect(page.getByRole('heading',{name:'Email on My Mac'})).toBeVisible();await expect(page).toHaveURL(base+'/device');await expect(page.locator('#account-email')).toHaveText('Connected as me@example.com');expect(state.inspected).toEqual([{userCode:code}]);expect(state.approved).toBe(0);expect(state.sessions).toBe(0);
 await expect(page.getByLabel('Desktop linking code')).toBeHidden();await expect(page.locator('#desktop-name img')).toHaveCount(0);await expect(page.getByRole('button',{name:'Approve connection'})).toBeVisible();await page.screenshot({path:`${process.env.BOOKING_SCREENSHOT_DIR||'test-results'}/email-device-connect-desktop.png`,fullPage:true});
 await page.setViewportSize({width:390,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBeTruthy();await page.screenshot({path:`${process.env.BOOKING_SCREENSHOT_DIR||'test-results'}/email-device-connect-mobile.png`,fullPage:true});
 await page.getByRole('button',{name:'Approve connection'}).click();await expect(page.getByRole('heading',{name:'You’re connected'})).toBeVisible();await expect(page.locator('#success-account')).toHaveText('Connected as me@example.com');await expect(page.getByText(/Return to your desktop app to continue/)).toBeVisible();expect(state.approved).toBe(1);
 await page.getByText('Manage connected devices',{exact:true}).click();await expect(page.getByRole('button',{name:'Revoke access'})).toBeVisible();await page.getByRole('button',{name:'Revoke access'}).click();await expect(page.locator('#sessions-status')).toHaveText('Device access revoked.');expect(state.revoked).toBe(1);
});
test('manual code entry remains a fallback and editing a reviewed code requires another review',async({page})=>{
 const state=await mockDevice(page);await page.goto(base+'/device');await expect(page.getByLabel('Desktop linking code')).toBeVisible();await expect(page.getByRole('button',{name:'Approve connection'})).toBeHidden();
 await page.getByLabel('Desktop linking code').fill('ABCD-EFGH-JKLM');await page.getByRole('button',{name:'Continue',exact:true}).click();await expect(page.getByRole('button',{name:'Approve connection'})).toBeVisible();expect(state.approved).toBe(0);
 await page.getByRole('button',{name:'Use a different code'}).click();await expect(page.getByRole('button',{name:'Approve connection'})).toBeHidden();await page.getByLabel('Desktop linking code').fill('NPQR-STUV-WXYZ');await page.getByRole('button',{name:'Continue',exact:true}).click();await expect(page.getByRole('button',{name:'Approve connection'})).toBeVisible();expect(state.inspected).toEqual([{userCode:'ABCD-EFGH-JKLM'},{userCode:'NPQR-STUV-WXYZ'}]);
});
test('signed-out handoff keeps the connection pending until sign-in and explicit approval',async({page})=>{
 const state=await mockDevice(page,{signedIn:false});await page.goto(base+'/device#code=ABCD-EFGH-JKLM');await expect(page.getByRole('link',{name:'Continue with Google'})).toBeVisible();await expect(page.getByRole('button',{name:'Approve connection'})).toBeHidden();expect(state.approved).toBe(0);
 state.signedIn=true;await page.getByRole('button',{name:'I’ve signed in'}).click();await expect(page.getByRole('button',{name:'Approve connection'})).toBeVisible();expect(state.approved).toBe(0);
});
test('Google sign-in returns to the pending device without putting a code in OAuth query or approving automatically',async({page})=>{
 const state=await mockDevice(page,{signedIn:false});const code='ABCD-EFGH-JKLM';
 await page.route('**/auth/google?returnTo=device',route=>{state.signedIn=true;return route.fulfill({contentType:'text/html',body:'<script>location.replace("/device")</script>'});});
 await page.goto(base+'/device#code='+code);await expect(page.getByRole('link',{name:'Continue with Google'})).toHaveAttribute('href','/auth/google?returnTo=device');await page.getByRole('link',{name:'Continue with Google'}).click();
 await expect(page).toHaveURL(base+'/device');await expect(page.getByRole('button',{name:'Approve connection'})).toBeVisible();expect(state.inspected.length).toBeGreaterThanOrEqual(2);expect(state.inspected.every(value=>value.userCode===code)).toBeTruthy();expect(state.approved).toBe(0);
 await page.getByRole('button',{name:'Approve connection'}).click();await expect(page.getByRole('heading',{name:'You’re connected'})).toBeVisible();expect(await page.evaluate(()=>sessionStorage.getItem('email-device-pending'))).toBeNull();
});
test('an expired pending handoff is removed from session storage without inspecting or approving',async({page})=>{
 const state=await mockDevice(page);await page.addInitScript(()=>sessionStorage.setItem('email-device-pending',JSON.stringify({code:'ABCD-EFGH-JKLM',expiresAt:Date.now()-1})));await page.goto(base+'/device');await expect(page.getByLabel('Desktop linking code')).toBeVisible();expect(state.inspected).toHaveLength(0);expect(state.approved).toBe(0);expect(await page.evaluate(()=>sessionStorage.getItem('email-device-pending'))).toBeNull();
});
test('device name and account email are always rendered as text',async({page})=>{
 await mockDevice(page,{name:'My Mac <img src=x>',accountEmail:'me@example.com <script>x</script>'});await page.goto(base+'/device#code=ABCD-EFGH-JKLM');await expect(page.locator('#desktop-name')).toHaveText('My Mac <img src=x>');await expect(page.locator('#account-email')).toHaveText('Connected as me@example.com <script>x</script>');await expect(page.locator('#review img,#review script')).toHaveCount(0);
});
test('settings authorization explicitly describes configuration writes and approves only that reviewed scope',async({page})=>{
 const scope='booking:read email:tracking booking:settings',state=await mockDevice(page,{scope});await page.goto(base+'/device#code=ABCD-EFGH-JKLM');await expect(page.getByRole('button',{name:'Approve settings access'})).toBeVisible();await expect(page.getByText('Allow this device to manage your meeting settings, links, and scheduling profile.')).toBeVisible();expect(state.approved).toBe(0);
 await page.getByText('What you’re allowing',{exact:true}).click();await expect(page.getByText('Create, edit, publish, or remove meeting types and update your scheduling profile.')).toBeVisible();await page.getByRole('button',{name:'Approve settings access'}).click();await expect(page.getByRole('heading',{name:'You’re connected'})).toBeVisible();expect(state.approvals[0].approvedScope).toBe(scope);expect(state.approvals[0].accountEmail).toBe('me@example.com');
});
test('an unbranded device page names no desktop client or operator',async({page})=>{
 await mockDevice(page);await page.goto(base+'/device#code=ABCD-EFGH-JKLM');await expect(page).toHaveTitle('Connect your desktop app');await expect(page.locator('.brand')).toHaveText('s.Scheduling');await expect(page.getByText('Only continue if you started this in your desktop app.')).toBeVisible();
});
test('the device page names only the configured desktop client and brand',async({page})=>{
 await mockDevice(page,{vars:{BRAND_NAME:'Acme',DESKTOP_APP_NAME:'Acme Mail'}});await page.goto(base+'/device#code=ABCD-EFGH-JKLM');await expect(page).toHaveTitle('Connect Acme Mail');await expect(page.locator('.brand')).toHaveText('a.Acme');await expect(page.getByRole('heading',{name:'Connect Acme Mail'})).toBeVisible();await expect(page.getByText('Only continue if you started this in your Acme Mail app.')).toBeVisible();
 await page.getByRole('button',{name:'Approve connection'}).click();await expect(page.getByText(/Return to Acme Mail to continue/)).toBeVisible();await expect(page).toHaveTitle('Connected · Acme');
});
