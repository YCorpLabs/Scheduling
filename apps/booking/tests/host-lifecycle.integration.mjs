import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
const HOST='h_abcdefghijklmnopqrstuvwx';
test('actual host RPC fences, drains and purges without resurrecting through alarms or late handlers',async()=>{
 const source=`import {LiveBookingHost} from './src/host.js';import {AuthStore} from './src/auth.js';import {beginLifecycle,ackLifecycle} from './src/lifecycle.js';import {activeHostCall} from './src/host-lifecycle.js';export {AuthStore};
 const id='${HOST}',operationId='deletion_operation_fixture';
 export class FixtureHost extends LiveBookingHost{
  fixtureAlarm(){return this.alarm();}
  fixtureSeed(){this.ledger.putAccount({id:'private-account',grant:'PRIVATE-GRANT',email:'private@example.test'});return {seeded:true};}
  fixtureRaw(){return {accounts:this.ledger.rows('SELECT COUNT(*) AS n FROM live_accounts')[0].n,bookings:this.ledger.rows('SELECT COUNT(*) AS n FROM live_bookings')[0].n,metaKeys:this.ledger.rows('SELECT key FROM live_meta ORDER BY key').map(r=>r.key)};}
  async fixtureLate(){try{return await activeHostCall(this.ledger,async()=>{await fetch('https://fixture.invalid/hold');this.ledger.putAccount({id:'late',grant:'LATE-GRANT'});return {lateRejected:false};});}catch(error){return {lateRejected:error.code==='lifecycle_fenced'};}}
 }
 export default {async fetch(request,env){const path=new URL(request.url).pathname,host=env.LIVE_HOSTS.getByName(id),data={operationId,generation:1};
 if(path==='/init')return Response.json(await host.init({id,name:'Private Name'}));
 if(path==='/seed')return Response.json(await host.fixtureSeed());
 if(path==='/late')return Response.json(await host.fixtureLate());
 if(path==='/begin')return Response.json(await beginLifecycle(env,id,{operationId,expectedGeneration:0,ledgerIds:[id]}));
 if(path==='/fence')return Response.json(await host.lifecycleFence(data));
 if(path==='/ack'){const value=await host.lifecycleFence(data);return Response.json(await ackLifecycle(env,id,{...data,ledgerId:id,epoch:value.epoch}));}
 if(path==='/drain')return Response.json(await host.lifecycleDrain(data));
 if(path==='/purge')return Response.json(await host.lifecyclePurge(data));
 if(path==='/settings')return Response.json(await host.settingsWithRevision());
 if(path==='/resume')return Response.json(await host.setMaintenance({action:'resume',expectedEpoch:1}));
 if(path==='/alarm')return Response.json(await host.fixtureAlarm());
 if(path==='/raw')return Response.json(await host.fixtureRaw());return new Response(null,{status:404});}};`;
 const bundle=await build({stdin:{contents:source,resolveDir:new URL('..',import.meta.url).pathname},bundle:true,format:'esm',platform:'browser',external:['cloudflare:workers'],write:false});
 let release,entered;const held=new Promise(r=>entered=r),gate=new Promise(r=>release=r);
 const mf=new Miniflare(convertV4MiniflareOptions({workers:[{name:'host-lifecycle',modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2026-11-10',bindings:{TOKEN_ENCRYPTION_KEY:Buffer.alloc(32,7).toString('base64'),PUBLIC_ORIGIN:'https://fixture.invalid'},durableObjects:{AUTH:{className:'AuthStore',useSQLite:true},LIVE_HOSTS:{className:'FixtureHost',useSQLite:true}},outboundService:async request=>{if(request.url==='https://fixture.invalid/hold'){entered();await gate;return new Response('settled');}throw Error('Unexpected provider call');}}]}));
 const call=async path=>{try{return await (await mf.dispatchFetch('http://localhost'+path)).json();}catch(error){throw new Error('Fixture request failed: '+path,{cause:error});}};
 try{
  await call('/init');await call('/seed');assert.equal((await call('/settings')).profile.name,'Private Name');
  const pending=call('/late');pending.catch(()=>{});await held;await call('/begin');assert.equal((await call('/fence')).fenced,true);await call('/ack');
  assert.equal((await call('/settings')).code,'lifecycle_fenced');assert.equal((await call('/resume')).code,'lifecycle_fenced');assert.equal((await call('/alarm')).frozen,true);
  const blocked=await call('/purge');assert.equal(blocked.purged,false);assert.equal(blocked.impact.blockers.activeHandlers,1);
  release();assert.equal((await pending).lateRejected,true);assert.equal((await call('/drain')).drained,true);
  assert.equal((await call('/purge')).localDataDeleted,true);assert.equal((await call('/purge')).purged,true);
  const raw=await call('/raw');assert.equal(raw.accounts,0);assert.equal(raw.bookings,0);assert.deepEqual(raw.metaKeys,['operations:fence','profile']);
  assert.equal((await call('/init')).code,'lifecycle_fenced');assert.equal((await call('/settings')).code,'lifecycle_fenced');
 }finally{release?.();await mf.dispose();}
});
