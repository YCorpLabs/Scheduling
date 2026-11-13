import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';

// Real SQLite ledger, Google HTTP adapter, crypto and notification adapter in
// workerd. All outbound traffic terminates in the deterministic fake below.
test('workerd recovers ambiguous insert acknowledgements and verifies each due reminder independently',async()=>{
 const built=await build({stdin:{resolveDir:new URL('..',import.meta.url).pathname,contents:`
  import {DurableObject} from 'cloudflare:workers';
  import {BookingLedger} from './src/ledger.js';
  import {DEFAULT} from './public/policy.js';
  import {intakeRevision} from './public/intake.js';
  export class LifecycleHarness extends DurableObject {
   constructor(ctx,env){super(ctx,env);this.ledger=new BookingLedger(ctx,env);}
   async fetch(request){const path=new URL(request.url).pathname,l=this.ledger;
    if(path.endsWith('/request')){
     l.init({id:'owner',name:'Owner'});await l.connect({accountId:'a',email:'owner@example.test',tokens:{access_token:'fake',refresh_token:'fake',expires_at:Date.now()+86400000}});
     await l.configureCalendars({accounts:[{id:'a',destinationCalendarId:'primary',conflictCalendarIds:['primary']}]});
     l.saveSettings({meetingTypes:[{...DEFAULT,id:'intro',slug:'intro',title:'Review',published:true,accountId:'a',calendarId:'primary',reminder:true,reminderMinutes:[5],zone:'UTC',notice:0,horizon:5,startHour:0,endHour:24,days:[0,1,2,3,4,5,6],buffer:0}]});
     const result=await l.reserve('intro',{start:Math.ceil((Date.now()+3600000)/900000)*900000,name:'Guest',email:'guest@example.test',idempotencyKey:'runtime-lifecycle-request-123',intakeRevision:await intakeRevision(l.type('intro'))});
     this.id=result.booking.id;await this.ctx.storage.deleteAlarm();return Response.json({status:result.booking.status,eventId:l.booking(this.id).eventId});
    }
    if(path.endsWith('/recover')){this.ledger=new BookingLedger(this.ctx,this.env);await this.ledger.reconcile(this.id);await this.ctx.storage.deleteAlarm();return Response.json({booking:this.ledger.booking(this.id),jobs:this.ledger.rows('SELECT body FROM live_jobs').map(r=>JSON.parse(r.body))});}
    if(path.endsWith('/process')){
     const now=Date.now,b=l.booking(this.id);try{
      Date.now=()=>b.start-5*60000;
      const job=l.rows("SELECT body FROM live_jobs WHERE json_extract(body,'$.kind')='reminder' ORDER BY due LIMIT 1")[0];if(job)await l.processJob(JSON.parse(job.body));
      return Response.json({booking:l.booking(this.id),jobs:l.rows("SELECT due,body FROM live_jobs WHERE json_extract(body,'$.kind')='reminder'").map(r=>({due:r.due,...JSON.parse(r.body)}))});
     }finally{Date.now=now;await this.ctx.storage.deleteAlarm();}
    }
    return new Response('missing',{status:404});
   }
   alarm(){return this.ledger.alarm();}
  }
  export default {fetch(request,env){return env.HARNESS.getByName(new URL(request.url).pathname.split('/')[1]).fetch(request);}};
 `},bundle:true,write:false,format:'esm',platform:'browser',external:['cloudflare:workers']});
 const events=new Map(),modes=new Map(),mail=[];let ambiguous=false,inserts=0,reads=0;
 const mf=new Miniflare(convertV4MiniflareOptions({workers:[{name:'lifecycle-quality',modules:true,script:built.outputFiles[0].text,compatibilityDate:'2026-11-10',durableObjects:{HARNESS:{className:'LifecycleHarness',useSQLite:true}},bindings:{PUBLIC_ORIGIN:'http://localhost',TOKEN_ENCRYPTION_KEY:Buffer.alloc(32,7).toString('base64'),RESEND_API_KEY:'fake',MAIL_FROM:'meet@example.test'},outboundService:async request=>{
  const u=new URL(request.url);
  if(u.hostname==='api.resend.com'){mail.push(await request.json());return Response.json({id:'mail-'+mail.length});}
  assert.equal(u.hostname,'www.googleapis.com','No request may reach a real provider');
  if(u.pathname.endsWith('/calendarList'))return Response.json({items:[{id:'primary',accessRole:'owner'}]});
  if(u.pathname.endsWith('/freeBusy')){const body=await request.json();return Response.json({calendars:Object.fromEntries(body.items.map(i=>[i.id,{busy:[]}]))});}
  if(u.pathname.endsWith('/events')&&request.method==='POST'){inserts++;const event=await request.json();events.set(event.id,{...event,etag:'"1"',status:'confirmed'});return Response.json(ambiguous?{}:events.get(event.id));}
  assert.equal(request.method,'GET');reads++;const id=u.pathname.split('/').at(-1),mode=modes.get(id),event=events.get(id);
  if(mode==='revoked')return Response.json({error:{message:'private provider body'}},{status:403});
  if(mode==='deleted')return Response.json({id,status:'cancelled'});
  if(!event)return Response.json({error:{}},{status:404});
  if(mode==='all_day')return Response.json({...event,start:{date:'2026-11-01'},end:{date:'2026-11-02'}});
  return Response.json(event);
 }}]}));
 const call=async path=>{const response=await mf.dispatchFetch('http://localhost'+path);assert.equal(response.status,200,await response.clone().text());return response.json();};
 try{
  ambiguous=true;const before=inserts,unknown=await call('/ambiguous/request');assert.equal(unknown.status,'pending');assert.equal(mail.length,0);
  const recovered=await call('/ambiguous/recover');assert.equal(recovered.booking.status,'confirmed');assert.equal(inserts,before+1);assert.ok(recovered.jobs.some(j=>j.kind==='reminder'));assert.equal(mail.length,0);ambiguous=false;
  for(const mode of ['deleted','revoked','all_day','move','current']){
   const result=await call('/'+mode+'/request'),event=events.get(result.eventId),beforeMail=mail.length,beforeReads=reads;assert.equal(result.status,'confirmed');
   if(mode==='move'){event.start.dateTime=new Date(Date.parse(event.start.dateTime)+3600000).toISOString();event.end.dateTime=new Date(Date.parse(event.end.dateTime)+3600000).toISOString();}
   else modes.set(result.eventId,mode);
   const state=await call('/'+mode+'/process');assert.equal(reads,beforeReads+1,mode+' needs a fresh event GET');assert.equal(mail.length,beforeMail+(mode==='current'?1:0),mode);
   if(mode==='deleted'){assert.equal(state.booking.status,'cancelled');assert.deepEqual(state.jobs,[]);}
   if(['revoked','all_day'].includes(mode)){assert.equal(state.booking.calendarSyncStatus,'pending');assert.equal(state.jobs[0].pausedForCalendarSync,true);assert.ok(!state.jobs[0].firstAttemptAt);assert.ok(!JSON.stringify(state).includes('private provider body'));}
   if(mode==='move'){assert.equal(state.booking.version,2);assert.equal(state.jobs.length,1);assert.equal(state.jobs[0].due,Date.parse(event.start.dateTime)-5*60000);await call('/move/process');assert.equal(mail.length,beforeMail+1);}
   if(mode==='current'){assert.deepEqual(state.jobs,[]);await call('/current/process');assert.equal(mail.length,beforeMail+1);}
  }
 }finally{await mf.dispose();}
});
