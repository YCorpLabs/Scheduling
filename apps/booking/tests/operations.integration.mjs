// Isolated workerd drill: SQLite Durable Object state is persisted to a local
// directory, copied as a snapshot, wiped, and restored into a new runtime.
// This exercises restart/restore semantics of the ledger on workerd SQLite.
// It is NOT Cloudflare point-in-time recovery, which local runtimes lack.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,cpSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';

const src=path=>JSON.stringify(new URL(path,import.meta.url).pathname);
async function harness(){
  const {build}=await import('esbuild');
  const built=await build({stdin:{resolveDir:new URL('..',import.meta.url).pathname,contents:`
    import {DurableObject} from 'cloudflare:workers';
    import {BookingLedger} from ${src('../src/ledger.js')};
    import {DEFAULT} from ${src('../public/policy.js')};
    import {intakeRevision} from ${src('../public/intake.js')};
    const json=r=>r.json();
    // Calendar and mail state live in the Node test process, outside SQLite.
    const google={refreshTokens:async()=>({access_token:'mock',expires_at:Date.now()+3600000}),listCalendars:async()=>[{id:'primary',accessRole:'owner'}],freeBusy:async()=>[],
      getEvent:async(_,{eventId})=>{const r=await fetch('https://calendar.test/events/'+eventId);return r.status===404?null:json(r);},
      createEvent:async(_,{eventId,event})=>{const r=await fetch('https://calendar.test/events/'+eventId,{method:'POST',body:JSON.stringify(event)});if(r.status===504)throw Object.assign(Error('timeout'),{retryable:true});return json(r);},
      deleteEvent:async(_,{eventId})=>{await fetch('https://calendar.test/events/'+eventId,{method:'DELETE'});}};
    const notify=async(_env,payload)=>{const r=await fetch('https://mail.test/send',{method:'POST',body:JSON.stringify({key:payload.idempotencyKey})});if(r.status===504)throw Object.assign(Error('timeout'),{retryable:false,deliveryUnknown:true});return {id:'ok'};};
    export class OpsHarness extends DurableObject {
      constructor(ctx,env){super(ctx,env);this.ledger=new BookingLedger(ctx,env,{google,sendNotification:notify});}
      async fetch(request){
        const l=this.ledger,path=new URL(request.url).pathname,body=request.method==='POST'?await request.json():{};
        if(path==='/setup'){
          l.init({id:'owner',name:'Owner',email:'owner@example.test'});
          await l.connect({accountId:'a',email:'calendar@example.test',tokens:{access_token:'mock',refresh_token:'mock-refresh',expires_at:Date.now()+3600000}});
          await l.configureCalendars({accounts:[{id:'a',destinationCalendarId:'primary',conflictCalendarIds:['primary']}]});
          l.saveSettings({meetingTypes:[{...DEFAULT,id:'intro',slug:'intro',published:true,accountId:'a',calendarId:'primary',reminder:false,zone:'UTC',notice:0,horizon:5,startHour:0,endHour:24,days:[0,1,2,3,4,5,6],buffer:0}]});
          return Response.json({ok:true});
        }
        if(path==='/book'){const start=Math.ceil((Date.now()+3600000)/900000)*900000+body.offset*3600000;return Response.json(await l.reserve('intro',{start,name:'Drill Guest',email:'drill.guest@example.test',idempotencyKey:'ops-drill-key-'+body.offset+'-000000',intakeRevision:await intakeRevision(l.type('intro'))}));}
        if(path==='/alarm'){await l.alarm();return Response.json({ok:true});}
        if(path==='/status')return Response.json(await l.operationalStatus());
        if(path==='/manage')return Response.json(await l.manage(body.id,body.token));
        if(path==='/resolve')return Response.json(l.resolveParkedDelivery(body));
        if(path==='/wipe'){await this.ctx.storage.deleteAll();this.ledger=new BookingLedger(this.ctx,this.env,{google,sendNotification:notify});return Response.json({ok:true});}
        return new Response('missing',{status:404});
      }
      alarm(){return this.ledger.alarm();}
    }
    export default {fetch(request,env){return env.OPS.getByName('drill').fetch(request);}};
  `},bundle:true,write:false,format:'esm',platform:'browser',external:['cloudflare:workers']});
  return built.outputFiles[0].text;
}

test('workerd SQLite restart and snapshot restore keep parked sends parked and pending creates idempotent',async()=>{
  const script=await harness(),root=mkdtempSync(join(tmpdir(),'booking-ops-drill-'));
  const events=new Map(),mail=[];let calendarTimeout=false,mailTimeout=true,inserts=0;
  const outboundService=async request=>{
    const u=new URL(request.url);
    if(u.hostname==='mail.test'){const {key}=await request.json();mail.push(key);return mailTimeout?new Response('upstream',{status:504}):Response.json({id:'ok'});}
    if(u.hostname==='calendar.test'){
      const id=u.pathname.split('/').at(-1);
      if(request.method==='POST'){inserts++;const event={...await request.json(),id,etag:'etag',status:'confirmed'};events.set(id,event);return calendarTimeout?new Response('lost',{status:504}):Response.json(event);}
      if(request.method==='DELETE'){events.delete(id);return new Response(null,{status:204});}
      return events.has(id)?Response.json(events.get(id)):new Response('missing',{status:404});
    }
    throw Error('Unexpected outbound request '+u.hostname);
  };
  const start=dir=>new Miniflare(convertV4MiniflareOptions({resourcePersistencePath:dir,workers:[{name:'ops-drill',modules:true,script,compatibilityDate:'2026-11-10',
    durableObjects:{OPS:{className:'OpsHarness',useSQLite:true}},
    bindings:{PUBLIC_ORIGIN:'http://localhost',TOKEN_ENCRYPTION_KEY:Buffer.alloc(32,7).toString('base64'),RESEND_API_KEY:'mock-key',MAIL_FROM:'meet@example.test'},outboundService}]}));
  const call=async(mf,path,body)=>{const r=await mf.dispatchFetch('http://localhost'+path,body?{method:'POST',body:JSON.stringify(body)}:{});const text=await r.text();try{return JSON.parse(text);}catch{throw Error(path+" "+r.status+" "+text.slice(0,400));}};
  const live=join(root,'live'),snapshot=join(root,'snapshot');
  try{
    let mf=start(live),confirmed,pending;
    try{
      await call(mf,'/setup',{});
      confirmed=await call(mf,'/book',{offset:0});assert.equal(confirmed.booking.status,'confirmed');
      await call(mf,'/alarm',{});
      calendarTimeout=true;pending=await call(mf,'/book',{offset:2});calendarTimeout=false;assert.equal(pending.booking.status,'pending');
      const status=await call(mf,'/status');
      assert.equal(status.deliveries.review.count,1);assert.equal(status.bookings.pending.count,1);
      // PITR bookmarks are unavailable in local workerd; status must degrade, not fail.
      assert.equal(status.storage.bookmark,null);
      assert.ok(!JSON.stringify(status).includes('drill.guest@example.test')&&!JSON.stringify(status).includes(confirmed.managementToken));
    }finally{await mf.dispose();}
    assert.equal(inserts,2);const parkedKey=mail[0];assert.equal(mail.length,1);
    cpSync(live,snapshot,{recursive:true});

    // Restart on the same storage: nothing replays and the pending outcome resolves.
    mailTimeout=false;mf=start(live);
    try{
      await call(mf,'/alarm',{});await call(mf,'/alarm',{});
      assert.equal(mail.filter(k=>k===parkedKey).length,1,'restart must not replay the parked send');
      const status=await call(mf,'/status');assert.equal(status.bookings.pending.count,0);assert.equal(status.deliveries.review.count,1);
      assert.equal(inserts,2,'deterministic GET recovers the lost create');
      await call(mf,'/wipe',{});assert.equal((await call(mf,'/status')).calendarSync.tracked,0);
    }finally{await mf.dispose();}

    // Restore the pre-restart snapshot into a fresh runtime.
    const sentBeforeRestore=mail.length;mf=start(snapshot);
    try{
      let status=await call(mf,'/status');assert.equal(status.bookings.pending.count,1,'snapshot predates reconciliation');
      await call(mf,'/alarm',{});await call(mf,'/alarm',{});
      status=await call(mf,'/status');
      assert.equal(status.bookings.pending.count,0);assert.equal(inserts,2,'restore must not insert a second calendar event');
      assert.equal(mail.filter(k=>k===parkedKey).length,1,'restore must not replay the parked send');
      assert.ok(mail.length>=sentBeforeRestore);
      assert.equal(status.deliveries.review.count,1);
      const manage=await call(mf,'/manage',{id:confirmed.booking.id,token:confirmed.managementToken});assert.equal(manage.booking.id,confirmed.booking.id);
      const item=status.deliveries.review.items[0];
      const resolved=await call(mf,'/resolve',{jobId:item.jobId,outcome:'delivered',expectedUpdatedAt:item.updatedAt});
      assert.equal(resolved.evidence,'operator_assertion');
      assert.equal((await call(mf,'/status')).deliveries.review.count,0);
      assert.equal(mail.filter(k=>k===parkedKey).length,1);
    }finally{await mf.dispose();}
  }finally{rmSync(root,{recursive:true,force:true});}
});

test('operations routes require an owner session, enforce same-origin writes and keep public health minimal',async()=>{
  const {build}=await import('esbuild');
  const built=await build({entryPoints:[new URL('../src/worker.js',import.meta.url).pathname],bundle:true,write:false,format:'esm',platform:'browser',external:['cloudflare:workers']});
  const mail=[];
  const mf=new Miniflare(convertV4MiniflareOptions({workers:[{name:'ops-routes',modules:true,script:built.outputFiles[0].text,compatibilityDate:'2026-11-10',
    durableObjects:{HOSTS:{className:'BookingHost',useSQLite:true},LIVE_HOSTS:{className:'LiveBookingHost',useSQLite:true},AUTH:{className:'AuthStore',useSQLite:true}},
    bindings:{LIVE_ENABLED:'true',PUBLIC_ORIGIN:'http://localhost',GOOGLE_CLIENT_ID:'test-client',GOOGLE_CLIENT_SECRET:'test-secret',TOKEN_ENCRYPTION_KEY:Buffer.alloc(32,7).toString('base64'),RESEND_API_KEY:'mock-key',MAIL_FROM:'Scheduling <meet@example.com>'},
    outboundService:async request=>{
      const u=new URL(request.url);
      if(u.hostname==='oauth2.googleapis.com')return Response.json({access_token:'access-owner',expires_in:3600,scope:'openid email profile'});
      if(u.hostname==='openidconnect.googleapis.com')return Response.json({sub:'ops-owner',email:'ops-owner@example.com',email_verified:true,name:'Ops Owner'});
      if(u.hostname==='api.resend.com'){mail.push(1);return Response.json({id:'x'});}
      throw Error('Unexpected outbound request '+u.hostname);
    }}]}));
  const call=(path,{cookie,body,origin='http://localhost'}={})=>mf.dispatchFetch('http://localhost'+path,{redirect:'manual',headers:{...(cookie?{Cookie:cookie}:{}),...(body?{'Content-Type':'application/json',Origin:origin}:{})},...(body?{method:'POST',body:JSON.stringify(body)}:{})});
  try{
    assert.deepEqual(await(await call('/api/health')).json(),{ready:true});
    assert.equal((await call('/api/live/operations')).status,401);
    assert.equal((await call('/api/live/operations/deliveries/resolve',{body:{jobId:'x',outcome:'delivered',expectedUpdatedAt:1}})).status,401);
    const begin=await call('/auth/google');assert.equal(begin.status,302);
    const state=new URL(begin.headers.get('Location')).searchParams.get('state'),binding=begin.headers.get('Set-Cookie').split(';')[0];
    const callback=await call('/auth/google/callback?state='+state+'&code=ops-code',{cookie:binding});assert.equal(callback.status,303,await callback.clone().text());
    const cookie=callback.headers.getSetCookie().find(v=>v.startsWith('email_booking_session=')).split(';')[0];
    const response=await call('/api/live/operations',{cookie});assert.equal(response.status,200);
    assert.equal(response.headers.get('Cache-Control'),'no-store');
    const status=await response.json();assert.equal(status.schemaVersion,1);assert.equal(status.deliveries.queued,0);
    assert.ok(!JSON.stringify(status).includes('ops-owner@example.com'));
    assert.equal((await call('/api/live/operations/deliveries/resolve',{cookie,origin:'https://evil.example',body:{jobId:'x',outcome:'delivered',expectedUpdatedAt:1}})).status,403);
    const missing=await call('/api/live/operations/deliveries/resolve',{cookie,body:{jobId:'x:1:confirmed',outcome:'delivered',expectedUpdatedAt:1}});
    assert.equal(missing.status,404);assert.equal((await missing.json()).error,'This email is no longer parked.');
    assert.equal((await call('/api/live/operations/deliveries/resolve',{cookie,body:{jobId:'x',outcome:'resend'}})).status,400);
    assert.equal(mail.length,0);
  }finally{await mf.dispose();}
});
