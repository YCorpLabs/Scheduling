import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {BookingLedger} from '../src/ledger.js';
import {DEFAULT,workingWindowChecker} from '../public/policy.js';
import {intakeRevision} from '../public/intake.js';
import {normalizeTeamScheduling,hostsShareResource} from '../public/team-policy.js';
const config={...DEFAULT,zone:'UTC',notice:0,horizon:5,startHour:0,endHour:24,days:[0,1,2,3,4,5,6],buffer:0,reminder:false};
// Keep long reschedule fixtures away from UTC midnight regardless of when CI runs.
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

import {validDuration,normalizeDurationOptions,allowedDurations,selectDuration} from '../public/durations.js';
import {validateConfig,policySlots} from '../public/policy.js';
import {HostedSettings} from '../src/settings.js';
test('duration validation is strict and options preserve an explicit default and order',()=>{
 for(const duration of [5,17,37,480])assert.equal(validateConfig({...DEFAULT,duration}).duration,duration);
 for(const duration of [null,'30',4,481,30.5,NaN,Infinity,true]){assert.equal(validDuration(duration),false);assert.throws(()=>validateConfig({...DEFAULT,duration}));}
 for(const options of [[],[30,30],[15],[30,'60'],[30,4],[30,481],[5,15,30,60,90],false,{},'30'])assert.throws(()=>normalizeDurationOptions(options,30));
 assert.deepEqual(normalizeDurationOptions([60,30,17],30),[60,30,17]);assert.equal(normalizeDurationOptions(null,37),null);assert.deepEqual(allowedDurations({duration:37}),[37]);assert.equal(selectDuration({duration:30,durationOptions:[30,60]},60),60);for(const value of [null,'60',45])assert.throws(()=>selectDuration({duration:30,durationOptions:[30,60]},value));
 const policy={...config,duration:120,startHour:9,endHour:10};assert.equal(policySlots(policy,Date.now()).length,0);
});
test('single and all team availability honor chosen lengths and keep full options',async()=>{
 for(const mode of ['single','all']){const f=await setup('all',{duration:30,durationOptions:[17,30,60],...(mode==='single'?{teamScheduling:null}:{})}),at=start();f.busy.a=[{start:at+20*60000,end:at+30*60000}];const short=await f.ledger.availability('intro',{from:at,to:at+3600000,duration:17}),long=await f.ledger.availability('intro',{from:at,to:at+3600000,duration:60});assert.equal(short.config.duration,17);assert.deepEqual(short.config.durationOptions,[17,30,60]);assert.equal(short.slots.find(s=>s.start===at).end,at+17*60000);assert.ok(!long.slots.some(s=>s.start===at));await assert.rejects(()=>f.ledger.availability('intro',{duration:45}));}
});
test('custom chosen duration binds provider end, durable replay and changed-length conflicts',async()=>{
 const f=await setup('all',{duration:30,durationOptions:[17,30,60]}),key=crypto.randomUUID(),first=await f.book({duration:17,idempotencyKey:key});assert.equal(first.booking.status,'confirmed',JSON.stringify(first));assert.equal(first.booking.duration,17);assert.equal(first.booking.end-first.booking.start,17*60000);assert.equal(f.ledger.booking(first.booking.id).config.duration,17);assert.equal(+new Date([...f.events.values()][0].end.dateTime)-first.booking.start,17*60000);assert.equal((await f.book({duration:17,idempotencyKey:key})).booking.id,first.booking.id);assert.deepEqual(Object.fromEntries(Object.entries(await f.book({duration:60,idempotencyKey:key})).filter(([k])=>['status','code'].includes(k))),{status:409,code:'idempotency_conflict'});await f.save({...f.type,duration:60,durationOptions:[17,60]});assert.equal((await f.book({idempotencyKey:key,teamRevision:f.ledger.booking(first.booking.id).teamRevision})).booking.id,first.booking.id);
});
test('approval and reschedule retain accepted nondefault length after option removal',async()=>{
 for(const mode of ['single','all']){const f=await setup('all',{duration:30,durationOptions:[30,47],requiresApproval:true,...(mode==='single'?{teamScheduling:null}:{})}),first=await f.book({duration:47});assert.equal(first.booking.status,'awaiting_approval');await f.save({...f.ledger.settings().meetingTypes[0],duration:30,durationOptions:null});const approved=await f.ledger.decideBooking(first.booking.id,{action:'approve',expectedVersion:first.booking.version,key:crypto.randomUUID()});assert.equal(approved.booking.status,'confirmed',JSON.stringify(approved));assert.equal(approved.booking.end-approved.booking.start,47*60000);const moved=await f.ledger.reschedule(first.booking.id,first.managementToken,first.booking.start+3*3600000,crypto.randomUUID());assert.equal(moved.booking.status,'awaiting_approval',JSON.stringify(moved));assert.equal(moved.booking.end-moved.booking.start,47*60000);assert.equal(f.ledger.booking(moved.booking.id).config.duration,47);}
});
test('selected length consumes actual booked-minute quota and preserves old options for old clients',async()=>{
 const f=await setup('all',{duration:30,durationOptions:[17,30,60],dailyBookedMinutesLimit:60}),one=await f.book({duration:17,start:Math.floor(Date.now()/86400000)*86400000+86400000+9*3600000});assert.equal(one.booking.status,'confirmed');const long=await f.book({duration:60,start:one.booking.start+3*3600000});assert.equal(long.status,409);const small=await f.book({duration:30,start:one.booking.start+4*3600000});assert.equal(small.booking.status,'confirmed');const service=new HostedSettings(f.ledger,f.storage),before=await service.read(),type={...before.meetingTypes[0]};delete type.durationOptions;const after=await service.apply({meetingTypes:[type]},before.revision);assert.deepEqual(after.settings.meetingTypes[0].durationOptions,[17,30,60]);
});
test('options removed during provider read cannot admit a stale selected duration',async()=>{
 const f=await setup('all',{duration:30,durationOptions:[30,60]}),at=start(),page=await f.ledger.availability('intro',{duration:60}),read=f.google.freeBusy;let entered,release;const reached=new Promise(r=>entered=r),gate=new Promise(r=>release=r);f.google.freeBusy=async(...args)=>{entered();await gate;return read(...args);};const pending=f.ledger.reserve('intro',{duration:60,start:at,name:'Guest',email:'guest@company.test',key:crypto.randomUUID(),intakeRevision:await intakeRevision(f.ledger.type('intro')),teamRevision:page.config.team.revision});await reached;await f.save({...f.type,durationOptions:null});release();assert.equal((await pending).status,409);assert.equal(f.events.size,0);
});

test('token-bound retired duration availability retains assigned host and rejects changed authority',async()=>{
 const f=await setup('choose',{duration:30,durationOptions:[30,47]}),first=await f.book({duration:47,teamHostId:'a'});assert.equal(first.booking.status,'confirmed');await f.save({...f.type,durationOptions:null});await assert.rejects(()=>f.ledger.availability('intro',{duration:47}));assert.equal((await f.ledger.rescheduleAvailability(first.booking.id,'invalid-token')).status,404);const page=await f.ledger.rescheduleAvailability(first.booking.id,first.managementToken);assert.equal(page.config.duration,47);assert.equal(page.config.durationOptions,null);assert.ok(page.slots.length);assert.ok(page.slots.every(s=>s.end-s.start===47*60000&&JSON.stringify(s.hostIds)==='["a"]'));
 const changed={...f.ledger.settings().meetingTypes[0]};changed.teamScheduling.hosts[0]={...changed.teamScheduling.hosts[0],accountId:'b'};changed.teamScheduling.hosts[1]={...changed.teamScheduling.hosts[1],accountId:'a'};await f.save(changed);assert.equal((await f.ledger.rescheduleAvailability(first.booking.id,first.managementToken)).status,409);
});
test('management availability cannot return a snapshot cancelled during provider reads',async()=>{
 const f=await setup('all',{duration:37}),first=await f.book(),read=f.google.freeBusy;f.ledger.availabilityCache.clear();let entered,release;const reached=new Promise(r=>entered=r),gate=new Promise(r=>release=r);f.google.freeBusy=async(...args)=>{entered();await gate;return read(...args);};const pending=f.ledger.rescheduleAvailability(first.booking.id,first.managementToken);await reached;await f.ledger.cancel(first.booking.id,first.managementToken);release();assert.equal((await pending).status,409);
});

test('management availability refuses a replacement started during provider reads',async()=>{const f=await setup('all',{duration:37}),first=await f.book(),read=f.google.freeBusy;f.ledger.availabilityCache.clear();let entered,release;const reached=new Promise(r=>entered=r),gate=new Promise(r=>release=r);f.google.freeBusy=async(...args)=>{entered();await gate;return read(...args);};const pending=f.ledger.rescheduleAvailability(first.booking.id,first.managementToken);await reached;f.ledger.putBooking({...f.ledger.booking(first.booking.id),replacementKey:'in-flight-replacement'});release();assert.equal((await pending).status,409);});
