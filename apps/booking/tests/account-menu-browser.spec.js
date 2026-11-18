import {test,expect} from '@playwright/test';import {DEFAULT} from '../public/policy.js';
const base=process.env.BOOKING_TEST_ORIGIN||'http://127.0.0.1:8791';
async function setup(page){let logouts=0;await page.route('**/api/**',route=>{const path=new URL(route.request().url()).pathname;let data={revision:'A'.repeat(43),profile:{name:'Riley Quinn'},accounts:[],meetingTypes:[{...DEFAULT,id:'intro',slug:'intro',title:'Intro'}]};if(path==='/api/bootstrap')data={mode:'live',authenticated:true,email:'riley@company.test',hostId:'h_abcdefghijklmnopqrstuvwx'};if(path==='/api/live/workspaces')return route.fulfill({status:404,json:{error:'Unsupported'}});if(path==='/api/live/calendars')data={accounts:[]};if(path==='/api/live/sessions')data={sessions:[]};if(path==='/api/live/operations')data={generatedAt:Date.now(),issues:[]};return route.fulfill({json:data});});await page.route('**/auth/logout',route=>{logouts++;return route.fulfill({json:{ok:true}});});await page.goto(base+'/studio#link=intro');await expect(page.locator('#account-trigger')).toBeVisible();return {logouts:()=>logouts};}
// The name menu at the top of the sidebar; Settings and Theme are reached through it.
const openMenu=async page=>{await page.locator('#account-trigger').click();const menu=page.getByRole('dialog',{name:'Account',exact:true});await expect(menu).toBeVisible();return menu;};
async function openSettings(page,name){await (await openMenu(page)).getByRole('button',{name:'Settings',exact:true}).click();if(name){const list=page.getByRole('navigation',{name:'Settings'});await ((await list.isVisible())?list.getByRole('button',{name,exact:true}):page.getByRole('button',{name:new RegExp('^'+name)})).click();await expect(page.getByRole('heading',{name,level:1})).toBeVisible();}}
test('the name menu is the name and email, Settings and Sign out, opens below the name and dismisses by keyboard or outside click',async({page})=>{
 await setup(page);const trigger=page.locator('#account-trigger'),menu=page.getByRole('dialog',{name:'Account',exact:true});await expect(page.locator('#account-menu')).toBeHidden();
 await expect(trigger).toHaveText(/RQ\s*Riley Quinn/);await expect(trigger).toHaveAccessibleName('Riley Quinn, account menu');expect((await trigger.boundingBox()).height).toBe(40);
 const nav=await page.getByRole('navigation',{name:'Scheduling'}).boundingBox(),own=await trigger.boundingBox();expect(own.y).toBeLessThan(nav.y);
 await trigger.focus();await page.keyboard.press('ArrowDown');await expect(menu.getByRole('button',{name:'Settings',exact:true})).toBeFocused();
 expect((await menu.boundingBox()).y).toBeGreaterThanOrEqual(own.y+own.height);
 await expect(menu).toContainText('Riley Quinn');await expect(menu).toContainText('riley@company.test');
 await expect(menu.getByRole('button')).toHaveText(['Settings','Sign out']);await expect(menu.getByText('Switch to',{exact:true})).toHaveCount(0);
 for(const gone of ['Edit profile','Change picture','Manage account','Calendar access','Dark mode','Troubleshooting','Light','Dark','Auto','New team'])await expect(menu.getByText(gone,{exact:true})).toHaveCount(0);
 await page.keyboard.press('End');await expect(menu.getByRole('button',{name:'Sign out',exact:true})).toBeFocused();await page.keyboard.press('Escape');await expect(trigger).toBeFocused();await expect(page.locator('#account-menu')).toBeHidden();
 await trigger.click();await page.screenshot({path:`${process.env.BOOKING_SCREENSHOT_DIR||'test-results'}/compact-account-menu.png`,fullPage:true});await page.getByRole('heading',{name:'Intro',exact:true}).click();await expect(page.locator('#account-menu')).toBeHidden();
 await expect(page.getByRole('navigation',{name:'Scheduling'}).getByRole('button',{name:'Settings',exact:true})).toHaveCount(0);
 await (await openMenu(page)).getByRole('button',{name:'Settings',exact:true}).click();await expect(page.getByRole('navigation',{name:'Settings'})).toBeVisible();
});
test('Theme switches in place in Sign-in & data; Auto follows the system',async({page})=>{
 await setup(page);await page.emulateMedia({colorScheme:'dark'});await openSettings(page,'Sign-in & data');const theme=page.getByRole('group',{name:'Theme'});
 await theme.getByRole('button',{name:'Dark',exact:true}).click();await expect(page.locator('html')).toHaveAttribute('data-theme','dark');await expect(page.getByRole('heading',{name:'Sign-in & data',level:1})).toBeVisible();await expect(theme.getByRole('button',{name:'Dark',exact:true})).toHaveAttribute('aria-pressed','true');
 await theme.getByRole('button',{name:'Light',exact:true}).click();await expect(page.locator('html')).toHaveAttribute('data-theme','light');await expect(theme.getByRole('button',{name:'Dark',exact:true})).toHaveAttribute('aria-pressed','false');
 await theme.getByRole('button',{name:'Auto',exact:true}).click();await expect(page.locator('html')).toHaveAttribute('data-theme','dark');
 await page.emulateMedia({colorScheme:'light'});await expect(page.locator('html')).toHaveAttribute('data-theme','light');
 await page.reload();await expect(page.locator('html')).toHaveAttribute('data-theme','light');expect(await page.evaluate(()=>localStorage.getItem('scheduling-theme'))).toBe('auto');
 await expect(page.locator('main').getByRole('button',{name:'Sign out',exact:true})).toBeHidden();
});
test('account actions preserve dirty drafts and sign out is never invoked after keeping edits',async({page})=>{
 const state=await setup(page);await page.getByLabel('Meeting name',{exact:true}).fill('Keep my draft');await page.locator('#account-trigger').click();await page.getByRole('button',{name:'Sign out',exact:true}).click();await page.getByRole('dialog',{name:'Unsaved changes',exact:true}).getByRole('button',{name:'Keep editing',exact:true}).click();expect(state.logouts()).toBe(0);await expect(page.getByLabel('Meeting name',{exact:true})).toHaveValue('Keep my draft');
});
test('on a phone the name menu sits at the top; the tab bar has no Settings; Settings holds Theme and Sign out and there is no sideways scroll',async({page})=>{
 const state=await setup(page);await page.setViewportSize({width:390,height:844});const trigger=page.locator('#account-trigger');await expect(trigger).toBeVisible();expect((await trigger.boundingBox()).y).toBeLessThan(80);
 await expect(page.getByRole('navigation',{name:'Sections'}).getByRole('button',{name:'Settings',exact:true})).toHaveCount(0);
 await openSettings(page,'Sign-in & data');
 const theme=page.getByRole('group',{name:'Theme'});await theme.getByRole('button',{name:'Dark',exact:true}).click();await expect(page.locator('html')).toHaveAttribute('data-theme','dark');
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.screenshot({path:`${process.env.BOOKING_SCREENSHOT_DIR||'test-results'}/compact-account-dark.png`,fullPage:true});
 await page.locator('main').getByRole('button',{name:'Sign out',exact:true}).click();await expect.poll(state.logouts).toBe(1);
});
