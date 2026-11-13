import {test,expect} from '@playwright/test';

test('asset-first and Worker responses protect owner/management pages while guest embeds stay usable',async({page,request})=>{
  for(const path of ['/','/studio','/manage/host/booking']){
    const response=await request.get('http://127.0.0.1:8791'+path);
    expect(response.headers()['content-security-policy']).toContain("frame-ancestors 'none'");
  }
  for(const path of ['/book?embed=1','/b/h_fixture/intro?embed=1']){
    const response=await request.get('http://127.0.0.1:8791'+path);
    expect(response.headers()['content-security-policy']).not.toContain('frame-ancestors');
  }
  await page.goto('http://127.0.0.1:8791/site');
  // A same-origin frame is also forbidden: this catches CSP response policies
  // that look correct in text but are not actually enforced by the browser.
  const rejected=page.waitForEvent('console',{predicate:message=>message.type()==='error'&&message.text().includes('frame-ancestors')});
  await page.evaluate(()=>{const frame=document.createElement('iframe');frame.id='owner-framing-probe';frame.src='/studio';document.body.append(frame);});
  await rejected;
  await expect(page.locator('#owner-framing-probe')).toBeAttached();
  await expect.poll(()=>page.locator('#owner-framing-probe').evaluate(frame=>{
    try{return !!frame.contentDocument?.querySelector('#app');}catch{return false;}
  })).toBe(false);
  await page.evaluate(()=>{const frame=document.createElement('iframe');frame.id='guest-framing-probe';frame.src='/book?embed=1';document.body.append(frame);});
  await expect(page.frameLocator('#guest-framing-probe').locator('#app')).toBeVisible();
});
