import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {BookingLedger} from '../src/ledger.js';
import {DEFAULT,workingWindowChecker} from '../public/policy.js';
import {intakeRevision} from '../public/intake.js';
import {normalizeTeamScheduling,hostsShareResource} from '../public/team-policy.js';
const config={...DEFAULT,zone:'UTC',notice:0,horizon:5,startHour:0,endHour:24,days:[0,1,2,3,4,5,6],buffer:0,reminder:false};
const start=()=>Math.floor(Date.now()/86400000)*86400000+86400000+9*3600000;
async function setup(mode='any',extra={}){
 const db=new DatabaseSync(':memory:'),storage={sql:{exec(q,...args){const rows=db.prepare(q).all(...args);return {toArray:()=>rows};}},setAlarm:async()=>{},transactionSync(fn){db.exec('BEGIN');try{const value=fn();db.exec('COMMIT');return value;}catch(e){db.exec('ROLLBACK');throw e;}}};
 const events=new Map(),busy={a:[],b:[]},calls=[];
 const google={refreshTokens:async()=>{throw Error('unexpected refresh');},listCalendars:async()=>[{id:'primary',accessRole:'owner'},{id:'shared',accessRole:'writer'}],freeBusy:async(token,input)=>{calls.push({token,...input});return busy[token];},getEvent:async(_,{eventId})=>events.get(eventId)??null,createEvent:async(token,{eventId,event,calendarId})=>{const result={...event,id:eventId,etag:'v1',status:'confirmed'};events.set(eventId,result);return result;},deleteEvent:async(_,{eventId})=>events.delete(eventId)};
 const ledger=new BookingLedger({storage},{TOKEN_ENCRYPTION_KEY:Buffer.alloc(32,9).toString('base64'),PUBLIC_ORIGIN:'https://test.invalid'},{google});ledger.init({id:'profile',name:'Profile'});
 for(const accountId of ['a','b']){await ledger.connect({accountId,email:accountId+'@company.test',tokens:{access_token:accountId,refresh_token:accountId,expires_at:start()+86400000}});}
 await ledger.configureCalendars({accounts:['a','b'].map(id=>({id,destinationCalendarId:'primary',conflictCalendarIds:['primary']}))});
 const type={...config,id:'intro',slug:'intro',published:true,accountId:'a',calendarId:'primary',teamScheduling:{mode,hosts:['a','b'].map(id=>({id,name:id.toUpperCase(),accountId:id}))},...extra};
 const save=async(value)=>{const verifiedDestinations=await ledger.verifyMeetingDestinations({meetingTypes:[value]},ledger.settings());return ledger.saveSettings({meetingTypes:[value]},{verifiedDestinations});};
 await save(type);
 const book=async(data={})=>{const type=ledger.type('intro');return ledger.reserve('intro',{start:start(),name:'Guest',email:'guest@company.test',idempotencyKey:crypto.randomUUID(),intakeRevision:await intakeRevision(type),teamRevision:await ledger.teamRevision(type),...data});};
 return {ledger,google,events,busy,calls,book,save,storage,type};
}
test('team normalization is strict and resources follow account and shared destinations',()=>{
 assert.throws(()=>normalizeTeamScheduling({mode:'unknown',hosts:[]}));assert.throws(()=>normalizeTeamScheduling({mode:'any',hosts:[{id:'x',name:'X',accountId:'a'},{id:'y',name:'Y',accountId:'a'}]}));
 assert.ok(!hostsShareResource({accountId:'a',calendarId:'primary'},{accountId:'b',calendarId:'primary'}));assert.ok(hostsShareResource({accountId:'a',calendarId:'shared'},{accountId:'b',calendarId:'shared'}));assert.ok(hostsShareResource({accountId:'a',calendarId:'primary',conflictCalendarIds:['shared']},{accountId:'b',calendarId:'shared'}));
});
test('any and choose show per-host availability, all intersects it, public config excludes identifiers',async()=>{
 for(const mode of ['any','choose','all']){const {ledger,busy}=await setup(mode),at=start();busy.a=[{start:at,end:at+30*60000}];const page=await ledger.availability('intro',{from:at,to:at+3600000});assert.ok(!page.error,JSON.stringify(page));const slot=page.slots.find(s=>s.start===at);if(mode==='all')assert.equal(slot,undefined);else assert.deepEqual(slot.hostIds,['b']);assert.deepEqual(Object.keys(page.config.team).sort(),['hosts','mode','revision']);assert.equal(page.config.teamScheduling,undefined);assert.ok(!JSON.stringify(page.config.team).includes('accountId'));assert.ok(!JSON.stringify(page.config.team).includes('@'));}
});
test('any assigns available host, fairly rotates later bookings, choose binds replay to host',async()=>{
 const fixture=await setup(),at=start();fixture.busy.a=[{start:at,end:at+30*60000}];const one=await fixture.book({start:at});assert.equal(one.booking.status,'confirmed');assert.deepEqual(one.booking.assignedHosts,[{id:'b',name:'B'}]);fixture.busy.a=[];const two=await fixture.book({start:at+3600000});assert.deepEqual(two.booking.assignedHosts,[{id:'a',name:'A'}]);
 const {book}=await setup('choose'),key=crypto.randomUUID(),a=await book({teamHostId:'b',idempotencyKey:key});assert.equal(a.booking.status,'confirmed');assert.equal((await book({teamHostId:'b',idempotencyKey:key})).booking.id,a.booking.id);assert.equal((await book({teamHostId:'a',idempotencyKey:key})).status,409);assert.equal((await book({})).status,400);
});
test('simultaneous guests can use separate hosts but never double assign the last host',async()=>{
 const {book,ledger}=await setup(),at=start();const result=await Promise.all([book({start:at}),book({start:at}),book({start:at})]);assert.equal(result.filter(r=>r.booking?.status==='confirmed').length,2,JSON.stringify(result));assert.equal(result.filter(r=>r.status===409).length,1);assert.equal(new Set(result.filter(r=>r.booking).map(r=>ledger.booking(r.booking.id).accountId)).size,2);
});
test('collective reserves every host, invites staff outside guest limits, disconnect blocks cohosts',async()=>{
 const {book,ledger,events}=await setup('all');const result=await book({email:'b@company.test'});assert.equal(result.booking.status,'confirmed',JSON.stringify(result));assert.deepEqual(result.booking.assignedHosts.map(h=>h.id),['a','b']);assert.deepEqual([...events.values()][0].attendees.map(p=>p.email),['b@company.test']);assert.equal((await book()).status,409);assert.equal((await ledger.disconnect('b')).status,409);await ledger.cancel(result.booking.id,result.managementToken);assert.equal(events.size,0);assert.equal((await book()).booking.status,'confirmed');
});
test('same host account is isolated across links even under different host IDs',async()=>{
 const f=await setup('choose'),one=await f.book({teamHostId:'a'});assert.equal(one.booking.status,'confirmed');const other={...f.ledger.settings().meetingTypes[0],id:'other',slug:'other',teamScheduling:{mode:'choose',hosts:[{id:'different-id',name:'A',accountId:'a'}]}};const verifiedDestinations=await f.ledger.verifyMeetingDestinations({meetingTypes:[...f.ledger.settings().meetingTypes,other]});f.ledger.saveSettings({meetingTypes:[...f.ledger.settings().meetingTypes,other]},{verifiedDestinations});const page=await f.ledger.availability('other');assert.ok(!page.slots.some(slot=>slot.start===one.booking.start));
});
test('unknown insert recovers original assignment after restart without selecting another host',async()=>{
 const f=await setup(),create=f.google.createEvent;f.google.createEvent=async(...args)=>{await create(...args);throw Error('timeout');};const one=await f.book();assert.equal(one.booking.status,'pending');const original=f.ledger.booking(one.booking.id);const restarted=new BookingLedger({storage:f.storage},f.ledger.env,{google:f.google});await restarted.reconcile(one.booking.id);assert.equal(restarted.booking(one.booking.id).status,'confirmed');assert.deepEqual(restarted.booking(one.booking.id).teamAssignment,original.teamAssignment);assert.equal(f.events.size,1);
});
test('rescheduling retains chosen host and rejects a changed destination',async()=>{
 const f=await setup('choose'),one=await f.book({teamHostId:'b'});const moved=await f.ledger.reschedule(one.booking.id,one.managementToken,one.booking.start+3600000,crypto.randomUUID());assert.equal(moved.booking.status,'confirmed',JSON.stringify(moved));assert.deepEqual(moved.booking.assignedHosts,[{id:'b',name:'B'}]);const type=f.ledger.settings().meetingTypes[0];type.teamScheduling.hosts[1]={...type.teamScheduling.hosts[1],useDefaultCalendar:false,calendarId:'shared'};await f.save(type);const rejected=await f.ledger.reschedule(moved.booking.id,moved.managementToken,moved.booking.start+3600000,crypto.randomUUID());assert.equal(rejected.status,409);
});
test('approval rechecks the actual non-primary assigned host and preserves the assignment',async()=>{
 const f=await setup('choose',{requiresApproval:true}),one=await f.book({teamHostId:'b'});assert.equal(one.booking.status,'awaiting_approval');f.busy.b=[{start:one.booking.start,end:one.booking.end}];const decision=()=>f.ledger.decideBooking(one.booking.id,{action:'approve',expectedVersion:one.booking.version,key:crypto.randomUUID()});assert.equal((await decision()).status,409);f.busy.b=[];const approved=await decision();assert.equal(approved.booking.status,'confirmed',JSON.stringify(approved));assert.deepEqual(approved.booking.assignedHosts,[{id:'b',name:'B'}]);
});
test('fresh admission fails closed when authorization or policy changes while Google is reading',async()=>{
 for(const mutation of ['connection','policy']){const f=await setup(),read=f.google.freeBusy;let entered,release;const reached=new Promise(r=>entered=r),gate=new Promise(r=>release=r);f.google.freeBusy=async(...args)=>{entered();await gate;return read(...args);};const pending=f.book();await reached;if(mutation==='connection'){const b=f.ledger.account('b');b.connectionVersion++;f.ledger.putAccount(b);}else{const types=f.ledger.meta('meetingTypes');types[0].teamScheduling.hosts[0].name='Changed';f.ledger.putMeta('meetingTypes',types);}release();const result=await pending;assert.ok(result.error);assert.equal(f.events.size,0);assert.equal(f.ledger.rows('SELECT id FROM live_bookings').length,0);}
});
test('duplicate host identities and deleting a referenced schedule fail closed',async()=>{
 const f=await setup(),b=f.ledger.account('b');b.email='A@company.test';f.ledger.putAccount(b);await assert.rejects(()=>f.save(f.type),/distinct connected/);
});
test('host saved hours are enforced and schedule removal or in-place edits cannot bypass admission',async()=>{
 const f=await setup(),at=start(),day=new Date(at).getUTCDay(),schedules=[{id:'hours',name:'Hours',zone:'UTC',weeklyHours:Object.fromEntries(Array.from({length:7},(_,day)=>[day,[{start:0,end:1440}]])),dateOverrides:{}}];
 f.ledger.saveSettings({availabilitySchedules:schedules});const type=f.ledger.settings().meetingTypes[0];type.teamScheduling.hosts.forEach(h=>h.scheduleId='hours');await f.save(type);assert.throws(()=>f.ledger.saveSettings({availabilitySchedules:[]}),/schedule is missing/);
 let entered,release;const reached=new Promise(r=>entered=r),gate=new Promise(r=>release=r),read=f.google.freeBusy;f.google.freeBusy=async(...args)=>{entered();await gate;return read(...args);};const booking=f.book({start:at});await reached;const changed=f.ledger.meta('availabilitySchedules');changed[0].weeklyHours[day]=[];f.ledger.putMeta('availabilitySchedules',changed);release();assert.equal((await booking).status,409);assert.equal(f.events.size,0);
});
test('same primary identity under another grant and canonical calendar IDs share a local resource',()=>{
 assert.ok(hostsShareResource({accountId:'a',calendarId:'primary',email:'person@company.test'},{accountId:'b',calendarId:'person@company.test',email:'other@company.test'}));assert.ok(!hostsShareResource({accountId:'a',calendarId:'primary',email:'a@company.test'},{accountId:'b',calendarId:'primary',email:'b@company.test'}));
});
test('reconnect after uncertain insert recovers with the renewed grant, never reassigns or reinserts',async()=>{
 const f=await setup('all'),create=f.google.createEvent;f.google.createEvent=async(...args)=>{await create(...args);throw Error('unknown');};const result=await f.book();assert.equal(result.booking.status,'pending');const old=f.ledger.booking(result.booking.id).teamAssignment;await f.ledger.connect({accountId:'b',email:'b@company.test',tokens:{access_token:'b',refresh_token:'b',expires_at:Date.now()+86400000}});await f.ledger.reconcile(result.booking.id);assert.equal(f.ledger.booking(result.booking.id).status,'confirmed');assert.deepEqual(f.ledger.booking(result.booking.id).teamAssignment,old);assert.equal(f.events.size,1);
});
test('collective reminders require current host grants and nondeclined staff invitations',async()=>{
 const f=await setup('all',{reminder:true,reminderMinutes:[5]});f.ledger.env.RESEND_API_KEY='fake';f.ledger.env.MAIL_FROM='meet@company.test';const one=await f.book(),b=f.ledger.booking(one.booking.id),clock=Date.now;let sent=0;f.ledger.notify=async()=>{sent++;return {id:'mail'};};
 const event=f.events.get(b.eventId);event.attendees.find(a=>a.email==='b@company.test').responseStatus='declined';const job=JSON.parse(f.ledger.rows("SELECT body FROM live_jobs WHERE json_extract(body,'$.kind')='reminder'")[0].body);
 try{Date.now=()=>b.start-5*60000;await f.ledger.processJob(job);}finally{Date.now=clock;}
 assert.equal(sent,0);assert.equal(f.ledger.booking(b.id).calendarSyncStatus,'pending');assert.match(f.ledger.booking(b.id).lastError,/review/);assert.equal(JSON.parse(f.ledger.rows('SELECT body FROM live_jobs WHERE id=?',job.id)[0].body).pausedForCalendarSync,true);
});
test('collective synchronization does not confirm an old Google response after cohost reconnect',async()=>{
 const f=await setup('all'),one=await f.book(),get=f.google.getEvent;let entered,release;const reached=new Promise(r=>entered=r),gate=new Promise(r=>release=r);f.google.getEvent=async(...args)=>{entered();await gate;return get(...args);};const check=f.ledger.reconcileConfirmed(one.booking.id,{forNotification:true});await reached;const account=f.ledger.account('b');account.connectionVersion++;f.ledger.putAccount(account);release();assert.notEqual(await check,true);
});
test('external collective moves retain conservative holds and pause delivery until an explicit repair',async()=>{
 const f=await setup('all'),one=await f.book(),b=f.ledger.booking(one.booking.id),event=f.events.get(b.eventId),moved=b.start+3600000;event.start.dateTime=new Date(moved).toISOString();event.end.dateTime=new Date(moved+30*60000).toISOString();assert.notEqual(await f.ledger.reconcileConfirmed(b.id,{forNotification:true}),true);const changed=f.ledger.booking(b.id);assert.equal(changed.start,moved);assert.equal(changed.calendarSyncStatus,'pending');assert.deepEqual(changed.teamReviewHold,{start:b.start,end:moved+30*60000});assert.notEqual(await f.ledger.reconcileConfirmed(b.id,{forNotification:true}),true);assert.equal((await f.book({start:b.start})).status,409);assert.equal((await f.book({start:moved})).status,409);const repair=await f.ledger.reschedule(b.id,one.managementToken,moved+3600000,crypto.randomUUID());assert.equal(repair.booking?.status,'confirmed',repair.error||'Repair did not return a booking');assert.equal(f.ledger.booking(repair.booking.id).teamReviewHold,undefined);assert.equal(f.ledger.booking(b.id).status,'cancelled');
});
test('explicit conflict selections must belong to the host account calendar discovery',async()=>{
 const f=await setup(),type=f.ledger.settings().meetingTypes[0];type.teamScheduling.hosts[0].conflictCalendarIds=['unlisted'];await assert.rejects(()=>f.save(type),/conflict calendars from this connected account/);assert.equal(f.ledger.settings().meetingTypes[0].teamScheduling.hosts[0].conflictCalendarIds,null);
});
test('an old token refresh cannot replace a newly reconnected grant',async()=>{
 const f=await setup(),a=f.ledger.account('a');await f.ledger.connect({accountId:'a',email:a.email,tokens:{refresh_token:'old',expires_at:1}});let entered,release;const reached=new Promise(r=>entered=r),gate=new Promise(r=>release=r);f.google.refreshTokens=async()=>{entered();await gate;return {access_token:'stale',expires_at:Date.now()+86400000};};const pending=f.ledger.access('a');await reached;await f.ledger.connect({accountId:'a',email:a.email,tokens:{access_token:'new',refresh_token:'new',expires_at:Date.now()+86400000}});const current=f.ledger.account('a');release();await assert.rejects(pending,/authorization changed/);assert.equal(f.ledger.account('a').grant,current.grant);assert.equal(await f.ledger.access('a'),'new');
});
test('a completed reschedule replays its accepted assignment after later link policy changes',async()=>{
 const f=await setup('choose'),one=await f.book({teamHostId:'b'}),key=crypto.randomUUID(),at=one.booking.start+3600000,moved=await f.ledger.reschedule(one.booking.id,one.managementToken,at,key);assert.equal(moved.booking.status,'confirmed');const type=f.ledger.settings().meetingTypes[0];type.teamScheduling=null;await f.save(type);const replay=await f.ledger.reschedule(one.booking.id,one.managementToken,at,key);assert.equal(replay.booking.id,moved.booking.id,JSON.stringify(replay));assert.deepEqual(replay.booking.assignedHosts,[{id:'b',name:'B'}]);
});
test('collective uses one organizer grid while cohost hours need containment, not matching anchors',async()=>{
 const f=await setup('all'),now=Date.UTC(2026,10,12,0),base={...f.ledger.type('intro'),slotInterval:30,duration:30},hosts=f.ledger.teamHosts(base);hosts[0].policy={...base,teamScheduling:null,startHour:9,endHour:17,weeklyHours:null};hosts[1].policy={...base,teamScheduling:null,weeklyHours:Object.fromEntries(Array.from({length:7},(_,day)=>[day,[{start:9*60+15,end:17*60+15}]]))};const slots=f.ledger.teamSlots(base,hosts,{a:[],b:[]},Date.UTC(2026,10,12,9),Date.UTC(2026,10,12,18),{now});assert.equal(slots[0].start,Date.UTC(2026,10,12,9,30));assert.deepEqual(slots[0].hostIds,['a','b']);assert.equal(slots.at(-1).end,Date.UTC(2026,10,12,17));
 hosts[1].policy={...hosts[1].policy,weeklyHours:Object.fromEntries(Array.from({length:7},(_,day)=>[day,[{start:9*60+17,end:17*60+17}]]))};assert.equal(f.ledger.teamSlots(base,hosts,{a:[],b:[]},Date.UTC(2026,10,12,9),Date.UTC(2026,10,12,18),{now})[0].start,Date.UTC(2026,10,12,9,30));
});
test('collective containment handles offset timezones and elapsed time across DST transitions',async()=>{
 const f=await setup('all'),now=Date.UTC(2026,10,12),base={...f.ledger.type('intro'),slotInterval:45,duration:30},hosts=f.ledger.teamHosts(base);hosts[0].policy={...base,teamScheduling:null,startHour:9,endHour:17,weeklyHours:null};hosts[1].policy={...base,teamScheduling:null,zone:'Asia/Kathmandu',weeklyHours:Object.fromEntries(Array.from({length:7},(_,day)=>[day,[{start:14*60+50,end:22*60+50}]]))};const slots=f.ledger.teamSlots(base,hosts,{a:[],b:[]},Date.UTC(2026,10,12,9),Date.UTC(2026,10,12,18),{now});assert.equal(slots[0].start,Date.UTC(2026,10,12,9,45));
 const hours=(start,end)=>Object.fromEntries(Array.from({length:7},(_,day)=>[day,[{start,end}]])),fall=Date.UTC(2026,10,1,5,30),spring=Date.UTC(2026,2,8,6,30),policy={...config,zone:'America/New_York',duration:60};
 assert.equal(workingWindowChecker({...policy,weeklyHours:hours(60,120)},Date.UTC(2026,10,1))(fall,fall+3600000),true);assert.equal(workingWindowChecker({...policy,weeklyHours:hours(90,120)},Date.UTC(2026,10,1))(fall,fall+3600000),false);
 assert.equal(workingWindowChecker({...policy,weeklyHours:hours(60,240)},Date.UTC(2026,2,8))(spring,spring+3600000),true);assert.equal(workingWindowChecker({...policy,weeklyHours:hours(60,120)},Date.UTC(2026,2,8))(spring,spring+3600000),false);
});
