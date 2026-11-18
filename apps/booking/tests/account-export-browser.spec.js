import {test,expect} from '@playwright/test';
import {DEFAULT} from '../public/policy.js';
// Mocked /api/** only. Nothing here reaches Google or the hosted Worker's storage.
const base=process.env.BOOKING_TEST_ORIGIN||'http://127.0.0.1:8791';
const company='h_acmeacmeacmeacmeacmeacme',other='h_betabetabetabetabetabeta';
const caps=role=>({readBookings:true,readAnalytics:true,approveBookings:role!=='viewer',manageSettings:['owner','admin'].includes(role),exportProfile:['owner','admin'].includes(role),manageCalendars:['owner','admin'].includes(role),manageMembers:['owner','admin'].includes(role),manageIntegrations:['owner','admin'].includes(role),manageOperations:['owner','admin'].includes(role),transferOwnership:role==='owner',grantAdmin:role==='owner'});
const settings=(hostId,name)=>({revision:'A'.repeat(43),hostId,profile:{name,email:'ada@example.com'},accounts:[],meetingTypes:[{...DEFAULT,id:'intro',slug:'intro',title:name+' intro'}]});
const page1=(scope,sections,nextCursor)=>({schema:1,generatedAt:1794484800000,scope,sections,nextCursor});

async function mock(page,{role='admin',exports={},sessions=[{id:'s1',current:true,createdAt:Date.now()-3600000,lastSeenAt:Date.now(),expiresAt:Date.now()+86400000}]}={}){
 const state={role,requests:[],exports,held:{},sessions};
 await page.route('**/api/**',async route=>{
  const req=route.request(),path=new URL(req.url()).pathname,ws=req.headers()['x-scheduling-workspace']||null,body=req.postDataJSON?.()??null;
  state.requests.push({path,ws,body,expectedAccount:req.headers()['x-scheduling-account']||null});const json=(data,status=200)=>route.fulfill({status,json:data});
  if(path==='/api/bootstrap')return json({mode:'live',authenticated:true,email:'ada@example.com',hostId:'h_me'});
  if(path==='/api/live/workspaces')return json({workspaces:[{id:'h_me',name:'Ada',role:'owner',personal:true,capabilities:caps('owner')},{id:company,name:'Acme',role:state.role,personal:false,capabilities:caps(state.role)},{id:other,name:'Beta',role:'admin',personal:false,capabilities:caps('admin')}],activeWorkspaceId:'h_me'});
  if(path==='/api/live/account/export'||path==='/api/live/workspace/export'){
   const key=path.includes('account')?'account':'workspace',handler=state.exports[key];
   const reply=typeof handler==='function'?await handler({body,ws,state}):handler;
   if(reply?.hold)await new Promise(resolve=>{state.held[key]=resolve;});
   return json(reply.json,reply.status||200);
  }
  if(path==='/api/live/settings')return json(ws?{...settings(ws,ws===company?'Acme':'Beta'),workspace:{id:ws,role:state.role,capabilities:caps(state.role)}}:settings('h_me','Ada'));
  if(path==='/api/live/workspace')return json({members:[{id:'h_me',email:'ada@example.com',role:state.role},{id:'h_owner',email:'owner@acme.test',role:'owner'}],invitations:[]});
  if(path==='/api/live/sessions')return json({sessions:state.sessions});
  if(path==='/api/live/sessions/revoke')return json({revoked:true});
  if(path==='/api/live/calendars')return json({accounts:[]});
  if(path==='/api/live/calendar-contributions')return json({contributions:[]});
  if(path==='/api/live/operations')return json({generatedAt:Date.now(),issues:[]});
  return json({});
 });
 return state;
}
// Pages are served from a script keyed by cursor so repeated reads are idempotent.
const paged=(scope,script)=>({body})=>{const step=script[body?.cursor??'start'];return typeof step==='function'?step():step;};
async function downloaded(page,click){const [download]=await Promise.all([page.waitForEvent('download'),click()]);const chunks=[];for await(const chunk of await download.createReadStream())chunks.push(chunk);return {name:download.suggestedFilename(),json:JSON.parse(Buffer.concat(chunks).toString('utf8'))};}
const exportRequests=state=>state.requests.filter(r=>r.path.endsWith('/export'));
// The name menu at the top of the sidebar holds the profiles, Settings and Sign out.
const openMenu=async page=>{await page.locator('#account-trigger').click();const menu=page.getByRole('dialog',{name:'Account',exact:true});await expect(menu).toBeVisible();return menu;};
async function openSettings(page,name){await (await openMenu(page)).getByRole('button',{name:'Settings',exact:true}).click();if(name){const list=page.getByRole('navigation',{name:'Settings'});await ((await list.isVisible())?list.getByRole('button',{name}):page.getByRole('button',{name:new RegExp('^'+name)})).click();await expect(page.getByRole('heading',{name,level:1})).toBeVisible();}}
const switchTo=async(page,name)=>(await openMenu(page)).getByRole('group',{name:'Switch to'}).getByRole('button',{name:new RegExp(name)}).click();

test('Sign-in & data lists browsers inline; another browser signs out after a confirmation',async({page})=>{
 const state=await mock(page,{sessions:[{id:'s1',current:true,createdAt:Date.now()-3600000,lastSeenAt:Date.now(),expiresAt:Date.now()+86400000},{id:'s2',device:'Safari on iPhone',mobile:true,createdAt:Date.now()-9*86400000,lastSeenAt:Date.now()-3*86400000-60000,expiresAt:Date.now()+86400000}]});
 await page.goto(base+'/studio');await openMenu(page);
 // The name menu holds who is signed in, the profiles, Settings and Sign out; browsers are in Settings.
 await expect(page.locator('#account-menu button')).toHaveText([/Ada/,/Acme/,/Beta/,'Settings','Sign out']);
 await page.keyboard.press('Escape');await expect(page.locator('#account-trigger')).toBeFocused();
 await openSettings(page,'Sign-in & data');
 await expect(page.getByRole('heading',{name:'Sign-in & data',level:1})).toBeVisible();await expect(page.getByText('You sign in with Google as ada@example.com.',{exact:true})).toBeVisible();
 await expect(page.getByText('This browser',{exact:true})).toBeVisible();await expect(page.getByText('Last used 3 days ago',{exact:true})).toBeVisible();
 await expect(page.getByRole('button',{name:/^Sign out/})).toHaveCount(1);
 await page.screenshot({path:`${process.env.BOOKING_SCREENSHOT_DIR||'test-results'}/account-export-desktop.png`});
 const signOut=page.getByRole('button',{name:'Sign out Safari on iPhone',exact:true});await signOut.click();
 const confirm=page.getByRole('dialog',{name:'Sign out this browser?'});await expect(confirm.getByText('Anyone using that browser will need to sign in again.')).toBeVisible();
 await confirm.getByRole('button',{name:'Cancel',exact:true}).click();await expect(signOut).toBeFocused();expect(state.requests.filter(r=>r.path==='/api/live/sessions/revoke')).toHaveLength(0);
 await signOut.click();state.sessions=state.sessions.slice(0,1);await page.getByRole('dialog',{name:'Sign out this browser?'}).getByRole('button',{name:'Sign out',exact:true}).click();
 await expect(page.getByText('Safari on iPhone')).toHaveCount(0);expect(state.requests.filter(r=>r.path==='/api/live/sessions/revoke').map(r=>[r.ws,r.body])).toEqual([[null,{id:'s2'}]]);
});

test('account export reads every page without a profile header and downloads only when complete',async({page})=>{
 let release;const state=await mock(page,{exports:{account:paged('account',{start:{json:page1('account',[{name:'profile',data:{name:'Ada'}}],'c1')},c1:()=>new Promise(r=>{release=()=>r({json:page1('account',[{name:'bookings',data:[{id:'b1'}]}],'c2')});}),c2:{json:page1('account',[{name:'bookings',data:[{id:'b2'}]}],null)}})}});
 // The account export never sends the open team's header, even from a team.
 await page.goto(base+`/studio?workspace=${company}`);await expect(page.locator('#account-trigger')).toHaveText(/Acme/);await openSettings(page,'Sign-in & data');
 const dialog=page.locator('[data-account-export]');await expect(dialog.getByText('Everything Scheduling stores about you',{exact:true})).toBeVisible();await dialog.getByRole('button',{name:'Download your data',exact:true}).click();
 await expect(dialog.getByRole('status').filter({hasText:'Preparing export…'})).toBeVisible();await expect(dialog.getByRole('link',{name:'Download'})).toHaveCount(0);
 await expect.poll(()=>!!release).toBe(true);release();
 const link=dialog.getByRole('link',{name:'Download',exact:true});await expect(link).toBeVisible();
 const file=await downloaded(page,()=>link.click());expect(file.name).toMatch(/^scheduling-account-\d{4}-\d{2}-\d{2}\.json$/);
 expect(file.json.sections).toEqual([{name:'profile',data:{name:'Ada'}},{name:'bookings',data:[{id:'b1'},{id:'b2'}]}]);
 expect(exportRequests(state).map(r=>[r.ws,r.body])).toEqual([[null,{}],[null,{cursor:'c1'}],[null,{cursor:'c2'}]]);
 const href=await link.getAttribute('href');await page.getByRole('button',{name:'Back',exact:true}).click();await expect(dialog).toHaveCount(0);
 expect(await page.evaluate(async url=>{try{await fetch(url);return 'readable';}catch{return 'revoked';}},href)).toBe('revoked');
});

test('a failed page can be retried from its cursor; changed data discards and needs Export again',async({page})=>{
 let failOnce=true;const state=await mock(page,{exports:{account:paged('account',{start:{json:page1('account',[{name:'a',data:[1]}],'c1')},c1:()=>failOnce?(failOnce=false,{status:503,json:{error:'Unavailable'}}):{json:page1('account',[{name:'a',data:[2]}],'c2')},c2:{status:409,json:{error:'Your data changed.',code:'export_changed'}}})}});
 await page.goto(base+'/studio#settings/account');
 const dialog=page.locator('[data-account-export]');await dialog.getByRole('button',{name:'Download your data',exact:true}).click();
 await expect(dialog.getByRole('alert')).toContainText('Export paused');await expect(dialog.getByRole('link',{name:'Download'})).toHaveCount(0);
 await expect(dialog.getByRole('button',{name:'Try again',exact:true})).toBeFocused();await page.keyboard.press('Enter');
 await expect(dialog.getByRole('alert')).toContainText('Data changed during export');await expect(dialog.getByRole('link',{name:'Download'})).toHaveCount(0);
 expect(exportRequests(state).map(r=>r.body)).toEqual([{},{cursor:'c1'},{cursor:'c1'},{cursor:'c2'}]);
 await expect(dialog.getByRole('button',{name:'Try again',exact:true})).toBeFocused();
 state.exports.account={json:page1('account',[{name:'a',data:[9]}],null)};await page.keyboard.press('Enter');
 expect((await downloaded(page,()=>dialog.getByRole('link',{name:'Download',exact:true}).click())).json.sections).toEqual([{name:'a',data:[9]}]);
 expect(exportRequests(state).at(-1).body).toEqual({});
});

test('profile export appears only with the capability and names the selected profile',async({page})=>{
 for(const role of ['member','viewer']){const state=await mock(page,{role});await page.goto(base+`/studio?workspace=${company}#team`);await expect(page.getByRole('heading',{name:'Members'})).toBeVisible();await expect(page.getByRole('button',{name:/^Export/})).toHaveCount(0);await page.unrouteAll();void state;}
 const state=await mock(page,{role:'admin',exports:{workspace:paged('workspace',{start:{json:page1('workspace',[{name:'members',data:[{id:'m1'}]}],'w1')},w1:{json:page1('workspace',[{name:'members',data:[{id:'m2'}]}],null)}})}});
 await page.goto(base+`/studio?workspace=${company}#team`);await expect(page.getByRole('heading',{name:'Acme',exact:true})).toBeVisible();
 await page.getByRole('button',{name:'Export Acme data',exact:true}).click();
 const file=await downloaded(page,()=>page.getByRole('link',{name:'Download',exact:true}).click());expect(file.name).toMatch(/^scheduling-acme-/);expect(file.json.scope).toBe('workspace');
 expect(exportRequests(state).every(r=>r.ws===company)).toBe(true);
 await page.goto(base+'/studio#team');await expect(page.getByRole('button',{name:/^Export .* data$/})).toHaveCount(0);
});

test('role loss stops profile export without a cached download',async({page})=>{
 const state=await mock(page,{role:'admin',exports:{workspace:paged('workspace',{start:{json:page1('workspace',[{name:'members',data:[]}],'w1')},w1:()=>{state.role='member';return {status:403,json:{error:'You do not have access.'}};}})}});
 await page.goto(base+`/studio?workspace=${company}#team`);await page.getByRole('button',{name:'Export Acme data',exact:true}).click();
 await expect(page.getByRole('link',{name:'Download'})).toHaveCount(0);
 await expect(page.getByRole('button',{name:/^Export .*data$|^Export again$/})).toHaveCount(0);
 await expect.poll(()=>state.requests.filter(r=>r.path==='/api/live/workspaces').length).toBeGreaterThan(1);
});

test('switching profile mid-export ignores the late page',async({page})=>{
 const state=await mock(page,{role:'admin',exports:{workspace:()=>({hold:true,json:page1('workspace',[{name:'members',data:[]}],null)})}});
 await page.goto(base+`/studio?workspace=${company}#team`);await page.getByRole('button',{name:'Export Acme data',exact:true}).click();
 await expect(page.getByRole('status').filter({hasText:'Preparing export…'})).toBeVisible();
 await switchTo(page,'Beta');await expect(page.getByRole('heading',{name:'Beta',exact:true})).toBeVisible();
 await expect.poll(()=>!!state.held.workspace).toBe(true);state.held.workspace();
 await page.waitForTimeout(200);await expect(page.getByRole('link',{name:'Download'})).toHaveCount(0);await expect(page.getByRole('button',{name:'Export Beta data',exact:true})).toBeVisible();
 expect(exportRequests(state).map(r=>r.ws)).toEqual([company]);
});

test('390 px: Settings opens from the name menu as a list, Sign-in & data fits, and export is usable by keyboard',async({page})=>{
 await page.setViewportSize({width:390,height:844});await mock(page,{exports:{account:{json:page1('account',[{name:'a',data:[]}],null)}}});await page.goto(base+'/studio');
 await expect(page.getByRole('navigation',{name:'Sections'}).getByRole('button',{name:'Settings',exact:true})).toHaveCount(0);await (await openMenu(page)).getByRole('button',{name:'Settings',exact:true}).click();
 await expect(page.getByRole('heading',{name:'Settings',level:1})).toBeVisible();await page.getByRole('button',{name:/^Sign-in & data/}).click();
 await expect(page.getByRole('heading',{name:'Sign-in & data',level:1})).toBeVisible();await expect(page.getByRole('button',{name:'Settings',exact:true}).first()).toBeVisible();
 const start=page.getByRole('button',{name:'Download your data',exact:true});await start.focus();await page.keyboard.press('Enter');
 const link=page.getByRole('link',{name:'Download',exact:true});await expect(link).toBeFocused();
 // Theme is on this page on every size; on phones Sign out is here too.
 await expect(page.getByRole('group',{name:'Theme'})).toBeVisible();await expect(page.getByRole('button',{name:'Sign out',exact:true})).toBeVisible();
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 await page.screenshot({path:(process.env.BOOKING_SCREENSHOT_DIR||'test-results')+'/account-export-390.png',fullPage:true});
});


test('a stale account tab refuses export after the shared signed-in identity changes',async({page})=>{
 const state=await mock(page,{exports:{account:{status:409,json:{error:'Account changed',code:'export_account_changed'}}}});await page.goto(base+'/studio#settings/account');
 const dialog=page.locator('[data-account-export]');await dialog.getByRole('button',{name:'Download your data',exact:true}).click();
 await expect(dialog.getByRole('alert')).toContainText('The signed-in account changed. Reload Scheduling.');await expect(dialog.getByRole('link',{name:'Download'})).toHaveCount(0);await expect(dialog.getByRole('button',{name:'Try again'})).toHaveCount(0);
 expect(exportRequests(state).map(r=>r.expectedAccount)).toEqual(['h_me']);
});
