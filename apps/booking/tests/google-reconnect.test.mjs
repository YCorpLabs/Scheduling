import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {BookingLedger} from '../src/ledger.js';
import {GoogleError,grantRejected} from '../src/google.js';
import {operationalStatus} from '../src/operations.js';
import {DEFAULT} from '../public/policy.js';

const config={...DEFAULT,zone:'UTC',notice:0,horizon:5,startHour:0,endHour:24,days:[0,1,2,3,4,5,6],buffer:0,reminder:false};
test.beforeEach(t=>t.mock.timers.enable({apis:['Date'],now:Date.UTC(2030,0,7,9)}));

async function setup(){
 const db=new DatabaseSync(':memory:'),storage={sql:{exec(q,...args){const rows=db.prepare(q).all(...args);return {toArray:()=>rows};}},setAlarm:async()=>{},transactionSync(fn){db.exec('BEGIN');try{const value=fn();db.exec('COMMIT');return value;}catch(e){db.exec('ROLLBACK');throw e;}}};
 const provider={refresh:null,refreshes:0,listed:0};
 const google={
  refreshTokens:async()=>{provider.refreshes++;if(provider.refresh)throw provider.refresh;return {access_token:'fresh',expires_in:3600,expires_at:Date.now()+3600000};},
  listCalendars:async()=>{provider.listed++;return [{id:'primary',accessRole:'owner',primary:true},{id:'shared',accessRole:'writer'}];},
  freeBusy:async()=>[],getEvent:async()=>null,createEvent:async()=>{throw Error('unexpected write');},deleteEvent:async()=>{}
 };
 const member={id:'h_'+'m'.repeat(24),email:'member@company.test',role:'member',joinedAt:100},record={members:[member]};
 const env={AUTH:{getByName(){return {get:async()=>structuredClone(record)};}},TOKEN_ENCRYPTION_KEY:Buffer.alloc(32,9).toString('base64'),PUBLIC_ORIGIN:'https://test.invalid'};
 const ledger=new BookingLedger({storage},env,{google});ledger.init({id:'h_'+'w'.repeat(24),name:'Profile',workspaceKind:'company'});
 // Tokens are valid now; tests expire them to force a refresh.
 for(const id of ['host','member'])await ledger.connect({accountId:id,email:id==='host'?'host@company.test':member.email,tokens:{access_token:id,refresh_token:id,expires_at:Date.now()+86400000}});
 await ledger.configureCalendars({accounts:['host','member'].map(id=>({id,destinationCalendarId:'primary',conflictCalendarIds:['primary']}))});
 const type={...config,id:'intro',slug:'intro',published:true,accountId:'host',calendarId:'primary'};
 ledger.saveSettings({meetingTypes:[type]},{verifiedDestinations:await ledger.verifyMeetingDestinations({meetingTypes:[type]},ledger.settings())});
 ledger.putAccount({...ledger.account('member'),ownerMemberId:member.id,ownerJoinedAt:member.joinedAt,ownerFenceEpoch:0});await ledger.refreshMemberEligibility();
 const expire=async id=>{const {decryptTokens,encryptTokens}=await import('../src/crypto.js'),a=ledger.account(id),t=await decryptTokens(a.grant,env.TOKEN_ENCRYPTION_KEY,ledger.hostId());ledger.putAccount({...a,grant:await encryptTokens({...t,expires_at:Date.now()-1000},env.TOKEN_ENCRYPTION_KEY,ledger.hostId())});};
 return {ledger,provider,member:{...member,workspaceId:ledger.hostId()},expire};
}

test('grantRejected covers invalid_grant and 401 only',()=>{
 assert.equal(grantRejected(new GoogleError(400,'invalid_grant')),true);
 assert.equal(grantRejected(new GoogleError(401,'unauthorized')),true);
 for(const error of [new GoogleError(403,'forbidden'),new GoogleError(503,'temporarily_unavailable',true),new GoogleError(504,'timeout',true),Error('other')])assert.equal(grantRejected(error),false);
});

for(const [name,error] of [['401 from the token endpoint',new GoogleError(401,'unauthorized')],['invalid_grant',new GoogleError(400,'invalid_grant')]]){
 test(`${name} marks the connection for reconnection and keeps the grant`,async()=>{
  const f=await setup();await f.expire('host');const grant=f.ledger.account('host').grant;f.provider.refresh=error;
  const listed=await f.ledger.listCalendars();
  assert.deepEqual(listed.accounts.find(a=>a.id==='host'),{id:'host',email:'host@company.test',reconnectRequired:true,calendars:[]});
  assert.ok(listed.accounts.find(a=>a.id==='member'),'other accounts still list');
  const stored=f.ledger.account('host');assert.equal(stored.reconnectRequired,true);assert.equal(stored.connected,true);assert.equal(stored.grant,grant,'the stored grant is not deleted');
  assert.equal(f.ledger.settings().accounts.find(a=>a.id==='host').reconnectRequired,true);assert.ok(!JSON.stringify(f.ledger.settings()).includes('"grant"'));
 });
}

test('other Google failures do not mark the connection',async()=>{
 const f=await setup();await f.expire('host');f.provider.refresh=new GoogleError(503,'temporarily_unavailable',true);
 await assert.rejects(()=>f.ledger.listCalendars(),e=>e.code==='temporarily_unavailable');
 assert.equal(f.ledger.account('host').reconnectRequired,undefined);
});

test('booking links on a rejected grant keep failing closed',async()=>{
 const f=await setup();await f.expire('host');f.provider.refresh=new GoogleError(401,'unauthorized');
 for(let i=0;i<2;i++){const page=await f.ledger.availability('intro',{});assert.equal(page.status,503);assert.equal(page.error,'Calendar availability is temporarily unavailable.');assert.equal(page.slots,undefined);}
 assert.equal(f.ledger.account('host').reconnectRequired,true);assert.equal(f.provider.refreshes,2,'each request still asks Google, so a recovered grant works again');
});

test('a working refresh or a fresh consent clears the flag',async()=>{
 const f=await setup();await f.expire('host');f.provider.refresh=new GoogleError(401,'unauthorized');await f.ledger.listCalendars();assert.equal(f.ledger.account('host').reconnectRequired,true);
 f.provider.refresh=null;const listed=await f.ledger.listCalendars();assert.equal(listed.accounts.find(a=>a.id==='host').reconnectRequired,undefined);assert.equal(f.ledger.account('host').reconnectRequired,undefined);
 await f.expire('host');f.provider.refresh=new GoogleError(400,'invalid_grant');await f.ledger.listCalendars();const version=f.ledger.account('host').connectionVersion;
 await f.ledger.connect({accountId:'host',email:'host@company.test',tokens:{access_token:'new',refresh_token:'new',expires_at:Date.now()+86400000}});
 assert.equal(f.ledger.account('host').reconnectRequired,undefined);assert.equal(f.ledger.account('host').connectionVersion,version+1);
});

test('team calendar settings refuse a rejected account with a reconnect code',async()=>{
 const f=await setup();await f.expire('host');f.provider.refresh=new GoogleError(401,'unauthorized');await f.ledger.listCalendars();
 await assert.rejects(()=>f.ledger.configureCalendars({accounts:[{id:'host',destinationCalendarId:'primary',conflictCalendarIds:['primary']}]}),e=>e.status===409&&e.code==='calendar_reconnect_required'&&/Reconnect Google Calendar for host@company.test/.test(e.message));
 await assert.rejects(()=>f.ledger.verifyMeetingDestinations({meetingTypes:[{...config,id:'other',slug:'other',accountId:'host',calendarId:'shared',useDefaultCalendar:false}]},f.ledger.settings()),e=>e.code==='invalid_settings'&&e.status===400&&/Reconnect Google Calendar/.test(e.message));
});

test('member calendars and My calendar show reconnect instead of connected',async()=>{
 const f=await setup();assert.equal((await f.ledger.ownCalendar(f.member)).readiness,'ready');
 await f.expire('member');f.provider.refresh=new GoogleError(401,'unauthorized');
 const page=await f.ledger.ownCalendar(f.member);assert.equal(page.readiness,'reconnect');assert.deepEqual(page.calendars,[]);assert.equal(page.account.connected,true);
 assert.equal((await f.ledger.ownCalendarReadiness(f.member)).readiness,'reconnect');
 assert.equal((await f.ledger.memberCalendarReadiness()).members[0].readiness,'reconnect');
 await assert.rejects(()=>f.ledger.configureOwnCalendar(f.member,{accountId:'member',calendarId:'primary',conflictCalendarIds:['primary'],expectedRevision:page.revision}),e=>e.status===409&&e.code==='calendar_reconnect_required');
 assert.ok(f.ledger.account('member').grant,'member grant is kept');
});

test('Status reports a calendar that needs reconnection',async()=>{
 const f=await setup();assert.ok(!(await operationalStatus(f.ledger)).issues.some(i=>i.code==='calendar_authorization'));
 await f.expire('host');f.provider.refresh=new GoogleError(401,'unauthorized');await f.ledger.listCalendars();
 const status=await operationalStatus(f.ledger);assert.equal(status.accounts.reconnectNeeded,1);assert.ok(status.issues.some(i=>i.code==='calendar_authorization'));
});
