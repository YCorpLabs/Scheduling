import {test,expect} from '@playwright/test';
import {readFileSync} from 'node:fs';
import {DEFAULT,validateConfig} from '../public/policy.js';
import {validateBrandImage} from '../public/branding.js';
const base=process.env.BOOKING_TEST_ORIGIN||'http://127.0.0.1:8791';
const fixture=kind=>new URL('./fixtures/'+kind+'.jpg',import.meta.url).pathname;
async function setup(page,{allowMeetings=false}={}){
 let saved={revision:'A'.repeat(43),profile:{name:'Ada Lind',company:'',email:'owner@example.com'},accounts:[],meetingTypes:[{...DEFAULT,id:'intro',slug:'intro',title:'Intro call',duration:30,locationType:'google_meet',published:false}]};const writes=[];
 await page.route('**/api/**',async route=>{const path=new URL(route.request().url()).pathname;let data=saved;
 if(path==='/api/bootstrap')data={mode:'live',authenticated:true,hostId:'h_abcdefghijklmnopqrstuvwx',email:'owner@example.com'};
 if(path==='/api/live/calendars')data={accounts:[]};
 if(path==='/api/live/settings'&&route.request().method()==='POST'){const body=route.request().postDataJSON();expect(body.expectedRevision).toBe(saved.revision);expect(Object.keys(body.patch)).toEqual(body.patch.profile?['profile']:allowMeetings?['meetingTypes']:['profile']);if(body.patch.profile)for(const key of Object.keys(body.patch.profile))if(key.endsWith('Image'))validateBrandImage(body.patch.profile[key],key);if(body.patch.meetingTypes)body.patch.meetingTypes.forEach(validateConfig);writes.push(body);saved={...saved,...(body.patch.meetingTypes?{meetingTypes:body.patch.meetingTypes}:{}),profile:{...saved.profile,...body.patch.profile},revision:String.fromCharCode(66+writes.length).repeat(43)};data={settings:saved,revision:saved.revision};}
 return route.fulfill({json:data});});await page.goto(base+'/studio#link=intro');return {writes,get profile(){return saved.profile;},get settings(){return saved;}};
}
// Settings → Profile stages photo and banner crops with name and company; one Save writes them.
async function pick(page,label,kind){const pickerPromise=page.waitForEvent('filechooser');await page.getByRole('button',{name:label,exact:true}).click();await (await pickerPromise).setFiles(fixture(kind));}
async function crop(page,label,kind,{cancel=false}={}){
 await pick(page,label,kind);const dialog=page.getByRole('dialog',{name:/Crop /});await expect(dialog).toBeVisible();
 if(cancel){await dialog.getByRole('button',{name:'Cancel',exact:true}).click();await expect(dialog).toHaveCount(0);return;}
 await dialog.getByLabel('Zoom',{exact:true}).focus();await page.keyboard.press('End');await dialog.getByLabel('Horizontal position',{exact:true}).focus();await page.keyboard.press('End');expect(await dialog.locator('canvas').evaluate(canvas=>canvas.getContext('2d').getImageData(0,0,1,1).data[0])).toBeLessThan(120);
 await dialog.getByRole('button',{name:'Use image',exact:true}).click();await expect(dialog).toHaveCount(0);
}
const openProfile=async page=>{await page.getByRole('button',{name:'Settings',exact:true}).click();await expect(page.getByRole('heading',{name:'Profile',level:1})).toBeVisible();};

test('profile edits photo, banner, name and company with a live preview and saves once',async({page})=>{
 const state=await setup(page);await openProfile(page);
 await expect(page.getByText('Guests see this on your booking pages.',{exact:true})).toBeVisible();
 const card=page.locator('[data-profile-card]');await expect(card).toContainText('Ada Lind');await expect(card).toContainText('Intro call');await expect(card).toContainText('30 minutes · Google Meet');
 await page.getByLabel('Name',{exact:true}).fill('Ada Morgan');await page.getByLabel('Company',{exact:true}).fill('Fernhill');
 await expect(card.locator('.pf-card-name')).toHaveText('Ada Morgan');await expect(card.locator('.pf-card-company')).toHaveText('Fernhill');await expect(card.locator('.pf-card-avatar')).toHaveText('AM');
 await crop(page,'Change photo','avatar');await crop(page,'Add banner','banner');
 await expect(page.getByLabel('Name',{exact:true})).toHaveValue('Ada Morgan');await expect(card.locator('.pf-card-avatar img')).toBeVisible();await expect(card.locator('.pf-card-banner')).toBeVisible();
 await expect(page.getByRole('button',{name:'Remove photo',exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'Change banner',exact:true})).toBeVisible();expect(state.writes).toHaveLength(0);
 await page.getByRole('button',{name:'Save',exact:true}).click();await expect(page.locator('#host-status')).toHaveText('Saved');
 expect(state.writes).toHaveLength(1);expect(Object.keys(state.writes[0].patch.profile).sort()).toEqual(['avatarImage','bannerImage','company','name']);expect(state.profile).toMatchObject({name:'Ada Morgan',company:'Fernhill'});
 await expect(page.locator('#account-trigger')).toContainText('Ada Morgan');await expect(page.locator('#account-trigger .host-avatar img')).toBeVisible();
 await page.screenshot({path:`${process.env.BOOKING_SCREENSHOT_DIR||'test-results'}/scheduling-profile-desktop.png`,fullPage:true});
});

test('cancelled crops change nothing; removal needs Save; leaving with unsaved edits asks first',async({page})=>{
 const state=await setup(page);await openProfile(page);
 await crop(page,'Change photo','avatar',{cancel:true});await expect(page.getByRole('button',{name:'Remove photo',exact:true})).toBeHidden();
 await crop(page,'Change photo','avatar');await page.getByRole('button',{name:'Back',exact:true}).click();
 const ask=page.getByRole('dialog',{name:'Unsaved changes',exact:true});await expect(ask).toBeVisible();await ask.getByRole('button',{name:'Keep editing',exact:true}).click();
 await expect(page.getByRole('heading',{name:'Profile',level:1})).toBeVisible();await expect(page.locator('.pf-avatar img')).toBeVisible();expect(state.writes).toHaveLength(0);
 const save=async()=>{await page.getByRole('button',{name:'Save',exact:true}).click();await expect(page.getByRole('button',{name:'Save',exact:true})).toBeEnabled();await expect(page.locator('#host-status')).toHaveText('Saved');};
 await save();expect(state.writes).toHaveLength(1);
 await page.getByRole('button',{name:'Remove photo',exact:true}).click();await expect(page.getByRole('button',{name:'Change photo',exact:true})).toBeFocused();expect(state.writes).toHaveLength(1);
 await save();expect(state.writes).toHaveLength(2);expect(state.writes[1].patch.profile).toEqual({avatarImage:null});expect(state.profile.avatarImage).toBeNull();
 await page.getByLabel('Name',{exact:true}).fill(' ');await page.getByRole('button',{name:'Save',exact:true}).click();await expect(page.getByRole('alert')).toHaveText('Enter a name.');await expect(page.getByLabel('Name',{exact:true})).toBeFocused();expect(state.writes).toHaveLength(2);
});

test('a save conflict keeps the edits, and Profile fits a phone with ‹ Settings',async({page})=>{
 await page.setViewportSize({width:360,height:780});await setup(page);await expect(page.locator('#account-trigger')).toBeHidden();
 await page.getByRole('navigation',{name:'Sections'}).getByRole('button',{name:'Settings',exact:true}).click();await page.getByRole('button',{name:/^Profile/}).click();await expect(page.getByRole('heading',{name:'Profile',level:1})).toBeVisible();
 await crop(page,'Add banner','banner');
 await page.route('**/api/live/settings',route=>route.request().method()==='POST'?route.fulfill({status:409,json:{error:'Settings changed. Reload before saving.',code:'settings_conflict'}}):route.fulfill({json:{revision:'Z'.repeat(43),profile:{name:'Ada Lind',avatarImage:null,bannerImage:null},accounts:[],meetingTypes:[]}}));
 await page.getByRole('button',{name:'Save',exact:true}).click();await expect(page.getByRole('alert')).toContainText('Your profile changed elsewhere. Your edits are still here.');await expect(page.locator('.pf-banner img')).toBeVisible();
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 await page.screenshot({path:`${process.env.BOOKING_SCREENSHOT_DIR||'test-results'}/scheduling-profile-mobile.png`,fullPage:true});
 await page.getByRole('button',{name:'Settings',exact:true}).first().click();await expect(page.getByRole('dialog',{name:'Unsaved changes',exact:true})).toBeVisible();
});
test('guest branding stays present through selecting a time and Back, in light and dark',async({page})=>{
 const image=kind=>'data:image/jpeg;base64,'+readFileSync(fixture(kind)).toString('base64');
 for(const theme of ['light','dark']){
  await page.setViewportSize(theme==='dark'?{width:390,height:844}:{width:1280,height:800});await page.unrouteAll();const start=Date.now()+86400000;await page.route('**/api/**',route=>route.fulfill({json:route.request().url().endsWith('/bootstrap')?{mode:'local'}:{config:{...DEFAULT,theme,avatarImage:image('avatar'),bannerImage:image('banner')},slots:[{start,end:start+1800000}]}}));await page.goto(base+'/book?embed=1');await expect(page.locator('.host-banner')).toBeVisible();const banner=await page.locator('.host-banner').boundingBox();expect(Math.abs(banner.width/banner.height-3)).toBeLessThan(.02);await expect(page.locator('.avatar img')).toBeVisible();await page.locator('.slot').first().click();await expect(page.locator('.host-banner')).toBeVisible();await expect(page.getByLabel('Your name',{exact:true})).toBeFocused();await page.keyboard.press('Escape');await expect(page.locator('.slot.chosen')).toBeFocused();await expect(page.locator('.host-banner')).toBeVisible();await expect.poll(()=>page.locator('#app').evaluate(app=>app.getAnimations({subtree:true}).filter(a=>a.playState==='running').length)).toBe(0);await page.screenshot({path:`${process.env.BOOKING_SCREENSHOT_DIR||'test-results'}/scheduling-profile-guest-${theme}.png`});
 }
});

test('Name and picture in a dirty link asks before leaving, and unsupported files leave the profile intact',async({page})=>{
 const state=await setup(page);await page.getByLabel('Meeting name',{exact:true}).fill('Keep this edit');
 await page.locator('#meeting-form .le-rows').waitFor().then(()=>page.evaluate(()=>document.querySelectorAll('#meeting-form details.le-row').forEach(d=>d.open=true)));
 await page.getByRole('button',{name:'Name and picture ↗',exact:true}).click();const ask=page.getByRole('dialog',{name:'Unsaved changes',exact:true});await expect(ask).toBeVisible();
 await ask.getByRole('button',{name:'Keep editing',exact:true}).click();await expect(page.getByLabel('Meeting name',{exact:true})).toHaveValue('Keep this edit');
 await page.getByRole('button',{name:'Name and picture ↗',exact:true}).click();await page.getByRole('dialog',{name:'Unsaved changes',exact:true}).getByRole('button',{name:'Discard changes',exact:true}).click();
 await expect(page.getByRole('heading',{name:'Profile',level:1})).toBeVisible();
 const pickerPromise=page.waitForEvent('filechooser');await page.getByRole('button',{name:'Change photo',exact:true}).click();await (await pickerPromise).setFiles({name:'image.svg',mimeType:'image/svg+xml',buffer:Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>')});
 await expect(page.getByRole('alert')).toContainText('PNG, JPEG or WebP');await expect(page.getByRole('dialog',{name:/Crop /})).toHaveCount(0);expect(state.writes).toHaveLength(0);
});
