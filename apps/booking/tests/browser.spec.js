import { test, expect } from '@playwright/test';
const base=process.env.BOOKING_TEST_ORIGIN||'http://127.0.0.1:8791';
test('guest can choose, go back without losing details, reserve, and release',async({page})=>{
  await page.goto(base+'/book');
  await expect(page.getByRole('region',{name:'Choose a date'})).toBeVisible();
  await page.locator('[data-slot]').first().click();
  await page.getByLabel('Your name',{exact:true}).fill('Sample Guest');
  await page.getByLabel('Email address',{exact:true}).fill('sample@example.com');
  await page.getByRole('button',{name:'Choose another time'}).click();
  await page.locator('[data-slot]').first().click();
  await expect(page.getByLabel('Your name',{exact:true})).toHaveValue('Sample Guest');
  await page.getByRole('button',{name:'Reserve demo time'}).click();
  await expect(page.getByRole('heading',{name:'Demo time reserved'})).toBeVisible();
  await page.getByRole('button',{name:'Release demo time'}).click();
  await expect(page.getByRole('region',{name:'Choose a date'})).toBeVisible();
});
test('concurrent reservations admit one guest; retries do not create another reservation',async({request})=>{
  const state=await(await request.get(base+'/api/availability')).json();const start=state.slots[4].start;
  const post=(data)=>request.post(base+'/api/book',{headers:{Origin:base},data});
  const keys=[crypto.randomUUID(),crypto.randomUUID()];
  const results=await Promise.all(keys.map(key=>post({start,key})));
  expect(results.map(r=>r.status()).sort()).toEqual([200,409]);
  const i=results.findIndex(r=>r.ok()),winner=await results[i].json();
  const retry=await(await post({start,key:keys[i]})).json();expect(retry.id).toBe(winner.id);
  const changed=await post({start:start+60000,key:keys[i]});expect(changed.status()).toBe(409);
  const released=await request.post(base+'/api/cancel',{headers:{Origin:base},data:{id:winner.id,token:winner.token}});expect(released.ok()).toBeTruthy();
  const cancelledRetry=await post({start,key:keys[i]});expect(cancelledRetry.status()).toBe(410);
});
test('unsafe origins and invalid settings cannot mutate state',async({request})=>{
  const response=await request.post(base+'/api/settings',{headers:{Origin:'https://untrusted.example'},data:{}});expect(response.status()).toBe(403);
  const response2=await request.post(base+'/api/settings',{headers:{Origin:base},data:{horizon:999}});expect(response2.status()).toBe(400);
});
test('host live preview and settings persist',async({page,request})=>{
  const before=await(await request.get(base+'/api/availability')).json();
  await page.goto(base+'/studio#link=intro');
  await page.getByLabel('What are we meeting about?').fill('A thoughtful demo');
  await expect(page.frameLocator('#preview').getByRole('heading',{name:'A thoughtful demo'})).toBeVisible();
  await page.getByRole('button',{name:'Save changes'}).click();
  await expect(page.getByText('Saved · guest page updated')).toBeVisible();
  const after=await(await request.get(base+'/api/availability')).json();expect(after.config.title).toBe('A thoughtful demo');
  await request.post(base+'/api/settings',{headers:{Origin:base},data:before.config});
});
test('mobile booking reflows and keyboard can reach the form',async({page})=>{
  await page.setViewportSize({width:390,height:844});await page.goto(base+'/book');
  await page.locator('[data-slot]').first().focus();await page.keyboard.press('Enter');
  await expect(page.getByLabel('Your name',{exact:true})).toBeFocused();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBeTruthy();
  await page.keyboard.press('Escape');await expect(page.getByRole('region',{name:'Choose a date'})).toBeVisible();
});
test('website popup traps focus and Escape restores trigger',async({page})=>{
  await page.goto(base+'/site');const trigger=page.getByRole('button',{name:'Book a demo'}).last();
  await trigger.click();await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');await expect(page.getByRole('dialog')).toHaveCount(0);await expect(trigger).toBeFocused();
});

test('booker stays usable at desktop, tablet and mobile widths in both themes',async({page,request})=>{
  const before=await(await request.get(base+'/api/availability')).json();
  try {
    for(const theme of ['light','dark']) {
      await request.post(base+'/api/settings',{headers:{Origin:base},data:{...before.config,theme}});
      for(const width of [1440,800,632,390,320]) {
        await page.setViewportSize({width,height:900});await page.goto(base+'/book');
        await expect(page.locator('.slot').first()).toBeVisible();
        expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBeTruthy();
        const widths=await page.locator('.slot').evaluateAll(els=>els.map(e=>e.getBoundingClientRect().width));
        expect(Math.min(...widths)).toBeGreaterThan(60);
        if(width===1440)await page.screenshot({path:`${process.env.BOOKING_SCREENSHOT_DIR||'test-results'}/scheduling-cal-${theme}.png`});
        if(width===390)await page.screenshot({path:`${process.env.BOOKING_SCREENSHOT_DIR||'test-results'}/scheduling-cal-${theme}-mobile.png`,fullPage:true});
        await page.locator('.slot').first().click();
        await expect(page.getByLabel('Your name',{exact:true})).toBeFocused();
        expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBeTruthy();
      }
    }
  } finally {await request.post(base+'/api/settings',{headers:{Origin:base},data:before.config});}
});
