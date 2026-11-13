import {test,expect} from '@playwright/test';
const base=process.env.BOOKING_TEST_ORIGIN||'http://127.0.0.1:8791';
async function signedOut(page,mode='live',brand){
 const requests=[];await page.route('**/api/**',async route=>{requests.push(new URL(route.request().url()).pathname);await route.fulfill({json:{mode,authenticated:false,...(brand?{brand}:{})}});});await page.goto(base+'/studio');return requests;
}
test('sign in presents one Google action with keyboard access and no calendar access',async({page})=>{
 const requests=await signedOut(page);await expect(page).toHaveTitle('Scheduling');await expect(page.getByRole('heading',{name:'Scheduling',exact:true})).toBeVisible();await expect(page.locator('.sign-in-mark')).toHaveText('s.');await expect(page.locator('.sign-in-brand,.sign-in-footer')).toHaveCount(0);const action=page.getByRole('link',{name:'Continue with Google',exact:true});await expect(action).toHaveAttribute('href','/auth/google');await expect(page.getByRole('link')).toHaveCount(2);await expect(page.locator('.sign-in-card')).toHaveCount(0);expect(requests).toEqual(['/api/bootstrap']);
 await page.getByRole('link',{name:'Skip to content'}).focus();await page.keyboard.press('Tab');await expect(action).toBeFocused();await page.screenshot({path:`${process.env.BOOKING_SCREENSHOT_DIR||'test-results'}/scheduling-sign-in-desktop.png`,fullPage:true});
 await page.setViewportSize({width:390,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBeTruthy();await expect(action).toBeInViewport();await page.screenshot({path:`${process.env.BOOKING_SCREENSHOT_DIR||'test-results'}/scheduling-sign-in-mobile.png`,fullPage:true});
 await page.setViewportSize({width:1440,height:1000});await page.evaluate(()=>document.documentElement.dataset.theme='dark');await expect(action).toBeVisible();await page.screenshot({path:`${process.env.BOOKING_SCREENSHOT_DIR||'test-results'}/scheduling-sign-in-dark.png`,fullPage:true});
});
test('setup mode has no sign-in action and short reduced-motion layouts stay usable',async({page})=>{
 await page.emulateMedia({reducedMotion:'reduce'});await page.setViewportSize({width:667,height:375});await signedOut(page,'setup');await expect(page.getByRole('status').filter({hasText:'Calendar connection is being set up.'})).toBeVisible();await expect(page.getByRole('link',{name:'Continue with Google'})).toHaveCount(0);await expect(page.locator('.sign-in-content')).toHaveCSS('animation-name','none');expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBeTruthy();
});
test('operator identity, links and mark come from configuration',async({page})=>{
 const brand={productName:'Rota',brandName:'Acme',organization:{name:'Acme Labs',url:'https://acme.example.com',markPath:'M8 8h16v16H8z'},privacyUrl:'https://acme.example.com/privacy',termsUrl:'https://acme.example.com/terms',supportEmail:'help@acme.example.com'};
 await signedOut(page,'live',brand);await expect(page).toHaveTitle('Rota');await expect(page.getByRole('heading',{name:'Rota',exact:true})).toBeVisible();await expect(page.locator('.sign-in-mark')).toHaveText('a.');await expect(page.getByText('Scheduling')).toHaveCount(0);
 const home=page.getByRole('link',{name:'Acme Labs home'});await expect(home).toHaveAttribute('href','https://acme.example.com');await expect(page.locator('.sign-in-brand path')).toHaveAttribute('d','M8 8h16v16H8z');
 const footer=page.locator('.sign-in-footer');await expect(footer.getByRole('link',{name:'Privacy'})).toHaveAttribute('href','https://acme.example.com/privacy');await expect(footer.getByRole('link',{name:'Terms'})).toHaveAttribute('href','https://acme.example.com/terms');await expect(footer.getByRole('link',{name:'Support'})).toHaveAttribute('href','mailto:help@acme.example.com');
 await home.focus();await page.keyboard.press('Tab');await expect(page.getByRole('link',{name:'Continue with Google',exact:true})).toBeFocused();
 await page.setViewportSize({width:390,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBeTruthy();
});
test('unsafe identity values fall back to neutral defaults',async({page})=>{
 await signedOut(page,'live',{productName:'<b>Rota</b>',organization:{name:'Acme Labs',url:'javascript:alert(1)',markPath:'M0 0"/><script>alert(1)</script>'},privacyUrl:'http://acme.example.com/privacy',supportEmail:'not an address'});
 await expect(page).toHaveTitle('Scheduling');await expect(page.getByRole('heading',{name:'Scheduling',exact:true})).toBeVisible();await expect(page.getByRole('link',{name:'Acme Labs home'})).toHaveCount(0);await expect(page.locator('.sign-in-brand')).toHaveText('Acme Labs');await expect(page.locator('.sign-in-brand svg,.sign-in-screen script')).toHaveCount(0);await expect(page.locator('.sign-in-footer')).toHaveCount(0);
});
test('a long product name stays inside the sign-in page on small phones',async({page})=>{
 await page.setViewportSize({width:320,height:640});await signedOut(page,'live',{productName:'Scheduling by Acme Labs'});
 await expect(page).toHaveTitle('Scheduling by Acme Labs');await expect(page.getByRole('heading',{name:'Scheduling by Acme Labs',exact:true})).toBeVisible();await expect(page.getByRole('link',{name:'Continue with Google',exact:true})).toBeInViewport();
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBeTruthy();
});
