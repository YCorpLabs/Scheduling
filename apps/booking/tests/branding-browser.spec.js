import {test,expect} from '@playwright/test';
import {DEFAULT} from '../public/policy.js';
const base=process.env.BOOKING_TEST_ORIGIN||'http://127.0.0.1:8791',host='h_abcdefghijklmnopqrstuvwx',start=Date.now()+86400000;
const config={...DEFAULT,id:'intro',slug:'intro',title:'A conversation',host:'Riley',published:true};
async function liveGuest(page,brand){
 await page.route('**/api/**',route=>{const path=new URL(route.request().url()).pathname;return route.fulfill({json:path==='/api/bootstrap'?{mode:'live',authenticated:false,...(brand?{brand}:{})}:path.endsWith('/availability')?{mode:'live',config,slots:[{start,end:start+1800000}]}:{}});});
 await page.goto(base+`/b/${host}/intro`);await expect(page.locator('[data-slot]').first()).toBeVisible();
}
test('an unconfigured instance shows only neutral product identity to guests',async({page})=>{
 await page.goto(base+'/book');await expect(page.locator('[data-slot]').first()).toBeVisible();
 await expect(page).toHaveTitle('Book a conversation · Scheduling');const footer=page.locator('.guest-bottom');await expect(footer.getByRole('link',{name:'Set up your booking page'})).toHaveText('Scheduling');await expect(footer.locator('.legal-link')).toHaveCount(0);
});
test('configured brand and operator links reach the guest booking page',async({page})=>{
 await liveGuest(page,{productName:'Rota',brandName:'Acme',privacyUrl:'https://acme.example.com/privacy',termsUrl:'https://acme.example.com/terms'});
 await expect(page).toHaveTitle('Book a conversation · Acme');const footer=page.locator('.guest-bottom');await expect(footer.getByRole('link',{name:'Set up your booking page'})).toHaveText('Acme');
 await expect(footer.getByRole('link',{name:'Privacy'})).toHaveAttribute('href','https://acme.example.com/privacy');await expect(footer.getByRole('link',{name:'Terms'})).toHaveAttribute('href','https://acme.example.com/terms');await expect(footer.getByRole('link',{name:'Support'})).toHaveCount(0);
 await page.locator('[data-slot]').first().click();await expect(page.locator('#booking-form').getByRole('link',{name:'Privacy',exact:true})).toHaveAttribute('href','https://acme.example.com/privacy');
 await page.setViewportSize({width:390,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBeTruthy();
});
test('embedded booking keeps the configured footer brand',async({page})=>{
 await page.route('**/api/**',route=>{const path=new URL(route.request().url()).pathname;return route.fulfill({json:path==='/api/bootstrap'?{mode:'live',authenticated:false,brand:{brandName:'Acme'}}:path.endsWith('/availability')?{mode:'live',config,slots:[{start,end:start+1800000}]}:{}});});
 await page.goto(base+`/b/${host}/intro?embed=1`);await expect(page.locator('[data-slot]').first()).toBeVisible();await expect(page.locator('.guest-bottom a').first()).toHaveText('Acme');
});
async function studio(page,brand,workspaces){
 await page.route('**/api/**',route=>{const path=new URL(route.request().url()).pathname;let data={revision:'A'.repeat(43),profile:{name:'Riley Quinn'},accounts:[],meetingTypes:[{...DEFAULT,id:'intro',slug:'intro',title:'Intro'}]};if(path==='/api/bootstrap')data={mode:'live',authenticated:true,email:'riley@company.test',hostId:host,...(brand?{brand}:{})};if(path==='/api/live/workspaces')return workspaces?route.fulfill({json:workspaces}):route.fulfill({status:404,json:{error:'Unsupported'}});if(path==='/api/live/calendars')data={accounts:[]};if(path==='/api/live/sessions')data={sessions:[]};if(path==='/api/live/operations')data={generatedAt:Date.now(),issues:[]};return route.fulfill({json:data});});
 await page.goto(base+'/studio#link=intro');await expect(page.locator('#account-trigger')).toBeVisible();
}
test('Studio wordmark and tab title are neutral without configuration',async({page})=>{
 await studio(page);await expect(page.locator('.host-brand .wordmark')).toHaveText('s.Scheduling');await expect(page).toHaveTitle(/ · Scheduling$/);
});
test('Studio wordmark and tab title follow the configured product and brand',async({page})=>{
 await studio(page,{productName:'Rota',brandName:'Acme',privacyUrl:'https://acme.example.com/privacy'});await expect(page.locator('.host-legal').getByRole('link',{name:'Privacy',exact:true})).toHaveAttribute('href','https://acme.example.com/privacy');await expect(page.locator('.host-brand .wordmark')).toHaveText('a.Rota');await expect(page).toHaveTitle(/ · Acme Rota$/);
});
test('a long product name wraps beside the workspace switcher without overflow',async({page})=>{
 const caps=Object.fromEntries(['readBookings','readAnalytics','approveBookings','manageSettings','manageCalendars','manageMembers','manageIntegrations','manageOperations','transferOwnership','grantAdmin'].map(k=>[k,true]));
 const workspaces={workspaces:[{id:host,name:'Personal',role:'owner',personal:true,capabilities:caps},{id:'h_acmeacmeacmeacmeacmeacme',name:'Acme',role:'admin',personal:false,capabilities:caps}],activeWorkspaceId:host};
 await studio(page,{productName:'Scheduling by Acme Labs'},workspaces);const wordmark=page.locator('.host-brand .wordmark');await expect(wordmark).toHaveText('s.Scheduling by Acme Labs');await expect(page.locator('.workspace-switch')).toBeVisible();
 for(const width of [1440,390,320]){
  await page.setViewportSize({width,height:844});
  const fit=await page.evaluate(()=>{const box=s=>document.querySelector(s).getBoundingClientRect(),w=box('.host-brand .wordmark'),sw=box('.workspace-switch'),nav=box('.host-nav');return {page:document.documentElement.scrollWidth<=innerWidth,inside:w.left>=nav.left&&w.right<=nav.right+1,apart:w.right<=sw.left+1||w.bottom<=sw.top+1};});
  expect(fit,`width ${width}`).toEqual({page:true,inside:true,apart:true});
 }
});
