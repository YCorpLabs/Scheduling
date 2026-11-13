import {test,expect} from '@playwright/test';
import {DEFAULT} from '../public/policy.js';

const base=process.env.BOOKING_TEST_ORIGIN||'http://127.0.0.1:8791';
const hostId='h_'+'M'.repeat(24);
const message='Scheduling is paused for maintenance. Please try again later.';

async function setup(page,{initiallyFrozen=false}={}){
  const start=Date.now()+86400000;
  await page.route('**/api/**',route=>{
    const path=new URL(route.request().url()).pathname;
    if(path==='/api/bootstrap')return route.fulfill({json:{mode:'live'}});
    if(path.endsWith('/availability')&&!initiallyFrozen)return route.fulfill({json:{
      config:{...DEFAULT,question:'',questions:[]},slots:[{start,end:start+1800000}]
    }});
    if(path.endsWith('/availability')||path.endsWith('/book'))return route.fulfill({
      status:503,json:{error:message,code:'maintenance_frozen'}
    });
    return route.fulfill({json:{}});
  });
  await page.goto(base+`/b/${hostId}/intro`);
}

test('a frozen public page explains maintenance and offers no bookable slots',async({page})=>{
  await setup(page,{initiallyFrozen:true});
  await expect(page.getByText(message,{exact:true})).toBeVisible();
  await expect(page.locator('[data-slot]')).toHaveCount(0);
  await expect(page.getByRole('button',{name:/Confirm|Reserve|Request time/})).toHaveCount(0);
});

test('a freeze during booking preserves guest details and does not show confirmation',async({page})=>{
  await setup(page);
  await page.locator('[data-slot]').first().click();
  await page.getByLabel('Your name',{exact:true}).fill('Sample Guest');
  await page.getByLabel('Email address',{exact:true}).fill('sample@example.com');
  await page.getByRole('button',{name:/Confirm booking|Confirm time|Reserve time/}).click();
  await expect(page.getByText(message,{exact:true})).toBeVisible();
  await expect(page.getByLabel('Your name',{exact:true})).toHaveValue('Sample Guest');
  await expect(page.getByLabel('Email address',{exact:true})).toHaveValue('sample@example.com');
  await expect(page.getByRole('heading',{name:/confirmed/i})).toHaveCount(0);
});
