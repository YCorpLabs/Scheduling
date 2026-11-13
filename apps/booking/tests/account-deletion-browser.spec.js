import {test,expect} from '@playwright/test';
import {DEFAULT} from '../public/policy.js';
const base=process.env.BOOKING_TEST_ORIGIN||'http://127.0.0.1:8791';
const operationId='h_abcdefghijklmnopqrstuvwx.'+'d'.repeat(32),receipt='r'.repeat(43);
const preparation=extra=>({operationId,receipt,confirmationToken:'signed.confirmation',expiresAt:Date.now()+300000,canDelete:true,blockers:[],impact:{links:1,calendars:1,bookings:3},...extra});
const status=(state='fencing')=>({operationId,state,localDataDeleted:state==='deleted',providerRevocation:'not_requested',needsReview:state==='needs_review',requestedAt:Date.now(),deleteBy:Date.now()+30*86400000});
async function mock(page,options={}){
 const state={requests:[],phase:'fencing',...options};
 await page.route('**/api/**',async route=>{
  const req=route.request(),path=new URL(req.url()).pathname,body=req.postDataJSON?.()??null;
  state.requests.push({path,body,headers:req.headers()});const json=(data,status=200)=>route.fulfill({status,json:data});
  if(path==='/api/live/account/deletion/prepare')return json(state.preparation||preparation());
  if(path==='/api/live/account/deletion/confirm'){if(state.lostConfirm)return route.abort('failed');return json(status(state.phase));}
  if(path==='/api/account/deletion/status')return json(state.statusResponse||status(state.phase));
  if(path==='/api/bootstrap')return json({mode:'live',authenticated:state.signedOut!==true,hostId:'h_me',email:'ada@example.test'});
  if(path==='/api/live/workspaces')return json({workspaces:[{id:'h_me',name:'Ada',role:'owner',personal:true,capabilities:{manageSettings:true,manageCalendars:true,readBookings:true,readAnalytics:true,manageOperations:true,manageIntegrations:true}}],activeWorkspaceId:'h_me'});
  if(path==='/api/live/settings')return json({revision:'A'.repeat(43),hostId:'h_me',profile:{name:'Ada',email:'ada@example.test'},accounts:[],meetingTypes:[{...DEFAULT,id:'intro',slug:'intro',title:'Intro'}]});
  if(path==='/api/live/account/export')return json({schema:1,scope:'account',generatedAt:Date.now(),sections:[],nextCursor:null});
  if(path==='/api/live/calendars')return json({accounts:[]});
  if(path==='/api/live/calendar-contributions')return json({contributions:[]});
  if(path==='/api/live/operations')return json({generatedAt:Date.now(),issues:[]});
  return json({});
 });return state;
}
async function open(page){await page.goto(base+'/studio');await page.locator('#account-trigger').click();await page.getByRole('button',{name:'Manage account',exact:true}).click();await page.getByRole('button',{name:'Delete account…',exact:true}).click();return page.getByRole('dialog',{name:'Delete account',exact:true});}
const confirms=state=>state.requests.filter(r=>r.path.endsWith('/deletion/confirm'));

test('deletion is an explicit confirmation with export available first, and Cancel returns focus',async({page})=>{
 const state=await mock(page);let dialog=await open(page);await expect(dialog.getByRole('heading',{name:'Delete your account?'})).toBeVisible();await expect(dialog.getByText('ada@example.test',{exact:true})).toBeVisible();await expect(dialog.getByRole('button',{name:'Cancel',exact:true})).toBeFocused();expect(confirms(state)).toHaveLength(0);
 await dialog.getByRole('button',{name:'Export data',exact:true}).click();await expect(dialog).toHaveCount(0);await expect(page.getByRole('link',{name:'Download',exact:true})).toBeVisible();
 await page.getByRole('button',{name:'Delete account…',exact:true}).click();dialog=page.getByRole('dialog',{name:'Delete account',exact:true});await expect(dialog.getByRole('heading',{name:'Delete your account?'})).toBeVisible();await page.keyboard.press('Escape');await expect(dialog).toHaveCount(0);await expect(page.getByRole('button',{name:'Delete account…',exact:true})).toBeFocused();expect(confirms(state)).toHaveLength(0);
});

test('owned profiles and bookings block deletion with direct resolution links',async({page})=>{
 const workspaceId='h_acmeacmeacmeacmeacmeacme';const state=await mock(page,{preparation:preparation({canDelete:false,blockers:[{code:'owned_workspace',label:'Transfer ownership of Acme.',workspaceId},{code:'future_bookings',label:'Resolve upcoming bookings.',count:2}]})});
 const dialog=await open(page);await expect(dialog.getByRole('heading',{name:'Resolve these first'})).toBeVisible();await expect(dialog.getByRole('button',{name:'Delete account',exact:true})).toHaveCount(0);await expect(dialog.getByRole('link',{name:'Open Team'})).toHaveAttribute('href','/studio?workspace='+workspaceId+'#team');await expect(dialog.getByRole('link',{name:'Open Bookings'})).toHaveAttribute('href','/studio#bookings');expect(confirms(state)).toHaveLength(0);
});

test('a lost confirm response keeps the receipt and checks status without another destructive call',async({page})=>{
 const state=await mock(page,{lostConfirm:true});const dialog=await open(page);await dialog.getByRole('button',{name:'Delete account',exact:true}).click();await expect(dialog.getByRole('heading',{name:'Check deletion status'})).toBeVisible();await expect(dialog.getByRole('alert')).toContainText('may have been accepted');await page.keyboard.press('Escape');await expect(dialog).toBeVisible();
 expect(await page.evaluate(()=>JSON.parse(sessionStorage.getItem('scheduling.account-deletion.v1')))).toEqual({operationId,receipt});await dialog.getByRole('button',{name:'Check status',exact:true}).click();await expect(dialog.getByRole('heading',{name:'Deletion in progress'})).toBeVisible();expect(confirms(state)).toHaveLength(1);
 const req=state.requests.find(r=>r.path==='/api/account/deletion/status');expect(req.body).toEqual({operationId,receipt});expect(req.headers['x-scheduling-workspace']).toBeUndefined();expect(confirms(state)[0].headers['x-scheduling-account']).toBe('h_me');
});

test('revoked sign-in after reload resumes receipt status rather than asking the deleted account to authenticate',async({page})=>{
 const state=await mock(page,{lostConfirm:true});const dialog=await open(page);await dialog.getByRole('button',{name:'Delete account',exact:true}).click();await expect(dialog.getByRole('heading',{name:'Check deletion status'})).toBeVisible();state.signedOut=true;state.phase='needs_review';await page.reload();
 await expect(page.getByRole('heading',{name:'Deletion needs review'})).toBeVisible();await expect(page.getByText('Access is closed.',{exact:false})).toBeVisible();expect(confirms(state)).toHaveLength(1);await expect(page.getByRole('button',{name:/Sign in with Google/})).toHaveCount(0);
});

test('review stays pending until the server proves erasure, and Done clears only the receipt',async({page})=>{
 const state=await mock(page,{phase:'needs_review'});const dialog=await open(page);await dialog.getByRole('button',{name:'Delete account',exact:true}).click();await expect(dialog.getByRole('heading',{name:'Deletion needs review'})).toBeVisible();await expect(dialog.getByRole('heading',{name:'Account deleted',exact:true})).toHaveCount(0);
 state.phase='deleted';await dialog.getByRole('button',{name:'Check status',exact:true}).click();await expect(dialog.getByRole('heading',{name:'Account deleted',exact:true})).toBeVisible();await expect(dialog.getByText('Your account data has been removed from active storage.')).toBeVisible();await expect(dialog.getByText(/Google permissions were not revoked/)).toBeVisible();await dialog.getByRole('link',{name:'Done',exact:true}).click();expect(await page.evaluate(()=>sessionStorage.getItem('scheduling.account-deletion.v1'))).toBeNull();
});

test('malformed completion is unknown and does not offer a false deleted confirmation',async({page})=>{
 const state=await mock(page,{lostConfirm:true,statusResponse:{...status('deleted'),localDataDeleted:false}});const dialog=await open(page);await dialog.getByRole('button',{name:'Delete account',exact:true}).click();await expect(dialog.getByRole('button',{name:'Check status',exact:true})).toBeVisible();await dialog.getByRole('button',{name:'Check status',exact:true}).click();await expect(dialog.getByRole('heading',{name:'Check deletion status'})).toBeVisible();await expect(dialog.getByRole('heading',{name:'Account deleted',exact:true})).toHaveCount(0);expect(confirms(state)).toHaveLength(1);
});

test('expired preparation requires review again and never confirms an old token',async({page})=>{
 const state=await mock(page,{preparation:preparation({expiresAt:Date.now()-1})});const dialog=await open(page);await dialog.getByRole('button',{name:'Delete account',exact:true}).click();await expect(dialog.getByRole('alert')).toContainText('confirmation expired');expect(confirms(state)).toHaveLength(0);state.preparation=preparation();await dialog.getByRole('button',{name:'Check again',exact:true}).click();await expect(dialog.getByRole('heading',{name:'Delete your account?'})).toBeVisible();
});

test('390px confirmation and pending status fit the viewport and remain keyboard usable',async({page})=>{
 await page.setViewportSize({width:390,height:844});const state=await mock(page,{phase:'needs_review'});const dialog=await open(page);await expect(dialog.getByRole('button',{name:'Cancel',exact:true})).toBeFocused();await page.screenshot({path:'test-results/account-deletion-confirm-phone.png'});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await dialog.getByRole('button',{name:'Delete account',exact:true}).click();await expect(dialog.getByRole('heading',{name:'Deletion needs review'})).toBeFocused();await page.screenshot({path:'test-results/account-deletion-pending-phone.png'});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await dialog.getByRole('button',{name:'Check status',exact:true}).focus();await page.keyboard.press('Enter');await expect(dialog.getByRole('button',{name:'Check status',exact:true})).toBeFocused();expect(confirms(state)).toHaveLength(1);
});

test('blocked browser storage never submits deletion and still lets the user cancel',async({page})=>{
 await page.addInitScript(()=>{const original=Storage.prototype.setItem;Storage.prototype.setItem=function(key,value){if(this===sessionStorage&&key==='scheduling.account-deletion.v1')throw Error('Site storage denied');return original.call(this,key,value);};});
 const state=await mock(page),dialog=await open(page);await dialog.getByRole('button',{name:'Delete account',exact:true}).click();await expect(dialog.getByRole('alert')).toContainText('couldn’t save deletion status');expect(confirms(state)).toHaveLength(0);await dialog.getByRole('button',{name:'Cancel',exact:true}).click();await expect(dialog).toHaveCount(0);await expect(page.getByRole('button',{name:'Delete account…',exact:true})).toBeFocused();
});
