import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {BookingLedger} from '../src/ledger.js';
import {DEFAULT,workingWindowChecker} from '../public/policy.js';
import {intakeRevision} from '../public/intake.js';
import {normalizeTeamScheduling,hostsShareResource} from '../public/team-policy.js';
const config={...DEFAULT,zone:'UTC',notice:0,horizon:5,startHour:0,endHour:24,days:[0,1,2,3,4,5,6],buffer:0,reminder:false};
// Keep member scheduling scenarios away from UTC midnight.
test.beforeEach(t=>t.mock.timers.enable({apis:['Date'],now:Date.UTC(2030,0,7,9)}));
const start=()=>Math.ceil((Date.now()+3*3600000)/900000)*900000;
async function setup(mode='any',extra={}){
 const db=new DatabaseSync(':memory:'),storage={sql:{exec(q,...args){const rows=db.prepare(q).all(...args);return {toArray:()=>rows};}},setAlarm:async()=>{},transactionSync(fn){db.exec('BEGIN');try{const value=fn();db.exec('COMMIT');return value;}catch(e){db.exec('ROLLBACK');throw e;}}};
 const events=new Map(),busy={a:[],b:[]},calls=[];
 const google={refreshTokens:async()=>{throw Error('unexpected refresh');},listCalendars:async()=>[{id:'primary',accessRole:'owner'},{id:'shared',accessRole:'writer'}],freeBusy:async(token,input)=>{calls.push({token,...input});return busy[token];},getEvent:async(_,{eventId})=>events.get(eventId)??null,createEvent:async(token,{eventId,event,calendarId})=>{const result={...event,id:eventId,etag:'v1',status:'confirmed'};events.set(eventId,result);return result;},deleteEvent:async(_,{eventId})=>events.delete(eventId)};
 const members=['a','b'].map((id,i)=>({id:'h_'+id.repeat(24),email:id+'@company.test',role:'member',joinedAt:100+i})),record={members},env={AUTH:{getByName(){return {get:async()=>structuredClone(record)};}},TOKEN_ENCRYPTION_KEY:Buffer.alloc(32,9).toString('base64'),PUBLIC_ORIGIN:'https://test.invalid'},ledger=new BookingLedger({storage},env,{google});ledger.init({id:'h_'+'w'.repeat(24),name:'Profile',workspaceKind:'company'});
 for(const accountId of ['a','b']){await ledger.connect({accountId,email:accountId+'@company.test',tokens:{access_token:accountId,refresh_token:accountId,expires_at:Date.now()+86400000}});}
 await ledger.configureCalendars({accounts:['a','b'].map(id=>({id,destinationCalendarId:'primary',conflictCalendarIds:['primary']}))});
 const type={...config,id:'intro',slug:'intro',published:true,accountId:'a',calendarId:'primary',teamScheduling:{mode,hosts:['a','b'].map(id=>({id,name:id.toUpperCase(),accountId:id}))},...extra};
 const save=async(value)=>{const verifiedDestinations=await ledger.verifyMeetingDestinations({meetingTypes:[value]},ledger.settings());return ledger.saveSettings({meetingTypes:[value]},{verifiedDestinations});};
 await save(type);for(const [i,id] of ['a','b'].entries()){const account=ledger.account(id);ledger.putAccount({...account,ownerMemberId:members[i].id,ownerJoinedAt:members[i].joinedAt,ownerFenceEpoch:0});}await ledger.refreshMemberEligibility();
 const book=async(data={})=>{const type=ledger.type('intro');return ledger.reserve('intro',{start:start(),name:'Guest',email:'guest@company.test',idempotencyKey:crypto.randomUUID(),intakeRevision:await intakeRevision(type),teamRevision:await ledger.teamRevision(type),...data});};
 return {ledger,google,events,busy,calls,book,save,storage,type,record,members,member:i=>({...members[i],workspaceId:ledger.hostId()})};
}

test('own calendar projection and writes never expose or mutate another contribution',async()=>{
 const f=await setup(),m=f.member(0),page=await f.ledger.ownCalendar(m);
 assert.equal(page.account.id,'a');assert.ok(!JSON.stringify(page).includes('b@company.test'));assert.ok(!JSON.stringify(page).includes('refresh_token'));assert.ok(!JSON.stringify(page).includes('grant'));
 await assert.rejects(()=>f.ledger.configureOwnCalendar(m,{accountId:'b',calendarId:'primary',conflictCalendarIds:[],schedule:page.schedule,expectedRevision:page.revision}),e=>e.status===403);
 const before=f.ledger.account('b'),updated=await f.ledger.configureOwnCalendar(m,{accountId:'a',calendarId:'shared',conflictCalendarIds:['primary'],schedule:{zone:'UTC',weeklyHours:{0:[],1:[{start:600,end:720}],2:[],3:[],4:[],5:[],6:[]},dateOverrides:{}},expectedRevision:page.revision});
 assert.equal(updated.account.calendarId,'shared');assert.deepEqual(f.ledger.account('b'),before);assert.equal(updated.schedule.zone,'UTC');
 await assert.rejects(()=>f.ledger.configureOwnCalendar(m,{accountId:'a',calendarId:'primary',conflictCalendarIds:[],schedule:page.schedule,expectedRevision:page.revision}),e=>e.status===409);
 await assert.rejects(()=>f.ledger.configureOwnCalendar(m,{...updated,patch:{profile:{name:'bad'}}}),e=>e.status===400);
});
test('removal and viewer downgrade stop fresh assignments while remaining any host stays usable',async()=>{
 for(const action of ['remove','viewer']){const f=await setup(),at=start();f.ledger.fenceMemberCalendar(f.members[0].id);if(action==='remove')f.record.members.shift();else f.record.members[0].role='viewer';const page=await f.ledger.availability('intro',{from:at,to:at+3600000});assert.ok(!page.error,JSON.stringify(page));assert.deepEqual(page.slots.find(s=>s.start===at).hostIds,['b']);assert.equal((await f.book()).booking.assignedHosts[0].id,'b');}
});
test('membership loss during fresh freebusy prevents a collective hold even before AUTH CAS',async()=>{
 const f=await setup('all'),read=f.google.freeBusy;let entered,release;const reached=new Promise(r=>entered=r),gate=new Promise(r=>release=r);f.google.freeBusy=async(...args)=>{entered();await gate;return read(...args);};const booking=f.book();await reached;f.ledger.fenceMemberCalendar(f.members[0].id);release();const outcome=await booking;assert.ok(outcome.error);assert.equal(f.ledger.rows('SELECT id FROM live_bookings').length,0);assert.equal(f.events.size,0);
});
test('authoritative role loss without a cached local mutation fails closed at admission',async()=>{
 const f=await setup('all'),read=f.google.freeBusy;let entered,release;const reached=new Promise(r=>entered=r),gate=new Promise(r=>release=r);f.google.freeBusy=async(...args)=>{entered();await gate;return read(...args);};const booking=f.book();await reached;f.record.members[1].role='viewer';release();assert.ok((await booking).error);assert.equal(f.events.size,0);
});
test('accepted collective replay and cancellation remain possible after member removal',async()=>{
 const f=await setup('all'),key=crypto.randomUUID(),teamRevision=await f.ledger.teamRevision(f.ledger.type('intro')),first=await f.book({idempotencyKey:key,teamRevision});assert.equal(first.booking.status,'confirmed');f.ledger.fenceMemberCalendar(f.members[0].id);f.record.members.shift();const replay=await f.book({idempotencyKey:key,teamRevision});assert.ok(replay.booking,JSON.stringify(replay));assert.equal(replay.booking.id,first.booking.id);assert.equal((await f.ledger.cancel(first.booking.id,first.managementToken)).booking.status,'cancelled');assert.equal(f.events.size,0);
});
test('own consent withdrawal removes the local grant despite accepted bookings and preserves holds',async()=>{
 const f=await setup('all'),first=await f.book();assert.equal(first.booking.status,'confirmed');const owner=f.member(0);f.record.members.shift();const result=f.ledger.withdrawMemberCalendar({id:owner.id,email:owner.email},'a');assert.equal(result.withdrawn,true);assert.equal(result.acceptedBookingsNeedReview,1);assert.equal(f.ledger.account('a').grant,undefined);assert.equal(f.ledger.account('a').connected,false);assert.equal(f.events.size,1);assert.equal(f.ledger.booking(first.booking.id).status,'confirmed');assert.equal(f.ledger.booking(first.booking.id).calendarSyncStatus,'needs_review');assert.ok(f.ledger.localBusy().length);assert.throws(()=>f.ledger.withdrawMemberCalendar({id:owner.id,email:owner.email},'b'),e=>e.status===403);
 await assert.rejects(()=>f.ledger.connect({accountId:'a',email:owner.email,tokens:{access_token:'a',refresh_token:'a'}}),/owner must reconnect/);
});
test('fenced OAuth cannot reconnect; fresh owner reconnect preserves accepted snapshots',async()=>{
 const f=await setup('all'),first=await f.book(),member=f.member(0),grant={accountId:'a',email:member.email,tokens:{access_token:'a',refresh_token:'a',expires_at:Date.now()+86400000},ownerMember:{...member,fenceEpoch:0}};
 f.ledger.fenceMemberCalendar(member.id);await assert.rejects(()=>f.ledger.connect(grant),e=>e.status===409);await f.ledger.connect({...grant,ownerMember:{...member,fenceEpoch:1}});assert.equal(f.ledger.account('a').ownerMemberId,member.id);assert.equal(f.ledger.booking(first.booking.id).teamAssignment.hosts[0].email,member.email);assert.equal((await f.ledger.memberCalendarReadiness()).members[0].readiness,'ready');
 const legacy=f.ledger.account('b');delete legacy.ownerMemberId;f.ledger.putAccount(legacy);await f.ledger.connect({...grant,accountId:'b',email:f.members[1].email,ownerMember:{...f.member(1),fenceEpoch:0}});assert.equal(f.ledger.account('b').ownerMemberId,f.members[1].id);
});
test('member working hours constrain both single and collective link hours',async()=>{
 const f=await setup('all'),at=start(),date=new Date(at).toISOString().slice(0,10),a=f.ledger.account('a');f.ledger.putAccount({...a,memberSchedule:{zone:'UTC',weeklyHours:Object.fromEntries(Array.from({length:7},(_,d)=>[d,[]])),dateOverrides:{[date]:[]}}});const page=await f.ledger.availability('intro',{from:at,to:at+3600000});assert.equal(page.slots.length,0);assert.equal((await f.book()).status,409);
 const type={...f.type,teamScheduling:null};await f.save(type);const single=await f.ledger.availability('intro',{from:at,to:at+3600000});assert.equal(single.slots.length,0);assert.equal((await f.book()).status,409);
});

test('admin paths cannot replace member destination/busy preferences or use host overrides',async()=>{
 const f=await setup();await assert.rejects(()=>f.ledger.configureCalendars({accounts:[{id:'a',destinationCalendarId:'shared',conflictCalendarIds:['shared']}]}),e=>e.status===403);
 assert.deepEqual((await f.ledger.listCalendars()).accounts.map(a=>a.calendars),[[],[]]);
 for(const override of [{useDefaultCalendar:false,calendarId:'shared'},{conflictCalendarIds:['shared']}]){const type={...f.type,teamScheduling:{...f.type.teamScheduling,hosts:f.type.teamScheduling.hosts.map((h,i)=>i?{...h}:{...h,...override})}};await assert.rejects(()=>f.ledger.verifyMeetingDestinations({meetingTypes:[type]}),e=>e.code==='invalid_settings');assert.throws(()=>f.ledger.saveSettings({meetingTypes:[type]}),e=>e.code==='invalid_settings');}
 const type={...f.type,teamScheduling:null,useDefaultCalendar:false,calendarId:'shared'};await assert.rejects(()=>f.ledger.verifyMeetingDestinations({meetingTypes:[type]}),e=>e.code==='invalid_settings');
});
test('role/fence changes during own-calendar provider I/O cannot commit settings',async()=>{
 for(const mutation of ['fence','role']){const f=await setup(),member=f.member(0),page=await f.ledger.ownCalendar(member),list=f.google.listCalendars;let entered,release;const reached=new Promise(r=>entered=r),gate=new Promise(r=>release=r);f.google.listCalendars=async(...args)=>{entered();await gate;return list(...args);};const save=f.ledger.configureOwnCalendar(member,{accountId:'a',calendarId:'shared',conflictCalendarIds:[],schedule:page.schedule,expectedRevision:page.revision});await reached;if(mutation==='fence')f.ledger.fenceMemberCalendar(member.id);else f.record.members[0].role='viewer';release();await assert.rejects(()=>save,e=>e.status===403||e.status===409);assert.equal(f.ledger.account('a').destinationCalendarId,'primary');}
});

test('explicit fresh consent after rejoining restores same member grant without changing accepted hosts',async()=>{
 const f=await setup('all'),first=await f.book(),member=f.member(0);f.ledger.withdrawMemberCalendar({id:member.id,email:member.email},'a');f.record.members[0].joinedAt=999;const rejoined=f.member(0);await assert.rejects(()=>f.ledger.connect({accountId:'a',email:member.email,tokens:{access_token:'a',refresh_token:'a'},ownerMember:{...member,fenceEpoch:1}}),e=>e.status===403);
 await f.ledger.connect({accountId:'a',email:member.email,tokens:{access_token:'a',refresh_token:'a',expires_at:Date.now()+86400000},ownerMember:{...rejoined,fenceEpoch:1}});assert.equal(f.ledger.account('a').ownerJoinedAt,999);assert.equal(f.ledger.account('a').consentWithdrawn,false);assert.equal(f.ledger.booking(first.booking.id).teamAssignment.hosts[0].email,member.email);assert.equal((await f.ledger.memberCalendarReadiness()).members[0].readiness,'ready');
});
test('withdrawn collective participant prevents due follow-up from sending',async()=>{
 const f=await setup('all',{followUpMinutes:5});f.ledger.env.MAIL_FROM='notify@company.test';f.ledger.env.RESEND_API_KEY='fixture';const first=await f.book();assert.equal(first.booking.status,'confirmed');let sent=0;f.ledger.notify=async()=>{sent++;};f.ledger.withdrawMemberCalendar({id:f.members[0].id,email:f.members[0].email},'a');const row=f.ledger.rows("SELECT body FROM live_jobs WHERE json_extract(body,'$.kind')='follow_up'")[0];assert.ok(row);const job=JSON.parse(row.body),now=Date.now;Date.now=()=>first.booking.end+6*60000;try{await f.ledger.processJob(job);}finally{Date.now=now;}assert.equal(sent,0);const retained=JSON.parse(f.ledger.rows('SELECT body FROM live_jobs WHERE id=?',job.id)[0].body);assert.equal(retained.pausedForCalendarSync,true);assert.equal(retained.firstAttemptAt,undefined);
});

test('member working-window checks preserve every supported duration and the full link horizon',async()=>{
 const f=await setup(),a=f.ledger.account('a');f.ledger.putAccount({...a,memberSchedule:{zone:'UTC',weeklyHours:Object.fromEntries(Array.from({length:7},(_,d)=>[d,[{start:0,end:1440}]])),dateOverrides:{}}});const account=f.ledger.account('a');for(const duration of [15,30,45,60]){const at=Math.floor((Date.now()+40*86400000)/86400000)*86400000+12*3600000;assert.equal(f.ledger.memberHoursAllow(account,at,at+duration*60000),true,String(duration));}
});

test('legacy custom destinations cannot bypass newly contributed preferences at runtime',async()=>{
 const f=await setup('all'),types=f.ledger.meta('meetingTypes');types[0].teamScheduling.hosts[0]={...types[0].teamScheduling.hosts[0],useDefaultCalendar:false,calendarId:'shared',conflictCalendarIds:['shared']};f.ledger.putMeta('meetingTypes',types);const host=f.ledger.teamHosts(f.ledger.type('intro'))[0];assert.equal(host.calendarId,'primary');assert.deepEqual(host.conflictCalendarIds,['primary']);types[0]={...types[0],teamScheduling:null,useDefaultCalendar:false,calendarId:'shared'};f.ledger.putMeta('meetingTypes',types);assert.equal(f.ledger.destination(f.ledger.type('intro')).calendarId,'primary');
});

test('published owned single/any links remain editable after withdrawal without enabling new references',async()=>{
 const {HostedSettings}=await import('../src/settings.js');
 for(const mode of ['single','any']){const f=await setup('any');if(mode==='single')await f.save({...f.type,teamScheduling:null});f.ledger.withdrawMemberCalendar({id:f.members[0].id,email:f.members[0].email},'a');const service=new HostedSettings(f.ledger,f.storage),before=await service.read();const profile=await service.apply({profile:{company:'After withdrawal'}},before.revision);assert.equal(profile.settings.profile.company,'After withdrawal');
 const type={...profile.settings.meetingTypes[0],title:'Edited safely'},saved=await service.apply({meetingTypes:[type]},profile.revision);assert.equal(saved.settings.meetingTypes[0].published,true);assert.equal(saved.settings.meetingTypes[0].title,'Edited safely');
 if(mode==='single'){await assert.rejects(()=>f.ledger.availability('intro'));assert.equal((await f.book()).status,409);}else assert.equal((await f.book()).booking.assignedHosts[0].id,'b');
 const fresh={...type,id:'new',slug:'new'};await assert.rejects(()=>service.apply({meetingTypes:[type,fresh]},saved.revision),/connected/);
 }
});
test('connected owned team destinations save without accessing private provider calendars',async()=>{
 const f=await setup('any'),service=new (await import('../src/settings.js')).HostedSettings(f.ledger,f.storage),before=await service.read();f.google.listCalendars=async()=>{throw Error('must not enumerate owned calendars');};const changed={...before.meetingTypes[0],title:'Owned hosts'};const result=await service.apply({meetingTypes:[changed]},before.revision);assert.equal(result.settings.meetingTypes[0].title,'Owned hosts');
});
test('renamed verified identity can withdraw its earlier contribution using trusted ownership',async()=>{
 const f=await setup('all'),member=f.member(0);const outcome=f.ledger.withdrawMemberCalendar({id:member.id,email:'renamed@company.test'},'a');assert.equal(outcome.withdrawn,true);assert.equal(f.ledger.account('a').grant,undefined);assert.throws(()=>f.ledger.withdrawMemberCalendar({id:f.members[1].id,email:member.email},'a'),e=>e.status===403);
});

test('fresh legacy adoption canonicalizes only that contributor links and keeps accepted snapshots',async()=>{
 const f=await setup('all'),first=await f.book(),acceptedBefore=f.ledger.booking(first.booking.id),a=f.ledger.account('a');delete a.ownerMemberId;delete a.ownerJoinedAt;delete a.ownerFenceEpoch;f.ledger.putAccount(a);
 const prior=f.ledger.meta('meetingTypes')[0],otherHost=structuredClone(prior.teamScheduling.hosts[1]),team={...prior,useDefaultCalendar:false,calendarId:'shared',teamScheduling:{...prior.teamScheduling,hosts:prior.teamScheduling.hosts.map((h,i)=>i?h:{...h,useDefaultCalendar:false,calendarId:'shared',conflictCalendarIds:['shared']})}},single={...prior,id:'single',slug:'single',teamScheduling:null,useDefaultCalendar:false,calendarId:'shared'},unrelated={...single,id:'unrelated',slug:'unrelated',accountId:'b',useDefaultCalendar:true,calendarId:'primary'};f.ledger.putMeta('meetingTypes',[team,single,unrelated]);
 await f.ledger.connect({accountId:'a',email:f.members[0].email,tokens:{access_token:'a',refresh_token:'a',expires_at:Date.now()+86400000},ownerMember:{...f.member(0),fenceEpoch:0}});
 const types=f.ledger.meta('meetingTypes');assert.equal(types[0].useDefaultCalendar,true);assert.equal(types[0].calendarId,'primary');assert.equal(types[0].teamScheduling.hosts[0].useDefaultCalendar,true);assert.equal(types[0].teamScheduling.hosts[0].calendarId,'');assert.equal(types[0].teamScheduling.hosts[0].conflictCalendarIds,null);assert.deepEqual(types[0].teamScheduling.hosts[1],otherHost);assert.deepEqual(types[2],unrelated);assert.equal(types[1].useDefaultCalendar,true);assert.equal(types[1].calendarId,'primary');
 const after=f.ledger.booking(first.booking.id);assert.deepEqual(after.config,acceptedBefore.config);assert.deepEqual(after.teamAssignment,acceptedBefore.teamAssignment);assert.equal(after.calendarId,acceptedBefore.calendarId);
 const service=new (await import('../src/settings.js')).HostedSettings(f.ledger,f.storage),current=await service.read();const saved=await service.apply({profile:{company:'Unrelated edit'}},current.revision);assert.equal(saved.settings.profile.company,'Unrelated edit');const hours=await service.apply({availabilitySchedules:[{id:'company-hours',name:'Hours',zone:'UTC',weeklyHours:Object.fromEntries(Array.from({length:7},(_,d)=>[d,[{start:540,end:1020}]])),dateOverrides:{}}]},saved.revision);assert.equal(hours.settings.availabilitySchedules[0].id,'company-hours');
 await assert.rejects(()=>service.apply({meetingTypes:[{...types[1],useDefaultCalendar:false,calendarId:'shared'}]},hours.revision),/own calendar preferences/);
});

test('approval cannot resurrect guest cancellation during final membership refresh',async()=>{
 const f=await setup('all',{requiresApproval:true}),first=await f.book(),refresh=f.ledger.refreshMemberEligibility.bind(f.ledger);let count=0,entered,release;const reached=new Promise(r=>entered=r),gate=new Promise(r=>release=r);f.ledger.refreshMemberEligibility=async()=>{if(++count===2){entered();await gate;}return refresh();};const decision=f.ledger.decideBooking(first.booking.id,{action:'approve',expectedVersion:first.booking.version,key:crypto.randomUUID()});await reached;const cancelled=await f.ledger.cancel(first.booking.id,first.managementToken);assert.equal(cancelled.booking.status,'cancelled');release();const outcome=await decision;assert.equal(outcome.status,409);assert.equal(f.ledger.booking(first.booking.id).status,'cancelled');assert.equal(f.events.size,0);
});
test('own preference revision rejects a save whose digest was held across another commit',async()=>{
 const f=await setup(),member=f.member(0),page=await f.ledger.ownCalendar(member),digest=crypto.subtle.digest.bind(crypto.subtle);let calls=0,entered,release;const reached=new Promise(r=>entered=r),gate=new Promise(r=>release=r);crypto.subtle.digest=async(...args)=>{const result=await digest(...args);if(++calls===1){entered();await gate;}return result;};const payload={accountId:'a',calendarId:'primary',conflictCalendarIds:['primary'],schedule:page.schedule,expectedRevision:page.revision};let delayed;
 try{delayed=f.ledger.configureOwnCalendar(member,{...payload,calendarId:'shared'});await reached;const winner=await f.ledger.configureOwnCalendar(member,{...payload,schedule:{...page.schedule,zone:'America/New_York'}});assert.equal(winner.schedule.zone,'America/New_York');release();await assert.rejects(()=>delayed,e=>e.status===409);assert.equal(f.ledger.account('a').memberSchedule.zone,'America/New_York');assert.equal(f.ledger.account('a').destinationCalendarId,'primary');assert.equal(f.ledger.account('a').preferenceVersion,1);}finally{release();crypto.subtle.digest=digest;await delayed?.catch(()=>{});}
});
test('calendar-only save preserves unconfigured hours; cheap reads never enumerate Google',async()=>{
 const f=await setup(),member=f.member(0),page=await f.ledger.ownCalendar(member),updated=await f.ledger.configureOwnCalendar(member,{accountId:'a',calendarId:'primary',conflictCalendarIds:['primary'],expectedRevision:page.revision});assert.equal(updated.scheduleConfigured,false);assert.equal(f.ledger.account('a').memberSchedule,undefined);f.google.listCalendars=async()=>{throw Error('No provider read for badge/state');};assert.deepEqual(await f.ledger.ownCalendarReadiness(member),{readiness:'ready'});assert.deepEqual(f.ledger.contributionState({id:member.id},'a'),{connected:true,withdrawn:false});f.ledger.withdrawMemberCalendar({id:member.id},'a');assert.deepEqual(f.ledger.contributionState({id:member.id},'a'),{connected:false,withdrawn:true});assert.throws(()=>f.ledger.contributionState({id:f.members[1].id},'a'),e=>e.status===404);f.record.members=[];assert.deepEqual(f.ledger.contributionState({id:member.id},'a'),{connected:false,withdrawn:true});await assert.rejects(()=>f.ledger.ownCalendarReadiness(member),e=>e.status===403);
});
