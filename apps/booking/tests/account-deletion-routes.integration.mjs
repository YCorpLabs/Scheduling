import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
const HOST='h_abcdefghijklmnopqrstuvwx',OTHER='h_bcdefghijklmnopqrstuvwxy',TOKEN='t'.repeat(43);
test('actual public deletion routes enforce origin/account, revoke sessions401, keep scoped status and resume cancelled maintenance',async()=>{
 const source=`import worker,{AuthStore,LiveBookingHost} from './src/worker.js';import {storeBrowserSession} from './src/auth.js';import {reserveLifecycle,cancelLifecycleReservation} from './src/lifecycle.js';export {AuthStore};const id='${HOST}',other='${OTHER}',user={hostId:id,email:'me@example.test'},token='${TOKEN}';
 export class FixtureHost extends LiveBookingHost{runMaintenance(){this.ledger.putMeta('fixture-maintenance',(this.ledger.meta('fixture-maintenance')||0)+1);return {ok:true};}fixtureCount(){return this.ledger.meta('fixture-maintenance')||0;}}
 export default {async fetch(request,env,ctx){const p=new URL(request.url).pathname;if(p==='/fixture/init'){await env.LIVE_HOSTS.getByName(id).init({id,name:'Me',email:user.email});await env.AUTH.getByName('identity:'+id).put({...user,version:1,accountGeneration:0},86400000);await storeBrowserSession(env,token,user);await env.AUTH.getByName('host-registry').register(id);await env.AUTH.getByName('account-cleanup-inventory-epoch').put({schema:1,complete:true,scanId:'route-scan',activatedAt:1,completedAt:2,knownHostIds:[id]},86400000);await env.AUTH.getByName('account-cleanup-inventory:'+id).put({schema:1,hostId:id,complete:true,scanId:'route-scan',schemaActivatedAt:1,objectIds:[]},86400000);return Response.json({ok:true});}
 if(p==='/fixture/cancelled'){const host=env.LIVE_HOSTS.getByName(id),impact=await host.lifecycleImpact(),binding={coordinatorId:id,operationId:'cancel_operation_123456',nonce:'cancel_nonce_12345678',actorId:id,actorGeneration:0,expectedGeneration:0,manifestHash:'a'.repeat(43),notAfter:Date.now()+60000,targets:[{kind:'host',id,revision:impact.revision}]};await reserveLifecycle(env,id,binding);await env.AUTH.getByName('lifecycle:'+id).accountDeletionAttach(id,{operationId:binding.operationId,publicOperationId:id+'.'+'x'.repeat(32),expectedGeneration:0,receiptHash:'r'.repeat(43),manifest:{},binding,requestedAt:Date.now(),deleteBy:Date.now()+86400000});await cancelLifecycleReservation(env,id,{...binding,reason:'cancelled'});let job;await worker.scheduled({},env,{waitUntil:p=>job=p});await job;return Response.json({count:await host.fixtureCount()});}
 return worker.fetch(request,env,ctx);}};`;
 const bundle=await build({stdin:{contents:source,resolveDir:new URL('..',import.meta.url).pathname},bundle:true,format:'esm',platform:'browser',external:['cloudflare:workers'],write:false});
 const mf=new Miniflare(convertV4MiniflareOptions({workers:[{name:'deletion-routes',modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2026-11-10',bindings:{PUBLIC_ORIGIN:'https://fixture.invalid',LIVE_ENABLED:'true',GOOGLE_CLIENT_ID:'fixture',GOOGLE_CLIENT_SECRET:'fixture',TOKEN_ENCRYPTION_KEY:Buffer.alloc(32,1).toString('base64')},durableObjects:{AUTH:{className:'AuthStore',useSQLite:true},LIVE_HOSTS:{className:'FixtureHost',useSQLite:true}},outboundService:()=>{throw Error('Real providers forbidden');}}]}));
 const call=async(path,data={},options={})=>{const res=await mf.dispatchFetch('https://fixture.invalid'+path,{method:'POST',headers:{'Content-Type':'application/json',Origin:options.origin||'https://fixture.invalid',Cookie:'email_booking_session='+TOKEN,'X-Scheduling-Account':options.account||HOST},body:JSON.stringify(data)});return {status:res.status,body:await res.json()};};
 try{
  assert.equal((await call('/fixture/init')).status,200);assert.equal((await call('/fixture/cancelled')).body.count,1);
  assert.equal((await call('/api/live/account/deletion/prepare',{}, {origin:'https://foreign.invalid'})).status,403);
  assert.equal((await call('/api/live/account/deletion/prepare',{}, {account:OTHER})).status,409);
  const p=await call('/api/live/account/deletion/prepare');assert.equal(p.status,200);assert.equal(p.body.canDelete,true);
  const confirmed=await call('/api/live/account/deletion/confirm',{confirmationToken:p.body.confirmationToken});assert.equal(confirmed.status,200);assert.equal(confirmed.body.state,'deleted');
  const privateRead=await mf.dispatchFetch('https://fixture.invalid/api/live/settings',{headers:{Cookie:'email_booking_session='+TOKEN}});assert.equal(privateRead.status,401);
  assert.equal((await call('/api/account/deletion/status',{operationId:p.body.operationId,receipt:'w'.repeat(43)})).status,404);
  const status=await call('/api/account/deletion/status',{operationId:p.body.operationId,receipt:p.body.receipt});assert.equal(status.body.state,'deleted');assert.equal(status.body.localDataDeleted,true);
 }finally{await mf.dispose();}
});
