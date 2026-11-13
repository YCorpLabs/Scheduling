import {test,expect} from '@playwright/test';
import {DEFAULT} from '../public/policy.js';
const base=process.env.BOOKING_TEST_ORIGIN||'http://127.0.0.1:8791';
const publicPath='/b/h_abcdefghijklmnopqrstuvwx/intro';
async function guest(page,{motion='smooth',query='',local=false}={}){
 const tomorrow=new Date();tomorrow.setUTCDate(tomorrow.getUTCDate()+1);tomorrow.setUTCHours(12,0,0,0);const start=tomorrow.getTime();
 const config={...DEFAULT,host:'Ada Lind',company:'',title:'Intro call',questions:[],zone:'UTC',motion};
 const slots=[0,1,2,32].map(day=>({start:start+day*86400000,end:start+day*86400000+1800000}));
 await page.route('**/api/**',route=>{const path=new URL(route.request().url()).pathname;if(path.endsWith('/visit'))return route.fulfill({json:{ok:true}});expect(route.request().method()).toBe('GET');return route.fulfill({json:path==='/api/bootstrap'?{mode:local?'local':'live',authenticated:false}:{config,slots}});});
 await page.addInitScript(()=>{window.motionCalls=[];const animate=Element.prototype.animate;Element.prototype.animate=function(frames,options){window.motionCalls.push({className:this.className,duration:options.duration});return animate.call(this,frames,options);};});
 await page.goto(base+(local?'/book':publicPath)+query);
 await expect(page.locator('[data-slot]').first()).toBeVisible();
}
test('date changes preserve the surrounding component; steps keep one width and keyboard state',async({page})=>{
 await guest(page);const host=await page.locator('.host-intro').elementHandle(),card=await page.locator('.booking').boundingBox();
 await page.locator('.date-cell.available').nth(1).click();
 expect(await host.evaluate(node=>node.isConnected)).toBe(true);
 await expect(page.locator('.date-cell.selected')).toBeFocused();
 expect(await page.evaluate(()=>window.motionCalls.some(call=>call.className==='time-list'&&call.duration===160))).toBe(true);
 await page.locator('[data-slot]').first().click();
 const details=await page.locator('.booking.details').boundingBox();expect(Math.abs(details.x-card.x)).toBeLessThan(1);expect(Math.abs(details.width-card.width)).toBeLessThan(1);
 await expect(page.getByLabel('Your name',{exact:true})).toBeFocused();await page.getByLabel('Your name',{exact:true}).fill('Alex');
 await page.keyboard.press('Escape');await expect(page.locator('.slot.chosen')).toBeFocused();
 await page.locator('.slot.chosen').click();await expect(page.getByLabel('Your name',{exact:true})).toHaveValue('Alex');
});
test('host and embed preferences disable motion; reduced motion always wins',async({page})=>{
 for(const options of [{motion:'none'},{motion:'smooth',query:'?motion=none'},{motion:'none',query:'?motion=smooth'}]){
  await page.unrouteAll();await guest(page,options);await page.locator('[data-slot]').first().click();
  const enabled=options.query==='?motion=smooth';await expect(page.locator('html')).toHaveAttribute('data-motion',enabled?'smooth':'none');
  expect(await page.evaluate(()=>window.motionCalls.length>0)).toBe(enabled);
 }
 await page.emulateMedia({reducedMotion:'reduce'});await page.unrouteAll();await guest(page,{query:'?motion=smooth'});
 await page.locator('[data-slot]').first().click();await expect(page.locator('html')).toHaveAttribute('data-motion','none');expect(await page.evaluate(()=>window.motionCalls)).toEqual([]);
 await page.emulateMedia({reducedMotion:'no-preference'});await expect(page.locator('html')).toHaveAttribute('data-motion','smooth');
 await page.keyboard.press('Escape');expect(await page.evaluate(()=>window.motionCalls.length)).toBeGreaterThan(0);
 await page.emulateMedia({reducedMotion:'reduce'});await expect(page.locator('html')).toHaveAttribute('data-motion','none');await expect.poll(()=>page.locator('#app').evaluate(app=>app.getAnimations({subtree:true}).filter(a=>a.playState==='running').length)).toBe(0);
});
test('mobile details stay within the frame and instant mode has no smooth scrolling',async({page})=>{
 await page.setViewportSize({width:360,height:780});await guest(page,{motion:'none'});
 await page.evaluate(()=>{window.scrollChoices=[];const scroll=Element.prototype.scrollIntoView;Element.prototype.scrollIntoView=function(options){window.scrollChoices.push(options.behavior);return scroll.call(this,options);};});
 await page.locator('.date-cell.available').nth(1).click();expect(await page.evaluate(()=>window.scrollChoices)).toContain('instant');
 await page.locator('[data-slot]').first().click();await expect(page.getByLabel('Your name',{exact:true})).toBeFocused();
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 await page.keyboard.press('Escape');await expect(page.locator('.slot.chosen')).toBeFocused();
});
test('inline and popup embeds forward the component motion option',async({page})=>{
 await guest(page,{local:true});
 await page.evaluate(async()=>{const inline=document.createElement('div');inline.id='motion-inline';inline.dataset.emailBooking='/book';inline.dataset.emailMotion='none';const button=document.createElement('button');button.id='motion-popup';button.textContent='Book a meeting';button.dataset.emailBooking='/book';button.dataset.emailMotion='smooth';document.body.append(inline,button);await new Promise((resolve,reject)=>{const script=document.createElement('script');script.src='/embed.js';script.onload=resolve;script.onerror=reject;document.body.append(script);});});
 await expect(page.locator('#motion-inline iframe')).toHaveAttribute('src',/embed=1&motion=none/);
 await page.getByRole('button',{name:'Book a meeting',exact:true}).click();await expect(page.locator('dialog iframe')).toHaveAttribute('src',/embed=1&motion=smooth/);
 await page.keyboard.press('Escape');await expect(page.locator('dialog')).toHaveCount(0);await expect(page.locator('#motion-popup')).toBeFocused();
});
