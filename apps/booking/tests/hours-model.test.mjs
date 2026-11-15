import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {BookingLedger} from '../src/ledger.js';
import {migrateHoursModel,restoreHoursModel,normalizeHoursWrite,hoursSources,workdayHours,ALL_WEEK_ID} from '../src/hours-model.js';
import {DEFAULT,resolveAvailabilitySchedule,validateConfig} from '../public/policy.js';

const week=(from,to,days=[1,2,3,4,5])=>Object.fromEntries([0,1,2,3,4,5,6].map(d=>[d,days.includes(d)?[{start:from*60,end:to*60}]:[]]));
const work={id:'work',name:'Working hours',zone:'Europe/Oslo',weeklyHours:week(9,17),dateOverrides:{'2030-12-24':[]}};
const evenings={id:'evenings',name:'Evenings',zone:'Europe/Oslo',weeklyHours:week(18,20,[2,4]),dateOverrides:{}};
const link=(id,extra={})=>({...DEFAULT,id,slug:id,title:id,published:true,accountId:'a',calendarId:'primary',...extra});
const hoursOf=(type,schedules,defaultId)=>{const r=resolveAvailabilitySchedule(type,schedules,defaultId);return JSON.stringify({zone:r.zone,weeklyHours:validateConfig(r).weeklyHours,dateOverrides:r.dateOverrides});};
const resolvedAfter=(kind,state,type)=>{const s=hoursSources(kind,state.availabilitySchedules,state.defaultAvailabilityScheduleId);return hoursOf(type,s.schedules,s.defaultId);};

function personalState(){
  return {kind:'personal',availabilitySchedules:[work,evenings],defaultAvailabilityScheduleId:'work',meetingTypes:[
    link('inherits',{useDefaultSchedule:true}),
    link('pointsAtDefault',{scheduleId:'work'}),
    link('evenings',{scheduleId:'evenings'}),
    link('inline',{zone:'Asia/Tokyo',weeklyHours:week(10,12,[1]),dateOverrides:{}}),
    link('team',{scheduleId:'work',teamScheduling:{mode:'any',hosts:[{id:'a',name:'A',accountId:'a',useDefaultCalendar:true,calendarId:'',conflictCalendarIds:null,scheduleId:'evenings'},{id:'b',name:'B',accountId:'b',useDefaultCalendar:true,calendarId:'',conflictCalendarIds:null,scheduleId:null}]}})
  ]};
}

test('personal: the default becomes the availability and every link keeps exactly its hours',()=>{
  const before=personalState(),after=migrateHoursModel(before);
  assert.equal(after.defaultAvailabilityScheduleId,'work');
  assert.deepEqual(after.availabilitySchedules.map(s=>s.id),['work','evenings'],'evenings stays only because a team host points at it');
  const byId=Object.fromEntries(after.meetingTypes.map(t=>[t.id,t]));
  assert.equal(byId.inherits.useDefaultSchedule,true);
  assert.equal(byId.pointsAtDefault.useDefaultSchedule,true);assert.equal(byId.pointsAtDefault.scheduleId,null);
  assert.equal(byId.evenings.useDefaultSchedule,false);assert.equal(byId.evenings.scheduleId,null);assert.deepEqual(byId.evenings.weeklyHours,evenings.weeklyHours);
  assert.equal(byId.team.teamScheduling.hosts[0].scheduleId,'evenings');
  for(const type of before.meetingTypes)assert.equal(resolvedAfter('personal',after,byId[type.id]),hoursOf(type,before.availabilitySchedules,before.defaultAvailabilityScheduleId),type.id);
});

test('company: shared hours become each link\'s own times and the team default goes away',()=>{
  const before={...personalState(),kind:'company'},after=migrateHoursModel(before);
  assert.equal(after.defaultAvailabilityScheduleId,null);
  assert.deepEqual(after.availabilitySchedules.map(s=>s.id),['evenings']);
  for(const type of after.meetingTypes){assert.equal(type.scheduleId,null,type.id);assert.equal(type.useDefaultSchedule,false,type.id);}
  const byId=Object.fromEntries(after.meetingTypes.map(t=>[t.id,t]));
  for(const type of before.meetingTypes)assert.equal(resolvedAfter('company',after,byId[type.id]),hoursOf(type,before.availabilitySchedules,before.defaultAvailabilityScheduleId),type.id);
});

test('personal without saved hours gets Mon-Fri 09-17 in the links\' zone and links stay as they are',()=>{
  const before={kind:'personal',availabilitySchedules:[],defaultAvailabilityScheduleId:null,meetingTypes:[link('intro',{zone:'America/New_York'})]},after=migrateHoursModel(before);
  assert.equal(after.defaultAvailabilityScheduleId,'availability');assert.equal(after.availabilitySchedules[0].zone,'America/New_York');
  assert.deepEqual(after.availabilitySchedules[0].weeklyHours,workdayHours('America/New_York').weeklyHours);
  assert.deepEqual(after.meetingTypes,before.meetingTypes);
});

test('restore puts back the named schedules and each link\'s original fields; links made later stay',()=>{
  const before=personalState(),{backup,...after}=migrateHoursModel(before);
  const later=link('later',{useDefaultSchedule:true});
  const restored=restoreHoursModel({meetingTypes:[...after.meetingTypes,later]},backup);
  assert.deepEqual(restored.availabilitySchedules,before.availabilitySchedules);
  assert.equal(restored.defaultAvailabilityScheduleId,'work');
  for(const type of before.meetingTypes){const r=restored.meetingTypes.find(t=>t.id===type.id);assert.equal(r.scheduleId,type.scheduleId??null);assert.equal(r.useDefaultSchedule,type.useDefaultSchedule??false);assert.equal(hoursOf(r,restored.availabilitySchedules,'work'),hoursOf(type,before.availabilitySchedules,'work'));}
  assert.ok(restored.meetingTypes.some(t=>t.id==='later'));
  assert.throws(()=>restoreHoursModel({meetingTypes:[]},null),/No hours backup/);
});

test('writes from older clients are normalized without changing hours, and normalizing twice changes nothing',()=>{
  const once=normalizeHoursWrite(personalState()),twice=normalizeHoursWrite({kind:'personal',...once});
  assert.deepEqual(twice,once);
});

// ----- ledger integration -----
function storage(){
  const db=new DatabaseSync(':memory:');
  return {db,sql:{exec(q,...args){const rows=db.prepare(q).all(...args);return {toArray:()=>rows};}},setAlarm:async()=>{},transactionSync(fn){db.exec('BEGIN');try{const value=fn();db.exec('COMMIT');return value;}catch(e){db.exec('ROLLBACK');throw e;}}};
}
const env=record=>({AUTH:{getByName(){return {get:async()=>structuredClone(record)};}},TOKEN_ENCRYPTION_KEY:Buffer.alloc(32,9).toString('base64'),PUBLIC_ORIGIN:'https://test.invalid'});
const google={refreshTokens:async()=>{throw Error('unexpected refresh');},listCalendars:async()=>[{id:'primary',accessRole:'owner'}],freeBusy:async()=>[],getEvent:async()=>null,createEvent:async()=>{throw Error('unexpected write');},deleteEvent:async()=>{}};
function seed(store,{kind,schedules,defaultId,types}){
  const ledger=new BookingLedger({storage:store},env({members:[]}),{google});
  ledger.init({id:'h_'+'w'.repeat(24),name:'Riley',workspaceKind:kind});
  // Put the workspace back to the version 1 shape, as an existing instance has it.
  ledger.putMeta('availabilitySchedules',schedules);ledger.putMeta('defaultAvailabilityScheduleId',defaultId);ledger.putMeta('meetingTypes',types);ledger.putMeta('hoursModel',1);
  ledger.putAccount({id:'a',email:'riley@example.com',connected:true,destinationCalendarId:'primary',conflictCalendarIds:['primary']});
  ledger.putAccount({id:'b',email:'sam@example.com',connected:true,destinationCalendarId:'primary',conflictCalendarIds:['primary']});
}

test('an existing workspace upgrades once on start, keeps every link\'s hours, and downgrades back',()=>{
  const store=storage(),state=personalState();seed(store,{kind:'personal',schedules:state.availabilitySchedules,defaultId:'work',types:state.meetingTypes});
  const ledger=new BookingLedger({storage:store},env({members:[]}),{google});
  assert.equal(ledger.meta('hoursModel'),2);assert.ok(ledger.meta('hoursModelBackup'));
  for(const type of state.meetingTypes){const now=ledger.type(type.slug),expected=hoursOf(type,state.availabilitySchedules,'work');assert.equal(JSON.stringify({zone:now.zone,weeklyHours:validateConfig(now).weeklyHours,dateOverrides:now.dateOverrides}),expected,type.id);}
  const migrated=JSON.stringify(ledger.settings());new BookingLedger({storage:store},env({members:[]}),{google});assert.equal(JSON.stringify(ledger.settings()),migrated,'a second start changes nothing');
  assert.equal(ledger.downgradeHoursModel(),true);assert.equal(ledger.meta('hoursModel'),1);assert.equal(ledger.meta('hoursModelBackup')??null,null);
  assert.deepEqual(ledger.meta('availabilitySchedules'),state.availabilitySchedules);
  assert.equal(ledger.meta('meetingTypes').find(t=>t.id==='evenings').scheduleId,'evenings');
});

test('a new personal profile starts with an availability and a starter link that switches on with the first calendar',async()=>{
  const ledger=new BookingLedger({storage:storage()},env({members:[]}),{google});
  ledger.init({id:'h_'+'n'.repeat(24),name:'New Host',email:'new@example.com'});
  assert.equal(ledger.meta('hoursModel'),2);
  const [availability]=ledger.meta('availabilitySchedules');assert.equal(ledger.meta('defaultAvailabilityScheduleId'),availability.id);assert.deepEqual(availability.weeklyHours,workdayHours().weeklyHours);
  let [starter]=ledger.meta('meetingTypes');assert.equal(starter.useDefaultSchedule,true);assert.equal(starter.published,false);assert.equal(starter.host,'New Host');
  await ledger.connect({accountId:'acct',email:'new@example.com',tokens:{access_token:'x',refresh_token:'x',expires_at:Date.now()+86400000}});
  [starter]=ledger.meta('meetingTypes');assert.equal(starter.published,true);assert.equal(starter.accountId,'acct');
  assert.equal(ledger.account('acct').destinationCalendarId,'new@example.com');assert.equal(ledger.type('intro').calendarId,'new@example.com');
  await ledger.connect({accountId:'second',email:'other@example.com',tokens:{access_token:'y',refresh_token:'y',expires_at:Date.now()+86400000}});
  assert.equal(ledger.meta('meetingTypes')[0].accountId,'acct','a second calendar does not take over the link');
});

test('team links: "any time" uses each host\'s availability, own times keep today\'s narrowing',()=>{
  const ledger=new BookingLedger({storage:storage()},env({members:[]}),{google});
  ledger.init({id:'h_'+'c'.repeat(24),name:'Northwind',workspaceKind:'company'});
  const today=new Date();today.setUTCHours(0,0,0,0);const monday=today.getTime()+((8-today.getUTCDay())%7||7)*86400000,saturday=monday+5*86400000,at=(day,h)=>day+h*3600000;
  const anyTime={...link('demo',{useDefaultSchedule:true,zone:'UTC'})},own={...link('weekend',{zone:'UTC',weeklyHours:week(0,24,[0,1,2,3,4,5,6])})};
  const member={id:'a',email:'riley@example.com',connected:true,ownerMemberId:'h_'+'m'.repeat(24),destinationCalendarId:'primary'};
  // Not set: "any time" falls back to Mon-Fri 09-17 in the link zone; own times are not narrowed (today's behavior).
  assert.equal(ledger.memberHoursAllow(member,at(monday,10),at(monday,10.5),anyTime),true);
  assert.equal(ledger.memberHoursAllow(member,at(saturday,10),at(saturday,10.5),anyTime),false);
  assert.equal(ledger.memberHoursAllow(member,at(saturday,10),at(saturday,10.5),own),true);
  // Set: it limits both kinds of links.
  const evenings={...member,memberSchedule:{zone:'UTC',weeklyHours:week(18,20,[6]),dateOverrides:{}}};
  assert.equal(ledger.memberHoursAllow(evenings,at(saturday,18),at(saturday,18.5),anyTime),true);
  assert.equal(ledger.memberHoursAllow(evenings,at(monday,10),at(monday,10.5),anyTime),false);
  assert.equal(ledger.memberHoursAllow(evenings,at(saturday,10),at(saturday,10.5),own),false);
  // The link itself resolves to the whole week; hosts do the limiting.
  const resolved=ledger.resolveHours(anyTime);assert.deepEqual(resolved.weeklyHours[6],[{start:0,end:1440}]);
  assert.ok(hoursSources('company',[],null).schedules.some(s=>s.id===ALL_WEEK_ID));
});

test('older clients sending named schedules keep working; links get their own times and nothing else changes',()=>{
  const ledger=new BookingLedger({storage:storage()},env({members:[]}),{google});
  ledger.init({id:'h_'+'d'.repeat(24),name:'Desk'});ledger.putAccount({id:'a',email:'riley@example.com',connected:true,destinationCalendarId:'primary',conflictCalendarIds:['primary']});
  const availability=ledger.meta('availabilitySchedules')[0],extra={...evenings,id:'desktop-extra'};
  ledger.saveSettings({availabilitySchedules:[availability,extra],meetingTypes:[{...ledger.meta('meetingTypes')[0],accountId:'a',published:false,useDefaultSchedule:false,scheduleId:'desktop-extra'}]});
  assert.deepEqual(ledger.meta('availabilitySchedules').map(s=>s.id),[availability.id]);
  const stored=ledger.meta('meetingTypes')[0];assert.equal(stored.scheduleId,null);assert.deepEqual(stored.weeklyHours,extra.weeklyHours);assert.equal(stored.zone,extra.zone);
});

test('links count their own views and confirmed bookings',()=>{
  const ledger=new BookingLedger({storage:storage()},env({members:[]}),{google});
  ledger.init({id:'h_'+'s'.repeat(24),name:'Stats'});ledger.putAccount({id:'a',email:'riley@example.com',connected:true,destinationCalendarId:'primary',conflictCalendarIds:['primary']});
  ledger.saveSettings({meetingTypes:[{...ledger.meta('meetingTypes')[0],accountId:'a',published:true}]});
  ledger.recordVisit('intro');ledger.recordVisit('intro','email');ledger.recordMetric('link-confirmed:intro');
  const stats=ledger.analytics();assert.deepEqual(stats.links.intro,{views:2,confirmed:1});assert.equal(stats.totals.pageViews,2);assert.ok(stats.linksStartedAt);
});
