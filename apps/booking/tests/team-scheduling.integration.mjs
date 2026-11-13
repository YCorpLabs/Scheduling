import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
test('workerd SQLite admits only available team resources and recovers the same collective assignment',async()=>{
 const built=await build({stdin:{resolveDir:new URL('..',import.meta.url).pathname,contents:`
 import {DurableObject} from 'cloudflare:workers';
 import {BookingLedger} from './src/ledger.js';
 import {DEFAULT} from './public/policy.js';
 import {intakeRevision} from './public/intake.js';
 const events=new Map();let unknown=false;
 const provider={listCalendars:async()=>[{id:'primary',accessRole:'owner'}],freeBusy:async()=>[],getEvent:async(_,{eventId})=>events.get(eventId)??null,createEvent:async(_,{eventId,event})=>{const result={...event,id:eventId,etag:'v1',status:'confirmed'};events.set(eventId,result);if(unknown)throw Error('unknown');return result;},deleteEvent:async(_,{eventId})=>events.delete(eventId)};
 export class TeamHarness extends DurableObject{
 constructor(ctx,env){super(ctx,env);this.ledger=new BookingLedger(ctx,env,{google:provider});}
 alarm(){return this.ledger.alarm();}
 async fetch(request){const l=this.ledger,body=await request.json();try{
 if(body.action==='init'){l.init({id:'profile',name:'Profile'});for(const id of ['a','b'])await l.connect({accountId:id,email:id+'@company.test',tokens:{access_token:id,refresh_token:id,expires_at:Date.now()+86400000}});await l.configureCalendars({accounts:['a','b'].map(id=>({id,destinationCalendarId:'primary',conflictCalendarIds:['primary']}))});const type={...DEFAULT,id:'intro',slug:'intro',published:true,zone:'UTC',notice:0,horizon:5,startHour:0,endHour:24,days:[0,1,2,3,4,5,6],buffer:0,reminder:false,teamScheduling:{mode:body.mode,hosts:['a','b'].map(id=>({id,name:id,accountId:id}))}};const verifiedDestinations=await l.verifyMeetingDestinations({meetingTypes:[type]});l.saveSettings({meetingTypes:[type]},{verifiedDestinations});return Response.json({ok:true});}
 if(body.action==='book'){unknown=!!body.unknown;const type=l.type('intro');return Response.json(await l.reserve('intro',{start:body.start,name:'Guest',email:'guest@company.test',key:body.key,intakeRevision:await intakeRevision(type),teamRevision:await l.teamRevision(type)}));}
 if(body.action==='recover'){this.ledger=new BookingLedger(this.ctx,this.env,{google:provider});await this.ledger.reconcile(body.id);return Response.json({booking:this.ledger.booking(body.id),count:events.size});}
 if(body.action==='cancel')return Response.json(await l.cancel(body.id,body.token));
 return Response.json({bookings:l.listBookings().bookings});
 }finally{await this.ctx.storage.deleteAlarm();}}
 }
 export default {fetch(request,env){return env.HARNESS.getByName(new URL(request.url).pathname).fetch(request);}};
 `},bundle:true,write:false,format:'esm',platform:'browser',external:['cloudflare:workers']});
 const mf=new Miniflare(convertV4MiniflareOptions({workers:[{name:'team-scheduling-runtime',modules:true,script:built.outputFiles[0].text,compatibilityDate:'2026-11-10',durableObjects:{HARNESS:{className:'TeamHarness',useSQLite:true}},bindings:{PUBLIC_ORIGIN:'http://localhost',TOKEN_ENCRYPTION_KEY:Buffer.alloc(32,8).toString('base64')},outboundService:()=>{throw Error('No real network is permitted');}}]}));
 const call=async(path,body)=>{const response=await mf.dispatchFetch('http://localhost/'+path,{method:'POST',body:JSON.stringify(body)});assert.equal(response.status,200,await response.clone().text());return response.json();};
 try{
  const at=Math.ceil((Date.now()+3600000)/900000)*900000;await call('any',{action:'init',mode:'any'});
  const results=await Promise.all(Array.from({length:3},(_,i)=>call('any',{action:'book',start:at,key:'team-runtime-concurrent-'+i})));
  assert.equal(results.filter(r=>r.booking?.status==='confirmed').length,2,JSON.stringify(results));assert.equal(results.filter(r=>r.status===409).length,1);assert.equal(new Set(results.filter(r=>r.booking).map(r=>r.booking.assignedHosts[0].id)).size,2);
  await call('all',{action:'init',mode:'all'});const pending=await call('all',{action:'book',start:at,key:'collective-runtime-unknown',unknown:true});assert.equal(pending.booking.status,'pending');assert.equal((await call('all',{action:'book',start:at,key:'collective-runtime-collision'})).status,409);const recovered=await call('all',{action:'recover',id:pending.booking.id});assert.equal(recovered.booking.status,'confirmed');assert.deepEqual(recovered.booking.teamAssignment.hosts.map(h=>h.id),['a','b']);assert.equal(recovered.count,3);const cancelled=await call('all',{action:'cancel',id:pending.booking.id,token:pending.managementToken});assert.equal(cancelled.booking.status,'cancelled');
 }finally{await mf.dispose();}
});
