import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {BookingLedger} from '../src/ledger.js';
import {DEFAULT,workingWindowChecker} from '../public/policy.js';
import {intakeRevision} from '../public/intake.js';
import {normalizeTeamScheduling,hostsShareResource} from '../public/team-policy.js';
const config={...DEFAULT,zone:'UTC',notice:0,horizon:5,startHour:0,endHour:24,days:[0,1,2,3,4,5,6],buffer:0,reminder:false};
// Keep admission and reschedule fixtures inside a UTC workday.
test.beforeEach(t=>t.mock.timers.enable({apis:['Date'],now:Date.UTC(2030,0,7,9)}));
const start=()=>Math.ceil((Date.now()+3*3600000)/900000)*900000;
async function setup(mode='any',extra={}){
 const db=new DatabaseSync(':memory:'),storage={sql:{exec(q,...args){const rows=db.prepare(q).all(...args);return {toArray:()=>rows};}},setAlarm:async()=>{},transactionSync(fn){db.exec('BEGIN');try{const value=fn();db.exec('COMMIT');return value;}catch(e){db.exec('ROLLBACK');throw e;}}};
 const events=new Map(),busy={a:[],b:[]},calls=[];
 const google={refreshTokens:async()=>{throw Error('unexpected refresh');},listCalendars:async()=>[{id:'primary',accessRole:'owner'},{id:'shared',accessRole:'writer'}],freeBusy:async(token,input)=>{calls.push({token,...input});return busy[token];},getEvent:async(_,{eventId})=>events.get(eventId)??null,createEvent:async(token,{eventId,event,calendarId})=>{const result={...event,id:eventId,etag:'v1',status:'confirmed'};events.set(eventId,result);return result;},deleteEvent:async(_,{eventId})=>events.delete(eventId)};
 const ledger=new BookingLedger({storage},{TOKEN_ENCRYPTION_KEY:Buffer.alloc(32,9).toString('base64'),PUBLIC_ORIGIN:'https://test.invalid'},{google});ledger.init({id:'profile',name:'Profile'});
 for(const accountId of ['a','b']){await ledger.connect({accountId,email:accountId+'@company.test',tokens:{access_token:accountId,refresh_token:accountId,expires_at:Date.now()+86400000}});}
 await ledger.configureCalendars({accounts:['a','b'].map(id=>({id,destinationCalendarId:'primary',conflictCalendarIds:['primary']}))});
 const type={...config,id:'intro',slug:'intro',published:true,accountId:'a',calendarId:'primary',teamScheduling:mode==='single'?null:{mode,hosts:['a','b'].map(id=>({id,name:id.toUpperCase(),accountId:id}))},...extra};
 const save=async(value)=>{const verifiedDestinations=await ledger.verifyMeetingDestinations({meetingTypes:[value]},ledger.settings());return ledger.saveSettings({meetingTypes:[value]},{verifiedDestinations});};
 await save(type);
 const book=async(data={})=>{const type=ledger.type('intro');return ledger.reserve('intro',{start:start(),name:'Guest',email:'guest@company.test',idempotencyKey:crypto.randomUUID(),intakeRevision:await intakeRevision(type),teamRevision:type.teamScheduling?await ledger.teamRevision(type):undefined,...data});};
 return {ledger,google,events,busy,calls,book,save,storage,type};
}

import {normalizeLinkAccess,linkAccessState} from '../public/link-access.js';
import {validateConfig} from '../public/policy.js';
import {normalizeSettingsPatch} from '../src/settings.js';
import {projectWorkspaceSettings} from '../src/workspaces.js';
test('strict link settings and exact expiration boundary',()=>{
 assert.deepEqual(normalizeLinkAccess({}),{singleUse:false,expiresAt:null});
 for(const expiresAt of ['1',true,-1,NaN,Infinity,1.5,8640000000000001])assert.throws(()=>validateConfig({...DEFAULT,expiresAt}));
 for(const singleUse of [null,'true',0,1])assert.throws(()=>validateConfig({...DEFAULT,singleUse}));
 assert.equal(linkAccessState({expiresAt:100},false,99).state,'open');assert.equal(linkAccessState({expiresAt:100},false,100).state,'expired');
 assert.deepEqual(linkAccessState({singleUse:false},true),{state:'open',used:true,expiresAt:null});assert.equal(linkAccessState({singleUse:true,expiresAt:100},true,100).state,'expired');
});
test('concurrent single-use requests spend once and cancellation does not reopen',async()=>{
 const f=await setup('all',{singleUse:true}),out=await Promise.all([f.book(),f.book({start:start()+3*3600000})]);
 const first=out.find(r=>r.booking),denied=out.find(r=>r.code==='link_used');assert.ok(first);assert.equal(denied.status,410);assert.equal(f.ledger.rows('SELECT id FROM live_bookings').length,1);
 await f.ledger.cancel(first.booking.id,first.managementToken);assert.equal((await f.ledger.availability('intro')).code,'link_used');assert.equal(f.ledger.settings().linkAccess.intro.used,true);
});
test('accepted same-key retry survives expiration and consumption without another event',async()=>{
 const f=await setup('all',{singleUse:true,expiresAt:Date.now()+60000}),key=crypto.randomUUID(),at=start(),data={start:at,idempotencyKey:key,teamRevision:await f.ledger.teamRevision(f.ledger.type('intro'))};
 const first=await f.book(data);await f.save({...f.type,expiresAt:0});const replay=await f.book(data);assert.equal(replay.booking.id,first.booking.id);assert.equal(f.events.size,1);assert.equal((await f.ledger.availability('intro')).code,'link_expired');assert.equal((await f.book({idempotencyKey:key,start:at+3*3600000})).code,'idempotency_conflict');
});
test('validation/provider-read failures do not spend; accepted unknown insert does',async()=>{
 const f=await setup('all',{singleUse:true});assert.ok((await f.book({name:''})).error);assert.equal(f.ledger.linkUsed('intro'),false);
 const read=f.google.freeBusy;f.google.freeBusy=async()=>{throw Error('provider unavailable');};assert.equal((await f.book()).status,503);assert.equal(f.ledger.linkUsed('intro'),false);f.google.freeBusy=read;
 f.google.createEvent=async()=>{throw Error('unknown insert');};const first=await f.book();assert.equal(first.booking.status,'pending');assert.equal(f.ledger.linkUsed('intro'),true);assert.equal((await f.book({start:start()+3*3600000})).code,'link_used');
});
async function crossExpiry(f,operation){const realNow=Date.now,read=f.google.freeBusy,expiry=f.type.expiresAt;let entered,release;const reached=new Promise(r=>entered=r),gate=new Promise(r=>release=r);f.google.freeBusy=async(...args)=>{entered();await gate;return read(...args);};let pending;try{pending=operation();await reached;Date.now=()=>expiry;release();return await pending;}finally{release();Date.now=realNow;await pending?.catch(()=>{});}}
test('expiration crossing a provider await refuses a new hold without consuming',async()=>{
 const f=await setup('all',{singleUse:true,expiresAt:Date.now()+60000});assert.equal((await crossExpiry(f,()=>f.book())).code,'link_expired');assert.equal(f.ledger.linkUsed('intro'),false);assert.equal(f.ledger.rows('SELECT id FROM live_bookings').length,0);
});
test('availability rechecks expiration after provider work and before exposing cached times',async()=>{
 const f=await setup('all',{expiresAt:Date.now()+60000});assert.equal((await crossExpiry(f,()=>f.ledger.availability('intro'))).code,'link_expired');const realNow=Date.now;try{Date.now=()=>f.type.expiresAt;assert.equal((await f.ledger.availability('intro')).code,'link_expired');}finally{Date.now=realNow;}
});
test('accepted guest management and rescheduling work after link expiration and consumption',async()=>{
 const f=await setup('all',{singleUse:true}),first=await f.book();await f.save({...f.type,expiresAt:0});const page=await f.ledger.rescheduleAvailability(first.booking.id,first.managementToken);assert.ok(page.slots.length,JSON.stringify(page));const moved=await f.ledger.reschedule(first.booking.id,first.managementToken,first.booking.start+3*3600000,crypto.randomUUID());assert.equal(moved.booking.status,'confirmed',JSON.stringify(moved));assert.equal(f.events.size,1);assert.equal((await f.ledger.cancel(moved.booking.id,moved.managementToken)).booking.status,'cancelled');
});
test('accepted approval remains decidable after expiration',async()=>{
 const f=await setup('all',{singleUse:true,requiresApproval:true}),first=await f.book();assert.equal(first.booking.status,'awaiting_approval');await f.save({...f.type,expiresAt:0});const approved=await f.ledger.decideBooking(first.booking.id,{action:'approve',expectedVersion:first.booking.version,key:crypto.randomUUID()});assert.equal(approved.booking.status,'confirmed');assert.equal(f.ledger.linkUsed('intro'),true);
});
test('tombstone survives toggles, cleanup, restart and old settings clients; lower roles see no usage',async()=>{
 const f=await setup('all',{singleUse:true}),first=await f.book();await f.ledger.cancel(first.booking.id,first.managementToken);await f.save({...f.type,singleUse:false});assert.equal((await f.book({start:start()+3*3600000})).booking.status,'confirmed');await f.save(f.type);assert.equal((await f.book({start:start()+6*3600000})).code,'link_used');
 const b=f.ledger.booking(first.booking.id);b.start=Date.now()-100*86400000;b.end=b.start+1800000;f.ledger.putBooking(b);await f.ledger.maintain();assert.equal(f.ledger.booking(first.booking.id),null);
 const restarted=new BookingLedger({storage:f.storage},f.ledger.env,{google:f.google});assert.equal(restarted.settings().linkAccess.intro.state,'used');const current=restarted.settings(),old={...current.meetingTypes[0]};delete old.singleUse;delete old.expiresAt;const normalized=normalizeSettingsPatch(current,{meetingTypes:[old]});assert.equal(normalized.patch.meetingTypes[0].singleUse,true);assert.equal(normalized.patch.meetingTypes[0].expiresAt,null);assert.equal(projectWorkspaceSettings(current,{personal:false,hostId:'profile',role:'member',capabilities:{manageSettings:false}}).linkAccess,undefined);
});
test('atomic insert failure rolls back single-use tombstone with the booking',async()=>{
 const f=await setup('all',{singleUse:true}),exec=f.storage.sql.exec;let armed=true;f.storage.sql.exec=(q,...args)=>{if(armed&&q.startsWith('INSERT INTO live_bookings')){armed=false;throw Error('fixture insert failure');}return exec(q,...args);};await assert.rejects(()=>f.book(),/fixture insert failure/);assert.equal(f.ledger.linkUsed('intro'),false);assert.equal(f.ledger.rows('SELECT id FROM live_bookings').length,0);assert.equal((await f.book()).booking.status,'confirmed');
});
test('fresh meeting identifiers get a fresh allowance and removed IDs retain tombstones',async()=>{
 const f=await setup('all',{singleUse:true}),first=await f.book();await f.ledger.cancel(first.booking.id,first.managementToken);await f.save({...f.type,id:'second'});assert.equal(f.ledger.settings().linkAccess.second.used,false);assert.equal((await f.book()).booking.status,'confirmed');await f.save(f.type);assert.equal(f.ledger.settings().linkAccess.intro.state,'used');
});

test('single-host availability rechecks expiry and closed links make no provider read',async()=>{
 const f=await setup('single',{expiresAt:Date.now()+60000});assert.equal((await crossExpiry(f,()=>f.ledger.availability('intro'))).code,'link_expired');await f.save({...f.type,expiresAt:0});const before=f.calls.length;assert.equal((await f.ledger.availability('intro')).code,'link_expired');assert.equal((await f.book()).code,'link_expired');assert.equal(f.calls.length,before);
});
test('ordinary bookings before enabling single-use do not consume the future allowance',async()=>{
 const f=await setup('single'),first=await f.book();await f.ledger.cancel(first.booking.id,first.managementToken);await f.save({...f.type,singleUse:true});assert.equal(f.ledger.linkUsed('intro'),false);assert.equal((await f.book()).booking.status,'confirmed');assert.equal((await f.book({start:start()+3*3600000})).code,'link_used');
});
test('approval rejection, approval expiry and definitive provider failure never reset a spent link',async()=>{
 const rejected=await setup('all',{singleUse:true,requiresApproval:true}),r=await rejected.book();await rejected.ledger.decideBooking(r.booking.id,{action:'reject',expectedVersion:r.booking.version,key:crypto.randomUUID()});assert.equal(rejected.ledger.settings().linkAccess.intro.state,'used');
 const expired=await setup('all',{singleUse:true,requiresApproval:true}),e=await expired.book(),realNow=Date.now;try{Date.now=()=>e.booking.approvalExpiresAt;expired.ledger.expireApprovals();assert.equal(expired.ledger.booking(e.booking.id).status,'expired');assert.equal(expired.ledger.settings().linkAccess.intro.state,'used');}finally{Date.now=realNow;}
 const failed=await setup('all',{singleUse:true});failed.google.createEvent=async()=>{throw Object.assign(Error('rejected'),{status:400,retryable:false});};assert.equal((await failed.book()).booking.status,'failed');assert.equal((await failed.book({start:start()+3*3600000})).code,'link_used');
});
test('an uncertain accepted insert recovers by deterministic GET after link expiration',async()=>{
 const f=await setup('all',{singleUse:true}),key=crypto.randomUUID(),body={idempotencyKey:key,start:start(),teamRevision:await f.ledger.teamRevision(f.ledger.type('intro'))},create=f.google.createEvent;
 f.google.createEvent=async(...args)=>{await create(...args);throw Error('lost acknowledgement');};const first=await f.book(body);assert.equal(first.booking.status,'pending');await f.save({...f.type,expiresAt:0});const retry=await f.book(body);assert.equal(retry.booking.id,first.booking.id);await f.ledger.reconcile(first.booking.id);assert.equal((await f.ledger.manage(first.booking.id,first.managementToken)).booking.status,'confirmed');assert.equal(f.events.size,1);
});
test('single and team availability cannot return open times after another request spends the allowance',async()=>{
 for(const mode of ['single','all']){const f=await setup(mode,{singleUse:true}),read=f.google.freeBusy;let entered,release,armed=true;const reached=new Promise(r=>entered=r),gate=new Promise(r=>release=r);f.google.freeBusy=async(...args)=>{if(armed){armed=false;entered();await gate;}return read(...args);};const pending=f.ledger.availability('intro');try{await reached;assert.equal((await f.book()).booking.status,'confirmed');release();assert.equal((await pending).code,'link_used');}finally{release();await pending.catch(()=>{});}}
});
