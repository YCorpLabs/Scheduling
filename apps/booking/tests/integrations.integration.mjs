// Local workerd SQLite acceptance. Every outbound request is intercepted by the
// Node fixture; no Slack, Discord, DNS or user provider is contacted.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,cpSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {build} from 'esbuild';
const src=JSON.stringify(new URL('../src/ledger.js',import.meta.url).pathname);
async function script(){return (await build({stdin:{resolveDir:new URL('..',import.meta.url).pathname,contents:`
 import {DurableObject} from 'cloudflare:workers';
 import {BookingLedger} from ${src};
 export class IntegrationHarness extends DurableObject{
  constructor(ctx,env){super(ctx,env);this.ledger=new BookingLedger(ctx,env,{integrations:{resolve:async()=>['93.184.216.34']}});this.ledger.fenceStore={get:async()=>{const r=await fetch('https://fence.test/value');return r.json();},compareAndSwap:async(version,body)=>{const r=await fetch('https://fence.test/value',{method:'POST',body:JSON.stringify({version,body})});return (await r.json()).ok;}};ctx.blockConcurrencyWhile(async()=>{if(this.ledger.hostId())await this.ledger.syncMaintenanceFence();});}
  async fetch(request){const l=this.ledger,path=new URL(request.url).pathname,body=request.method==='POST'?await request.json():{};
   if(path==='/setup'){l.init({id:'fixture-host',name:'Fixture'});await l.setMaintenance({action:'freeze',expectedEpoch:0});await l.setMaintenance({action:'resume',expectedEpoch:1});const c=await l.configureIntegration({kind:'slack',name:'Fixture',url:'https://hooks.slack.com/services/T123456/B123456/abcdefghijklmnopqrstuv',events:['booking.requested']});return Response.json(c);}
   if(path==='/seed'){const now=Date.now();l.putBooking({id:'fixture_booking_123456789',requestKey:'fixture-request',meetingTypeId:'intro',title:'Fixture meeting',name:'Private Guest',email:'private@example.com',start:now+3600000,end:now+5400000,status:'failed',version:1});await l.wake();return Response.json(l.integrationStatus());}
   if(path==='/status')return Response.json({integrations:l.integrationStatus(),operations:await l.operationalStatus()});
   if(path==='/alarm'){await l.alarm();return Response.json(l.integrationStatus());}
   if(path==='/due'){for(const row of l.rows("SELECT body FROM live_integration_deliveries WHERE state IN ('queued','retry','in_flight')")){const job=JSON.parse(row.body);job.due=Date.now();l.integrations.saveDelivery(job);}return Response.json({ok:true});}
   if(path==='/cycle'){let epoch=l.maintenanceEpoch();const a=await l.setMaintenance({action:'freeze',expectedEpoch:epoch});const b=await l.setMaintenance({action:'resume',expectedEpoch:epoch+1});return Response.json({a,b});}
   if(path==='/resume')return Response.json(await l.setMaintenance({action:'resume',expectedEpoch:l.maintenanceEpoch()}));
   if(path==='/discard')return Response.json(await l.retryIntegrationDelivery({deliveryId:body.id,action:'discard'}));
   return new Response('not found',{status:404});
  }
  alarm(){return this.ledger.alarm();}
 }
 export default{fetch(request,env){return env.BOX.getByName('fixture').fetch(request);}};
 `},bundle:true,write:false,format:'esm',platform:'browser',external:['cloudflare:workers']})).outputFiles[0].text;}

test('workerd outbox survives restart; ambiguous retries keep event ID and restored accepted jobs stay quarantined',async()=>{
 const source=await script(),root=mkdtempSync(join(tmpdir(),'booking-integrations-drill-')),live=join(root,'live'),snapshot=join(root,'snapshot'),restored=join(root,'restored');
 let remote=null,mode='ambiguous';const sent=[];
 const outboundService=async request=>{const u=new URL(request.url);if(u.hostname==='fence.test'){if(request.method==='POST'){const {version,body}=await request.json();if((remote?.version??null)!==version)return Response.json({ok:false});remote=body;return Response.json({ok:true});}return Response.json(remote);}assert.equal(u.hostname,'hooks.slack.com');const payload=await request.json();sent.push({id:request.headers.get('x-scheduling-event-id'),payload});return new Response(null,{status:mode==='ambiguous'?504:200});};
 const start=dir=>new Miniflare(convertV4MiniflareOptions({resourcePersistencePath:dir,workers:[{name:'integration-drill',modules:true,script:source,compatibilityDate:'2026-11-10',durableObjects:{BOX:{className:'IntegrationHarness',useSQLite:true}},bindings:{TOKEN_ENCRYPTION_KEY:Buffer.alloc(32,7).toString('base64')},outboundService}]}));
 const call=async(mf,path,body)=>{const r=await mf.dispatchFetch('http://localhost'+path,body?{method:'POST',body:JSON.stringify(body)}:{});assert.equal(r.status,200);return r.json();};
 let mf;
 try{
  mf=start(live);assert.ok((await call(mf,'/setup',{})).integration.id);const queued=await call(mf,'/seed',{});assert.equal(queued.deliveries[0].state,'queued');assert.equal(sent.length,0);await mf.dispose();mf=null;cpSync(live,snapshot,{recursive:true});
  mf=start(live);let state=await call(mf,'/status');assert.equal(state.integrations.deliveries[0].state,'queued');assert.equal(state.operations.outbound.frozen,false);const alarmResult=await call(mf,'/alarm',{});assert.equal(sent.length,1,JSON.stringify(alarmResult));assert.equal((await call(mf,'/status')).integrations.deliveries[0].state,'retry');await mf.dispose();mf=null;
  mode='accepted';mf=start(live);await call(mf,'/due',{});await call(mf,'/alarm',{});assert.equal(sent.length,2);assert.equal(sent[0].id,sent[1].id);assert.equal((await call(mf,'/status')).integrations.deliveries[0].state,'delivered');const cycle=await call(mf,'/cycle',{});assert.equal(cycle.b.ok,true);await mf.dispose();mf=null;
  cpSync(snapshot,restored,{recursive:true});mf=start(restored);state=await call(mf,'/status');const job=state.integrations.deliveries[0];assert.equal(job.state,'quarantined');assert.equal(state.operations.outbound.frozen,true);assert.ok(state.operations.issues.some(i=>i.code==='integration_restore_quarantine'));await call(mf,'/alarm',{});assert.equal(sent.length,2);assert.equal((await call(mf,'/resume',{})).code,'integration_restore_quarantine');assert.equal((await call(mf,'/discard',{id:job.id})).ok,true);assert.equal((await call(mf,'/resume',{})).ok,true);await call(mf,'/alarm',{});assert.equal(sent.length,2);
  for(const message of sent){assert.ok(!JSON.stringify(message).includes('private@example.com'));assert.ok(!JSON.stringify(message).includes('Private Guest'));}
 }finally{await mf?.dispose();rmSync(root,{recursive:true,force:true});}
});
