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
async function studio(page,brand,workspaces,name='Riley Quinn'){
 await page.route('**/api/**',route=>{const path=new URL(route.request().url()).pathname;let data={revision:'A'.repeat(43),profile:{name},accounts:[],meetingTypes:[{...DEFAULT,id:'intro',slug:'intro',title:'Intro'}]};if(path==='/api/bootstrap')data={mode:'live',authenticated:true,email:'riley@company.test',hostId:host,...(brand?{brand}:{})};if(path==='/api/live/workspaces')return workspaces?route.fulfill({json:workspaces}):route.fulfill({status:404,json:{error:'Unsupported'}});if(path==='/api/live/calendars')data={accounts:[]};if(path==='/api/live/sessions')data={sessions:[]};if(path==='/api/live/operations')data={generatedAt:Date.now(),issues:[]};return route.fulfill({json:data});});
 await page.goto(base+'/studio#link=intro');await expect(page.locator('#account-trigger')).toBeVisible();
}
// The sidebar's top row is always the name menu, also on older APIs without teams; the product name is in the tab title.
const openSettings=async(page,name)=>{await page.locator('#account-trigger').click();await page.locator('#account-menu').getByRole('button',{name:'Settings',exact:true}).click();await page.getByRole('navigation',{name:'Settings'}).getByRole('button',{name}).click();};
test('Studio tab title is neutral without configuration and the name menu is the top row',async({page})=>{
 await studio(page);await expect(page.locator('.host-brand #account-trigger')).toHaveText(/Riley Quinn/);await expect(page.locator('.host-brand .sb-brand')).toHaveCount(0);await expect(page).toHaveTitle(/ · Scheduling$/);
});
test('Studio tab title follows the configured product and brand',async({page})=>{
 await studio(page,{productName:'Rota',brandName:'Acme',privacyUrl:'https://acme.example.com/privacy'});await expect(page.locator('.host-brand .sb-brand')).toHaveCount(0);await expect(page).toHaveTitle(/ · Acme Rota$/);
 // Operator links are in Settings → Sign-in & data, not in the sidebar.
 await expect(page.locator('.host-nav').getByRole('link',{name:'Privacy'})).toHaveCount(0);
 await openSettings(page,'Sign-in & data');
 await expect(page.locator('.st-legal').getByRole('link',{name:'Privacy',exact:true})).toHaveAttribute('href','https://acme.example.com/privacy');
});
test('a long name stays inside the sidebar, and with a team the same menu shows the profiles',async({page})=>{
 await studio(page,{productName:'Scheduling by Acme Labs and Friends'},undefined,'Riley Quinn-Featherstonehaugh of the Acme Labs and Friends');const row=page.locator('#account-trigger');await expect(row).toHaveText(/Riley Quinn-Featherstonehaugh/);
 for(const width of [1440,390,320]){
  await page.setViewportSize({width,height:844});
  const fit=await page.evaluate(()=>{const w=document.querySelector('#account-trigger').getBoundingClientRect(),nav=document.querySelector('.host-nav').getBoundingClientRect();return {page:document.documentElement.scrollWidth<=innerWidth,inside:w.left>=nav.left&&w.right<=nav.right+1};});
  expect(fit,`width ${width}`).toEqual({page:true,inside:true});
 }
 const caps=Object.fromEntries(['readBookings','readAnalytics','approveBookings','manageSettings','manageCalendars','manageMembers','manageIntegrations','manageOperations','transferOwnership','grantAdmin'].map(k=>[k,true]));
 const workspaces={workspaces:[{id:host,name:'Personal',role:'owner',personal:true,capabilities:caps},{id:'h_acmeacmeacmeacmeacmeacme',name:'Acme',role:'admin',personal:false,capabilities:caps}],activeWorkspaceId:host};
 await page.unrouteAll();await page.goto('about:blank');await page.setViewportSize({width:1440,height:844});await studio(page,{productName:'Scheduling by Acme Labs'},workspaces);
 await expect(page.locator('#account-trigger')).toHaveText(/Riley Quinn/);await page.locator('#account-trigger').click();
 await expect(page.locator('#account-menu').getByRole('group',{name:'Switch to'}).getByRole('button')).toHaveText([/Riley Quinn/,/Acme/]);await expect(page.locator('.host-brand .sb-brand')).toHaveCount(0);await expect(page).toHaveTitle(/ · Scheduling by Acme Labs$/);
});
