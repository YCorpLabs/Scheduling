// Isolated workerd drill for the maintenance fence through the real Worker,
// LiveBookingHost and AuthStore. Host storage is rolled back by copying only the
// LIVE_HOSTS persistence directory; AUTH (the authoritative fence) is kept.
// This is NOT Cloudflare point-in-time recovery, which local runtimes lack.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,cpSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';

test('owner freeze/resume routes are guarded and a host storage rollback is detected at start',async()=>{
  const {build}=await import('esbuild');
  const built=await build({entryPoints:[new URL('../src/worker.js',import.meta.url).pathname],bundle:true,write:false,format:'esm',platform:'browser',external:['cloudflare:workers']});
  const root=mkdtempSync(join(tmpdir(),'booking-fence-drill-')),live=join(root,'live');const outbound=[];
  const start=()=>new Miniflare(convertV4MiniflareOptions({resourcePersistencePath:live,workers:[{name:'fence-drill',modules:true,script:built.outputFiles[0].text,compatibilityDate:'2026-11-10',
    durableObjects:{HOSTS:{className:'BookingHost',useSQLite:true},LIVE_HOSTS:{className:'LiveBookingHost',useSQLite:true},AUTH:{className:'AuthStore',useSQLite:true}},
    bindings:{LIVE_ENABLED:'true',PUBLIC_ORIGIN:'http://localhost',GOOGLE_CLIENT_ID:'test-client',GOOGLE_CLIENT_SECRET:'test-secret',TOKEN_ENCRYPTION_KEY:Buffer.alloc(32,7).toString('base64'),RESEND_API_KEY:'mock-key',MAIL_FROM:'Scheduling <meet@example.com>'},
    outboundService:async request=>{
      const u=new URL(request.url);
      if(u.hostname==='oauth2.googleapis.com')return Response.json({access_token:'access-owner',expires_in:3600,scope:'openid email profile'});
      if(u.hostname==='openidconnect.googleapis.com')return Response.json({sub:'fence-owner',email:'fence-owner@example.com',email_verified:true,name:'Fence Owner'});
      outbound.push(u.hostname);throw Error('Unexpected outbound request '+u.hostname);
    }}]}));
  let mf=start();
  const call=(path,{cookie,body,origin='http://localhost'}={})=>mf.dispatchFetch('http://localhost'+path,{redirect:'manual',headers:{...(cookie?{Cookie:cookie}:{}),...(body?{'Content-Type':'application/json',Origin:origin}:{})},...(body?{method:'POST',body:JSON.stringify(body)}:{})});
  const status=async cookie=>{const r=await call('/api/live/operations',{cookie});assert.equal(r.status,200);return r.json();};
  try{
    assert.equal((await call('/api/live/operations/maintenance',{body:{action:'freeze',expectedEpoch:0}})).status,401);
    const begin=await call('/auth/google');
    const state=new URL(begin.headers.get('Location')).searchParams.get('state'),binding=begin.headers.get('Set-Cookie').split(';')[0];
    const callback=await call('/auth/google/callback?state='+state+'&code=fence-code',{cookie:binding});assert.equal(callback.status,303,await callback.clone().text());
    const cookie=callback.headers.getSetCookie().find(v=>v.startsWith('email_booking_session=')).split(';')[0];
    const hostId=(await(await call('/api/bootstrap',{cookie})).json()).hostId;
    let s=await status(cookie);assert.deepEqual({frozen:s.outbound.frozen,epoch:s.outbound.epoch},{frozen:false,epoch:0});
    // Snapshot host storage (only) before any maintenance transition.
    await mf.dispose();cpSync(live,join(root,'snapshot'),{recursive:true});mf=start();

    assert.equal((await call('/api/live/operations/maintenance',{cookie,origin:'https://evil.example',body:{action:'freeze',expectedEpoch:0}})).status,403);
    assert.equal((await call('/api/live/operations/maintenance',{cookie,body:{action:'freeze',expectedEpoch:0,hostId}})).status,400);
    const frozen=await call('/api/live/operations/maintenance',{cookie,body:{action:'freeze',expectedEpoch:0}});
    assert.equal(frozen.status,200);assert.equal((await frozen.json()).maintenance.frozen,true);
    const repair=await call('/api/live/repair',{cookie,body:{}});assert.equal(repair.status,503);assert.equal((await repair.json()).code,'maintenance_frozen');
    const guest=await call(`/api/public/${hostId}/intro/availability`);assert.equal(guest.status,503);assert.equal((await guest.json()).code,'maintenance_frozen');
    s=await status(cookie);assert.ok(s.issues.some(i=>i.code==='outbound_paused'));assert.equal(s.outbound.epoch,1);
    assert.equal((await call('/api/live/operations/maintenance',{cookie,body:{action:'resume',expectedEpoch:0}})).status,409);
    assert.equal((await call('/api/live/operations/maintenance',{cookie,body:{action:'resume',expectedEpoch:1}})).status,200);
    assert.equal((await call('/api/live/repair',{cookie,body:{}})).status,200);
    s=await status(cookie);assert.equal(s.outbound.frozen,false);assert.equal(s.outbound.epoch,2);

    // Restart on unchanged storage: no rollback, nothing quarantined.
    await mf.dispose();mf=start();
    s=await status(cookie);assert.equal(s.outbound.frozen,false);assert.equal(s.outbound.lastRestoreDetected,null);

    // Roll back only the host namespace to the snapshot; AUTH keeps epoch 2.
    await mf.dispose();
    const namespace=readdirSync(join(live,'do')).find(name=>name.endsWith('LiveBookingHost'));assert.ok(namespace,'persisted LiveBookingHost directory');
    rmSync(join(live,'do',namespace),{recursive:true,force:true});cpSync(join(root,'snapshot','do',namespace),join(live,'do',namespace),{recursive:true});
    mf=start();
    s=await status(cookie);
    assert.equal(s.outbound.frozen,true,'restored host starts frozen');assert.equal(s.outbound.reason,'restore_detected');assert.equal(s.outbound.epoch,3);
    assert.ok(s.issues.some(i=>i.code==='restore_detected'&&i.severity==='critical'));
    assert.equal(s.outbound.lastRestoreDetected.storageEpoch,0);assert.equal(s.outbound.lastRestoreDetected.fenceEpoch,2);
    assert.equal((await call(`/api/public/${hostId}/intro/availability`)).status,503);
    assert.ok(!JSON.stringify(s).includes('fence-owner@example.com'));
    assert.equal((await call('/api/live/operations/maintenance',{cookie,body:{action:'resume',expectedEpoch:3}})).status,200);
    assert.deepEqual(outbound,[]);
  }finally{await mf.dispose();rmSync(root,{recursive:true,force:true});}
});
