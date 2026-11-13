import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {BookingLedger} from '../src/ledger.js';
import {DEFAULT,workingWindowChecker} from '../public/policy.js';
import {intakeRevision} from '../public/intake.js';
import {normalizeTeamScheduling,hostsShareResource} from '../public/team-policy.js';
const config={...DEFAULT,zone:'UTC',notice:0,horizon:5,startHour:0,endHour:24,days:[0,1,2,3,4,5,6],buffer:0,reminder:false};
// Keep the cutoff/move fixture inside one UTC workday.
test.beforeEach(t=>t.mock.timers.enable({apis:['Date'],now:Date.UTC(2030,0,7,9)}));
const start=()=>Math.ceil((Date.now()+3*3600000)/900000)*900000;
async function setup(mode='any',extra={}){
 const db=new DatabaseSync(':memory:'),storage={sql:{exec(q,...args){const rows=db.prepare(q).all(...args);return {toArray:()=>rows};}},setAlarm:async()=>{},transactionSync(fn){db.exec('BEGIN');try{const value=fn();db.exec('COMMIT');return value;}catch(e){db.exec('ROLLBACK');throw e;}}};
 const events=new Map(),busy={a:[],b:[]},calls=[];
 const google={refreshTokens:async()=>{throw Error('unexpected refresh');},listCalendars:async()=>[{id:'primary',accessRole:'owner'},{id:'shared',accessRole:'writer'}],freeBusy:async(token,input)=>{calls.push({token,...input});return busy[token];},getEvent:async(_,{eventId})=>events.get(eventId)??null,createEvent:async(token,{eventId,event,calendarId})=>{const result={...event,id:eventId,etag:'v1',status:'confirmed'};events.set(eventId,result);return result;},deleteEvent:async(_,{eventId})=>events.delete(eventId)};
 const ledger=new BookingLedger({storage},{TOKEN_ENCRYPTION_KEY:Buffer.alloc(32,9).toString('base64'),PUBLIC_ORIGIN:'https://test.invalid'},{google});ledger.init({id:'profile',name:'Profile'});
 for(const accountId of ['a','b']){await ledger.connect({accountId,email:accountId+'@company.test',tokens:{access_token:accountId,refresh_token:accountId,expires_at:Date.now()+86400000}});}
 await ledger.configureCalendars({accounts:['a','b'].map(id=>({id,destinationCalendarId:'primary',conflictCalendarIds:['primary']}))});
 const type={...config,id:'intro',slug:'intro',published:true,accountId:'a',calendarId:'primary',teamScheduling:{mode,hosts:['a','b'].map(id=>({id,name:id.toUpperCase(),accountId:id}))},...extra};
 const save=async(value)=>{const verifiedDestinations=await ledger.verifyMeetingDestinations({meetingTypes:[value]},ledger.settings());return ledger.saveSettings({meetingTypes:[value]},{verifiedDestinations});};
 await save(type);
 const book=async(data={})=>{const page=await ledger.availability('intro',{duration:data.duration}),type=ledger.type('intro');return ledger.reserve('intro',{start:start(),name:'Guest',email:'guest@company.test',idempotencyKey:crypto.randomUUID(),intakeRevision:await intakeRevision(type),teamRevision:page.config?.team?.revision,...data});};
 return {ledger,google,events,busy,calls,book,save,storage,type};
}

import {normalizeChangeNotices,changePolicyForStart,changeWindowOpen} from '../public/change-policy.js';
import {validateConfig} from '../public/policy.js';
import {adapterPayload} from '../src/integrations.js';
test('change notices are strict, snapshot deadlines close at equality and zero stays unrestricted',()=>{
 assert.deepEqual(normalizeChangeNotices({}),{cancellationNoticeMinutes:0,rescheduleNoticeMinutes:0});for(const value of [null,'60',-1,43201,1.5,true,NaN])for(const key of ['cancellationNoticeMinutes','rescheduleNoticeMinutes'])assert.throws(()=>validateConfig({...DEFAULT,[key]:value}));const start=Date.UTC(2027,0,2),p=changePolicyForStart({cancellationNoticeMinutes:60,rescheduleNoticeMinutes:120},start);assert.equal(p.cancelUntil,start-3600000);assert.equal(p.rescheduleUntil,start-7200000);assert.equal(changeWindowOpen(p,'cancel',p.cancelUntil-1),true);assert.equal(changeWindowOpen(p,'cancel',p.cancelUntil),false);assert.equal(changeWindowOpen(changePolicyForStart({},start),'cancel',start+86400000),true);
});
test('accepted notices survive link edits and staff-only overrides; replacement keeps promises',async()=>{
 const f=await setup('all',{cancellationNoticeMinutes:43200,rescheduleNoticeMinutes:43200}),first=await f.book();assert.equal(first.booking.status,'confirmed');assert.equal(first.booking.changePolicy.cancellationNoticeMinutes,43200);await f.save({...f.type,cancellationNoticeMinutes:0,rescheduleNoticeMinutes:0});assert.equal((await f.ledger.cancel(first.booking.id,first.managementToken,'private')).code,'change_window_closed');assert.equal((await f.ledger.rescheduleAvailability(first.booking.id,first.managementToken)).code,'change_window_closed');assert.equal((await f.ledger.reschedule(first.booking.id,first.managementToken,first.booking.start+3*3600000,crypto.randomUUID())).code,'change_window_closed');const staffPage=await f.ledger.rescheduleAvailability(first.booking.id,first.managementToken,{}, {staff:true});assert.ok(staffPage.slots.length);const moved=await f.ledger.reschedule(first.booking.id,first.managementToken,first.booking.start+3*3600000,crypto.randomUUID(),{staff:true});assert.equal(moved.booking.status,'confirmed',JSON.stringify(moved));assert.equal(moved.booking.changePolicy.cancellationNoticeMinutes,43200);assert.equal(moved.booking.changePolicy.rescheduleNoticeMinutes,43200);assert.equal((await f.ledger.cancel(moved.booking.id,moved.managementToken,'owner', {staff:true})).booking.cancellationReason,'owner');
});
test('legacy zero snapshot stays open after stricter edits and cancellation reason is first-intent immutable',async()=>{
 const f=await setup('all'),first=await f.book();await f.save({...f.type,cancellationNoticeMinutes:43200,rescheduleNoticeMinutes:43200});assert.equal(first.booking.changePolicy.cancelUntil,null);const cancelled=await f.ledger.cancel(first.booking.id,first.managementToken,'  First private reason  ');assert.equal(cancelled.booking.status,'cancelled');assert.equal(cancelled.booking.cancellationReason,'First private reason');assert.equal((await f.ledger.cancel(first.booking.id,first.managementToken,'Replacement')).booking.cancellationReason,'First private reason');await assert.rejects(()=>f.ledger.cancel(first.booking.id,first.managementToken,'a'.repeat(501)),e=>e.status===400);
});
test('pending and approval requests can always be withdrawn within a closed cutoff',async()=>{
 for(const status of ['pending','awaiting_approval']){const f=await setup('all',{cancellationNoticeMinutes:43200,requiresApproval:status==='awaiting_approval'});if(status==='pending')f.google.createEvent=async()=>{throw Error('unknown insert');};const first=await f.book();assert.equal(first.booking.status,status);const cancelled=await f.ledger.cancel(first.booking.id,first.managementToken,'Withdraw request');assert.equal(cancelled.booking.status,'cancelled');assert.equal(cancelled.booking.cancellationReason,'Withdraw request');}
});
test('cancel deadline is rechecked after authorization await before durable intent',async()=>{
 const f=await setup('all',{cancellationNoticeMinutes:60}),first=await f.book(),deadline=first.booking.changePolicy.cancelUntil,originalNow=Date.now,digest=crypto.subtle.digest.bind(crypto.subtle);let entered,release,armed=true;const reached=new Promise(r=>entered=r),gate=new Promise(r=>release=r);let now=deadline-1;Date.now=()=>now;crypto.subtle.digest=async(...args)=>{const result=await digest(...args);if(armed){armed=false;entered();await gate;}return result;};let pending;
 try{pending=f.ledger.cancel(first.booking.id,first.managementToken,'Late');await reached;now=deadline;release();assert.equal((await pending).code,'change_window_closed');assert.equal(f.ledger.booking(first.booking.id).status,'confirmed');assert.equal(f.ledger.booking(first.booking.id).cancellationReason,undefined);}finally{release();crypto.subtle.digest=digest;Date.now=originalNow;await pending?.catch(()=>{});}
});
test('reschedule closes during provider work before final hold and clears temporary intent',async()=>{
 const f=await setup('all',{rescheduleNoticeMinutes:60}),first=await f.book(),deadline=first.booking.changePolicy.rescheduleUntil,originalNow=Date.now,read=f.google.freeBusy;let entered,release;const reached=new Promise(r=>entered=r),gate=new Promise(r=>release=r);let now=deadline-1;Date.now=()=>now;f.google.freeBusy=async(...args)=>{entered();await gate;return read(...args);};let pending;
 try{pending=f.ledger.reschedule(first.booking.id,first.managementToken,first.booking.start+3*3600000,crypto.randomUUID());await reached;now=deadline;release();const result=await pending;assert.equal(result.code,'change_window_closed');assert.equal(f.ledger.rows('SELECT id FROM live_bookings').length,1);assert.equal(f.ledger.booking(first.booking.id).replacementKey,undefined);assert.equal(f.events.size,1);}finally{release();Date.now=originalNow;await pending?.catch(()=>{});}
});
test('accepted move replays after its old deadline, without new hold or changed reason sharing',async()=>{
 const f=await setup('all',{rescheduleNoticeMinutes:60}),first=await f.book(),key=crypto.randomUUID(),moved=await f.ledger.reschedule(first.booking.id,first.managementToken,first.booking.start+3*3600000,key),originalNow=Date.now;assert.equal(moved.booking.status,'confirmed');Date.now=()=>first.booking.changePolicy.rescheduleUntil;
 try{const replay=await f.ledger.reschedule(first.booking.id,first.managementToken,moved.booking.start,key);assert.equal(replay.booking.id,moved.booking.id);assert.equal(f.events.size,1);}finally{Date.now=originalNow;}
});
test('cancellation reason stays out of webhook, Slack, Discord and notification payloads',async()=>{
 const f=await setup('all'),outbound=[];f.ledger.env.MAIL_FROM='notify@company.test';f.ledger.env.RESEND_API_KEY='fixture';f.ledger.env.INTEGRATION_WEBHOOK_HOSTS='hooks.example.com';
 for(const [kind,url] of [['webhook','https://hooks.example.com/events'],['slack','https://hooks.slack.com/services/T12345/B12345/abcdefghijklmnopqrstuv'],['discord','https://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuv']]){const created=await f.ledger.configureIntegration({kind,name:kind,url,events:['booking.cancelled']});assert.ok(created.integration,JSON.stringify(created));}
 f.ledger.integrations.enqueue=(config,payload)=>outbound.push({kind:config.kind,payload:adapterPayload(config.kind,payload)});const first=await f.book();f.ledger.notify=async(_,payload)=>{outbound.push({kind:'email',payload});return {id:'sent'};};await f.ledger.cancel(first.booking.id,first.managementToken,'PRIVATE-CANCELLATION-REASON');for(const row of f.ledger.rows("SELECT body FROM live_jobs WHERE json_extract(body,'$.kind')='cancelled'"))await f.ledger.processJob(JSON.parse(row.body));assert.ok(outbound.some(p=>p.kind==='webhook'));assert.ok(outbound.some(p=>p.kind==='slack'));assert.ok(outbound.some(p=>p.kind==='discord'));assert.ok(outbound.some(p=>p.kind==='email'));assert.ok(!JSON.stringify(outbound).includes('PRIVATE-CANCELLATION-REASON'));
});

test('management availability rechecks the deadline after provider reads',async()=>{
 const f=await setup('all',{rescheduleNoticeMinutes:60}),first=await f.book(),deadline=first.booking.changePolicy.rescheduleUntil,originalNow=Date.now,read=f.google.freeBusy;f.ledger.availabilityCache.clear();let entered,release;const reached=new Promise(r=>entered=r),gate=new Promise(r=>release=r);let now=deadline-1;Date.now=()=>now;f.google.freeBusy=async(...args)=>{entered();await gate;return read(...args);};let pending;
 try{pending=f.ledger.rescheduleAvailability(first.booking.id,first.managementToken);await reached;now=deadline;release();assert.equal((await pending).code,'change_window_closed');assert.equal((await f.ledger.reschedule(first.booking.id,first.managementToken,first.booking.start,crypto.randomUUID())).code,'change_window_closed');}finally{release();Date.now=originalNow;await pending?.catch(()=>{});}
});
test('an originally blank cancellation reason cannot be added on an in-progress retry',async()=>{
 const f=await setup('all'),first=await f.book();f.google.deleteEvent=async()=>{throw Error('Unknown delete');};const initial=await f.ledger.cancel(first.booking.id,first.managementToken,'   ');assert.equal(initial.booking.status,'cancelling');assert.equal(initial.booking.cancellationReason,undefined);const retry=await f.ledger.cancel(first.booking.id,first.managementToken,'Later reason');assert.equal(retry.booking.cancellationReason,undefined);assert.equal(f.ledger.booking(first.booking.id).cancellationReason,undefined);
});
