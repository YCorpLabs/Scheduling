import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { BookingLedger,liveSlots } from '../src/ledger.js';
import { DEFAULT } from '../public/policy.js';
import { intakeRevision } from '../public/intake.js';
import { sha256, encryptTokens, decryptTokens } from '../src/crypto.js';
const config={...DEFAULT,zone:'UTC',notice:0,horizon:5,startHour:0,endHour:24,days:[0,1,2,3,4,5,6],buffer:0,reminder:false};
function setup(overrides={}){
 const db=new DatabaseSync(':memory:');const storage={sql:{exec(query,...args){const statement=db.prepare(query);const rows=statement.all(...args);return {toArray:()=>rows};}},setAlarm:async()=>{},transactionSync(callback){db.exec('BEGIN');try{const result=callback();db.exec('COMMIT');return result;}catch(error){db.exec('ROLLBACK');throw error;}}};
 const events=new Map(),effects={created:0,deleted:0};const provider={refreshTokens:async()=>({access_token:'access',expires_at:Date.now()+3600000}),listCalendars:async()=>[{id:'primary',accessRole:'owner'}],freeBusy:async()=>[],getEvent:async(_,{eventId})=>events.get(eventId)??null,createEvent:async(_,{eventId,event})=>{effects.created++;const result={...event,id:eventId,etag:'etag'};events.set(eventId,result);return result;},deleteEvent:async(_,{eventId})=>{effects.deleted++;events.delete(eventId);},...overrides};
 const ledger=new BookingLedger({storage},{TOKEN_ENCRYPTION_KEY:Buffer.alloc(32,7).toString('base64'),PUBLIC_ORIGIN:'https://example.test'}, {google:provider,sendNotification:async()=>({id:'sent'})});ledger.init({id:'host',name:'Host'});
 const ready=async()=>{await ledger.connect({accountId:'a',email:'host@example.test',tokens:{access_token:'access',refresh_token:'refresh',expires_at:Date.now()+3600000}});await ledger.configureCalendars({accounts:[{id:'a',destinationCalendarId:'primary',conflictCalendarIds:['primary']}]});ledger.saveSettings({meetingTypes:[{...config,id:'intro',slug:'intro',published:true,accountId:'a',calendarId:'primary'},{...config,id:'other',slug:'other',published:true,accountId:'a',calendarId:'primary'}]});};
 return {ledger,ready,events,effects,storage};
}
async function reserve(ledger,slug,data,replacesId){if(!Object.hasOwn(data,'intakeRevision'))data.intakeRevision=await intakeRevision(ledger.type(slug)??config);return ledger.reserve(slug,data,replacesId);}
// Keep relative move cases within one working day even when tests run late UTC.
const details=(key='1234567890123456')=>{let start=Math.ceil((Date.now()+3600000)/900000)*900000;const date=new Date(start);if(date.getUTCHours()>=16){date.setUTCDate(date.getUTCDate()+1);date.setUTCHours(2,0,0,0);start=date.getTime();}return {start,name:'Guest',email:'guest@example.test',idempotencyKey:key};};
test('live slots include lunch and respect existing buffer',()=>{const now=Date.UTC(2026,10,10,11);const c={...config,horizon:1};assert.ok(liveSlots(c,now,[],Date.UTC(2026,10,10,12),Date.UTC(2026,10,10,13)).length);const busy=[{start:now+3600000,end:now+5400000,buffer:30*60000}];assert.ok(!liveSlots(c,now,busy).some(s=>s.start===busy[0].end));});
test('one host conflicts across types; keys bind payload; only hash tokens stored',async()=>{const {ledger,ready,effects}=setup();await ready();const data=details();const first=await reserve(ledger,'intro',data);assert.equal(first.booking.status,'confirmed');assert.equal(effects.created,1);assert.equal((await reserve(ledger,'other',{...data,idempotencyKey:'other123456789012'})).status,409);assert.equal((await reserve(ledger,'intro',{...data,email:'other@example.test'})).status,409);const retry=await reserve(ledger,'intro',data);assert.equal(retry.booking.id,first.booking.id);assert.equal(retry.managementToken,first.managementToken);const stored=ledger.booking(first.booking.id);assert.ok(stored.tokenHash);assert.ok(!JSON.stringify(stored).includes(first.managementToken));assert.equal((await ledger.manage(first.booking.id,'bad')).status,404);assert.equal((await ledger.manage(first.booking.id,first.managementToken)).booking.email,data.email);});
test('synchronous durable holds admit only one concurrent guest',async()=>{let release;const gate=new Promise(r=>release=r);const {ledger,ready,effects}=setup({freeBusy:async()=>{await gate;return [];}});await ready();const data=details();const one=reserve(ledger,'intro',data);const two=reserve(ledger,'other',{...data,idempotencyKey:'second1234567890'});await new Promise(r=>setTimeout(r,20));release();const result=await Promise.all([one,two]);assert.equal(result.filter(r=>r.booking?.status==='confirmed').length,1);assert.equal(result.filter(r=>r.status===409).length,1);assert.equal(effects.created,1);});
test('unknown insert result recovers by deterministic GET without duplicate insert',async()=>{const {ledger,ready,effects,events}=setup();await ready();const original=ledger.google.createEvent;ledger.google.createEvent=async(...args)=>{await original(...args);throw Object.assign(Error('timeout'),{retryable:true});};const result=await reserve(ledger,'intro',details());assert.equal(result.booking.status,'pending');assert.equal(events.size,1);await ledger.reconcile(result.booking.id);assert.equal(ledger.booking(result.booking.id).status,'confirmed');assert.equal(effects.created,1);});
test('fresh provider conflict fails hold before any insert',async()=>{const data=details();const {ledger,ready,effects}=setup({freeBusy:async()=>[{start:data.start,end:data.start+60000}]});await ready();const result=await reserve(ledger,'intro',data);assert.equal(result.booking.status,'failed');assert.equal(effects.created,0);});
test('cancellation intent survives delete timeout and eviction',async()=>{let reject=true;const {ledger,ready,events}=setup();await ready();const result=await reserve(ledger,'intro',details());const original=ledger.google.deleteEvent;ledger.google.deleteEvent=async(...args)=>{await original(...args);if(reject)throw Error('timeout');};const cancelled=await ledger.cancel(result.booking.id,result.managementToken);assert.equal(cancelled.booking.status,'cancelling');assert.equal(events.size,0);reject=false;await ledger.reconcile(result.booking.id);assert.equal(ledger.booking(result.booking.id).status,'cancelled');assert.equal((await ledger.cancel(result.booking.id,result.managementToken)).booking.status,'cancelled');});
test('cancelling an in-flight create eventually deletes its event',async()=>{let release,entered;const reached=new Promise(r=>entered=r),gate=new Promise(r=>release=r);const {ledger,ready,events}=setup();await ready();const original=ledger.google.createEvent;ledger.google.createEvent=async(...args)=>{entered();await gate;return original(...args);};const reservation=reserve(ledger,'intro',details());await reached;const id=ledger.rows('SELECT id FROM live_bookings')[0].id;const b=ledger.booking(id);b.status='cancelling';b.version++;ledger.putBooking(b);release();await reservation;assert.equal(ledger.booking(id).status,'cancelled');assert.equal(events.size,0);});
test('persisted pending creation recovers in a new ledger instance',async()=>{const {ledger,ready,storage,effects}=setup();await ready();const create=ledger.google.createEvent;ledger.google.createEvent=async(...args)=>{await create(...args);throw Error('unknown');};const result=await reserve(ledger,'intro',details());const restarted=new BookingLedger({storage},ledger.env,{google:ledger.google,sendNotification:async()=>({id:'sent'})});await restarted.alarm();assert.equal(restarted.booking(result.booking.id).status,'confirmed');assert.equal(effects.created,1);});
test('unknown create with absent GET and fresh busy stays pending and does not insert again',async()=>{const {ledger,ready,effects}=setup();await ready();ledger.google.createEvent=async()=>{effects.created++;throw Error('unknown');};const data=details(),result=await reserve(ledger,'intro',data);ledger.google.freeBusy=async()=>[{start:data.start,end:data.start+60000}];await ledger.reconcile(result.booking.id);assert.equal(ledger.booking(result.booking.id).status,'pending');assert.equal(effects.created,1);});
test('rescheduling persists replacement before creation and returns recoverable successor',async()=>{const {ledger,ready,events}=setup();await ready();const data=details(),first=await reserve(ledger,'intro',data);const start=data.start+3*3600000;const second=await ledger.reschedule(first.booking.id,first.managementToken,start,'reschedule1234567890');assert.equal(second.booking.status,'confirmed');assert.equal(second.booking.meetingTypeSlug,'intro');assert.equal(second.previousBooking.status,'cancelled');assert.equal(ledger.booking(second.booking.id).replacesId,first.booking.id);assert.equal(events.size,1);const retry=await ledger.reschedule(first.booking.id,first.managementToken,start,'reschedule1234567890');assert.equal(retry.booking.id,second.booking.id);assert.equal(retry.managementToken,second.managementToken);});
test('notification retries retain exact encrypted payload and pause before provider deduplication expires',async()=>{const {ledger,ready}=setup();ledger.env.RESEND_API_KEY='test';ledger.env.MAIL_FROM='host@example.test';await ready();const result=await reserve(ledger,'intro',details());const payloads=[];ledger.notify=async(_env,payload)=>{payloads.push(payload);throw Object.assign(Error('unknown'),{retryable:true});};await ledger.alarm();let job=JSON.parse(ledger.rows('SELECT body FROM live_jobs')[0].body);assert.ok(job.payloadCiphertext);assert.ok(!JSON.stringify(job).includes(result.managementToken));await ledger.processJob(job);assert.deepEqual(payloads[0],payloads[1]);job=JSON.parse(ledger.rows('SELECT body FROM live_jobs')[0].body);job.firstAttemptAt=Date.now()-24*3600000;ledger.sql.exec('UPDATE live_jobs SET body=? WHERE id=?',JSON.stringify(job),job.id);await ledger.processJob(job);job=JSON.parse(ledger.rows('SELECT body FROM live_jobs')[0].body);assert.equal(job.requiresAttention,true);assert.equal(payloads.length,2);assert.equal(ledger.listBookings().notificationIssues.length,1);});
test('cancellation suppresses stale confirmed and reminder notification jobs',async()=>{const {ledger,ready}=setup();ledger.env.RESEND_API_KEY='test';ledger.env.MAIL_FROM='host@example.test';await ready();const result=await reserve(ledger,'intro',details());const sent=[];ledger.notify=async(_env,p)=>{sent.push(p);return {id:'sent'};};await ledger.cancel(result.booking.id,result.managementToken);await ledger.alarm();assert.equal(sent.length,1);assert.ok(sent[0].subject.endsWith('cancelled'));});
test('unpublished meetings are available only in explicit authenticated preview',async()=>{const {ledger,ready}=setup();await ready();ledger.saveSettings({meetingTypes:[{...config,id:'intro',slug:'intro',published:false,accountId:'a',calendarId:'primary'}]});assert.equal((await ledger.availability('intro')).status,404);assert.ok((await ledger.availability('intro',{preview:true})).slots.length);assert.equal((await reserve(ledger,'intro',details())).status,404);});
test('concurrent moves of one booking cannot create two successors',async()=>{const {ledger,ready,effects}=setup();await ready();const data=details(),first=await reserve(ledger,'intro',data);const [a,b]=await Promise.all([ledger.reschedule(first.booking.id,first.managementToken,data.start+3*3600000,'firstmove123456789'),ledger.reschedule(first.booking.id,first.managementToken,data.start+6*3600000,'othermove123456789')]);assert.equal([a,b].filter(r=>r.booking?.status==='confirmed').length,1);assert.equal([a,b].filter(r=>r.status===409).length,1);assert.equal(effects.created,2);});
test('cancelling the original during a move cancels its in-flight successor too',async()=>{const {ledger,ready,events}=setup();await ready();const data=details(),first=await reserve(ledger,'intro',data);let release,entered;const reached=new Promise(r=>entered=r),gate=new Promise(r=>release=r),create=ledger.google.createEvent;ledger.google.createEvent=async(...args)=>{entered();await gate;return create(...args);};const moving=ledger.reschedule(first.booking.id,first.managementToken,data.start+3*3600000,'moving12345678900');await reached;await ledger.cancel(first.booking.id,first.managementToken);release();const result=await moving;assert.equal(ledger.booking(result.booking.id).status,'cancelled');assert.equal(events.size,0);assert.equal(ledger.analytics().totals.rescheduled,0);assert.equal(ledger.analytics().totals.cancelled,2);});
test('shared primary calendar invitation omits management capability while private confirmation retains it',async()=>{const {ledger,ready,events}=setup();await ready();ledger.env.RESEND_API_KEY='test';ledger.env.MAIL_FROM='host@example.test';const result=await reserve(ledger,'intro',details()),event=[...events.values()][0];assert.ok(!JSON.stringify(event).includes(result.managementToken));assert.ok(!JSON.stringify(event).includes('/manage/'));assert.deepEqual(event.attendees,[{email:'guest@example.test',displayName:'Guest'}]);const sent=[];ledger.notify=async(_,payload)=>{sent.push(payload);return {id:'mail'};};await ledger.alarm();assert.equal(sent.length,1);assert.equal(sent[0].to,'guest@example.test');assert.ok(sent[0].text.includes(result.managementToken));assert.equal((await ledger.manage(result.booking.id,result.managementToken)).booking.status,'confirmed');});
test('publishing requires a configured destination and defaults use the real host',async()=>{const {ledger}=setup();assert.equal(ledger.settings().meetingTypes[0].host,'Host');assert.throws(()=>ledger.saveSettings({meetingTypes:[{...config,id:'x',slug:'x',published:true,accountId:'missing',calendarId:'primary'}]}));});
test('retention removes old terminal records but preserves pending outcomes and unresolved delivery jobs',async()=>{const {ledger,ready}=setup();await ready();const result=await reserve(ledger,'intro',details()),original=ledger.booking(result.booking.id);const old={...original,start:Date.now()-92*86400000,end:Date.now()-91*86400000};ledger.putBooking(old);ledger.putBooking({...old,id:'pending',requestKey:'pending',status:'pending'});ledger.putBooking({...old,id:'delivery',requestKey:'delivery',status:'cancelled'});ledger.sql.exec('INSERT INTO live_jobs VALUES (?,?,?)','attention',Date.now()+86400000,JSON.stringify({id:'attention',bookingId:'delivery',requiresAttention:true}));ledger.reconcile=async()=>{};await ledger.alarm();assert.equal(ledger.booking(old.id),null);assert.ok(ledger.booking('pending'));assert.ok(ledger.booking('delivery'));});
test('changing a destination migrates published types while existing bookings keep their calendar snapshots',async()=>{
 const {ledger,ready}=setup();await ready();const old=await reserve(ledger,'intro',details());
 ledger.google.listCalendars=async()=>[{id:'primary',accessRole:'owner'},{id:'team',accessRole:'writer'}];
 await ledger.configureCalendars({accounts:[{id:'a',destinationCalendarId:'team',conflictCalendarIds:['primary']}]});
 assert.equal(ledger.account('a').destinationCalendarId,'team');assert.ok(ledger.settings().meetingTypes.every(t=>t.calendarId==='team'&&t.published));
 assert.equal(ledger.booking(old.booking.id).calendarId,'primary');assert.equal(ledger.booking(old.booking.id).config.calendarId,'primary');
 assert.ok((await ledger.availability('intro')).slots.length);
 const result=await reserve(ledger,'intro',{...details('newdestination12345'),start:old.booking.start+3*3600000});
 assert.equal(result.booking.status,'confirmed');assert.equal(ledger.booking(result.booking.id).calendarId,'team');
 const calls=[],remove=ledger.google.deleteEvent;ledger.google.deleteEvent=async(access,input)=>{calls.push(input.calendarId);return remove(access,input);};
 await ledger.cancel(old.booking.id,old.managementToken);assert.deepEqual(calls,['primary']);
});
test('a later invalid account selection cannot partially change an earlier destination or type',async()=>{
 const {ledger,ready}=setup();await ready();await ledger.connect({accountId:'b',email:'second@example.test',tokens:{access_token:'access',refresh_token:'refresh',expires_at:Date.now()+3600000}});
 ledger.google.listCalendars=async()=>[{id:'primary',accessRole:'owner'},{id:'team',accessRole:'writer'},{id:'readonly',accessRole:'reader'}];const before=ledger.settings();
 await assert.rejects(()=>ledger.configureCalendars({accounts:[{id:'a',destinationCalendarId:'team',conflictCalendarIds:['primary']},{id:'b',destinationCalendarId:'readonly',conflictCalendarIds:[]}]}),/writable destination/);
 assert.deepEqual(ledger.settings(),before);
});
test('calendar configuration rolls back account writes if committing type migration fails',async()=>{
 const {ledger,ready}=setup();await ready();ledger.google.listCalendars=async()=>[{id:'team',accessRole:'writer'}];const before=ledger.settings(),put=ledger.putMeta;
 ledger.putMeta=function(key,value){if(key==='meetingTypes')throw Error('storage failure');return put.call(this,key,value);};
 await assert.rejects(()=>ledger.configureCalendars({accounts:[{id:'a',destinationCalendarId:'team',conflictCalendarIds:[]}]}),/storage failure/);assert.deepEqual(ledger.settings(),before);
});
test('invalid guest timezone is rejected before creating a durable booking or provider event',async()=>{
 const {ledger,ready,effects}=setup();await ready();assert.equal((await reserve(ledger,'intro',{...details(),timeZone:'Invalid/Zone'})).status,400);assert.equal(ledger.listBookings().bookings.length,0);assert.equal(effects.created,0);
 const result=await reserve(ledger,'intro',{...details(),timeZone:'America/New_York'});assert.equal(result.booking.status,'confirmed');assert.equal(result.booking.timeZone,'America/New_York');
});
test('disconnect allows historical confirmed bookings but blocks future and unresolved calendar effects',async()=>{
 const {ledger,ready}=setup();await ready();const result=await reserve(ledger,'intro',details());assert.equal((await ledger.disconnect('a')).status,409);
 const booking=ledger.booking(result.booking.id);booking.end=Date.now()-60000;ledger.putBooking(booking);
 for(const status of ['pending','cancelling']){booking.status=status;ledger.putBooking(booking);assert.equal((await ledger.disconnect('a')).status,409);}
 booking.status='confirmed';ledger.putBooking(booking);const settings=await ledger.disconnect('a');assert.equal(settings.accounts.length,0);assert.ok(settings.meetingTypes.every(t=>!t.published));assert.ok(ledger.booking(booking.id));
});
test('ended booking cancellation and rescheduling after disconnect leave no pending intent or provider calls',async()=>{
 const {ledger,ready,effects}=setup();await ready();const result=await reserve(ledger,'intro',details());
 const booking=ledger.booking(result.booking.id);booking.start=Date.now()-3600000;booking.end=Date.now()-60000;ledger.putBooking(booking);await ledger.disconnect('a');
 const before=ledger.booking(booking.id),effectsBefore={...effects};
 const cancelled=await ledger.cancel(booking.id,result.managementToken);assert.equal(cancelled.status,409);assert.match(cancelled.error,/ended.*cancelled/);
 const moved=await ledger.reschedule(booking.id,result.managementToken,details().start,'pastreschedule12345');assert.equal(moved.status,409);assert.match(moved.error,/ended.*rescheduled/);
 assert.deepEqual(ledger.booking(booking.id),before);assert.deepEqual(effects,effectsBefore);assert.equal(ledger.listBookings().bookings.length,1);
});
test('repeating cancellation of an already cancelled historical booking remains idempotent after disconnect',async()=>{
 const {ledger,ready,effects}=setup();await ready();const result=await reserve(ledger,'intro',details());await ledger.cancel(result.booking.id,result.managementToken);
 const booking=ledger.booking(result.booking.id);booking.end=Date.now()-60000;ledger.putBooking(booking);await ledger.disconnect('a');const before=ledger.booking(booking.id),deleted=effects.deleted;
 const repeated=await ledger.cancel(booking.id,result.managementToken);assert.equal(repeated.booking.status,'cancelled');assert.deepEqual(ledger.booking(booking.id),before);assert.equal(effects.deleted,deleted);
});
test('availability coalesces in-flight reads and reuses rounded ranges as the requested window advances',async()=>{
 let calls=0,release,entered;const gate=new Promise(r=>release=r),reached=new Promise(r=>entered=r);
 const {ledger,ready}=setup({freeBusy:async()=>{calls++;entered();await gate;return [];}});await ready();
 const one=ledger.availability('intro');await reached;const two=ledger.availability('other');release();const result=await Promise.all([one,two]);
 assert.ok(result.every(r=>r.slots.length));assert.equal(calls,1);
 const from=Date.now()+5000,to=Date.now()+config.horizon*86400000-5000;
 assert.ok((await ledger.availability('intro',{from,to})).slots.length);assert.equal(calls,1);
});
test('reservation bypasses cached availability and detects newly busy provider time',async()=>{
 let calls=0,busy=[];const {ledger,ready,effects}=setup({freeBusy:async()=>{calls++;return busy;}});await ready();const data=details();
 assert.ok((await ledger.availability('intro')).slots.some(s=>s.start===data.start));assert.equal(calls,1);
 busy=[{start:data.start,end:data.start+60000}];const result=await reserve(ledger,'intro',data);
 assert.equal(result.booking.status,'failed');assert.equal(calls,2);assert.equal(effects.created,0);
});
test('availability cache invalidates on calendar configuration, connection, settings, and booking effects',async()=>{
 let calls=0;const {ledger,ready}=setup({freeBusy:async()=>{calls++;return [];}});await ready();
 await ledger.availability('intro');await ledger.availability('intro');assert.equal(calls,1);
 await ledger.configureCalendars({accounts:[{id:'a',destinationCalendarId:'primary',conflictCalendarIds:[]}]});await ledger.availability('intro');assert.equal(calls,2);
 await ledger.connect({accountId:'a',email:'host@example.test',tokens:{access_token:'new',refresh_token:'refresh',expires_at:Date.now()+3600000}});await ledger.availability('intro');assert.equal(calls,3);
 ledger.saveSettings({meetingTypes:ledger.settings().meetingTypes});await ledger.availability('intro');assert.equal(calls,4);
 const result=await reserve(ledger,'intro',details());assert.equal(calls,5);await ledger.availability('intro');assert.equal(calls,6);
 await ledger.cancel(result.booking.id,result.managementToken);await ledger.availability('intro');assert.equal(calls,7);
});
test('failed availability promises are removed, cache entries expire, and coverage stays bounded',async()=>{
 let calls=0,reject=true;const {ledger,ready}=setup({freeBusy:async()=>{calls++;if(reject)throw Error('offline');return [];}});await ready();
 assert.equal((await ledger.availability('intro')).status,503);assert.equal(ledger.availabilityCache.size,0);reject=false;
 await ledger.availability('intro');assert.equal(calls,2);for(const entry of ledger.availabilityCache.values())entry.expiresAt=Date.now()-1;
 await ledger.availability('intro');assert.equal(calls,3);
 for(let n=0;n<8;n++)await ledger.availabilityBusy(Date.UTC(2026,0,1+n*10),Date.UTC(2026,0,2+n*10));
 assert.equal(ledger.availabilityCache.size,4);
});
test('reconciliation bypasses a warm availability cache for uncertain calendar effects',async()=>{
 let calls=0,busy=[];const {ledger,ready,effects}=setup({freeBusy:async()=>{calls++;return busy;},createEvent:async()=>{effects.created++;throw Error('unknown');}});await ready();
 const data=details(),result=await reserve(ledger,'intro',data);assert.equal(result.booking.status,'pending');assert.equal(calls,1);
 await ledger.availability('intro');assert.equal(calls,2);busy=[{start:data.start,end:data.start+60000}];
 await ledger.reconcile(result.booking.id);assert.equal(calls,3);assert.equal(ledger.booking(result.booking.id).status,'pending');assert.equal(effects.created,1);
});
test('authenticated host booking lookup recovers the management capability without leaking stored internals',async()=>{
 const {ledger,ready}=setup();await ready();const reservation=await reserve(ledger,'intro',details());
 const recovered=await ledger.hostBooking(reservation.booking.id);const {notifications,notificationHistory,...guestProjection}=recovered.booking;assert.deepEqual(guestProjection,reservation.booking);assert.deepEqual(notifications,[]);assert.equal(notificationHistory.complete,false);assert.equal(recovered.managementToken,reservation.managementToken);
 assert.equal((await ledger.manage(recovered.booking.id,recovered.managementToken)).booking.id,reservation.booking.id);
 assert.equal(recovered.booking.tokenRecovery,undefined);assert.equal(recovered.booking.tokenHash,undefined);assert.equal(recovered.booking.requestKey,undefined);
 assert.equal((await ledger.hostBooking('missing')).status,404);
});
test('malformed attendee addresses are rejected before storing a hold or calling Google',async()=>{
 const {ledger,ready,effects}=setup();await ready();
 for(const email of ['a@@b.c','a..b@example.test','a@-example.test','a@example..test','a\u0000@example.test']){
  assert.equal((await reserve(ledger,'intro',{...details(),email})).status,400,email);
 }
 assert.equal(ledger.listBookings().bookings.length,0);assert.equal(effects.created,0);
 assert.equal((await reserve(ledger,'intro',{...details(),email:'guest+tag@example.test'})).booking.status,'confirmed');
});
test('definitive initial create validation rejection releases the hold and stops calendar retries',async()=>{
 let attempts=0;const {ledger,ready}=setup({createEvent:async()=>{attempts++;throw Object.assign(Error('private provider body'),{status:400,retryable:false});}});await ready();
 const data=details(),result=await reserve(ledger,'intro',data);assert.equal(result.booking.status,'failed');
 assert.equal(ledger.localBusy().length,0);assert.equal(ledger.booking(result.booking.id).attempted,false);
 assert.ok(!JSON.stringify(ledger.booking(result.booking.id)).includes('private provider body'));
 await ledger.alarm();assert.equal(attempts,1);
 assert.equal((await reserve(ledger,'other',{...data,idempotencyKey:'replacement12345678'})).booking.status,'failed');assert.equal(attempts,2);
});
test('a later validation rejection never releases an earlier unknown create outcome',async()=>{
 let attempts=0;const {ledger,ready,events}=setup({createEvent:async()=>{attempts++;throw attempts===1?Object.assign(Error('timeout'),{retryable:true}):Object.assign(Error('rejected retry'),{status:400,retryable:false});}});await ready();
 const result=await reserve(ledger,'intro',details());await ledger.reconcile(result.booking.id);
 assert.equal(ledger.booking(result.booking.id).status,'pending');assert.equal(ledger.localBusy().length,1);
 const b=ledger.booking(result.booking.id);events.set(b.eventId,{id:b.eventId,etag:'etag',extendedProperties:{private:{emailBooking:b.id}}});
 await ledger.reconcile(b.id);assert.equal(ledger.booking(b.id).status,'confirmed');assert.equal(attempts,2);
});
test('definitive delete rejection retains cancellation intent and the real event',async()=>{
 const {ledger,ready,events}=setup();await ready();const result=await reserve(ledger,'intro',details());
 ledger.google.deleteEvent=async()=>{throw Object.assign(Error('rejected delete'),{status:400,retryable:false});};
 assert.equal((await ledger.cancel(result.booking.id,result.managementToken)).booking.status,'cancelling');
 await ledger.reconcile(result.booking.id);assert.equal(ledger.booking(result.booking.id).status,'cancelling');assert.equal(events.size,1);assert.equal(ledger.localBusy().length,1);
});
test('initial authorization rejection preserves a retryable hold without introducing an unknown insert',async()=>{
 let attempts=0;const {ledger,ready}=setup({createEvent:async()=>{attempts++;throw Object.assign(Error('rejected'),{status:attempts===1?401:400,retryable:false});}});await ready();
 const result=await reserve(ledger,'intro',details());assert.equal(result.booking.status,'pending');assert.equal(ledger.booking(result.booking.id).attempted,false);
 await ledger.reconcile(result.booking.id);assert.equal(ledger.booking(result.booking.id).status,'failed');
});
test('rejected replacement leaves the original confirmed and permits a fresh move',async()=>{
 const {ledger,ready}=setup();await ready();const data=details(),first=await reserve(ledger,'intro',data),create=ledger.google.createEvent;
 ledger.google.createEvent=async()=>{throw Object.assign(Error('rejected replacement'),{status:400,retryable:false});};
 const rejected=await ledger.reschedule(first.booking.id,first.managementToken,data.start+3*3600000,'rejectmove123456789');
 assert.equal(rejected.booking.status,'failed');assert.equal(ledger.booking(first.booking.id).status,'confirmed');assert.equal(ledger.booking(first.booking.id).replacementKey,undefined);
 ledger.google.createEvent=create;const next=await ledger.reschedule(first.booking.id,first.managementToken,data.start+6*3600000,'retrymove1234567890');assert.equal(next.booking.status,'confirmed');
});
test('cancel recovery completes from a minimal deleted-event tombstone without a second delete',async()=>{
 const {ledger,ready,events,effects}=setup();await ready();const result=await reserve(ledger,'intro',details());
 ledger.google.deleteEvent=async(_,{eventId})=>{effects.deleted++;events.set(eventId,{id:eventId,status:'cancelled'});throw Object.assign(Error('unknown delete outcome'),{retryable:true});};
 assert.equal((await ledger.cancel(result.booking.id,result.managementToken)).booking.status,'cancelling');
 await ledger.reconcile(result.booking.id);assert.equal(ledger.booking(result.booking.id).status,'cancelled');assert.equal(effects.deleted,1);assert.equal(ledger.localBusy().length,0);
});
test('deleted deterministic ID fails pending creation and releases its hold without reinsertion',async()=>{
 const {ledger,ready,events,effects}=setup();await ready();ledger.google.createEvent=async(_,{eventId})=>{effects.created++;events.set(eventId,{id:eventId,status:'cancelled'});throw Object.assign(Error('unknown create outcome'),{retryable:true});};
 const result=await reserve(ledger,'intro',details());assert.equal(result.booking.status,'pending');
 await ledger.reconcile(result.booking.id);assert.equal(ledger.booking(result.booking.id).status,'failed');assert.equal(ledger.localBusy().length,0);assert.equal(effects.created,1);assert.equal(effects.deleted,0);
 await ledger.alarm();assert.equal(effects.created,1);
});
test('deleted replacement releases the original move lock and keeps its event confirmed',async()=>{
 const {ledger,ready,events}=setup();await ready();const data=details(),first=await reserve(ledger,'intro',data);
 ledger.google.createEvent=async(_,{eventId})=>{events.set(eventId,{id:eventId,status:'cancelled'});throw Object.assign(Error('unknown'),{retryable:true});};
 const next=await ledger.reschedule(first.booking.id,first.managementToken,data.start+3*3600000,'deletedmove1234567');assert.equal(next.booking.status,'pending');
 await ledger.reconcile(next.booking.id);assert.equal(ledger.booking(next.booking.id).status,'failed');assert.equal(ledger.booking(first.booking.id).status,'confirmed');assert.equal(ledger.booking(first.booking.id).replacementKey,undefined);
});
test('host-only reconciliation issues and logs use allowlisted actions without provider or capability data',async()=>{
 const logs=[],original=console.error;console.error=value=>logs.push(JSON.parse(value));
 try{
  const {ledger,ready}=setup();await ready();
  ledger.google.getEvent=async()=>{throw Object.assign(Error('guest@example.test PRIVATE provider body'),{status:400,code:'invalid_grant',retryable:false});};
  const result=await reserve(ledger,'intro',details()),issues=ledger.listBookings().reconciliationIssues;
  assert.deepEqual(issues,[{bookingId:result.booking.id,kind:'authorization',message:'Reconnect the Google calendar to resume booking synchronization.'}]);
  assert.equal(result.booking.lastError,undefined);assert.equal((await ledger.manage(result.booking.id,result.managementToken)).booking.lastError,undefined);
  assert.equal((await ledger.hostBooking(result.booking.id)).booking.lastError,undefined);
  assert.deepEqual(logs,[{event:'booking_reconciliation_failed',code:'calendar_authorization_required',status:400}]);
  assert.ok(!JSON.stringify({issues,logs}).includes(result.managementToken));assert.ok(!JSON.stringify({issues,logs}).includes('PRIVATE'));assert.ok(!JSON.stringify({issues,logs}).includes('guest@example.test'));
  const b=ledger.booking(result.booking.id);b.lastError='untrusted SECRET';ledger.putBooking(b);assert.deepEqual(ledger.listBookings().reconciliationIssues,[]);
 }finally{console.error=original;}
});
test('transient provider errors surface sync issues and successful confirmation clears them',async()=>{
 const logs=[],original=console.error;console.error=value=>logs.push(JSON.parse(value));
 try{
  const {ledger,ready}=setup();await ready();const get=ledger.google.getEvent;
  ledger.google.getEvent=async()=>{throw Object.assign(Error('secret'),{status:403,code:'secret guest@example.test',retryable:true});};
  const result=await reserve(ledger,'intro',details());assert.equal(ledger.listBookings().reconciliationIssues[0].kind,'sync');
  assert.deepEqual(logs,[{event:'booking_reconciliation_failed',code:'calendar_sync_failed',status:403}]);
  ledger.google.getEvent=get;await ledger.reconcile(result.booking.id);assert.equal(ledger.booking(result.booking.id).status,'confirmed');assert.equal(ledger.booking(result.booking.id).lastError,undefined);assert.deepEqual(ledger.listBookings().reconciliationIssues,[]);
 }finally{console.error=original;}
});
test('successful cancellation clears synchronization errors and unknown failure status is logged safely',async()=>{
 const logs=[],original=console.error;console.error=value=>logs.push(JSON.parse(value));
 try{
  const {ledger,ready}=setup();await ready();const result=await reserve(ledger,'intro',details()),remove=ledger.google.deleteEvent;
  ledger.google.deleteEvent=async()=>{throw Object.assign(Error('private'),{status:'secret',code:'private'});};
  await ledger.cancel(result.booking.id,result.managementToken);assert.equal(ledger.listBookings().reconciliationIssues[0].kind,'sync');
  assert.deepEqual(logs,[{event:'booking_reconciliation_failed',code:'calendar_sync_failed',status:0}]);
  ledger.google.deleteEvent=remove;await ledger.reconcile(result.booking.id);assert.equal(ledger.booking(result.booking.id).status,'cancelled');assert.equal(ledger.booking(result.booking.id).lastError,undefined);assert.deepEqual(ledger.listBookings().reconciliationIssues,[]);
 }finally{console.error=original;}
});
test('analytics counts explicit page loads separately from availability with allowlisted source tags only',async()=>{
 const {ledger,ready}=setup();await ready();await ledger.availability('intro');assert.equal(ledger.analytics().totals.pageViews,0);
 ledger.recordVisit('intro','email');ledger.recordVisit('intro','email');ledger.recordVisit('other','website');ledger.recordVisit('intro','https://private.example/?guest=guest@example.test');
 assert.equal(ledger.recordVisit('missing','email').status,404);const analytics=ledger.analytics();assert.equal(analytics.totals.pageViews,4);assert.deepEqual(analytics.sources,{direct:1,email:2,website:1});assert.equal(analytics.series.length,30);assert.equal(analytics.period.timeZone,'UTC');
 const rows=JSON.stringify(ledger.rows('SELECT * FROM live_metrics'));assert.ok(!rows.includes('private.example'));assert.ok(!rows.includes('guest@example.test'));assert.ok(!JSON.stringify(analytics).includes('guest@example.test'));
});
test('analytics records booking lifecycle events once across idempotent retries and rescheduling',async()=>{
 const {ledger,ready}=setup();await ready();const data=details(),first=await reserve(ledger,'intro',data);await reserve(ledger,'intro',data);
 const moved=await ledger.reschedule(first.booking.id,first.managementToken,data.start+3*3600000,'analytics-move12345');await ledger.cancel(moved.booking.id,moved.managementToken);await ledger.cancel(moved.booking.id,moved.managementToken);
 assert.deepEqual(ledger.analytics().totals,{pageViews:0,bookingRequests:2,confirmed:2,cancelled:1,rescheduled:1,failed:0});
});
test('analytics persist after ledger restart and retention keeps at most 90 UTC days',async()=>{
 const {ledger,ready,storage}=setup();await ready();ledger.recordVisit('intro','email');const now=Date.now(),day=offset=>new Date(now+offset*86400000).toISOString().slice(0,10);
 ledger.sql.exec('INSERT INTO live_metrics VALUES (?,?,?)',day(-90),'visit:direct',17);ledger.sql.exec('INSERT INTO live_metrics VALUES (?,?,?)',day(-89),'visit:direct',8);ledger.sql.exec('INSERT INTO live_metrics VALUES (?,?,?)',day(-29),'visit:direct',3);
 const restarted=new BookingLedger({storage},ledger.env,{google:ledger.google});const analytics=restarted.analytics();assert.equal(analytics.totals.pageViews,4);assert.equal(restarted.rows('SELECT count FROM live_metrics WHERE day=?',day(-90)).length,0);assert.equal(restarted.rows('SELECT count FROM live_metrics WHERE day=?',day(-89))[0].count,8);
});
test('analytics and the booking transition roll back together on aggregate write failure',async()=>{
 const {ledger,ready}=setup();await ready();const first=await reserve(ledger,'intro',details()),before=ledger.analytics().totals,record=ledger.recordMetric;
 ledger.recordMetric=function(metric){record.call(this,metric);throw Error('metrics storage failure');};const b=ledger.booking(first.booking.id);b.status='cancelled';assert.throws(()=>ledger.putBooking(b),/metrics storage failure/);assert.equal(ledger.booking(b.id).status,'confirmed');assert.deepEqual(ledger.analytics().totals,before);
});
test('confirmed booking attribution persists only sanitized link tags and idempotent retries do not duplicate counts',async()=>{
 const {ledger,ready}=setup();await ready();const first=await reserve(ledger,'intro',{...details(),source:'email'});await reserve(ledger,'intro',{...details(),start:first.booking.start,source:'email'});
 assert.equal(ledger.booking(first.booking.id).source,'email');const second=await reserve(ledger,'intro',{...details('website-attribution1'),start:first.booking.start+3*3600000,source:'website'});assert.equal(second.booking.status,'confirmed');
 const third=await reserve(ledger,'intro',{...details('invalid-attribution1'),start:first.booking.start+6*3600000,source:'person@example.test'});assert.equal(ledger.booking(third.booking.id).source,'direct');
 assert.deepEqual(ledger.analytics().sourceBookings,{direct:1,email:1,website:1});assert.ok(!JSON.stringify(ledger.rows('SELECT * FROM live_metrics')).includes('person@example.test'));
});
const nextUtcDay=()=>Math.floor(Date.now()/86400000+1)*86400000;
function setIntroPolicy(ledger,patch){ledger.saveSettings({meetingTypes:ledger.settings().meetingTypes.map(type=>type.id==='intro'?{...type,...patch}:type)});}
test('live availability and admission both apply weekly minute ranges and closed date overrides',async()=>{
 const {ledger,ready}=setup();await ready();const day=nextUtcDay(),date=new Date(day).toISOString().slice(0,10),weekday=new Date(day).getUTCDay();
 setIntroPolicy(ledger,{weeklyHours:{[weekday]:[{start:550,end:650},{start:780,end:900}]}});
 const available=await ledger.availability('intro');assert.ok(available.slots.some(slot=>slot.start===day+550*60000));assert.ok(!available.slots.some(slot=>slot.start===day+600*60000));
 assert.equal((await reserve(ledger,'intro',{...details(),start:day+600*60000})).status,409);
 setIntroPolicy(ledger,{dateOverrides:{[date]:[]}});
 assert.ok(!(await ledger.availability('intro')).slots.some(slot=>slot.start>=day&&slot.start<day+86400000));
 assert.equal((await reserve(ledger,'intro',{...details(),start:day+550*60000})).status,409);
 setIntroPolicy(ledger,{dateOverrides:{[date]:[{start:605,end:665}]}});
 assert.equal((await reserve(ledger,'intro',{...details(),start:day+605*60000})).booking.status,'confirmed');
});
test('daily caps count pending holds, remain idempotent and stop concurrent different-time admissions',async()=>{
 let entered,release;const reached=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>release=resolve);
 const {ledger,ready}=setup();await ready();setIntroPolicy(ledger,{dailyBookingLimit:1});
 const create=ledger.google.createEvent;ledger.google.createEvent=async(...args)=>{entered();await gate;return create(...args);};
 const start=nextUtcDay()+9*3600000,data={...details(),start};const first=reserve(ledger,'intro',data);await reached;
 assert.equal((await reserve(ledger,'intro',{...details('second-cap-123456789'),start:start+2*3600000})).status,409);
 assert.ok(!(await ledger.availability('intro')).slots.some(slot=>slot.start>=nextUtcDay()&&slot.start<nextUtcDay()+86400000));
 release();const result=await first;assert.equal(result.booking.status,'confirmed');assert.equal((await reserve(ledger,'intro',data)).booking.id,result.booking.id);
 const second=setup();await second.ready();setIntroPolicy(second.ledger,{dailyBookingLimit:1});
 const pair=await Promise.all([reserve(second.ledger,'intro',{...data,idempotencyKey:'cap-concurrent-a-123'}),reserve(second.ledger,'intro',{...data,start:start+3*3600000,idempotencyKey:'cap-concurrent-b-123'})]);
 assert.equal(pair.filter(result=>result.booking?.status==='confirmed').length,1);assert.equal(pair.filter(result=>result.status===409).length,1);assert.equal(second.effects.created,1);
});
test('daily caps use the meeting timezone and remain scoped to the meeting type',async()=>{
 const {ledger,ready}=setup();await ready();setIntroPolicy(ledger,{zone:'America/Los_Angeles',dailyBookingLimit:1});const day=nextUtcDay();
 assert.equal((await reserve(ledger,'intro',{...details(),start:day+30*60000})).booking.status,'confirmed');
 assert.equal((await reserve(ledger,'intro',{...details('same-local-day-1234'),start:day+6*3600000+30*60000})).status,409);
 assert.equal((await reserve(ledger,'intro',{...details('next-local-day-1234'),start:day+8*3600000+30*60000})).booking.status,'confirmed');
 assert.equal((await reserve(ledger,'other',{...details('other-type-cap-1234'),start:day+5*3600000})).booking.status,'confirmed');
});
test('rescheduling at the daily cap replaces its original while cancelling holds retain capacity',async()=>{
 const {ledger,ready}=setup();await ready();setIntroPolicy(ledger,{dailyBookingLimit:1});const start=nextUtcDay()+9*3600000;
 const original=await reserve(ledger,'intro',{...details(),start});const moved=await ledger.reschedule(original.booking.id,original.managementToken,start+3*3600000,'capped-move-1234567');assert.equal(moved.booking.status,'confirmed');assert.equal(moved.previousBooking.status,'cancelled');
 const remove=ledger.google.deleteEvent;ledger.google.deleteEvent=async()=>{throw Object.assign(Error('provider rejection'),{status:400,retryable:false});};
 assert.equal((await ledger.cancel(moved.booking.id,moved.managementToken)).booking.status,'cancelling');
 assert.equal((await reserve(ledger,'intro',{...details('cancel-cap-123456789'),start:start+6*3600000})).status,409);
 ledger.google.deleteEvent=remove;await ledger.reconcile(moved.booking.id);
 assert.equal((await reserve(ledger,'intro',{...details('freed-cap-1234567890'),start:start+6*3600000})).booking.status,'confirmed');
});
test('host policy changes during asynchronous admission do not commit an outdated hold',async()=>{
 const {ledger,ready,effects}=setup();await ready();const start=nextUtcDay()+9*3600000;
 const data={...details(),start,intakeRevision:await intakeRevision(ledger.type('intro'))};
 const reservation=ledger.reserve('intro',data);
 setIntroPolicy(ledger,{weeklyHours:{}});
 const result=await reservation;assert.equal(result.status,409);assert.match(result.error,/settings changed/);assert.equal(ledger.listBookings().bookings.length,0);assert.equal(effects.created,0);
});

test('returning OAuth login preserves edited host identity and refreshes verified email',()=>{const {ledger}=setup();ledger.saveSettings({profile:{name:'Custom host',company:'Independent studio'}});ledger.init({id:'host',name:'Google display name',company:'Provider company',email:'verified@example.test'});assert.deepEqual(ledger.settings().profile,{id:'host',name:'Custom host',company:'Independent studio',email:'verified@example.test'});assert.equal(ledger.settings().meetingTypes[0].host,'Host');assert.throws(()=>ledger.init({id:'different',email:'other@example.test'}),/Host mismatch/);assert.equal(ledger.settings().profile.email,'verified@example.test');});

async function dueBooking(ledger,id){const b=ledger.booking(id);b.syncAfter=0;ledger.putBooking(b);return b;}
test('confirmed calendar edits update held time and location without another insert or confirmation',async()=>{
 const {ledger,ready,events,effects}=setup();await ready();const result=await reserve(ledger,'intro',details()),b=await dueBooking(ledger,result.booking.id),event=events.get(b.eventId);
 events.set(b.eventId,{...event,start:{dateTime:new Date(b.start+2*3600000).toISOString(),timeZone:'Europe/Paris'},end:{dateTime:new Date(b.end+3*3600000).toISOString()},location:'New office',status:'tentative',etag:'edited'});
 let confirmations=0;ledger.queueNotification=async()=>{confirmations++;};await ledger.reconcileConfirmed(b.id);
 const latest=ledger.booking(b.id);assert.equal(latest.start,b.start+2*3600000);assert.equal(latest.end,b.end+3*3600000);assert.equal(latest.location,'New office');assert.equal(latest.timeZone,b.timeZone);assert.equal(latest.calendarTimeZone,'Europe/Paris');assert.equal(latest.calendarChange,'updated');assert.equal(ledger.listBookings().bookings[0].calendarEventStatus,'tentative');assert.equal(latest.version,b.version+1);assert.equal(latest.calendarSyncStatus,'current');assert.equal(effects.created,1);assert.equal(effects.deleted,0);assert.equal(confirmations,0);assert.ok(!ledger.localBusy().some(x=>x.start===b.start));assert.equal(ledger.listBookings().bookings[0].calendarChange,'updated');
});
test('confirmed deletion and exact tombstones cancel locally and never recreate calendar events',async()=>{
 for(const tombstone of [false,true]){const {ledger,ready,events,effects}=setup();await ready();const result=await reserve(ledger,'intro',details()),b=await dueBooking(ledger,result.booking.id);if(tombstone)events.set(b.eventId,{id:b.eventId,status:'cancelled'});else events.delete(b.eventId);await ledger.reconcileConfirmed(b.id);assert.equal(ledger.booking(b.id).status,'cancelled');assert.equal(ledger.booking(b.id).calendarChange,'cancelled');await ledger.alarm();assert.equal(effects.created,1);assert.equal(effects.deleted,0);assert.equal(ledger.localBusy().length,0);}
});
test('confirmed synchronization rejects unowned, mismatched and unsupported events without losing the hold',async()=>{
 for(const edit of [e=>({...e,id:'wrong'}),e=>({...e,extendedProperties:{private:{emailBooking:'other'}}}),e=>({...e,start:{date:'2026-11-20'},end:{date:'2026-11-21'}})]){const {ledger,ready,events,effects}=setup();await ready();const result=await reserve(ledger,'intro',details()),b=await dueBooking(ledger,result.booking.id);events.set(b.eventId,edit(events.get(b.eventId)));await ledger.reconcileConfirmed(b.id);const current=ledger.booking(b.id);assert.equal(current.status,'confirmed');assert.equal(current.start,b.start);assert.equal(current.calendarSyncStatus,'pending');assert.ok(current.syncAfter>Date.now()+59*60000);assert.equal(effects.created,1);assert.equal(effects.deleted,0);assert.equal(ledger.listBookings().reconciliationIssues[0].message,'The calendar event could not be safely synchronized. Review its calendar details.');}
});
test('confirmed watcher batches at most three due events and schedules persisted retries fairly',async()=>{
 const {ledger,ready,events,storage}=setup();await ready();const result=await reserve(ledger,'intro',details()),base=ledger.booking(result.booking.id);for(let i=0;i<7;i++){const b={...base,id:'watch'+i,eventId:'event'+i,requestKey:'watch-key'+i,syncAfter:0};ledger.putBooking(b);events.set(b.eventId,{...events.get(base.eventId),id:b.eventId,extendedProperties:{private:{emailBooking:b.id}}});}
 let calls=0,alarmAt;const get=ledger.google.getEvent;ledger.google.getEvent=async(...args)=>{calls++;return get(...args);};storage.setAlarm=async time=>{alarmAt=time;};await ledger.alarm();assert.equal(calls,3);assert.ok(alarmAt>=Date.now()+14000&&alarmAt<Date.now()+20000);await ledger.alarm();assert.equal(calls,6);
});
test('confirmed provider timeouts and authorization errors retain data, back off durably and recover',async()=>{
 const {ledger,ready,storage}=setup();await ready();const result=await reserve(ledger,'intro',details()),b=await dueBooking(ledger,result.booking.id),get=ledger.google.getEvent;
 let calls=0;ledger.google.getEvent=async()=>{calls++;throw Object.assign(Error('private provider body'),{status:503});};await ledger.reconcileConfirmed(b.id);assert.equal(ledger.booking(b.id).status,'confirmed');assert.equal(ledger.booking(b.id).start,b.start);assert.ok(ledger.booking(b.id).syncAfter>=Date.now()+4*60000);await ledger.alarm();assert.equal(calls,1);
 const restored=new BookingLedger({storage},ledger.env,{google:ledger.google});await restored.reconcileConfirmed(b.id);assert.equal(calls,1);await dueBooking(restored,b.id);await restored.reconcileConfirmed(b.id);assert.ok(restored.booking(b.id).syncAfter>=Date.now()+9*60000);
 restored.google.getEvent=async()=>{throw Object.assign(Error('private'),{status:401});};await dueBooking(restored,b.id);await restored.reconcileConfirmed(b.id);assert.equal(restored.listBookings().reconciliationIssues[0].kind,'authorization');assert.ok(restored.booking(b.id).syncAfter>=Date.now()+59*60000);
 restored.google.getEvent=get;await restored.connect({accountId:'a',email:'host@example.test',tokens:{access_token:'renewed',refresh_token:'renewed',expires_at:Date.now()+3600000}});await dueBooking(restored,b.id);await restored.reconcileConfirmed(b.id);assert.equal(restored.booking(b.id).lastError,undefined);assert.equal(restored.booking(b.id).syncAttempts,0);assert.equal(restored.listBookings().reconciliationIssues.length,0);assert.ok(!JSON.stringify(restored.listBookings()).includes('private provider body'));
});
test('calendar reads cannot overwrite cancellation, replacement locks, or a changed connection',async()=>{
 for(const action of ['cancel','move','disconnect','reconnect']){const {ledger,ready}=setup();await ready();const result=await reserve(ledger,'intro',details()),b=await dueBooking(ledger,result.booking.id),get=ledger.google.getEvent;let release,entered;const gate=new Promise(r=>release=r),reached=new Promise(r=>entered=r);let first=true;ledger.google.getEvent=async(...args)=>{const event=await get(...args);if(first){first=false;entered();await gate;return {...event,start:{dateTime:new Date(b.start+3600000).toISOString()},end:{dateTime:new Date(b.end+3600000).toISOString()},location:'obsolete'};}return event;};
 const watching=ledger.reconcileConfirmed(b.id);await reached;
 if(action==='cancel')await ledger.cancel(b.id,result.managementToken);
 if(action==='move'){const moved=await ledger.reschedule(b.id,result.managementToken,b.start+3*3600000,'watchmove123456789');assert.equal(moved.booking.status,'confirmed');}
 if(action==='disconnect')ledger.sql.exec('DELETE FROM live_accounts WHERE id=?','a');
 if(action==='reconnect')await ledger.connect({accountId:'a',email:'host@example.test',tokens:{access_token:'new',refresh_token:'new',expires_at:Date.now()+3600000}});
 release();await watching;const current=ledger.booking(b.id);assert.equal(current.start,b.start);assert.notEqual(current.location,'obsolete');assert.equal(current.syncLeaseUntil,0);if(action==='cancel')assert.equal(current.status,'cancelled');if(action==='move'){assert.equal(current.status,'cancelled');assert.equal(ledger.booking(current.successorId).status,'confirmed');}}
});
test('confirmed watcher leases and retry deadlines survive an interrupted instance; old records rearm safely',async()=>{
 const {ledger,ready,storage}=setup();await ready();const result=await reserve(ledger,'intro',details()),b=ledger.booking(result.booking.id);let alarmAt=Date.now()+90*86400000;storage.getAlarm=async()=>alarmAt;storage.setAlarm=async time=>{alarmAt=time;};delete b.syncAfter;ledger.putBooking(b);await ledger.resumeConfirmedSync();assert.ok(alarmAt<Date.now()+20000);
 b.syncLeaseUntil=Date.now()+120000;ledger.putBooking(b);let calls=0;ledger.google.getEvent=async()=>{calls++;return null;};const restored=new BookingLedger({storage},ledger.env,{google:ledger.google});await restored.alarm();assert.equal(calls,0);assert.ok(alarmAt>=b.syncLeaseUntil);b.syncLeaseUntil=0;b.end=Date.now()-25*3600000;ledger.putBooking(b);await restored.alarm();assert.equal(calls,0);
});
test('Meet creation requests conference once and later confirmed reads capture the room without invitations',async()=>{
 const {ledger,ready,effects,events}=setup();await ready();ledger.saveSettings({meetingTypes:[{...ledger.settings().meetingTypes[0],locationType:'google_meet'}]});const create=ledger.google.createEvent;let requested=false;ledger.google.createEvent=async(access,args)=>{requested=args.conference;return create(access,args);};ledger.google.conferenceDetails=event=>event.hangoutLink?{conferenceStatus:'ready',meetingUrl:event.hangoutLink}:{conferenceStatus:'pending'};
 const result=await reserve(ledger,'intro',details());assert.equal(requested,true);assert.equal(result.booking.conferenceStatus,'pending');const b=await dueBooking(ledger,result.booking.id);events.get(b.eventId).hangoutLink='https://meet.google.com/abc-defg-hij';await ledger.reconcileConfirmed(b.id);assert.equal(ledger.listBookings().bookings[0].meetingUrl,'https://meet.google.com/abc-defg-hij');assert.equal(effects.created,1);
 ledger.google.conferenceDetails=()=>({conferenceStatus:'failed'});await dueBooking(ledger,b.id);await ledger.reconcileConfirmed(b.id);assert.equal(ledger.booking(b.id).status,'confirmed');assert.equal(ledger.booking(b.id).conferenceStatus,'failed');assert.equal(ledger.booking(b.id).meetingUrl,undefined);assert.equal(effects.created,1);
});

test('asymmetric buffers apply the larger required side gap and preserve legacy maximum semantics',()=>{
 const now=Date.UTC(2026,10,10),start=now+10*3600000,end=start+30*60000,c={...config,horizon:1,buffer:0,bufferBefore:10,bufferAfter:20};
 const before=[{start:start-3600000,end:start-15*60000,before:0,after:0}];assert.ok(liveSlots(c,now,before,start,end).some(s=>s.start===start));before[0].after=20*60000;assert.ok(!liveSlots(c,now,before,start,end).some(s=>s.start===start));
 const after=[{start:end+15*60000,end:end+45*60000,before:0,after:0}];assert.ok(!liveSlots(c,now,after,start,end).some(s=>s.start===start));after[0].start=end+20*60000;assert.ok(liveSlots(c,now,after,start,end).some(s=>s.start===start));
 const legacy={...config,buffer:15};assert.ok(liveSlots(legacy,now,[{start:end+20*60000,end:end+50*60000,buffer:15*60000}],start,end).some(s=>s.start===start));
});
test('weekly caps use local Monday weeks, include durable holds, and allow a replacing booking',async()=>{
 const {ledger,ready}=setup();await ready();ledger.saveSettings({meetingTypes:ledger.settings().meetingTypes.map(t=>({...t,horizon:30,weeklyBookingLimit:1}))});const type=ledger.type('intro'),data=details(),start=data.start;
 const b={id:'weekly-hold',requestKey:'weekly-hold',start,end:start+30*60000,status:'pending',config:type,meetingTypeId:'intro'};ledger.putBooking(b);
 assert.equal(ledger.withinDailyLimit(type,start+3600000),false);assert.equal(ledger.withinDailyLimit(type,start+7*86400000),true);assert.equal(ledger.withinDailyLimit(type,start,b.id),true);assert.equal(ledger.withinDailyLimit(ledger.type('other'),start),true);assert.equal((await reserve(ledger,'intro',{...data,start:start+3600000})).status,409);assert.ok(!(await ledger.availability('intro')).slots.some(s=>s.start===start+3600000));
 const boundaryType={...type,zone:'America/New_York'},sunday=Date.UTC(2026,10,16,4,30),monday=Date.UTC(2026,10,16,5,30);b.start=sunday;b.end=sunday+30*60000;ledger.putBooking(b);assert.equal(ledger.withinDailyLimit(boundaryType,sunday+10*60000),false);assert.equal(ledger.withinDailyLimit(boundaryType,monday),true);
});
test('authorized pending Meet polling is due-limited and leased; missing capabilities never call Google',async()=>{
 const {ledger,ready,events}=setup();await ready();ledger.saveSettings({meetingTypes:[{...ledger.settings().meetingTypes[0],locationType:'google_meet'}]});ledger.google.conferenceDetails=()=>({conferenceStatus:'pending'});const result=await reserve(ledger,'intro',details()),id=result.booking.id;let calls=0,release,entered;const get=ledger.google.getEvent,gate=new Promise(r=>release=r),reached=new Promise(r=>entered=r);ledger.google.getEvent=async(...args)=>{calls++;entered();await gate;return get(...args);};
 assert.equal((await ledger.manage(id,'wrong')).status,404);await ledger.manage(id,result.managementToken);assert.equal(calls,0);await dueBooking(ledger,id);const one=ledger.manage(id,result.managementToken);await reached;const two=await ledger.manage(id,result.managementToken);assert.equal(two.booking.conferenceStatus,'pending');assert.equal(calls,1);release();await one;
 assert.ok(ledger.booking(id).syncAfter>=Date.now()+9000);for(let i=0;i<5;i++){await dueBooking(ledger,id);await ledger.manage(id,result.managementToken);}assert.equal(calls,6);assert.ok(ledger.booking(id).syncAfter>=Date.now()+59000);assert.equal(events.size,1);
});
test('external calendar moves suppress stale reminders and queue only the new-version reminder',async()=>{
 const {ledger,ready,events}=setup();await ready();ledger.env.RESEND_API_KEY='test';ledger.env.MAIL_FROM='host@example.test';ledger.saveSettings({meetingTypes:[{...ledger.settings().meetingTypes[0],reminder:true}]});const data={...details(),start:nextUtcDay()+2*86400000+2*3600000},result=await reserve(ledger,'intro',data),b=await dueBooking(ledger,result.booking.id);let sent=0;ledger.notify=async()=>{sent++;return{id:'sent'};};const event=events.get(b.eventId);event.start.dateTime=new Date(b.start+3600000).toISOString();event.end.dateTime=new Date(b.end+3600000).toISOString();await ledger.reconcileConfirmed(b.id);const current=ledger.booking(b.id),jobs=ledger.rows('SELECT body FROM live_jobs').map(r=>JSON.parse(r.body));assert.ok(jobs.some(j=>j.kind==='reminder'&&j.version===current.version));assert.ok(!jobs.some(j=>j.kind==='confirmed'&&j.version===current.version));for(const job of jobs)if(job.version===b.version)await ledger.processJob(job);assert.equal(sent,0);assert.equal(ledger.rows('SELECT body FROM live_jobs').length,1);
});
test('rearming legacy confirmed watches cannot postpone work queued while reading the current alarm',async()=>{
 const {ledger,ready,storage}=setup();await ready();const result=await reserve(ledger,'intro',details()),b=ledger.booking(result.booking.id);let alarmAt;storage.setAlarm=async time=>{alarmAt=time;};storage.getAlarm=async()=>{ledger.putBooking({...b,id:'concurrent-pending',requestKey:'concurrent-pending',status:'pending'});return Date.now()+90*86400000;};await ledger.resumeConfirmedSync();assert.ok(alarmAt>=Date.now()+14000&&alarmAt<Date.now()+20000);
});
test('untrusted calendar state pauses reminders without deleting their job and resumes unchanged details safely',async()=>{
 const {ledger,ready,events}=setup();await ready();ledger.env.RESEND_API_KEY='test';ledger.env.MAIL_FROM='host@example.test';ledger.saveSettings({meetingTypes:[{...ledger.settings().meetingTypes[0],reminder:true}]});const result=await reserve(ledger,'intro',{...details(),start:nextUtcDay()+2*86400000+2*3600000}),b=await dueBooking(ledger,result.booking.id),event=events.get(b.eventId),original=structuredClone(event);event.start={date:'2026-11-20'};event.end={date:'2026-11-21'};await ledger.reconcileConfirmed(b.id);const job=JSON.parse(ledger.rows("SELECT body FROM live_jobs WHERE id=?",`${b.id}:${b.version}:reminder`)[0].body);let sent=0;ledger.notify=async()=>{sent++;return{id:'sent'};};const now=Date.now;try{Date.now=()=>b.start-1440*60000;await ledger.processJob(job);const paused=ledger.rows('SELECT due,body FROM live_jobs WHERE id=?',job.id)[0];assert.ok(paused);assert.equal(JSON.parse(paused.body).pausedForCalendarSync,true);assert.equal(JSON.parse(paused.body).leaseUntil,0);assert.ok(paused.due>=Date.now()+59*60000);assert.equal(sent,0);events.set(b.eventId,original);await dueBooking(ledger,b.id);await ledger.reconcileConfirmed(b.id);await ledger.processJob(job);assert.equal(sent,1);assert.equal(ledger.rows('SELECT body FROM live_jobs WHERE id=?',job.id).length,0);}finally{Date.now=now;}
});
test('attempted old-version notification outcomes survive calendar changes for operator review without resending',async()=>{
 const {ledger,ready,events}=setup();await ready();ledger.env.RESEND_API_KEY='test';ledger.env.MAIL_FROM='host@example.test';const result=await reserve(ledger,'intro',details()),b=ledger.booking(result.booking.id),job=JSON.parse(ledger.rows('SELECT body FROM live_jobs')[0].body);let attempts=0;ledger.notify=async()=>{attempts++;throw Object.assign(Error('unknown delivery'),{retryable:true});};await ledger.processJob(job);const encrypted=JSON.parse(ledger.rows('SELECT body FROM live_jobs WHERE id=?',job.id)[0].body).payloadCiphertext;const event=events.get(b.eventId);event.location='Changed office';await dueBooking(ledger,b.id);await ledger.reconcileConfirmed(b.id);await ledger.processJob(job);const retained=JSON.parse(ledger.rows('SELECT body FROM live_jobs WHERE id=?',job.id)[0].body);assert.equal(retained.requiresAttention,true);assert.equal(retained.superseded,true);assert.equal(retained.payloadCiphertext,encrypted);assert.equal(retained.error,'Delivery requires review');assert.equal(attempts,1);
});
test('one authorization or retryable rate-limit failure cools down the shared account across 100 bookings only',async()=>{
 for(const error of [{status:401},{status:429,retryable:true},{status:403,retryable:true}]){const {ledger,ready,events}=setup();await ready();const result=await reserve(ledger,'intro',details()),base=ledger.booking(result.booking.id),event=events.get(base.eventId);ledger.sql.exec('DELETE FROM live_bookings');for(let i=0;i<100;i++){const b={...base,id:'a-'+i,eventId:'event-'+i,requestKey:'key-'+i,syncAfter:0};ledger.putBooking(b);events.set(b.eventId,{...event,id:b.eventId,extendedProperties:{private:{emailBooking:b.id}}});}await ledger.connect({accountId:'b',email:'other@example.test',tokens:{access_token:'other',refresh_token:'other',expires_at:Date.now()+3600000}});const other={...base,id:'b-only',eventId:'b-event',accountId:'b',calendarId:'other-calendar',requestKey:'b-key',syncAfter:0};ledger.putBooking(other);events.set(other.eventId,{...event,id:other.eventId,extendedProperties:{private:{emailBooking:other.id}}});let aCalls=0,bCalls=0;ledger.google.getEvent=async(_token,args)=>{if(args.calendarId==='other-calendar'){bCalls++;return events.get(args.eventId);}aCalls++;throw Object.assign(Error('private'),error);};await ledger.alarm();await ledger.alarm();assert.equal(aCalls,1);assert.equal(bCalls,1);const account=ledger.account('a');assert.ok(account.syncCooldownUntil>=Date.now()+(error.status===401?59:4)*60000);assert.equal(ledger.listBookings().reconciliationIssues.find(i=>i.bookingId==='a-0').kind,error.status===401?'authorization':'sync');assert.ok(ledger.rows("SELECT body FROM live_bookings WHERE json_extract(body,'$.accountId')='a'").every(row=>JSON.parse(row.body).calendarSyncStatus==='pending'));const safeGet=async(_token,args)=>events.get(args.eventId);ledger.google.getEvent=safeGet;await ledger.connect({accountId:'a',email:'host@example.test',tokens:{access_token:'renewed',refresh_token:'renewed',expires_at:Date.now()+3600000}});assert.equal(ledger.account('a').syncCooldownUntil,0);assert.equal(ledger.account('a').syncFailures,0);await ledger.reconcileConfirmed('a-0');assert.equal(ledger.booking('a-0').calendarSyncStatus,'current');}
});
test('generated Meet booking ignores retained custom location text',async()=>{const {ledger,ready,events}=setup();await ready();ledger.saveSettings({meetingTypes:[{...ledger.settings().meetingTypes[0],locationType:'google_meet',location:'Private custom room'}]});const result=await reserve(ledger,'intro',details());assert.equal(result.booking.location,'');assert.equal([...events.values()][0].location,'');assert.equal(ledger.settings().meetingTypes[0].location,'Private custom room');});
test('typed intake snapshots labels and answers, invites bounded guests and binds the idempotent payload',async()=>{
 const {ledger,ready,events,effects}=setup();await ready();
 const questions=[{id:'topic',type:'text',label:'Discussion topic',required:true},{id:'approved',type:'checkbox',label:'Approved participants',required:true}];
 ledger.saveSettings({meetingTypes:[{...ledger.settings().meetingTypes[0],questions,extraGuestsLimit:2}]});
 const data={...details(),answers:{topic:'Roadmap',approved:true},additionalGuests:['OTHER@example.test','guest@example.test','host@example.test']};
 const result=await reserve(ledger,'intro',data);assert.equal(result.booking.status,'confirmed');assert.equal(result.booking.intakeVersion,1);assert.deepEqual(result.booking.questionSnapshot,questions);assert.deepEqual(result.booking.answers,data.answers);assert.deepEqual(result.booking.additionalGuests,['other@example.test']);
 const event=[...events.values()][0];assert.deepEqual(event.attendees,[{email:'guest@example.test',displayName:'Guest'},{email:'other@example.test'}]);assert.match(event.description,/Discussion topic\nRoadmap/);assert.match(event.description,/Approved participants\nYes/);assert.ok(!event.description.includes(result.managementToken));assert.ok(!event.description.includes('Manage your booking:'));assert.ok(!event.description.includes('/manage/'));
 assert.equal((await reserve(ledger,'intro',data)).booking.id,result.booking.id);assert.equal(effects.created,1);
 assert.equal((await reserve(ledger,'intro',{...data,answers:{...data.answers,topic:'Different'}})).status,409);
 assert.equal((await reserve(ledger,'intro',{...data,additionalGuests:['different@example.test']})).status,409);
 assert.equal((await ledger.reserve('intro',{...data,intakeRevision:'wrong'})).status,409);assert.equal((await ledger.reserve('intro',{...data,answers:{topic:false,approved:true}})).status,409);
 const hosted=await ledger.hostBooking(result.booking.id);assert.deepEqual(hosted.booking.answers,data.answers);assert.equal((await ledger.manage(result.booking.id,'bad')).status,404);
});
test('invalid typed intake creates no durable hold, provider event or notification job',async()=>{
 const {ledger,ready,effects}=setup();await ready();ledger.saveSettings({meetingTypes:[{...ledger.settings().meetingTypes[0],questions:[{id:'kind',type:'select',label:'Meeting topic',required:true,options:['Product','Support']}],extraGuestsLimit:1}]});
 for(const extra of [{answers:{}},{answers:{kind:'Other'}},{answers:{kind:'Product',unknown:'injection'}},{answers:{kind:'Product'},additionalGuests:['bad@local']},{answers:{kind:'Product'},additionalGuests:['a@example.test','b@example.test']}])assert.equal((await reserve(ledger,'intro',{...details(),...extra})).status,400);
 assert.equal(ledger.rows('SELECT id FROM live_bookings').length,0);assert.equal(ledger.rows('SELECT id FROM live_jobs').length,0);assert.equal(effects.created,0);
});
test('pending typed request retries its accepted form after host changes questions and guest policy',async()=>{
 const {ledger,ready,effects}=setup();await ready();const questions=[{id:'old',type:'text',label:'Original label',required:true}];
 ledger.saveSettings({meetingTypes:[{...ledger.settings().meetingTypes[0],questions,extraGuestsLimit:1}]});const create=ledger.google.createEvent;ledger.google.createEvent=async(...args)=>{await create(...args);throw Error('unknown provider result');};
 const data={...details(),answers:{old:'Original answer'},additionalGuests:['other@example.test']},first=await reserve(ledger,'intro',data);assert.equal(first.booking.status,'pending');
 ledger.saveSettings({meetingTypes:[{...ledger.settings().meetingTypes[0],questions:[{id:'new',type:'checkbox',label:'New required consent',required:true}],extraGuestsLimit:0}]});
 const retry=await reserve(ledger,'intro',data);assert.equal(retry.booking.id,first.booking.id);assert.deepEqual(retry.booking.questionSnapshot,questions);assert.deepEqual(retry.booking.answers,data.answers);assert.deepEqual(retry.booking.additionalGuests,data.additionalGuests);assert.equal(effects.created,1);
});
test('repeated moves retain accepted intake definitions and guests after form edits',async()=>{
 const {ledger,ready,events}=setup();await ready();const original=[{id:'old',type:'select',label:'Original topic',required:true,options:['Product','Support']}];
 ledger.saveSettings({meetingTypes:[{...ledger.settings().meetingTypes[0],questions:original,extraGuestsLimit:1}]});
 const data={...details(),answers:{old:'Support'},additionalGuests:['other@example.test']},first=await reserve(ledger,'intro',data);
 ledger.saveSettings({meetingTypes:[{...ledger.settings().meetingTypes[0],questions:[{id:'new',type:'checkbox',label:'New consent',required:true}],extraGuestsLimit:0}]});
 const next=await ledger.reschedule(first.booking.id,first.managementToken,data.start+3*3600000,'typed-move-one-12345');assert.equal(next.booking.status,'confirmed');assert.equal(next.booking.intakeRevision,first.booking.intakeRevision);assert.deepEqual(next.booking.questionSnapshot,original);assert.deepEqual(next.booking.answers,data.answers);assert.deepEqual(next.booking.additionalGuests,data.additionalGuests);
 const last=await ledger.reschedule(next.booking.id,next.managementToken,data.start+6*3600000,'typed-move-two-12345');assert.equal(last.booking.status,'confirmed');assert.equal(last.booking.intakeRevision,first.booking.intakeRevision);assert.deepEqual(last.booking.questionSnapshot,original);assert.deepEqual(last.booking.answers,data.answers);assert.deepEqual(last.booking.additionalGuests,data.additionalGuests);assert.match([...events.values()][0].description,/Original topic\nSupport/);assert.equal(events.size,1);
});
test('pre-intake legacy records retain their old idempotency hash and notes when retried or moved',async()=>{
 const {ledger,ready}=setup();await ready();const data={...details(),answer:'Historic note'},first=await reserve(ledger,'intro',data),old=ledger.booking(first.booking.id);
 delete old.durationVersion;delete old.duration;delete old.intakeVersion;delete old.intakeRevision;delete old.questionSnapshot;delete old.answers;delete old.additionalGuests;delete old.config.questions;delete old.config.extraGuestsLimit;old.config.question='';
 data.intakeRevision=undefined;old.payloadHash=await sha256(JSON.stringify({slug:'intro',start:data.start,name:data.name,email:data.email,answer:data.answer,timeZone:'',replacesId:null}));ledger.putBooking(old);
 ledger.saveSettings({meetingTypes:[{...ledger.settings().meetingTypes[0],questions:[{id:'new',type:'text',label:'New question',required:true}]}]});
 assert.equal((await reserve(ledger,'intro',data)).booking.id,first.booking.id);
 const moved=await ledger.reschedule(first.booking.id,first.managementToken,data.start+3*3600000,'legacy-intake-move-123');assert.equal(moved.booking.status,'confirmed');assert.equal(moved.booking.answer,data.answer);assert.deepEqual(moved.booking.answers,{legacy:data.answer});assert.deepEqual(moved.booking.questionSnapshot,[{id:'legacy',type:'textarea',label:'Guest note',required:false}]);
});
test('new holds require the reviewed form revision, including unchanged IDs with changed meaning',async()=>{
 const {ledger,ready,effects}=setup();await ready();const original=[{id:'topic',type:'select',label:'Department',required:false,options:['Product','Support']}];
 setIntroPolicy(ledger,{questions:original,extraGuestsLimit:1});
 const data={...details(),answers:{topic:'Product'},intakeRevision:await intakeRevision(ledger.type('intro'))};
 for(const revision of [undefined,'invalid',17])assert.equal((await ledger.reserve('intro',{...data,intakeRevision:revision})).status,400);
 for(const patch of [{questions:[{...original[0],label:'Budget approval'}]},{questions:[{...original[0],required:true}]},{questions:[{...original[0],options:['Product','Support','Other']}]},{extraGuestsLimit:0}]){
  setIntroPolicy(ledger,{questions:original,extraGuestsLimit:1,...patch});const result=await ledger.reserve('intro',data);assert.equal(result.status,400);assert.match(result.error,/questions changed/);
 }
 assert.equal(effects.created,0);assert.equal(ledger.rows('SELECT id FROM live_bookings').length,0);assert.equal(ledger.rows('SELECT id FROM live_jobs').length,0);
 const accepted=await ledger.reserve('intro',{...data,intakeRevision:await intakeRevision(ledger.type('intro'))});assert.equal(accepted.booking.status,'confirmed');assert.equal(accepted.booking.intakeRevision,await intakeRevision(ledger.type('intro')));
});
test('accepted typed records from before revision enforcement retain replay compatibility',async()=>{
 const {ledger,ready}=setup();await ready();setIntroPolicy(ledger,{questions:[{id:'topic',type:'text',label:'Topic',required:true}]});
 const data={...details(),answers:{topic:'Original'}},first=await reserve(ledger,'intro',data),old=ledger.booking(first.booking.id);delete old.durationVersion;delete old.duration;delete old.intakeRevision;
 old.payloadHash=await sha256(JSON.stringify({slug:'intro',start:data.start,name:data.name,email:data.email,answer:'',timeZone:'',replacesId:null,answers:data.answers,additionalGuests:[]}));ledger.putBooking(old);
 setIntroPolicy(ledger,{questions:[{id:'new',type:'checkbox',label:'New question',required:true}]});delete data.intakeRevision;
 const retry=await ledger.reserve('intro',data);assert.equal(retry.booking.id,first.booking.id);assert.deepEqual(retry.booking.answers,data.answers);
});
test('new legacy single-question forms also require a reviewed revision',async()=>{
 const {ledger,ready,effects}=setup();await ready();const data={...details(),answer:'Legacy notes'};
 const rejected=await ledger.reserve('intro',data);assert.equal(rejected.status,400);assert.match(rejected.error,/Refresh this page/);assert.equal(effects.created,0);assert.equal(ledger.rows('SELECT id FROM live_bookings').length,0);
 const accepted=await reserve(ledger,'intro',data);assert.equal(accepted.booking.status,'confirmed');assert.equal(accepted.booking.intakeRevision,await intakeRevision(ledger.type('intro')));assert.deepEqual(accepted.booking.answers,{legacy:'Legacy notes'});
});
test('configured reminders schedule exact distinct offsets and retain the legacy 24-hour job identity',async()=>{
 const {ledger,ready}=setup();await ready();ledger.env.RESEND_API_KEY='test';ledger.env.MAIL_FROM='host@example.test';
 setIntroPolicy(ledger,{reminder:true,reminderMinutes:[5,1440,60]});const result=await reserve(ledger,'intro',{...details(),start:nextUtcDay()+2*86400000+2*3600000}),b=ledger.booking(result.booking.id);
 const reminders=()=>ledger.rows("SELECT id,due,body FROM live_jobs WHERE json_extract(body,'$.kind')='reminder'").sort((a,b)=>a.due-b.due);
 const jobs=reminders();assert.deepEqual(jobs.map(j=>j.due),[1440,60,5].map(minutes=>b.start-minutes*60000));assert.deepEqual(jobs.map(j=>j.id),[`${b.id}:1:reminder`,`${b.id}:1:reminder:60`,`${b.id}:1:reminder:5`]);assert.deepEqual(jobs.map(j=>JSON.parse(j.body).minutesBefore),[1440,60,5]);
 await ledger.queueReminder(b);assert.deepEqual(reminders(),jobs);
});
test('reminders require delivery configuration and skip offsets which have already elapsed',async()=>{
 const {ledger,ready}=setup();await ready();setIntroPolicy(ledger,{reminder:true,reminderMinutes:[1440,60,5]});
 const first=await reserve(ledger,'intro',details());assert.equal(first.booking.status,'confirmed');assert.equal(ledger.rows('SELECT id FROM live_jobs').length,0);
 ledger.env.RESEND_API_KEY='test';ledger.env.MAIL_FROM='host@example.test';const b=ledger.booking(first.booking.id);b.start=Date.now()+30*60000;b.end=b.start+30*60000;ledger.putBooking(b);await ledger.queueReminder(b);
 assert.deepEqual(ledger.rows('SELECT body FROM live_jobs').map(row=>JSON.parse(row.body).minutesBefore),[5]);
 for(const patch of [{reminder:false,reminderMinutes:[5]},{reminder:true,reminderMinutes:[]}]){ledger.sql.exec('DELETE FROM live_jobs');b.config={...b.config,...patch};await ledger.queueReminder(b);assert.equal(ledger.rows('SELECT id FROM live_jobs').length,0);}
});
test('upgrading legacy reminders preserves an attempted job ciphertext and provider identity',async()=>{
 const {ledger,ready}=setup();await ready();ledger.env.RESEND_API_KEY='test';ledger.env.MAIL_FROM='host@example.test';setIntroPolicy(ledger,{reminder:true,reminderMinutes:null});
 const result=await reserve(ledger,'intro',{...details(),start:nextUtcDay()+2*86400000+2*3600000}),b=ledger.booking(result.booking.id),id=`${b.id}:1:reminder`;
 let job=JSON.parse(ledger.rows('SELECT body FROM live_jobs WHERE id=?',id)[0].body);delete job.minutesBefore;ledger.sql.exec('UPDATE live_jobs SET body=? WHERE id=?',JSON.stringify(job),id);
 const deliveries=[];ledger.notify=async(_env,payload)=>{deliveries.push(payload);throw Object.assign(Error('unknown'),{retryable:true});};const now=Date.now;try{Date.now=()=>b.start-1440*60000;await ledger.processJob(job);
 const before=ledger.rows('SELECT due,body FROM live_jobs WHERE id=?',id)[0];assert.ok(JSON.parse(before.body).payloadCiphertext);delete b.config.reminderMinutes;ledger.putBooking(b);
 await ledger.queueReminder(b);assert.deepEqual(ledger.rows('SELECT due,body FROM live_jobs WHERE id=?',id)[0],before);
 await ledger.processJob(JSON.parse(before.body));assert.equal(deliveries.length,2);assert.deepEqual(deliveries[0],deliveries[1]);assert.equal(deliveries[1].idempotencyKey,id);}finally{Date.now=now;}
});
test('booking reminder choices survive meeting-type edits and repeated moves; stale jobs never send',async()=>{
 const {ledger,ready}=setup();await ready();ledger.env.RESEND_API_KEY='test';ledger.env.MAIL_FROM='host@example.test';setIntroPolicy(ledger,{reminder:true,reminderMinutes:[60,5]});
 const data={...details(),start:nextUtcDay()+2*86400000+2*3600000},first=await reserve(ledger,'intro',data),oldJobs=ledger.rows('SELECT body FROM live_jobs').map(row=>JSON.parse(row.body));
 setIntroPolicy(ledger,{reminder:false,reminderMinutes:[120]});const moved=await ledger.reschedule(first.booking.id,first.managementToken,data.start+3*3600000,'reminder-move-one-123');const next=ledger.booking(moved.booking.id);assert.deepEqual(next.config.reminderMinutes,[60,5]);assert.equal(next.config.reminder,true);
 const again=await ledger.reschedule(next.id,moved.managementToken,data.start+6*3600000,'reminder-move-two-123');assert.deepEqual(ledger.booking(again.booking.id).config.reminderMinutes,[60,5]);
 let sends=0;ledger.notify=async()=>{sends++;return{id:'sent'};};for(const job of oldJobs)await ledger.processJob(job);assert.equal(sends,0);
 const latestJobs=ledger.rows("SELECT body FROM live_jobs WHERE json_extract(body,'$.bookingId')=? AND json_extract(body,'$.kind')='reminder'",again.booking.id).map(row=>JSON.parse(row.body));assert.deepEqual(latestJobs.map(job=>job.minutesBefore),[60,5]);
 await ledger.cancel(again.booking.id,again.managementToken);for(const job of latestJobs)await ledger.processJob(job);assert.equal(sends,0);
});
test('external calendar moves requeue every accepted reminder against the new version and time',async()=>{
 const {ledger,ready,events}=setup();await ready();ledger.env.RESEND_API_KEY='test';ledger.env.MAIL_FROM='host@example.test';setIntroPolicy(ledger,{reminder:true,reminderMinutes:[1440,60,5]});
 const result=await reserve(ledger,'intro',{...details(),start:nextUtcDay()+2*86400000+2*3600000}),b=await dueBooking(ledger,result.booking.id),oldJobs=ledger.rows('SELECT body FROM live_jobs').map(row=>JSON.parse(row.body));const event=events.get(b.eventId);event.start.dateTime=new Date(b.start+3600000).toISOString();event.end.dateTime=new Date(b.end+3600000).toISOString();await ledger.reconcileConfirmed(b.id);
 const current=ledger.booking(b.id),jobs=ledger.rows("SELECT due,body FROM live_jobs WHERE json_extract(body,'$.version')=?",current.version);assert.equal(current.version,b.version+1);assert.deepEqual(jobs.map(row=>row.due).sort((a,b)=>a-b),[1440,60,5].map(minutes=>current.start-minutes*60000));assert.ok(jobs.every(row=>JSON.parse(row.body).kind==='reminder'));
 let sends=0;ledger.notify=async()=>{sends++;return{id:'sent'};};for(const job of oldJobs)await ledger.processJob(job);assert.equal(sends,0);
});
test('unattempted reminders delayed past start are discarded, including calendar-sync pauses',async()=>{
 const {ledger,ready}=setup();await ready();ledger.env.RESEND_API_KEY='test';ledger.env.MAIL_FROM='host@example.test';setIntroPolicy(ledger,{reminder:true,reminderMinutes:[5]});
 const result=await reserve(ledger,'intro',details()),b=ledger.booking(result.booking.id),job=JSON.parse(ledger.rows("SELECT body FROM live_jobs WHERE json_extract(body,'$.kind')='reminder'")[0].body);let sends=0;ledger.notify=async()=>{sends++;return{id:'sent'};};
 const now=Date.now,get=ledger.google.getEvent,due=b.start-5*60000;try{Date.now=()=>due;ledger.google.getEvent=async()=>{throw Error('offline');};await ledger.processJob(job);assert.equal(JSON.parse(ledger.rows('SELECT body FROM live_jobs WHERE id=?',job.id)[0].body).pausedForCalendarSync,true);
 b.start=Date.now()-1;b.end=Date.now()+1800000;ledger.putBooking(b);await ledger.processJob(job);assert.equal(ledger.rows('SELECT id FROM live_jobs WHERE id=?',job.id).length,0);assert.equal(sends,0);}finally{Date.now=now;ledger.google.getEvent=get;}
});
test('unknown reminder outcomes retry the exact encrypted payload, then pause after start without a resend',async()=>{
 const {ledger,ready}=setup();await ready();ledger.env.RESEND_API_KEY='test';ledger.env.MAIL_FROM='host@example.test';setIntroPolicy(ledger,{reminder:true,reminderMinutes:[5]});
 const result=await reserve(ledger,'intro',details()),b=ledger.booking(result.booking.id),job=JSON.parse(ledger.rows("SELECT body FROM live_jobs WHERE json_extract(body,'$.kind')='reminder'")[0].body),sent=[];ledger.notify=async(_env,payload)=>{sent.push(payload);throw Object.assign(Error('unknown'),{retryable:true});};
 const now=Date.now,due=b.start-5*60000;try{Date.now=()=>due;await ledger.processJob(job);let stored=JSON.parse(ledger.rows('SELECT body FROM live_jobs WHERE id=?',job.id)[0].body);const ciphertext=stored.payloadCiphertext;assert.ok(ciphertext);assert.ok(!JSON.stringify(stored).includes(result.managementToken));
 await ledger.processJob(stored);assert.deepEqual(sent[0],sent[1]);assert.equal(sent[0].to,'guest@example.test');assert.equal(sent[0].idempotencyKey,job.id);
 b.start=Date.now()-1;ledger.putBooking(b);await ledger.processJob(stored);stored=JSON.parse(ledger.rows('SELECT body FROM live_jobs WHERE id=?',job.id)[0].body);assert.equal(sent.length,2);assert.equal(stored.payloadCiphertext,ciphertext);assert.equal(stored.requiresAttention,true);assert.equal(stored.expired,true);assert.equal(stored.leaseUntil,0);assert.ok(stored.firstAttemptAt);assert.equal(ledger.listBookings().notificationIssues[0].error,'Delivery requires review');}finally{Date.now=now;}
});

test('linked schedules drive public slots and durable reservations; schedule-only edits apply to all types',async()=>{
 const {ledger,ready,effects}=setup();await ready();const data=details(),day=new Date(data.start).toISOString().slice(0,10),schedule={id:'shared',name:'Shared hours',zone:'UTC',weeklyHours:Object.fromEntries(Array.from({length:7},(_,day)=>[day,[{start:0,end:1440}]])),dateOverrides:{}};
 ledger.saveSettings({availabilitySchedules:[schedule],meetingTypes:ledger.settings().meetingTypes.map(type=>({...type,scheduleId:'shared',zone:'Pacific/Honolulu',weeklyHours:{},dateOverrides:{[day]:[]}}))});
 for(const slug of ['intro','other']){const availability=await ledger.availability(slug,{from:data.start,to:data.start+3600000});assert.equal(availability.config.zone,'UTC');assert.ok(availability.slots.some(slot=>slot.start===data.start));assert.equal(availability.config.availabilitySchedules,undefined);}
 const first=await reserve(ledger,'intro',data);assert.equal(first.booking.status,'confirmed');assert.equal(ledger.booking(first.booking.id).config.zone,'UTC');
 ledger.saveSettings({availabilitySchedules:[{...schedule,dateOverrides:{[day]:[]}}]});for(const slug of ['intro','other'])assert.deepEqual((await ledger.availability(slug,{from:data.start,to:data.start+3600000})).slots,[]);
 const rejected=await reserve(ledger,'other',{...details('closed-schedule-key-123'),start:data.start+3600000});assert.equal(rejected.status,409);assert.equal(effects.created,1);assert.deepEqual(ledger.booking(first.booking.id).config.dateOverrides,{});const retry=await reserve(ledger,'intro',data);assert.equal(retry.booking.id,first.booking.id);
 const moved=await ledger.reschedule(first.booking.id,first.managementToken,data.start+3600000,'closed-schedule-move-123');assert.equal(moved.status,409);assert.equal(ledger.booking(first.booking.id).status,'confirmed');assert.equal(effects.created,1);
});
test('new linked meeting resolves immediately and concurrent schedule edits cannot admit stale durable holds',async()=>{
 const {ledger,ready,effects}=setup();await ready();const data=details(),day=new Date(data.start).toISOString().slice(0,10),schedule={id:'work',name:'Work',zone:'UTC',weeklyHours:Object.fromEntries(Array.from({length:7},(_,day)=>[day,[{start:0,end:1440}]])),dateOverrides:{}};
 ledger.saveSettings({availabilitySchedules:[schedule],meetingTypes:[...ledger.settings().meetingTypes,{...config,id:'new',slug:'new',scheduleId:'work',published:true,accountId:'a',calendarId:'primary'}]});assert.ok((await ledger.availability('new',{from:data.start,to:data.start+3600000})).slots.some(slot=>slot.start===data.start));
 data.intakeRevision=await intakeRevision(ledger.type('new'));const pending=ledger.reserve('new',data);ledger.saveSettings({availabilitySchedules:[{...schedule,dateOverrides:{[day]:[]}}]});const result=await pending;assert.equal(result.status,409);assert.equal(effects.created,0);assert.equal(ledger.rows('SELECT id FROM live_bookings').length,0);
});

const approve=(ledger,b,key='approval-decision-key-123')=>ledger.decideBooking(b.id,{action:'approve',expectedVersion:b.version,key});
test('approval requests hold a slot without calendar effects or reminder jobs; owner approval confirms exactly once',async()=>{
 const {ledger,ready,effects,events}=setup();await ready();ledger.env.RESEND_API_KEY='test';ledger.env.MAIL_FROM='host@example.test';setIntroPolicy(ledger,{requiresApproval:true,reminder:true,reminderMinutes:[5]});const data=details(),first=await reserve(ledger,'intro',data);assert.equal(first.booking.status,'awaiting_approval');assert.equal(first.booking.version,1);assert.equal(first.booking.approvalExpiresAt,data.start);assert.equal(effects.created,0);assert.equal(events.size,0);assert.deepEqual(ledger.rows('SELECT body FROM live_jobs').map(r=>JSON.parse(r.body).kind),['approval_requested_guest']);
 assert.equal((await reserve(ledger,'other',{...data,intakeRevision:await intakeRevision(ledger.type('other')),idempotencyKey:'competing-request-key'})).status,409);assert.equal((await ledger.disconnect('a')).status,409);const accepted=await approve(ledger,first.booking);assert.equal(accepted.booking.status,'confirmed');assert.equal(accepted.booking.version,2);assert.equal(effects.created,1);assert.ok(ledger.rows('SELECT id FROM live_jobs').length);assert.equal((await approve(ledger,first.booking)).booking.id,first.booking.id);assert.equal(effects.created,1);assert.equal((await ledger.decideBooking(first.booking.id,{action:'reject',expectedVersion:1,key:'approval-decision-key-123'})).status,409);
});
test('approval rejection, cancellation and lazy expiry release holds without any provider event effects',async()=>{
 const {ledger,ready,effects}=setup();await ready();setIntroPolicy(ledger,{requiresApproval:true});const first=await reserve(ledger,'intro',details()),decision={action:'reject',expectedVersion:1,key:'reject-decision-12345',reason:'Not this week'};const rejected=await ledger.decideBooking(first.booking.id,decision);assert.equal(rejected.booking.status,'rejected');assert.equal(rejected.booking.rejectionReason,'Not this week');assert.equal((await ledger.decideBooking(first.booking.id,decision)).booking.status,'rejected');assert.equal((await reserve(ledger,'intro',details())).booking.status,'rejected');
 const second=await reserve(ledger,'intro',details('cancel-request-key-123'));assert.equal((await ledger.cancel(second.booking.id,second.managementToken)).booking.status,'cancelled');
 const third=await reserve(ledger,'intro',details('expire-request-key-123'));const b=ledger.booking(third.booking.id);b.approvalExpiresAt=Date.now()-1;ledger.putBooking(b);assert.equal((await ledger.manage(b.id,third.managementToken)).booking.status,'expired');assert.equal((await approve(ledger,third.booking)).status,409);assert.equal(ledger.localBusy().length,0);assert.equal(effects.created,0);assert.equal(effects.deleted,0);assert.equal(ledger.rows('SELECT id FROM live_jobs').length,0);
});
test('approval checks fresh conflicts and current schedule, and does not silently redirect a destination',async()=>{
 const {ledger,ready,effects}=setup();await ready();setIntroPolicy(ledger,{requiresApproval:true});const first=await reserve(ledger,'intro',details());ledger.google.freeBusy=async()=>[{start:first.booking.start,end:first.booking.end}];assert.equal((await approve(ledger,first.booking)).status,409);assert.equal(ledger.booking(first.booking.id).status,'awaiting_approval');ledger.google.freeBusy=async()=>[];
 setIntroPolicy(ledger,{weeklyHours:{}});assert.equal((await approve(ledger,first.booking)).status,409);setIntroPolicy(ledger,{weeklyHours:null});const a=ledger.account('a');a.destinationCalendarId='other-calendar';ledger.putAccount(a);assert.equal((await approve(ledger,first.booking)).status,409);assert.equal(effects.created,0);
});
test('concurrent owner approval and rejection or guest cancellation cannot create an unapproved event',async()=>{
 for(const action of ['reject','cancel','expire','edit']){const {ledger,ready,effects}=setup();await ready();setIntroPolicy(ledger,{requiresApproval:true});const first=await reserve(ledger,'intro',details());let release,entered;const gate=new Promise(r=>release=r),reached=new Promise(r=>entered=r);ledger.google.freeBusy=async()=>{entered();await gate;return [];};const accepting=approve(ledger,first.booking);await reached;
 if(action==='reject')await ledger.decideBooking(first.booking.id,{action:'reject',expectedVersion:1,key:'concurrent-reject-12345'});if(action==='cancel')await ledger.cancel(first.booking.id,first.managementToken);if(action==='expire'){const b=ledger.booking(first.booking.id);b.approvalExpiresAt=Date.now()-1;ledger.putBooking(b);ledger.expireApprovals();}if(action==='edit')setIntroPolicy(ledger,{weeklyHours:{}});release();assert.equal((await accepting).status,409,action);assert.equal(effects.created,0,action);assert.ok(!ledger.booking(first.booking.id).approvalCheck,action);}
});
test('duplicate concurrent approve starts only one creation and provider-unknown outcomes survive request expiry and eviction',async()=>{
 const {ledger,ready,effects}=setup();await ready();setIntroPolicy(ledger,{requiresApproval:true});const first=await reserve(ledger,'intro',details());let release,entered;const gate=new Promise(r=>release=r),reached=new Promise(r=>entered=r);ledger.google.freeBusy=async()=>{entered();await gate;return [];};const accepting=approve(ledger,first.booking);await reached;assert.equal((await approve(ledger,first.booking,'other-approval-key-123')).status,409);release();const create=ledger.google.createEvent;ledger.google.createEvent=async(...args)=>{await create(...args);throw Error('unknown');};assert.equal((await accepting).booking.status,'pending');const b=ledger.booking(first.booking.id);b.approvalExpiresAt=Date.now()-1;ledger.putBooking(b);ledger.expireApprovals();assert.equal(ledger.booking(b.id).status,'pending');const reloaded=new BookingLedger(ledger.ctx,ledger.env,{google:ledger.google});await reloaded.reconcile(b.id);assert.equal(reloaded.booking(b.id).status,'confirmed');assert.equal(effects.created,1);assert.equal((await approve(reloaded,first.booking)).booking.status,'confirmed');
});
test('moving an unapproved request preserves approval after settings disable and invalidates the original decision',async()=>{
 const {ledger,ready,effects}=setup();await ready();setIntroPolicy(ledger,{requiresApproval:true});const first=await reserve(ledger,'intro',details());setIntroPolicy(ledger,{requiresApproval:false});const moved=await ledger.reschedule(first.booking.id,first.managementToken,first.booking.start+3600000,'move-approval-request-key');assert.equal(moved.booking.status,'awaiting_approval');assert.equal(moved.previousBooking.status,'cancelled');assert.equal((await approve(ledger,first.booking)).status,409);assert.equal((await approve(ledger,moved.booking)).booking.status,'confirmed');assert.equal(effects.created,1);
});
test('confirmed booking remains until approval move succeeds; rejection or expiry leaves original intact',async()=>{
 const {ledger,ready,effects,events}=setup();await ready();const first=await reserve(ledger,'intro',details());setIntroPolicy(ledger,{requiresApproval:true});const candidate=await ledger.reschedule(first.booking.id,first.managementToken,first.booking.start+3600000,'approval-move-candidate-1');assert.equal(candidate.booking.status,'awaiting_approval');assert.equal(ledger.booking(first.booking.id).status,'confirmed');assert.equal(events.size,1);
 await ledger.decideBooking(candidate.booking.id,{action:'reject',expectedVersion:1,key:'reject-move-candidate-1'});assert.ok(!ledger.booking(first.booking.id).replacementKey);assert.equal(events.size,1);
 const next=await ledger.reschedule(first.booking.id,first.managementToken,first.booking.start+7200000,'approval-move-candidate-2');const accepted=await approve(ledger,next.booking);assert.equal(accepted.booking.status,'confirmed');assert.equal(ledger.booking(first.booking.id).status,'cancelled');assert.equal(effects.created,2);assert.equal(events.size,1);
});
test('approval request quotas enforce canonical guest bounds across concurrent distinct slots',async()=>{
 const {ledger,ready}=setup();await ready();setIntroPolicy(ledger,{requiresApproval:true});const start=details().start;const results=await Promise.all(Array.from({length:4},(_,i)=>reserve(ledger,'intro',{...details('approval-quota-key-'+i),start:start+i*3600000})));assert.equal(results.filter(r=>r.booking?.status==='awaiting_approval').length,3);assert.equal(ledger.rows("SELECT id FROM live_bookings WHERE status='awaiting_approval'").length,3);
});
test('approval revalidation covers increased current buffers beyond the accepted request window',async()=>{
 const {ledger,ready,effects}=setup();await ready();setIntroPolicy(ledger,{requiresApproval:true,bufferBefore:0,bufferAfter:0});const first=await reserve(ledger,'intro',details());setIntroPolicy(ledger,{bufferBefore:30});let from;ledger.google.freeBusy=async(_access,range)=>{from=Date.parse(range.timeMin);return [{start:first.booking.start-20*60000,end:first.booking.start-10*60000}];};assert.equal((await approve(ledger,first.booking)).status,409);assert.ok(from<=first.booking.start-30*60000);assert.equal(effects.created,0);
});
test('owner review queue remains visible beyond the regular booking history limit',async()=>{const {ledger,ready}=setup();await ready();const t=ledger.type('intro');ledger.saveSettings({meetingTypes:[{...t,requiresApproval:true}]});const result=await reserve(ledger,'intro',details()),pending=ledger.booking(result.booking.id);for(let i=0;i<501;i++)ledger.putBooking({...pending,id:'history-'+i,requestKey:'history-'+i,status:'cancelled',start:pending.start+(i+1)*3600000,end:pending.end+(i+1)*3600000});assert.ok(ledger.listBookings().bookings.some(b=>b.id===pending.id));});
test('cancelling while approved provider creation is in flight cleans up the deterministic event',async()=>{let entered,release;const began=new Promise(r=>entered=r),blocked=new Promise(r=>release=r);const {ledger,ready,events,effects}=setup({createEvent:async(_,{eventId,event})=>{entered();await blocked;const result={...event,id:eventId,etag:'e'};events.set(eventId,result);return result;}});await ready();ledger.saveSettings({meetingTypes:[{...ledger.type('intro'),requiresApproval:true}]});const request=await reserve(ledger,'intro',details()),id=request.booking.id;const deciding=ledger.decideBooking(id,{action:'approve',expectedVersion:1,key:'approve-cancel-race'});await began;const cancelling=await ledger.cancel(id,request.managementToken);assert.equal(cancelling.booking.status,'cancelling');release();await deciding;assert.equal(ledger.booking(id).status,'cancelled');assert.equal(events.size,0);assert.equal(effects.deleted,1);});
const jobs=ledger=>ledger.rows('SELECT body FROM live_jobs').map(r=>JSON.parse(r.body));
async function processJobs(ledger){for(const j of jobs(ledger))await ledger.processJob(j);}
function enableApprovalMail(ledger){ledger.env.RESEND_API_KEY='test';ledger.env.MAIL_FROM='host@example.test';ledger.init({id:'host',name:'Verified owner',email:'owner@example.test'});setIntroPolicy(ledger,{requiresApproval:true});}
test('approval request mail targets verified owner and primary guest with distinct capability boundaries',async()=>{
 const {ledger,ready,effects}=setup();await ready();enableApprovalMail(ledger);ledger.saveSettings({profile:{name:'Owner',email:'attacker@example.test'},meetingTypes:[{...ledger.type('intro'),host:'attacker@example.test',extraGuestsLimit:1}]});const result=await reserve(ledger,'intro',{...details(),additionalGuests:['extra@example.test']});const persisted=jobs(ledger);assert.deepEqual(persisted.map(j=>j.kind).sort(),['approval_requested_guest','approval_requested_host']);assert.ok(!JSON.stringify(persisted).includes(result.managementToken));const sent=[];ledger.notify=async(_,p)=>{sent.push(p);return {id:'mail'};};await processJobs(ledger);assert.equal(sent.length,2);const owner=sent.find(p=>p.to==='owner@example.test'),guest=sent.find(p=>p.to==='guest@example.test');assert.ok(owner.text.includes('/studio#booking='+result.booking.id));assert.ok(!JSON.stringify(owner).includes(result.managementToken));assert.ok(guest.text.includes(result.managementToken));assert.match(guest.text,/not confirmed/i);assert.equal(effects.created,0);assert.equal(jobs(ledger).length,0);await reserve(ledger,'intro',details());assert.equal(jobs(ledger).length,0);
});
test('request and decision jobs commit with state and suppress unsent obsolete acknowledgement after approval',async()=>{
 const {ledger,ready}=setup();await ready();enableApprovalMail(ledger);const result=await reserve(ledger,'intro',details());assert.equal(jobs(ledger).length,2);const approved=await approve(ledger,result.booking);assert.equal(approved.booking.status,'confirmed');const sent=[];ledger.notify=async(_,p)=>{sent.push(p);return {id:'mail'};};await processJobs(ledger);assert.equal(sent.length,1);assert.ok(sent[0].subject.endsWith('confirmed'));assert.equal(sent[0].to,'guest@example.test');assert.equal(jobs(ledger).length,0);
});
test('rejection expiry and request cancellation send honest primary guest outcomes without calendar effects',async()=>{
 for(const state of ['rejected','expired','cancelled']){const {ledger,ready,effects}=setup();await ready();enableApprovalMail(ledger);const result=await reserve(ledger,'intro',details());if(state==='rejected')await ledger.decideBooking(result.booking.id,{action:'reject',expectedVersion:1,key:'reject-email-test-key',reason:'Different day'});if(state==='cancelled')await ledger.cancel(result.booking.id,result.managementToken);if(state==='expired'){const b=ledger.booking(result.booking.id);b.approvalExpiresAt=Date.now()-1;ledger.putBooking(b);ledger.expireApprovals();}assert.ok(jobs(ledger).some(j=>j.kind===state));const sent=[];ledger.notify=async(_,p)=>{sent.push(p);return {id:'mail'};};await processJobs(ledger);assert.equal(sent.length,1,state);assert.equal(sent[0].to,'guest@example.test');assert.ok(sent[0].text.includes(result.managementToken));assert.equal(effects.created,0);assert.equal(jobs(ledger).length,0);}
});
test('unknown approval delivery retains exact encrypted retry and pauses when superseded or too late',async()=>{
 for(const change of ['reject','cancel','expire','late']){const {ledger,ready}=setup();await ready();enableApprovalMail(ledger);const result=await reserve(ledger,'intro',details()),j=jobs(ledger).find(j=>j.kind==='approval_requested_host'),sent=[];ledger.notify=async(_,p)=>{sent.push(p);throw Object.assign(Error('unknown'),{retryable:true});};await ledger.processJob(j);let stored=jobs(ledger).find(x=>x.id===j.id);const ciphertext=stored.payloadCiphertext;assert.ok(ciphertext);await ledger.processJob(stored);assert.deepEqual(sent[0],sent[1]);if(change==='reject')await ledger.decideBooking(result.booking.id,{action:'reject',expectedVersion:1,key:'unknown-reject-key-123'});if(change==='cancel')await ledger.cancel(result.booking.id,result.managementToken);if(change==='expire'){const b=ledger.booking(result.booking.id);b.approvalExpiresAt=Date.now()-1;ledger.putBooking(b);ledger.expireApprovals();}if(change==='late'){stored=jobs(ledger).find(x=>x.id===j.id);stored.firstAttemptAt=Date.now()-24*3600000;ledger.sql.exec('UPDATE live_jobs SET body=? WHERE id=?',JSON.stringify(stored),j.id);}await ledger.processJob(stored);stored=jobs(ledger).find(x=>x.id===j.id);assert.equal(stored.requiresAttention,true,change);assert.equal(stored.payloadCiphertext,ciphertext);assert.equal(sent.length,2,change);}
});
test('approval transitions do not create delivery jobs when sender is unavailable or owner is unverified',async()=>{
 const {ledger,ready}=setup();await ready();setIntroPolicy(ledger,{requiresApproval:true});const result=await reserve(ledger,'intro',details());assert.equal(jobs(ledger).length,0);await ledger.decideBooking(result.booking.id,{action:'reject',expectedVersion:1,key:'no-delivery-reject-123'});assert.equal(jobs(ledger).length,0);ledger.env.RESEND_API_KEY='test';ledger.env.MAIL_FROM='host@example.test';const next=await reserve(ledger,'intro',details('guest-only-no-owner-email'));assert.equal(next.booking.status,'awaiting_approval');assert.deepEqual(jobs(ledger).map(j=>j.kind),['approval_requested_guest']);
});
test('approval request and notification insertion roll back together on storage failure then retry once',async()=>{
 const {ledger,ready,storage,effects}=setup();await ready();enableApprovalMail(ledger);const exec=storage.sql.exec;let failing=true;storage.sql.exec=(query,...args)=>{if(failing&&query.startsWith('INSERT OR IGNORE INTO live_jobs')&&String(args[0]).endsWith(':approval_requested_host')){failing=false;throw Error('storage unavailable');}return exec(query,...args);};const data=details();await assert.rejects(()=>reserve(ledger,'intro',data),/storage unavailable/);assert.equal(ledger.rows('SELECT id FROM live_bookings').length,0);assert.equal(jobs(ledger).length,0);assert.equal(effects.created,0);const retried=await reserve(ledger,'intro',data);assert.equal(retried.booking.status,'awaiting_approval');assert.equal(jobs(ledger).length,2);await reserve(ledger,'intro',data);assert.equal(jobs(ledger).length,2);
});
test('moving an approval request suppresses old unsent mail and queues the new time once',async()=>{
 const {ledger,ready}=setup();await ready();enableApprovalMail(ledger);const first=await reserve(ledger,'intro',details()),moved=await ledger.reschedule(first.booking.id,first.managementToken,first.booking.start+3600000,'move-mail-request-key');assert.equal(moved.booking.status,'awaiting_approval');const sent=[];ledger.notify=async(_,p)=>{sent.push(p);return {id:'sent'};};await processJobs(ledger);assert.equal(sent.length,2);assert.equal(sent.filter(p=>p.subject.endsWith('cancelled')).length,0);const newRequests=sent.filter(p=>!p.subject.endsWith('cancelled'));assert.equal(newRequests.length,2);assert.ok(newRequests.every(p=>p.text.includes(new Intl.DateTimeFormat('en-GB',{timeZone:'UTC',weekday:'short',day:'numeric',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(moved.booking.start))));assert.ok(!newRequests.some(p=>JSON.stringify(p).includes(first.managementToken)));assert.equal(jobs(ledger).length,0);
});
function cloudflareMail(ledger){ledger.env.NOTIFICATION_PROVIDER='cloudflare';ledger.env.EMAIL={send:async()=>({messageId:'unused'})};}
test('Cloudflare uncertain delivery parks immediately while a known rejected attempt can safely retry unchanged',async()=>{
 for(const unknown of [true,false]){const {ledger,ready}=setup();await ready();enableApprovalMail(ledger);cloudflareMail(ledger);const result=await reserve(ledger,'intro',details()),j=jobs(ledger).find(j=>j.kind==='approval_requested_host'),sent=[];ledger.notify=async(_,p)=>{sent.push(p);throw Object.assign(Error('delivery error'),{retryable:!unknown,deliveryUnknown:unknown});};await ledger.processJob(j);let stored=jobs(ledger).find(x=>x.id===j.id);assert.equal(stored.provider,'cloudflare');assert.equal(!!stored.requiresAttention,unknown);assert.equal(!!stored.deliveryInFlight,unknown);const envelope=await decryptTokens(stored.payloadCiphertext,ledger.env.TOKEN_ENCRYPTION_KEY,'host');assert.equal(envelope.from,'host@example.test');assert.equal(envelope.provider,'cloudflare');assert.ok(!JSON.stringify(envelope).includes(result.managementToken));ledger.env.MAIL_FROM='Changed <changed@example.test>';ledger.env.NOTIFICATION_PROVIDER='resend';await ledger.processJob(stored);assert.equal(sent.length,unknown?1:2);if(!unknown)assert.deepEqual(sent[0],sent[1]);}
});
test('a restarted Cloudflare in-flight job is reviewed without resending even after its lease expires',async()=>{
 const {ledger,ready,storage}=setup();await ready();enableApprovalMail(ledger);cloudflareMail(ledger);await reserve(ledger,'intro',details());const j=jobs(ledger).find(j=>j.kind==='approval_requested_host');let attempts=0;ledger.notify=async()=>{attempts++;throw Object.assign(Error('quota'),{retryable:true,deliveryUnknown:false});};await ledger.processJob(j);const stored=jobs(ledger).find(x=>x.id===j.id);stored.deliveryInFlight=true;stored.leaseUntil=Date.now()-1;ledger.sql.exec('UPDATE live_jobs SET body=? WHERE id=?',JSON.stringify(stored),j.id);const restarted=new BookingLedger({storage},ledger.env,{sendNotification:async()=>{attempts++;}});await restarted.processJob(stored);const after=jobs(ledger).find(x=>x.id===j.id);assert.equal(after.requiresAttention,true);assert.equal(after.payloadCiphertext,stored.payloadCiphertext);assert.equal(attempts,1);
});
test('legacy unsent mail freezes Resend sender while attempted payload without sender is retained for review',async()=>{
 for(const attempted of [false,true]){const {ledger,ready}=setup();await ready();enableApprovalMail(ledger);const r=await reserve(ledger,'intro',details()),j=jobs(ledger).find(j=>j.kind==='approval_requested_guest'),legacy={idempotencyKey:j.id,to:'guest@example.test',subject:'Original subject',text:'Original content'},ciphertext=await encryptTokens(legacy,ledger.env.TOKEN_ENCRYPTION_KEY,'host');j.payloadCiphertext=ciphertext;if(attempted)j.firstAttemptAt=Date.now()-1;ledger.sql.exec('UPDATE live_jobs SET body=? WHERE id=?',JSON.stringify(j),j.id);cloudflareMail(ledger);const sent=[];ledger.notify=async(_,p)=>{sent.push(p);return {id:'sent'};};await ledger.processJob(j);if(attempted){const after=jobs(ledger).find(x=>x.id===j.id);assert.equal(sent.length,0);assert.equal(after.payloadCiphertext,ciphertext);assert.equal(after.requiresAttention,true);}else{assert.equal(sent.length,1);assert.equal(sent[0].provider,'resend');assert.equal(sent[0].from,'host@example.test');assert.equal(sent[0].text,legacy.text);}assert.equal(ledger.booking(r.booking.id).status,'awaiting_approval');}
});
test('approved and moved shared calendar payloads never contain guest capabilities with or without additional attendees',async()=>{
 for(const extra of [[],['colleague@example.test']]){const {ledger,ready,events}=setup();await ready();setIntroPolicy(ledger,{requiresApproval:true,extraGuestsLimit:1,questions:[{id:'topic',type:'text',label:'Discussion topic',required:true}]});const first=await reserve(ledger,'intro',{...details(),answers:{topic:'Roadmap'},additionalGuests:extra});await approve(ledger,first.booking);let event=[...events.values()][0];assert.match(event.description,/Discussion topic\s+Roadmap/);assert.ok(!JSON.stringify(event).includes(first.managementToken));assert.ok(!JSON.stringify(event).includes('/manage/'));assert.deepEqual(event.attendees.map(a=>a.email),['guest@example.test',...extra]);const move=await ledger.reschedule(first.booking.id,first.managementToken,first.booking.start+3600000,'private-token-move-key');await approve(ledger,move.booking,'approve-private-move-key');event=[...events.values()][0];assert.match(event.description,/Discussion topic\s+Roadmap/);const serialized=JSON.stringify(event);assert.ok(!serialized.includes(first.managementToken));assert.ok(!serialized.includes(move.managementToken));assert.ok(!serialized.includes('/manage/'));assert.deepEqual(event.attendees.map(a=>a.email),['guest@example.test',...extra]);assert.equal((await ledger.manage(move.booking.id,move.managementToken)).booking.status,'confirmed');}
});
test('authorized booking views retain original approval policy after current meeting becomes instant',async()=>{
 for(const confirmed of [false,true]){const {ledger,ready}=setup();await ready();setIntroPolicy(ledger,{requiresApproval:true,approvalExpiryMinutes:240});const result=await reserve(ledger,'intro',details());if(confirmed)await approve(ledger,result.booking);setIntroPolicy(ledger,{requiresApproval:false,approvalExpiryMinutes:60});for(const view of [await ledger.manage(result.booking.id,result.managementToken),await ledger.hostBooking(result.booking.id),{booking:ledger.listBookings().bookings.find(b=>b.id===result.booking.id)}]){assert.equal(view.booking.requiresApproval,true);assert.equal(view.booking.approvalExpiryMinutes,240);assert.equal(view.booking.config,undefined);assert.equal(view.booking.tokenRecovery,undefined);}assert.equal((await ledger.manage(result.booking.id,'incorrect')).status,404);const moved=await ledger.reschedule(result.booking.id,result.managementToken,result.booking.start+3600000,'projection-move-'+confirmed);assert.equal(moved.booking.status,'awaiting_approval');assert.equal(moved.booking.requiresApproval,true);assert.equal(moved.booking.approvalExpiryMinutes,240);}
});

test('default inheritance drives slots and holds while accepted snapshots and retries survive default switches',async()=>{
 const {ledger,ready,effects}=setup();await ready();const data=details(),day=new Date(data.start).toISOString().slice(0,10),open={id:'open',name:'Open',zone:'UTC',weeklyHours:Object.fromEntries(Array.from({length:7},(_,day)=>[day,[{start:0,end:1440}]])),dateOverrides:{}},closed={...open,id:'closed',name:'Closed',dateOverrides:{[day]:[]}};
 ledger.saveSettings({availabilitySchedules:[open,closed],defaultAvailabilityScheduleId:'open',meetingTypes:ledger.settings().meetingTypes.map(t=>({...t,useDefaultSchedule:true,zone:'Pacific/Honolulu',weeklyHours:{}}))});
 assert.ok((await ledger.availability('intro',{from:data.start,to:data.start+3600000})).slots.some(s=>s.start===data.start));const accepted=await reserve(ledger,'intro',data);assert.equal(accepted.booking.status,'confirmed');const snapshot=structuredClone(ledger.booking(accepted.booking.id).config);
 ledger.saveSettings({defaultAvailabilityScheduleId:'closed'});assert.deepEqual((await ledger.availability('other',{from:data.start,to:data.start+3600000})).slots,[]);assert.equal((await reserve(ledger,'other',{...details('default-closed-request'),start:data.start+3600000})).status,409);assert.equal((await reserve(ledger,'intro',data)).booking.id,accepted.booking.id);assert.deepEqual(ledger.booking(accepted.booking.id).config,snapshot);assert.equal((await ledger.reschedule(accepted.booking.id,accepted.managementToken,data.start+3600000,'default-closed-move-key')).status,409);assert.equal(effects.created,1);
});
test('default switch during reservation invalidates a stale hold before any provider mutation',async()=>{
 const {ledger,ready,effects}=setup();await ready();const data=details(),day=new Date(data.start).toISOString().slice(0,10),open={id:'open',name:'Open',zone:'UTC',weeklyHours:Object.fromEntries(Array.from({length:7},(_,day)=>[day,[{start:0,end:1440}]])),dateOverrides:{}},closed={...open,id:'closed',name:'Closed',dateOverrides:{[day]:[]}};
 ledger.saveSettings({availabilitySchedules:[open,closed],defaultAvailabilityScheduleId:'open',meetingTypes:[...ledger.settings().meetingTypes,{...config,id:'new-default',slug:'new-default',useDefaultSchedule:true,published:true,accountId:'a',calendarId:'primary'}]});data.intakeRevision=await intakeRevision(ledger.type('new-default'));const pending=ledger.reserve('new-default',data);ledger.saveSettings({defaultAvailabilityScheduleId:'closed'});assert.equal((await pending).status,409);assert.equal(effects.created,0);assert.equal(ledger.rows('SELECT id FROM live_bookings').length,0);
});

const followJobs=ledger=>ledger.rows("SELECT body FROM live_jobs WHERE json_extract(body,'$.kind')='follow_up'").map(r=>JSON.parse(r.body));
const reminderJobs=ledger=>ledger.rows("SELECT body FROM live_jobs WHERE json_extract(body,'$.kind')='reminder'").map(r=>JSON.parse(r.body));
const reminderReady=async()=>{const fixture=setup();await fixture.ready();await fixture.ledger.connect({accountId:'a',email:'host@example.test',tokens:{access_token:'access',refresh_token:'refresh',expires_at:Date.now()+7*86400000}});fixture.ledger.env.RESEND_API_KEY='test';fixture.ledger.env.MAIL_FROM='host@example.test';setIntroPolicy(fixture.ledger,{reminder:true,reminderMinutes:[5]});return fixture;};
test('reminders do not send early and require a fresh read even before the background sync deadline',async()=>{
 const {ledger}=await reminderReady(),result=await reserve(ledger,'intro',details()),job=reminderJobs(ledger)[0],now=Date.now,get=ledger.google.getEvent;let reads=0,sends=0;
 ledger.google.getEvent=async(...args)=>{reads++;return get(...args);};ledger.notify=async()=>{sends++;};
 try{await ledger.processJob(job);assert.equal(reads,0);assert.equal(sends,0);Date.now=()=>result.booking.start-5*60000;await ledger.processJob(job);assert.equal(reads,1);assert.equal(sends,1);await ledger.processJob(job);assert.equal(sends,1);}finally{Date.now=now;}
});
test('due reminders suppress external deletions and pause revoked, unowned or all-day event state',async()=>{
 for(const mode of ['deleted','revoked','unowned','all_day']){
  const {ledger,events}=await reminderReady(),result=await reserve(ledger,'intro',details()),b=ledger.booking(result.booking.id),job=reminderJobs(ledger)[0],now=Date.now;let sends=0;ledger.notify=async()=>{sends++;};
  if(mode==='deleted')events.set(b.eventId,{id:b.eventId,status:'cancelled'});
  if(mode==='revoked')ledger.google.getEvent=async()=>{throw Object.assign(Error('private grant failure'),{status:403,retryable:false});};
  if(mode==='unowned')events.get(b.eventId).extendedProperties.private.emailBooking='another-booking';
  if(mode==='all_day'){const event=events.get(b.eventId);event.start={date:'2026-11-01'};event.end={date:'2026-11-02'};}
  try{Date.now=()=>b.start-5*60000;await ledger.processJob(job);assert.equal(sends,0,mode);assert.equal(ledger.booking(b.id).status,mode==='deleted'?'cancelled':'confirmed',mode);
   const stored=reminderJobs(ledger)[0];if(mode==='deleted')assert.equal(stored,undefined);else{assert.equal(stored.pausedForCalendarSync,true,mode);assert.ok(!stored.firstAttemptAt,mode);assert.equal(ledger.booking(b.id).calendarSyncStatus,'pending');assert.ok(!JSON.stringify(ledger.listBookings()).includes('private grant failure'));}
  }finally{Date.now=now;}
 }
});
test('fresh reminder reconciliation rebases repeated DST wall time by the actual provider instant',async()=>{
 const now=Date.now;try{
  Date.now=()=>Date.UTC(2026,9,31,12);const {ledger,events}=await reminderReady(),start=Date.UTC(2026,10,1,5,30),result=await reserve(ledger,'intro',{...details(),start,timeZone:'America/New_York'}),b=ledger.booking(result.booking.id),job=reminderJobs(ledger)[0],event=events.get(b.eventId),sent=[];
  event.start={dateTime:'2026-11-01T01:30:00-05:00',timeZone:'America/New_York'};event.end={dateTime:'2026-11-01T02:00:00-05:00',timeZone:'America/New_York'};
  ledger.notify=async(_,p)=>{sent.push(p);};Date.now=()=>start-5*60000;await ledger.processJob(job);assert.equal(sent.length,0);const current=ledger.booking(b.id),next=reminderJobs(ledger)[0];assert.equal(current.start,start+3600000);assert.equal(current.version,b.version+1);assert.equal(next.dueAt,start+3600000-5*60000);assert.equal(ledger.rows('SELECT due FROM live_jobs WHERE id=?',next.id)[0].due,next.dueAt);
  Date.now=()=>next.dueAt;await ledger.processJob(next);assert.equal(sent.length,1);assert.match(sent[0].text,/01:30.*America\/New_York/);assert.equal(sent[0].idempotencyKey,next.id);
 }finally{Date.now=now;}
});
test('reminder final send gate survives cancellation, reconnect, move, sync and maintenance races during encryption',async()=>{
 for(const action of ['cancel','reconnect','move','sync','sync_lease','freeze']){
  const {ledger}=await reminderReady(),result=await reserve(ledger,'intro',details()),job=reminderJobs(ledger)[0],now=Date.now,encrypt=crypto.subtle.encrypt;let enter,release,sends=0;const entered=new Promise(r=>enter=r),gate=new Promise(r=>release=r);ledger.notify=async()=>{sends++;};
  crypto.subtle.encrypt=async function(...args){enter();await gate;return encrypt.apply(this,args);};
  try{Date.now=()=>result.booking.start-5*60000;const processing=ledger.processJob(job);await entered;const b=ledger.booking(result.booking.id);
   if(action==='reconnect'){const a=ledger.account('a');a.connectionVersion++;ledger.putAccount(a);}
   else if(action==='freeze')ledger.putOperationalMeta('operations:fence',{epoch:1,frozen:true});
   else{if(action==='cancel'){b.status='cancelled';b.version++;}if(action==='move')b.replacementKey='pending-move';if(action==='sync')b.calendarSyncStatus='pending';if(action==='sync_lease')b.syncLeaseUntil=Date.now()+60000;ledger.putBooking(b);}
   release();await processing;assert.equal(sends,0,action);const stored=reminderJobs(ledger)[0];if(action==='cancel')assert.equal(stored,undefined);else{assert.ok(!stored.firstAttemptAt,action);assert.equal(stored.leaseUntil,0,action);}
  }finally{Date.now=now;crypto.subtle.encrypt=encrypt;}
 }
});
test('scheduled emails bind the grant from before their fresh read, including a reconnect as the read completes',async()=>{
 for(const kind of ['reminder','follow_up']){
  const {ledger}=await reminderReady();if(kind==='follow_up')setIntroPolicy(ledger,{reminder:false,followUpMinutes:5});
  const result=await reserve(ledger,'intro',details()),b=ledger.booking(result.booking.id),job=(kind==='reminder'?reminderJobs(ledger):followJobs(ledger))[0],now=Date.now,reconcile=ledger.reconcileConfirmed.bind(ledger);let sends=0;
  ledger.reconcileConfirmed=async(...args)=>{const refreshed=await reconcile(...args);const a=ledger.account('a');a.connectionVersion++;ledger.putAccount(a);return refreshed;};ledger.notify=async()=>{sends++;};
  try{Date.now=()=>kind==='reminder'?b.start-5*60000:b.end+5*60000;await ledger.processJob(job);assert.equal(sends,0,kind);const stored=(kind==='reminder'?reminderJobs(ledger):followJobs(ledger))[0];assert.equal(stored.pausedForCalendarSync,true);assert.ok(!stored.firstAttemptAt);}finally{Date.now=now;}
 }
});
const followReady=async()=>{const fixture=setup();await fixture.ready();fixture.ledger.env.RESEND_API_KEY='test';fixture.ledger.env.MAIL_FROM='host@example.test';setIntroPolicy(fixture.ledger,{followUpMinutes:5,followUpSubject:'Follow {meeting_title}',followUpBody:'Hi {guest_name}, from {host_name}',extraGuestsLimit:1});return fixture;};
test('follow-up is off by default, durably due after end and primary-only with no early sends',async()=>{
 const off=setup();await off.ready();off.ledger.env.RESEND_API_KEY='test';off.ledger.env.MAIL_FROM='host@example.test';await reserve(off.ledger,'intro',details());assert.deepEqual(followJobs(off.ledger),[]);
 const {ledger,events}=await followReady(),result=await reserve(ledger,'intro',{...details(),additionalGuests:['extra@example.test']}),job=followJobs(ledger)[0],sent=[];ledger.notify=async(_,p)=>{sent.push(p);return{id:'mail'};};await ledger.processJob(job);assert.equal(sent.length,0);assert.equal(ledger.rows('SELECT due FROM live_jobs WHERE id=?',job.id)[0].due,result.booking.end+5*60000);
 const now=Date.now;try{Date.now=()=>result.booking.end+5*60000+1;await ledger.processJob(job);assert.equal(sent.length,1);assert.equal(sent[0].to,'guest@example.test');assert.ok(sent[0].text.includes('Hi Guest, from Host'));assert.deepEqual(followJobs(ledger),[]);const b=ledger.booking(result.booking.id);await ledger.reconcileConfirmed(b.id,{forNotification:true});assert.deepEqual(followJobs(ledger),[]);assert.equal(events.size,1);}finally{Date.now=now;}
});
test('moves retain accepted follow-up timing and templates; cancelled and replaced jobs never send',async()=>{
 const {ledger}=await followReady(),first=await reserve(ledger,'intro',details()),old=followJobs(ledger)[0];setIntroPolicy(ledger,{followUpMinutes:null,followUpSubject:'Changed',followUpBody:'Changed'});const moved=await ledger.reschedule(first.booking.id,first.managementToken,first.booking.start+3600000,'follow-up-move-key-123');assert.equal(moved.booking.status,'confirmed');const b=ledger.booking(moved.booking.id);assert.equal(b.config.followUpMinutes,5);assert.equal(b.config.followUpSubject,'Follow {meeting_title}');let sent=0;ledger.notify=async()=>{sent++;};await ledger.processJob(old);assert.equal(sent,0);assert.ok(!followJobs(ledger).some(j=>j.id===old.id));const current=followJobs(ledger)[0];await ledger.cancel(b.id,moved.managementToken);await ledger.processJob(current);assert.equal(sent,0);assert.deepEqual(followJobs(ledger),[]);
});
test('follow-up beyond normal sync window requires fresh exact-owned event and pauses unknown calendar state',async()=>{
 const {ledger,events}=await followReady();setIntroPolicy(ledger,{followUpMinutes:2880});const result=await reserve(ledger,'intro',details()),job=followJobs(ledger)[0],now=Date.now;let sent=0,reads=0;ledger.notify=async()=>{sent++;return{id:'ok'};};const get=ledger.google.getEvent;ledger.google.getEvent=async(...args)=>{reads++;throw Error('offline');};
 try{Date.now=()=>result.booking.end+2880*60000+1;await ledger.processJob(job);assert.equal(reads,1);assert.equal(sent,0);assert.equal(followJobs(ledger)[0].pausedForCalendarSync,true);ledger.google.getEvent=get;const a=ledger.account('a');a.syncCooldownUntil=0;ledger.putAccount(a);await ledger.processJob(job);assert.equal(sent,1);assert.deepEqual(followJobs(ledger),[]);}finally{Date.now=now;}
});
test('deleted external event suppresses follow-up and unknown cloudflare delivery cannot resend',async()=>{
 for(const deleted of [true,false]){const {ledger,events}=await followReady(),result=await reserve(ledger,'intro',details()),job=followJobs(ledger)[0],now=Date.now;let sent=0;ledger.env.NOTIFICATION_PROVIDER='cloudflare';ledger.env.EMAIL={send:async()=>{}};ledger.notify=async()=>{sent++;throw Object.assign(Error('unknown delivery'),{deliveryUnknown:true,retryable:false});};if(deleted)events.delete(ledger.booking(result.booking.id).eventId);
 try{Date.now=()=>result.booking.end+5*60000+1;await ledger.processJob(job);assert.equal(sent,deleted?0:1);if(!deleted){const pending=followJobs(ledger)[0];assert.equal(pending.requiresAttention,true);assert.ok(pending.payloadCiphertext);await ledger.processJob(pending);assert.equal(sent,1);}}finally{Date.now=now;}}
});

test('external time edits rebase follow-up once, and successful or uncertain older sends cannot duplicate on new versions',async()=>{
 for(const delivered of [false,true]){const {ledger,events}=await followReady(),result=await reserve(ledger,'intro',details()),initial=followJobs(ledger)[0],now=Date.now;let sent=0;ledger.notify=async()=>{sent++;if(!delivered)throw Object.assign(Error('unknown'),{retryable:true});return{id:'ok'};};
 try{Date.now=()=>result.booking.end+5*60000+1;await ledger.processJob(initial);assert.equal(sent,1);const b=ledger.booking(result.booking.id),event=events.get(b.eventId);event.start.dateTime=new Date(b.start+3600000).toISOString();event.end.dateTime=new Date(b.end+3600000).toISOString();await ledger.reconcileConfirmed(b.id,{forNotification:true});assert.equal(followJobs(ledger).length,delivered?0:1);if(!delivered){await ledger.processJob(initial);assert.equal(followJobs(ledger)[0].requiresAttention,true);}assert.equal(sent,1);}finally{Date.now=now;}}
 const {ledger,events}=await followReady(),result=await reserve(ledger,'intro',details()),old=followJobs(ledger)[0],b=ledger.booking(result.booking.id),event=events.get(b.eventId),now=Date.now;event.start.dateTime=new Date(b.start+3600000).toISOString();event.end.dateTime=new Date(b.end+3600000).toISOString();let sent=0;ledger.notify=async()=>{sent++;return{id:'ok'};};
 try{Date.now=()=>b.end+5*60000+1;await ledger.processJob(old);assert.equal(sent,0);const next=followJobs(ledger)[0];assert.equal(next.version,b.version+1);assert.equal(ledger.rows('SELECT due FROM live_jobs WHERE id=?',next.id)[0].due,b.end+3600000+5*60000);Date.now=()=>b.end+3600000+5*60000+1;await ledger.processJob(next);assert.equal(sent,1);}finally{Date.now=now;}
});
test('late follow-ups skip unattempted backlog and retain uncertain deliveries for review',async()=>{
 for(const attempted of [false,true]){const {ledger}=await followReady(),result=await reserve(ledger,'intro',details()),job=followJobs(ledger)[0],now=Date.now;let sent=0;ledger.notify=async()=>{sent++;throw Object.assign(Error('unknown'),{retryable:true});};try{Date.now=()=>result.booking.end+5*60000+1;if(attempted)await ledger.processJob(job);Date.now=()=>result.booking.end+5*60000+24*3600000+1;await ledger.processJob(job);assert.equal(sent,attempted?1:0);assert.equal(followJobs(ledger).length,attempted?1:0);if(attempted)assert.equal(followJobs(ledger)[0].requiresAttention,true);}finally{Date.now=now;}}
});
test('terminal cancellation during follow-up calendar check prevents email delivery',async()=>{
 const {ledger}=await followReady(),result=await reserve(ledger,'intro',details()),job=followJobs(ledger)[0],now=Date.now;let enter,release,sent=0;const entered=new Promise(r=>enter=r),gate=new Promise(r=>release=r),get=ledger.google.getEvent;ledger.google.getEvent=async(...args)=>{enter();await gate;return get(...args);};ledger.notify=async()=>{sent++;};try{Date.now=()=>result.booking.end+5*60000+1;const processing=ledger.processJob(job);await entered;const cancelled=ledger.booking(result.booking.id);cancelled.status='cancelled';cancelled.version++;ledger.putBooking(cancelled);release();await processing;assert.equal(sent,0);assert.deepEqual(followJobs(ledger),[]);}finally{Date.now=now;}
});

test('follow-up final send gate rechecks disconnect, replacement and pending calendar after encryption yields',async()=>{
 for(const action of ['disconnect','replacement','pending']){const {ledger}=await followReady(),result=await reserve(ledger,'intro',details()),job=followJobs(ledger)[0],now=Date.now,encrypt=crypto.subtle.encrypt;let enter,release,sent=0;const entered=new Promise(r=>enter=r),gate=new Promise(r=>release=r);ledger.notify=async()=>{sent++;return{id:'ok'};};crypto.subtle.encrypt=async function(...args){enter();await gate;return encrypt.apply(this,args);};
 try{Date.now=()=>result.booking.end+5*60000+1;const processing=ledger.processJob(job);await entered;if(action==='disconnect')await ledger.disconnect('a');else{const b=ledger.booking(result.booking.id);if(action==='replacement')b.replacementKey='replacement-pending';else b.calendarSyncStatus='pending';ledger.putBooking(b);}release();await processing;assert.equal(sent,0,action);assert.equal(followJobs(ledger)[0].pausedForCalendarSync,true,action);assert.ok(!followJobs(ledger)[0].firstAttemptAt,action);}finally{Date.now=now;crypto.subtle.encrypt=encrypt;}}
});

test('approval requests do not queue follow-ups until confirmed',async()=>{
 const {ledger}=await followReady();setIntroPolicy(ledger,{requiresApproval:true});const result=await reserve(ledger,'intro',details());assert.deepEqual(followJobs(ledger),[]);await approve(ledger,result.booking);assert.equal(followJobs(ledger).length,1);
});

test('public availability does not expose custom follow-up messages or subjects',async()=>{
 const {ledger}=await followReady(),data=details(),availability=await ledger.availability('intro',{from:data.start,to:data.start+3600000});assert.equal(availability.config.followUpSubject,undefined);assert.equal(availability.config.followUpBody,undefined);assert.equal(availability.config.followUpMinutes,5);assert.equal(ledger.settings().meetingTypes.find(t=>t.id==='intro').followUpSubject,'Follow {meeting_title}');
});

test('owner email activity records acceptance atomically without leaking content, links or raw provider state to guests',async()=>{
 const {ledger}=await followReady(),result=await reserve(ledger,'intro',details()),b=ledger.booking(result.booking.id),jobs=ledger.rows('SELECT body FROM live_jobs').map(r=>JSON.parse(r.body)),confirmation=jobs.find(j=>j.kind==='confirmed');
 const scheduled=ledger.listBookings({includeNotifications:true}).bookings.find(x=>x.id===b.id);assert.equal(scheduled.notifications.length,2);assert.equal(scheduled.notifications.find(n=>n.kind==='follow_up').dueAt,b.end+5*60000);assert.equal(scheduled.notifications.find(n=>n.kind==='confirmed').status,'scheduled');
 ledger.notify=async()=>({id:'private-provider-id',raw:'provider data'});await ledger.processJob(confirmation);const owner=(await ledger.hostBooking(b.id)).booking,receipt=owner.notifications.find(n=>n.kind==='confirmed');assert.equal(receipt.status,'sent');assert.ok(receipt.sentAt);assert.equal(receipt.recipientRole,'guest');assert.deepEqual(Object.keys(receipt).sort(),['dueAt','id','kind','recipientRole','sentAt','status','updatedAt'].sort());
 for(const secret of [result.managementToken,'payloadCiphertext','provider data','private-provider-id','guest@example.test','Follow {meeting_title}'])assert.ok(!JSON.stringify(owner.notifications).includes(secret),secret);
 assert.equal((await ledger.manage(b.id,result.managementToken)).booking.notifications,undefined);assert.equal((await ledger.manage(b.id,result.managementToken)).booking.notificationHistory,undefined);assert.equal(ledger.listBookings().bookings[0].notifications,undefined);assert.equal(ledger.listBookings().bookings[0].notificationHistory,undefined);assert.equal(ledger.rows('SELECT id FROM live_jobs WHERE id=?',confirmation.id).length,0);assert.equal(ledger.rows('SELECT id FROM live_notification_receipts WHERE id=?',confirmation.id).length,1);
 await ledger.processJob(confirmation);assert.equal((await ledger.hostBooking(b.id)).booking.notifications.filter(n=>n.id===confirmation.id).length,1);
});
test('owner activity distinguishes sending, calendar wait, retry, uncertain review and safe terminal suppression',async()=>{
 const {ledger}=await followReady(),result=await reserve(ledger,'intro',details()),b=ledger.booking(result.booking.id),job=ledger.rows("SELECT body FROM live_jobs WHERE json_extract(body,'$.kind')='confirmed'").map(r=>JSON.parse(r.body))[0],status=()=>ledger.listBookings({includeNotifications:true}).bookings.find(x=>x.id===b.id).notifications.find(n=>n.id===job.id)?.status;
 job.leaseUntil=Date.now()+30000;ledger.sql.exec('UPDATE live_jobs SET body=? WHERE id=?',JSON.stringify(job),job.id);assert.equal(status(),'sending');job.leaseUntil=0;job.pausedForCalendarSync=true;ledger.sql.exec('UPDATE live_jobs SET body=? WHERE id=?',JSON.stringify(job),job.id);assert.equal(status(),'waiting_for_calendar');delete job.pausedForCalendarSync;job.firstAttemptAt=Date.now();ledger.sql.exec('UPDATE live_jobs SET body=? WHERE id=?',JSON.stringify(job),job.id);assert.equal(status(),'retrying');job.provider='cloudflare';job.deliveryInFlight=true;ledger.sql.exec('UPDATE live_jobs SET body=? WHERE id=?',JSON.stringify(job),job.id);assert.equal(status(),'needs_review');job.requiresAttention=true;job.error='raw private error';ledger.sql.exec('UPDATE live_jobs SET body=? WHERE id=?',JSON.stringify(job),job.id);assert.ok(!JSON.stringify(ledger.listBookings({includeNotifications:true})).includes('raw private error'));
 const follow=followJobs(ledger)[0];ledger.suppressNotification(follow);assert.equal(ledger.notificationActivity(b).find(n=>n.id===follow.id).status,'cancelled');assert.equal(ledger.rows('SELECT id FROM live_jobs WHERE id=?',follow.id).length,0);
 ledger.expireReminder({...follow,id:'late-receipt',dueAt:Date.now()-25*3600000},{...b,end:Date.now()-26*3600000});assert.equal(ledger.notificationActivity(b).find(n=>n.id==='late-receipt').status,'skipped');
});
test('email receipts are bounded per booking and host, expire after90days and do not imply historical completeness',async()=>{
 const {ledger}=await followReady(),result=await reserve(ledger,'intro',details()),b=ledger.booking(result.booking.id);for(let n=0;n<25;n++)ledger.recordNotification({id:'receipt-'+String(n).padStart(3,'0'),bookingId:b.id,kind:'reminder',dueAt:b.start-60000},'sent');assert.equal(ledger.rows('SELECT id FROM live_notification_receipts WHERE booking_id=?',b.id).length,20);
 for(let n=0;n<2005;n++)ledger.sql.exec('INSERT INTO live_notification_receipts VALUES (?,?,?,?)','bound-'+n,'bound-'+n,Date.now(),JSON.stringify({id:'bound-'+n}));ledger.sql.exec('INSERT INTO live_notification_receipts VALUES (?,?,?,?)','old','old',Date.now()-91*86400000,'{}');ledger.pruneNotificationReceipts();assert.equal(ledger.rows('SELECT id FROM live_notification_receipts').length,2000);assert.equal(ledger.rows('SELECT id FROM live_notification_receipts WHERE id=?','old').length,0);const owner=(await ledger.hostBooking(b.id)).booking;assert.equal(owner.notificationHistory.complete,false);assert.equal(owner.notificationHistory.retentionDays,90);assert.equal(owner.notificationHistory.limit,20);
});

test('owner activity prioritizes old delivery issues inside bounded booking list and exposes only a reason enum',async()=>{
 const {ledger}=await followReady(),result=await reserve(ledger,'intro',details()),base=ledger.booking(result.booking.id);const old={...base,start:Date.now()-365*86400000,end:Date.now()-365*86400000+60000};ledger.putBooking(old);
 for(let n=0;n<505;n++)ledger.putBooking({...base,id:'newer-'+n,requestKey:'newer-'+n,status:'failed',config:{...base.config,followUpMinutes:null}});
 const job=ledger.rows("SELECT body FROM live_jobs WHERE json_extract(body,'$.kind')='confirmed'").map(r=>JSON.parse(r.body))[0];job.requiresAttention=true;job.error='Delivery configuration requires review';job.firstAttemptAt=Date.now();ledger.sql.exec('UPDATE live_jobs SET body=? WHERE id=?',JSON.stringify(job),job.id);const owner=ledger.listBookings({includeNotifications:true});assert.equal(owner.bookings.length,500);assert.equal(owner.bookings[0].id,base.id);assert.equal(owner.bookings[0].notifications.find(n=>n.id===job.id).reason,'configuration');assert.equal(owner.bookings[0].notifications.find(n=>n.id===job.id).error,undefined);
 job.error='secret exception';job.superseded=true;ledger.sql.exec('UPDATE live_jobs SET body=? WHERE id=?',JSON.stringify(job),job.id);assert.equal(ledger.notificationActivity(old).find(n=>n.id===job.id).reason,'superseded');delete job.superseded;job.expired=true;ledger.sql.exec('UPDATE live_jobs SET body=? WHERE id=?',JSON.stringify(job),job.id);assert.equal(ledger.notificationActivity(old).find(n=>n.id===job.id).reason,'expired_attempt');assert.ok(!JSON.stringify(ledger.listBookings({includeNotifications:true})).includes('secret exception'));
});

test('crashed in-flight and stale attempted jobs appear consistently in owner attention list before alarm reconciliation',async()=>{
 const {ledger}=await followReady(),result=await reserve(ledger,'intro',details()),b=ledger.booking(result.booking.id),job=ledger.rows("SELECT body FROM live_jobs WHERE json_extract(body,'$.kind')='confirmed'").map(r=>JSON.parse(r.body))[0];job.firstAttemptAt=Date.now();job.provider='cloudflare';job.deliveryInFlight=true;job.leaseUntil=Date.now()-1;ledger.sql.exec('UPDATE live_jobs SET body=? WHERE id=?',JSON.stringify(job),job.id);let owner=ledger.listBookings({includeNotifications:true});assert.ok(owner.notificationIssues.some(n=>n.bookingId===b.id));assert.equal(owner.bookings[0].notifications.find(n=>n.id===job.id).status,'needs_review');delete job.deliveryInFlight;job.version=0;ledger.sql.exec('UPDATE live_jobs SET body=? WHERE id=?',JSON.stringify(job),job.id);owner=ledger.listBookings({includeNotifications:true});assert.ok(owner.notificationIssues.some(n=>n.bookingId===b.id));assert.equal(owner.bookings[0].notifications.find(n=>n.id===job.id).status,'needs_review');
});

test('owner attention priority handles more than100 bookings within Durable Objects SQL parameter limit',async()=>{
 const {ledger}=await followReady(),result=await reserve(ledger,'intro',details()),base=ledger.booking(result.booking.id);
 for(let n=0;n<125;n++){const b={...base,id:'attention-'+n,requestKey:'attention-'+n,status:'failed',config:{...base.config,followUpMinutes:null}};ledger.putBooking(b);const id=b.id+':1:confirmed';ledger.sql.exec('INSERT INTO live_jobs VALUES (?,?,?)',id,Date.now(),JSON.stringify({id,bookingId:b.id,kind:'confirmed',version:1,requiresAttention:true,error:'Delivery requires review'}));}
 const rows=ledger.rows.bind(ledger);let largest=0,priorityParameters;ledger.rows=(query,...args)=>{largest=Math.max(largest,args.length);assert.ok(args.length<=100,'Cloudflare SQLite allows at most100 bound parameters');if(query.includes('ORDER BY CASE WHEN id IN'))priorityParameters={query,args};return rows(query,...args);};const owner=ledger.listBookings({includeNotifications:true});assert.ok(largest<=100);assert.equal(priorityParameters.args.length,1);assert.match(priorityParameters.query,/IN \(SELECT value FROM json_each\(\?\)\)/);assert.equal(JSON.parse(priorityParameters.args[0]).length,125);assert.equal(owner.bookings.filter(b=>b.notifications.some(n=>n.status==='needs_review')).length,125);assert.equal(owner.bookings.slice(0,125).every(b=>b.id.startsWith('attention-')),true);
});

test('daily booked-time cap uses actual accepted lengths, combines with count caps and ignores buffers and other types',async()=>{
 const {ledger,ready}=setup();await ready();setIntroPolicy(ledger,{dailyBookedMinutesLimit:60,weeklyBookedMinutesLimit:120});const first=await reserve(ledger,'intro',details()),type=ledger.type('intro');let b=ledger.booking(first.booking.id);b.end=b.start+15*60000;ledger.putBooking(b);const slot={start:b.start+3600000,end:b.start+3600000+45*60000};assert.equal(ledger.quotaSlots({...type,duration:45},[slot]).length,1);assert.equal(ledger.quotaSlots({...type,dailyBookedMinutesLimit:55},[slot]).length,0);assert.equal(ledger.quotaSlots({...type,dailyBookingLimit:1},[slot]).length,0);
 ledger.putBooking({...b,id:'other-type-minutes',requestKey:'other-type-minutes',meetingTypeId:'other',start:b.start+1800000,end:b.start+1800000+60*60000});b.config.buffer=60;ledger.putBooking(b);assert.equal(ledger.quotaSlots(type,[slot]).length,1);b.status='cancelled';ledger.putBooking(b);assert.equal(ledger.quotaSlots({...type,dailyBookedMinutesLimit:45},[slot]).length,1);
 for(const status of ['awaiting_approval','pending','confirmed','cancelling']){ledger.putBooking({...b,status});assert.equal(ledger.quotaSlots({...type,dailyBookedMinutesLimit:45},[slot]).length,0,status);}ledger.putBooking({...b,status:'failed'});assert.equal(ledger.quotaSlots({...type,dailyBookedMinutesLimit:45},[slot]).length,1);
});
test('minute caps use start-local day and Monday week, elapsed DST time and full cross-midnight allocation',async()=>{
 const {ledger,ready}=setup();await ready();const accepted=await reserve(ledger,'intro',details()),base=ledger.booking(accepted.booking.id);base.status='cancelled';ledger.putBooking(base);const type={...ledger.type('intro'),zone:'Europe/Oslo',dailyBookedMinutesLimit:60,weeklyBookedMinutesLimit:60};
 const spring={...base,id:'spring-dst',requestKey:'spring-dst',status:'confirmed',start:Date.parse('2027-03-28T01:30:00+01:00'),end:Date.parse('2027-03-28T03:30:00+02:00')};ledger.putBooking(spring);assert.equal(spring.end-spring.start,3600000);assert.equal(ledger.withinDailyLimit(type,Date.parse('2027-03-28T10:00:00+02:00')),false);assert.equal(ledger.withinDailyLimit(type,Date.parse('2027-03-29T00:15:00+02:00')),true);spring.status='cancelled';ledger.putBooking(spring);
 const fall={...spring,id:'fall-dst',requestKey:'fall-dst',status:'pending',start:Date.parse('2027-10-31T02:30:00+02:00'),end:Date.parse('2027-10-31T02:30:00+01:00')};ledger.putBooking(fall);assert.equal(fall.end-fall.start,3600000);assert.equal(ledger.withinDailyLimit(type,Date.parse('2027-10-31T15:00:00+01:00')),false);fall.status='cancelled';ledger.putBooking(fall);
 const midnight={...fall,id:'midnight-minutes',requestKey:'midnight-minutes',status:'confirmed',start:Date.parse('2027-03-28T23:45:00+02:00'),end:Date.parse('2027-03-29T00:15:00+02:00')};ledger.putBooking(midnight);assert.equal(ledger.withinDailyLimit({...type,dailyBookedMinutesLimit:30,weeklyBookedMinutesLimit:30},Date.parse('2027-03-28T10:00:00+02:00')),false);assert.equal(ledger.withinDailyLimit({...type,dailyBookedMinutesLimit:30,weeklyBookedMinutesLimit:30},Date.parse('2027-03-29T00:15:00+02:00')),true);
});
test('simultaneous distinct slots cannot exceed booked-minute caps; authorized move excludes its original only',async()=>{
 const {ledger,ready,effects}=setup();await ready();setIntroPolicy(ledger,{dailyBookedMinutesLimit:30});const data=details(),results=await Promise.all([reserve(ledger,'intro',data),reserve(ledger,'intro',{...data,start:data.start+3600000,idempotencyKey:'minute-concurrent-key-123'})]);assert.equal(results.filter(r=>r.booking?.status==='confirmed').length,1);assert.equal(results.filter(r=>r.status===409).length,1);assert.equal(effects.created,1);const accepted=results.find(r=>r.booking),original=ledger.booking(accepted.booking.id);assert.equal((await reserve(ledger,'intro',{...details('injected-exclusion-key'),start:original.start+7200000,replacesId:original.id})).status,409);const moved=await ledger.reschedule(original.id,accepted.managementToken,original.start+7200000,'authorized-minute-move-key');assert.equal(moved.booking.status,'confirmed');assert.equal(ledger.booking(original.id).status,'cancelled');assert.equal(effects.created,2);
});
test('minute cap edit during async admission invalidates hold and approval checks stored request length after current duration changes',async()=>{
 const {ledger,ready,effects}=setup();await ready();const data=details();data.intakeRevision=await intakeRevision(ledger.type('intro'));const pending=ledger.reserve('intro',data);setIntroPolicy(ledger,{dailyBookedMinutesLimit:15});assert.equal((await pending).status,409);assert.equal(effects.created,0);assert.equal(ledger.rows('SELECT id FROM live_bookings').length,0);
 setIntroPolicy(ledger,{duration:60,requiresApproval:true,dailyBookedMinutesLimit:60});const request=await reserve(ledger,'intro',details('approval-duration-minutes-key'));assert.equal(request.booking.status,'awaiting_approval');setIntroPolicy(ledger,{duration:15,dailyBookedMinutesLimit:30});assert.equal((await approve(ledger,request.booking)).status,409);assert.equal(ledger.booking(request.booking.id).status,'awaiting_approval');assert.equal(effects.created,0);setIntroPolicy(ledger,{dailyBookedMinutesLimit:60});assert.equal((await approve(ledger,request.booking)).booking.status,'confirmed');assert.equal(effects.created,1);
});

test('month and year quotas use local start calendar buckets, leap days and actual elapsed duration',async()=>{
 const {ledger,ready}=setup();await ready();const result=await reserve(ledger,'intro',details()),base=ledger.booking(result.booking.id);base.status='cancelled';ledger.putBooking(base);
 const type={...ledger.type('intro'),zone:'Asia/Tokyo',monthlyBookingLimit:1,yearlyBookingLimit:1,monthlyBookedMinutesLimit:60,yearlyBookedMinutesLimit:60};
 const b={...base,id:'local-year',requestKey:'local-year',status:'confirmed',start:Date.parse('2027-12-31T23:45:00+09:00'),end:Date.parse('2028-01-01T00:45:00+09:00')};ledger.putBooking(b);
 assert.equal(ledger.withinDailyLimit(type,Date.parse('2027-12-31T12:00:00+09:00')),false);assert.equal(ledger.withinDailyLimit(type,Date.parse('2028-01-01T01:00:00+09:00')),true);
 b.start=Date.parse('2028-02-29T23:45:00+09:00');b.end=b.start+60*60000;ledger.putBooking(b);assert.equal(ledger.withinDailyLimit({...type,yearlyBookingLimit:0,yearlyBookedMinutesLimit:0},Date.parse('2028-02-29T12:00:00+09:00')),false);assert.equal(ledger.withinDailyLimit({...type,yearlyBookingLimit:0,yearlyBookedMinutesLimit:0},Date.parse('2028-03-01T01:00:00+09:00')),true);assert.equal(ledger.withinDailyLimit(type,Date.parse('2028-03-01T01:00:00+09:00')),false);
 for(const status of ['awaiting_approval','pending','cancelling']){b.status=status;ledger.putBooking(b);assert.equal(ledger.withinDailyLimit(type,Date.parse('2028-03-01T01:00:00+09:00')),false,status);}for(const status of ['cancelled','failed','rejected','expired']){b.status=status;ledger.putBooking(b);assert.equal(ledger.withinDailyLimit(type,Date.parse('2028-03-01T01:00:00+09:00')),true,status);}
 b.status='confirmed';b.end=b.start+15*60000;ledger.putBooking(b);const candidate=Date.parse('2028-02-29T12:00:00+09:00');assert.equal(ledger.withinDailyLimit({...type,monthlyBookingLimit:0,yearlyBookingLimit:0},candidate,undefined,candidate+45*60000),true);assert.equal(ledger.withinDailyLimit({...type,monthlyBookingLimit:0,yearlyBookingLimit:0},candidate,undefined,candidate+50*60000),false);
});
test('each long-period cap atomically admits only one concurrent slot and authorized reschedule excludes only original',async()=>{
 for(const [key,limit] of [['monthlyBookingLimit',1],['yearlyBookingLimit',1],['monthlyBookedMinutesLimit',30],['yearlyBookedMinutesLimit',30]]){
  const {ledger,ready,effects}=setup();await ready();setIntroPolicy(ledger,{[key]:limit});const data={...details(),start:nextUtcDay()+2*3600000},results=await Promise.all([reserve(ledger,'intro',data),reserve(ledger,'intro',{...data,start:data.start+3600000,idempotencyKey:'long-period-concurrent-key'})]);assert.equal(results.filter(r=>r.booking?.status==='confirmed').length,1,key);assert.equal(results.filter(r=>r.status===409).length,1,key);assert.equal(effects.created,1);const first=results.find(r=>r.booking);assert.equal((await reserve(ledger,'intro',{...data,start:data.start+7200000,idempotencyKey:'unauthorized-quota-exclude',replacesId:first.booking.id})).status,409);
  const moved=await ledger.reschedule(first.booking.id,first.managementToken,data.start+7200000,'authorized-long-cap-move');assert.equal(moved.booking.status,'confirmed');assert.equal(ledger.booking(first.booking.id).status,'cancelled');await ledger.cancel(moved.booking.id,moved.managementToken);assert.equal((await reserve(ledger,'intro',{...data,idempotencyKey:'after-cancel-long-cap'})).booking.status,'confirmed');
 }
});
test('approval refuses a destination changed during its async provider check without creating an event',async()=>{
 const {ledger,ready,effects}=setup();await ready();setIntroPolicy(ledger,{requiresApproval:true});const request=await reserve(ledger,'intro',details());await ledger.connect({accountId:'b',email:'second@example.test',tokens:{access_token:'access',refresh_token:'refresh',expires_at:Date.now()+3600000}});await ledger.configureCalendars({accounts:[{id:'b',destinationCalendarId:'primary',conflictCalendarIds:['primary']}]});const original=ledger.providerBusy.bind(ledger);ledger.providerBusy=async(...args)=>{const busy=await original(...args);setIntroPolicy(ledger,{accountId:'b',calendarId:'primary'});return busy;};const decision=await approve(ledger,request.booking);assert.equal(decision.status,409);assert.equal(ledger.booking(request.booking.id).status,'awaiting_approval');assert.equal(effects.created,0);
});
test('quota compaction survives clock movement, restart and repeated cleanup without retaining guest details or resetting annual usage',async()=>{
 const {ledger,ready,storage}=setup();await ready();setIntroPolicy(ledger,{yearlyBookingLimit:1});const result=await reserve(ledger,'intro',details()),b=ledger.booking(result.booking.id),now=Date.now(),clock=Date.now;let tick=now;b.start=now-90*86400000-30*60000;b.end=now-90*86400000;ledger.putBooking(b);const exec=ledger.sql.exec.bind(ledger.sql);ledger.sql.exec=(query,...args)=>{const result=exec(query,...args);if(query.startsWith('INSERT OR IGNORE INTO live_quota_history'))tick++;return result;};Date.now=()=>tick;
 try{await ledger.alarm();assert.ok(ledger.booking(b.id),'boundary record remains until the same cutoff includes it');await ledger.alarm();assert.equal(ledger.booking(b.id),null);const history=ledger.rows('SELECT * FROM live_quota_history');assert.equal(history.length,1);assert.deepEqual(Object.keys(history[0]).sort(),['booking_id','end','meeting_type_id','start']);assert.ok(!JSON.stringify(history).includes(b.email));const restarted=new BookingLedger({storage},ledger.env,{google:ledger.google,sendNotification:async()=>({id:'sent'})});await restarted.alarm();assert.equal(restarted.rows('SELECT * FROM live_quota_history').length,1);assert.equal(restarted.withinDailyLimit(restarted.type('intro'),b.start+3600000),false);assert.equal(restarted.withinDailyLimit(restarted.type('intro'),b.start+3600000,b.id),true);
  tick=now+401*86400000;await restarted.alarm();assert.equal(restarted.rows('SELECT * FROM live_quota_history').length,0);
 }finally{Date.now=clock;ledger.sql.exec=exec;}
});

test('long-period cap edits invalidate async admission and approval charges original request duration',async()=>{
 const {ledger,ready,effects}=setup();await ready();const data=details();data.intakeRevision=await intakeRevision(ledger.type('intro'));const admitting=ledger.reserve('intro',data);setIntroPolicy(ledger,{yearlyBookedMinutesLimit:15});assert.equal((await admitting).status,409);assert.equal(ledger.rows('SELECT id FROM live_bookings').length,0);assert.equal(effects.created,0);
 setIntroPolicy(ledger,{yearlyBookedMinutesLimit:0,monthlyBookedMinutesLimit:60,duration:60,requiresApproval:true});const request=await reserve(ledger,'intro',details('long-cap-approval-mixed'));assert.equal(request.booking.status,'awaiting_approval');setIntroPolicy(ledger,{duration:15,monthlyBookedMinutesLimit:30});assert.equal((await approve(ledger,request.booking,'mixed-long-cap-approval')).status,409);assert.equal(ledger.booking(request.booking.id).status,'awaiting_approval');assert.equal(effects.created,0);setIntroPolicy(ledger,{monthlyBookedMinutesLimit:60});assert.equal((await approve(ledger,request.booking,'mixed-long-cap-approval')).booking.status,'confirmed');assert.equal(effects.created,1);
});

test('default changes migrate followers only; pinned links and accepted calendar snapshots stay intact',async()=>{
 const {ledger,ready,events}=setup();await ready();ledger.google.listCalendars=async()=>[{id:'primary',accessRole:'owner'},{id:'team',accessRole:'writer'},{id:'next',accessRole:'owner'}];const types=ledger.settings().meetingTypes.map(t=>t.id==='intro'?{...t,useDefaultCalendar:false,calendarId:'team'}:t);const verifiedDestinations=await ledger.verifyMeetingDestinations({meetingTypes:types});ledger.saveSettings({meetingTypes:types},{verifiedDestinations});const data=details(),first=await reserve(ledger,'intro',data);assert.equal(ledger.booking(first.booking.id).calendarId,'team');await ledger.configureCalendars({accounts:[{id:'a',destinationCalendarId:'next',conflictCalendarIds:['primary']}]});assert.equal(ledger.type('intro').calendarId,'team');assert.equal(ledger.type('other').calendarId,'next');assert.equal(ledger.booking(first.booking.id).calendarId,'team');const calendars=[],remove=ledger.google.deleteEvent;ledger.google.deleteEvent=async(access,input)=>{calendars.push(input.calendarId);return remove(access,input);};const moved=await ledger.reschedule(first.booking.id,first.managementToken,data.start+7200000,'pinned-calendar-move-key');assert.equal(moved.booking.status,'confirmed');assert.equal(ledger.booking(moved.booking.id).calendarId,'team');assert.deepEqual(calendars,['team']);await ledger.cancel(moved.booking.id,moved.managementToken);assert.deepEqual(calendars,['team','team']);assert.equal(events.size,0);
});
test('busy checks include every pinned calendar once and enforce50calendar bound without dropping selected conflicts',async()=>{
 const {ledger,ready}=setup();await ready();ledger.google.listCalendars=async()=>[{id:'primary',accessRole:'owner'},{id:'team',accessRole:'writer'}];const types=ledger.settings().meetingTypes.map(t=>({...t,useDefaultCalendar:false,calendarId:'team'})),verifiedDestinations=await ledger.verifyMeetingDestinations({meetingTypes:types});ledger.saveSettings({meetingTypes:types},{verifiedDestinations});const a=ledger.account('a');a.conflictCalendarIds=['primary','team','primary'];ledger.putAccount(a);let ids;ledger.google.freeBusy=async(_,input)=>{ids=input.calendarIds;return [];};await ledger.providerBusy(Date.now(),Date.now()+60000);assert.deepEqual(ids,['primary','team']);a.conflictCalendarIds=Array.from({length:48},(_,n)=>'conflict-'+n);ledger.putAccount(a);await assert.rejects(()=>ledger.providerBusy(Date.now(),Date.now()+60000,{accountId:'a',calendarId:'historical'}),/50 calendars/);a.conflictCalendarIds=Array.from({length:50},(_,n)=>'conflict-'+n);ledger.putAccount(a);await assert.rejects(()=>ledger.providerBusy(Date.now(),Date.now()+60000),/50 calendars/);const before=ledger.settings();assert.throws(()=>ledger.saveSettings({profile:{name:'Must not persist'},meetingTypes:types}),/50 calendars/);assert.deepEqual(ledger.settings(),before);
});

test('deleted calendars cannot become defaults or selected conflicts',async()=>{
 const {ledger,ready}=setup();await ready();ledger.google.listCalendars=async()=>[{id:'primary',accessRole:'owner'},{id:'deleted',accessRole:'owner',deleted:true}];const before=ledger.settings();for(const selection of [{destinationCalendarId:'deleted',conflictCalendarIds:[]},{destinationCalendarId:'primary',conflictCalendarIds:['deleted']}]){await assert.rejects(()=>ledger.configureCalendars({accounts:[{id:'a',...selection}]}));assert.deepEqual(ledger.settings(),before);}
});
test('pending booking retry checks its accepted calendar even after the link is repinned elsewhere',async()=>{
 const {ledger,ready,effects}=setup();await ready();ledger.google.listCalendars=async()=>[{id:'primary',accessRole:'owner'},{id:'team',accessRole:'writer'},{id:'next',accessRole:'writer'}];let types=ledger.settings().meetingTypes.map(t=>t.id==='intro'?{...t,useDefaultCalendar:false,calendarId:'team'}:t);ledger.saveSettings({meetingTypes:types},{verifiedDestinations:await ledger.verifyMeetingDestinations({meetingTypes:types})});const data=details();ledger.google.freeBusy=async()=>{throw Error('network');};const result=await reserve(ledger,'intro',data);assert.equal(result.booking.status,'pending');assert.equal(effects.created,0);types=ledger.settings().meetingTypes.map(t=>t.id==='intro'?{...t,calendarId:'next'}:t);ledger.saveSettings({meetingTypes:types},{verifiedDestinations:await ledger.verifyMeetingDestinations({meetingTypes:types})});let checked;ledger.google.freeBusy=async(_,input)=>{checked=input.calendarIds;return input.calendarIds.includes('team')?[{start:data.start,end:data.start+60000}]:[];};await ledger.reconcile(result.booking.id);assert.ok(checked.includes('team'));assert.ok(checked.includes('next'));assert.equal(effects.created,0);assert.equal(ledger.booking(result.booking.id).status,'failed');
});

test('public availability carries only the saved profile pictures, without exposing profile identity or credentials',async()=>{
 const {readFileSync}=await import('node:fs');const image=kind=>'data:image/jpeg;base64,'+readFileSync(new URL('./fixtures/'+kind+'.jpg',import.meta.url)).toString('base64');
 const {ledger,ready}=setup();await ready();ledger.saveSettings({profile:{avatarImage:image('avatar'),bannerImage:image('banner')}});
 for(const slug of ['intro','other']){const state=await ledger.availability(slug);assert.equal(state.config.avatarImage,image('avatar'));assert.equal(state.config.bannerImage,image('banner'));assert.equal(state.config.id,undefined);assert.ok(!JSON.stringify(state).includes('refresh_token'));}
 ledger.saveSettings({profile:{avatarImage:null,bannerImage:null}});const state=await ledger.availability('intro');assert.equal(state.config.avatarImage,null);assert.equal(state.config.bannerImage,null);
});
