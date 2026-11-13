// Disposable remote fixture only. Never bind this harness to an existing namespace.
import {DurableObject} from 'cloudflare:workers';
import {AuthStore} from '../../apps/booking/src/auth.js';
import {BookingLedger} from '../../apps/booking/src/ledger.js';
import {FENCE_META,fenceStore} from '../../apps/booking/src/maintenance.js';
import {DEFAULT} from '../../apps/booking/public/policy.js';
import {intakeRevision} from '../../apps/booking/public/intake.js';
export {AuthStore};
// No real provider fetch can leave this fixture, even if an imported fallback is called.
globalThis.fetch=async()=>{throw Error('fixture_external_fetch_blocked');};
const HOST='fixture-host',EFFECTS='external-mock-effects';
const ok=(condition,code)=>{if(!condition)throw Error(code);};

export class FixtureEffects extends DurableObject {
  constructor(ctx,env){super(ctx,env);this.sql=ctx.storage.sql;this.sql.exec('CREATE TABLE IF NOT EXISTS effects(kind TEXT,key TEXT,body TEXT,PRIMARY KEY(kind,key))');}
  remember(key,value){this.sql.exec("INSERT OR REPLACE INTO effects VALUES('journal',?,?)",key,JSON.stringify(value));}
  recall(key){const row=this.sql.exec("SELECT body FROM effects WHERE kind='journal' AND key=?",key).toArray()[0];return row?JSON.parse(row.body):null;}
  event(id){const row=this.sql.exec("SELECT body FROM effects WHERE kind='event' AND key=?",id).toArray()[0];return row?JSON.parse(row.body):null;}
  create(id,event){this.sql.exec("INSERT INTO effects VALUES('calendar-attempt',?,?)",crypto.randomUUID(),'{}');if(this.event(id)){this.sql.exec("INSERT INTO effects VALUES('duplicate',?,?)",crypto.randomUUID(),'{}');return this.event(id);}this.sql.exec("INSERT INTO effects VALUES('event',?,?)",id,JSON.stringify(event));return event;}
  remove(id){this.sql.exec("DELETE FROM effects WHERE kind='event' AND key=?",id);}
  send(key){this.sql.exec("INSERT INTO effects VALUES('mail-attempt',?,?)",crypto.randomUUID(),'{}');if(this.sent(key)){this.sql.exec("INSERT INTO effects VALUES('duplicate',?,?)",crypto.randomUUID(),'{}');return {messageId:'fixture-duplicate'};}this.sql.exec("INSERT INTO effects VALUES('mail',?,?)",key,'{}');return {messageId:'fixture-accepted'};}
  sent(key){return this.sql.exec("SELECT 1 FROM effects WHERE kind='mail' AND key=?",key).toArray().length>0;}
  counts(){return {calendar:this.sql.exec("SELECT COUNT(*) AS n FROM effects WHERE kind='event'").toArray()[0].n,mail:this.sql.exec("SELECT COUNT(*) AS n FROM effects WHERE kind='mail'").toArray()[0].n,calendarAttempts:this.sql.exec("SELECT COUNT(*) AS n FROM effects WHERE kind='calendar-attempt'").toArray()[0].n,mailAttempts:this.sql.exec("SELECT COUNT(*) AS n FROM effects WHERE kind='mail-attempt'").toArray()[0].n,duplicates:this.sql.exec("SELECT COUNT(*) AS n FROM effects WHERE kind='duplicate'").toArray()[0].n};}
}
export class FixtureHost extends DurableObject {
  constructor(ctx,env){
    super(ctx,env);this.effects=env.EFFECTS.getByName(EFFECTS);this.fenceChain=Promise.resolve();
    // Keep automatic alarms outside the bounded drill window. The controller
    // explicitly invokes the genuine ledger alarm handler at each checkpoint.
    const storage=new Proxy(ctx.storage,{get(target,key){if(key==='setAlarm')return when=>target.setAlarm(Math.max(when,Date.now()+86400000));const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;}});
    const effects=this.effects;
    const google={refreshTokens:async()=>({access_token:'fixture-access',expires_at:Date.now()+3600000}),listCalendars:async()=>[{id:'primary',accessRole:'owner'}],freeBusy:async()=>[],
      getEvent:async(_,{eventId})=>effects.event(eventId),createEvent:async(_,{eventId,event})=>effects.create(eventId,{...event,id:eventId,etag:'fixture-etag',status:'confirmed'}),deleteEvent:async(_,{eventId})=>effects.remove(eventId)};
    this.ledger=new BookingLedger({storage},{...env,PUBLIC_ORIGIN:'https://fixture.invalid',MAIL_FROM:'Fixture <fixture@example.test>',NOTIFICATION_PROVIDER:'cloudflare',EMAIL:{send:async()=>{throw Error('fixture_real_email_forbidden');}}},{google,sendNotification:async(_env,payload)=>effects.send(payload.idempotencyKey)});
    ctx.blockConcurrencyWhile(()=>this.ledger.syncMaintenanceFence());
  }
  async initialize(){
    ok(!this.ledger.hostId(),'fixture_already_initialized');
    this.ledger.init({id:HOST,name:'Fixture Owner',email:'owner@example.test'});await this.ledger.syncMaintenanceFence();
    await this.ledger.connect({accountId:'fixture-account',email:'owner@example.test',tokens:{access_token:'fixture-access',refresh_token:'fixture-refresh',expires_at:Date.now()+86400000}});
    await this.ledger.configureCalendars({accounts:[{id:'fixture-account',destinationCalendarId:'primary',conflictCalendarIds:['primary']}]});
    this.ledger.saveSettings({meetingTypes:[{...DEFAULT,id:'intro',slug:'intro',published:true,accountId:'fixture-account',calendarId:'primary',zone:'UTC',days:[0,1,2,3,4,5,6],startHour:0,endHour:24,notice:0,horizon:7,buffer:0,reminder:false,followUpMinutes:null}]});
    for(let i=0;i<2;i++){
      const start=Math.ceil((Date.now()+(36+i*4)*3600000)/900000)*900000;
      const result=await this.ledger.reserve('intro',{start,name:'Synthetic Guest',email:`guest${i}@example.test`,idempotencyKey:`fixture-booking-key-000${i}`,intakeRevision:await intakeRevision(this.ledger.type('intro'))});
      ok(!result.error&&result.booking.status==='confirmed','fixture_booking_failed');
      if(i===0)await this.effects.remember('guest',{id:result.booking.id,token:result.managementToken});
    }
    this.ledger.putOperationalMeta('fixture:marker','baseline');await this.ctx.storage.put('fixture:kvMarker','baseline');return this.status();
  }
  async bookmark(){const value=await this.ctx.storage.getCurrentBookmark();ok(/[1-9a-f]/i.test(value),'real_bookmark_required');await this.effects.remember('baseline',value);return {bookmark:value};}
  async advance(){const job=this.ledger.rows('SELECT body FROM live_jobs ORDER BY id LIMIT 1')[0];ok(job,'fixture_job_missing');await this.ledger.processJob(JSON.parse(job.body));this.ledger.putOperationalMeta('fixture:marker','advanced');await this.ctx.storage.put('fixture:kvMarker','advanced');return this.status();}
  async status(){const operations=await this.ledger.operationalStatus(),guest=await this.effects.recall('guest');return {operations,effects:await this.effects.counts(),marker:this.ledger.meta('fixture:marker'),kvMarker:await this.ctx.storage.get('fixture:kvMarker'),guestCapabilityWorks:guest?!!(await this.ledger.manage(guest.id,guest.token)).booking:false};}
  transition(action,expectedEpoch){const run=this.fenceChain.then(()=>this.ledger.setMaintenance({action,expectedEpoch}));this.fenceChain=run.catch(()=>{});return run;}
  async frozenProbe(){await this.ledger.alarm();return {repair:await this.ledger.runMaintenance('manual'),availability:await this.ledger.availability('intro'),effects:await this.effects.counts()};}
  async prepareRestore(label){
    ok(['baseline','undo-baseline'].includes(label),'fixture_unknown_restore_point');
    const status=await this.ledger.operationalStatus(),fence=await fenceStore(this.env,HOST).get();
    ok(status.outbound.frozen&&fence?.frozen&&fence.epoch===status.outbound.epoch,'fixture_freeze_ack_required');
    ok(status.outbound.inFlight.calendar===0&&status.outbound.inFlight.deliveries===0,'fixture_drain_required');
    const target=await this.effects.recall(label);ok(typeof target==='string'&&/[1-9a-f]/i.test(target),'fixture_restore_point_missing');
    const undo=await this.ctx.storage.onNextSessionRestoreBookmark(target);
    await this.effects.remember('undo-'+label,undo);await this.effects.remember('restore-prepared',{label,epoch:fence.epoch,undo});
    return {prepared:true,undo};
  }
  restart(){this.ctx.abort('isolated fixture restart',{retryAlarm:false});}
  async reconcileDeliveries(){
    const status=await this.ledger.operationalStatus();
    for(const item of status.deliveries.review.items){const delivered=await this.effects.sent(item.jobId),result=await this.ledger.resolveParkedDelivery({jobId:item.jobId,expectedUpdatedAt:item.updatedAt,outcome:delivered?'delivered':'release'});ok(result.ok,'fixture_delivery_reconciliation_failed');}
    return this.status();
  }
  async drain(){await this.ledger.alarm();await this.ledger.alarm();return this.status();}
  async interruptedResume(expectedEpoch){
    const original=this.ledger.putOperationalMeta.bind(this.ledger);let interrupted=false;
    this.ledger.putOperationalMeta=(key,value)=>{if(key===FENCE_META&&!value.frozen&&!interrupted){interrupted=true;throw Error('fixture_interrupted_resume_commit');}return original(key,value);};
    try{return await this.transition('resume',expectedEpoch);}finally{this.ledger.putOperationalMeta=original;}
  }
  alarm(){return this.ledger.alarm();}
}
function authorized(request,secret){const expected='Bearer '+secret,actual=request.headers.get('Authorization')??'';if(!secret||actual.length!==expected.length)return false;let diff=0;for(let i=0;i<actual.length;i++)diff|=actual.charCodeAt(i)^expected.charCodeAt(i);return diff===0;}
export default {async fetch(request,env){
  if(!authorized(request,env.DRILL_AUTH)||request.method!=='POST'||new URL(request.url).pathname!=='/drill')return new Response('Not found',{status:404});
  if(Number(request.headers.get('content-length')??0)>1024)return new Response('Too large',{status:413});
  let data;try{const text=await request.text();if(text.length>1024)return new Response('Too large',{status:413});data=JSON.parse(text);}catch{return new Response('Invalid',{status:400});}
  const host=env.HOST.getByName('isolated-fixture');
  try{let result;switch(data.action){
    case 'initialize':result=await host.initialize();break;
    case 'bookmark':result=await host.bookmark();break;
    case 'advance':result=await host.advance();break;
    case 'status':result=await host.status();break;
    case 'freeze':case 'resume':result=await host.transition(data.action,data.epoch);break;
    case 'probe':result=await host.frozenProbe();break;
    case 'prepare':result=await host.prepareRestore(data.label);break;
    case 'restart':try{await host.restart();}catch{}result={restartRequested:true};break;
    case 'reconcile':result=await host.reconcileDeliveries();break;
    case 'drain':result=await host.drain();break;
    case 'interrupted-resume':result=await host.interruptedResume(data.epoch);break;
    default:return new Response('Invalid',{status:400});
  }return Response.json(result,{headers:{'Cache-Control':'no-store'}});}catch{return Response.json({error:'fixture_step_failed'},{status:500});}
}};
