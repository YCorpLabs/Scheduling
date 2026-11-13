import {test} from 'node:test';
import assert from 'node:assert/strict';
import {secureAsset} from '../src/http.js';

test('owner and private management assets reject framing without discarding upstream security policy',async()=>{
  for(const path of ['/','/studio','/studio/','/device','/index.html','/manage/host/booking']){
    const upstream="default-src 'none'; script-src 'self'; frame-ancestors 'self'";
    const source=new Response('fixture',{headers:{'Content-Security-Policy':upstream}});
    const result=secureAsset(source,new Request('https://scheduler.example'+path)),policy=result.headers.get('Content-Security-Policy');
    assert.ok(policy.startsWith(upstream));assert.match(policy,/frame-ancestors 'none'/);
    assert.equal(await result.text(),'fixture');assert.equal(result.headers.get('Referrer-Policy'),'no-referrer');
    assert.equal(source.headers.get('Content-Security-Policy'),upstream);
  }
});
test('guest booking and local preview stay embeddable; restrictive upstream policies are never removed',()=>{
  for(const path of ['/book?embed=1','/b/h_owner/intro?embed=1','/b/h_owner/intro/']){
    const request=new Request('https://scheduler.example'+path);
    assert.ok(!secureAsset(new Response('guest'),request).headers.get('Content-Security-Policy').includes('frame-ancestors'));
    const upstream="default-src 'self'; frame-ancestors https://approved.example";
    assert.equal(secureAsset(new Response('guest',{headers:{'Content-Security-Policy':upstream}}),request).headers.get('Content-Security-Policy'),upstream);
  }
  assert.match(secureAsset(new Response('private')).headers.get('Content-Security-Policy'),/frame-ancestors 'none'/);
});
