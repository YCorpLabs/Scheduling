import test from 'node:test';
import assert from 'node:assert/strict';
import {DEFAULT_BRAND,brandFromEnv,normalizeBrand,brandLabel,brandMark,studioName,legalLinksMarkup,organizationMarkup} from '../public/brand.js';
import {handleDevice} from '../src/device.js';
import {webhookUserAgent} from '../src/integrations.js';

test('an unconfigured instance has neutral identity and no operator links',()=>{
  const brand=brandFromEnv({});
  assert.deepEqual(brand,{...DEFAULT_BRAND});
  assert.equal(brandLabel(brand),'Scheduling');assert.equal(brandMark(brand),'s.');assert.equal(studioName(brand),'Scheduling');
  assert.equal(legalLinksMarkup(brand),'');assert.equal(organizationMarkup(brand),'');
  assert.deepEqual(normalizeBrand(undefined),brand);assert.deepEqual(normalizeBrand('nonsense'),brand);
});

test('operator configuration supplies every visible identity value',()=>{
  const brand=brandFromEnv({PRODUCT_NAME:'Rota',BRAND_NAME:'Acme',DESKTOP_APP_NAME:'Acme Mail',ORGANIZATION_NAME:'Acme Labs',ORGANIZATION_URL:'https://acme.example.com',ORGANIZATION_MARK_PATH:'M8 8h16v16H8z',SUPPORT_EMAIL:'help@acme.example.com',PRIVACY_URL:'https://acme.example.com/privacy',TERMS_URL:'https://acme.example.com/terms'});
  assert.deepEqual(brand,{productName:'Rota',brandName:'Acme',desktopAppName:'Acme Mail',organization:{name:'Acme Labs',url:'https://acme.example.com',markPath:'M8 8h16v16H8z'},supportEmail:'help@acme.example.com',privacyUrl:'https://acme.example.com/privacy',termsUrl:'https://acme.example.com/terms'});
  assert.equal(brandLabel(brand),'Acme');assert.equal(brandMark(brand),'a.');assert.equal(studioName(brand),'Acme Rota');
  // The configured URL spelling is kept exactly, without normalisation.
  assert.match(organizationMarkup(brand),/^<a href="https:\/\/acme\.example\.com" class="sign-in-brand" tabindex="0" aria-label="Acme Labs home"><svg [^>]+><rect [^>]+\/><path d="M8 8h16v16H8z" /);
  assert.equal(legalLinksMarkup(brand),'<a class="legal-link" href="https://acme.example.com/privacy" target="_blank" rel="noopener">Privacy</a><a class="legal-link" href="https://acme.example.com/terms" target="_blank" rel="noopener">Terms</a><a class="legal-link" href="mailto:help@acme.example.com">Support</a>');
  assert.equal(brandFromEnv({BRAND_NAME:'Acme'}).desktopAppName,'Acme');
});

test('unsafe or malformed identity values are dropped rather than rendered',()=>{
  const brand=brandFromEnv({PRODUCT_NAME:'<script>',BRAND_NAME:'x'.repeat(61),ORGANIZATION_NAME:'Acme "Labs"',ORGANIZATION_URL:'javascript:alert(1)',ORGANIZATION_MARK_PATH:'M0 0"/><script>',SUPPORT_EMAIL:'a@b',PRIVACY_URL:'http://acme.example.com/privacy',TERMS_URL:'https://user:pw@acme.example.com/terms'});
  assert.equal(brand.productName,'Scheduling');assert.equal(brand.brandName,'');assert.deepEqual(brand.organization,{name:'Acme "Labs"',url:'',markPath:''});
  assert.equal(brand.supportEmail,'');assert.equal(brand.privacyUrl,'');assert.equal(brand.termsUrl,'');
  assert.equal(organizationMarkup(brand),'<span class="sign-in-brand"><span>Acme &quot;Labs&quot;</span></span>');
  assert.equal(brandFromEnv({PRIVACY_URL:'http://127.0.0.1:8788/privacy'}).privacyUrl,'http://127.0.0.1:8788/privacy');
});

test('the device page derives its client name and links from configuration',async()=>{
  const page=async env=>(await handleDevice(new Request(env.PUBLIC_ORIGIN+'/device'),env)).text();
  const neutral=await page({PUBLIC_ORIGIN:'https://booking.example'});
  assert.match(neutral,/<title>Connect your desktop app<\/title>/);assert.match(neutral,/data-app="your desktop app"/);assert.match(neutral,/<span class="mark" aria-hidden="true">s\.<\/span>Scheduling/);
  assert.doesNotMatch(neutral,/Email app|Connect Email|>Email</);
  const branded=await page({PUBLIC_ORIGIN:'https://booking.example',BRAND_NAME:'Acme',DESKTOP_APP_NAME:'Acme <Mail>'});
  assert.match(branded,/<title>Connect Acme<\/title>/,'an unsafe desktop name falls back to the brand');
  const named=await page({PUBLIC_ORIGIN:'https://booking.example',BRAND_NAME:'Acme',DESKTOP_APP_NAME:'Acme & Co Mail'});
  assert.match(named,/<title>Connect Acme &amp; Co Mail<\/title>/);assert.match(named,/in your Acme &amp; Co Mail app\./);assert.match(named,/data-label="Acme"/);
  // verificationUrl is built from PUBLIC_ORIGIN; tests/device.test.mjs asserts it for a non-official origin.
});

test('webhook requests identify the configured instance or a neutral default',()=>{
  assert.equal(webhookUserAgent({}),'Scheduling-Webhooks/1');
  assert.equal(webhookUserAgent({WEBHOOK_USER_AGENT:'Acme-Scheduling-Webhooks/2'}),'Acme-Scheduling-Webhooks/2');
  for(const value of ['Acme Webhooks/1','Acme/1\r\nX-Injected: 1','/1','Acme',''])assert.equal(webhookUserAgent({WEBHOOK_USER_AGENT:value}),'Scheduling-Webhooks/1');
});
