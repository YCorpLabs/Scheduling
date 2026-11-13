import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {BookingLedger} from '../src/ledger.js';
import {exportAccount,exportWorkspace} from '../src/export.js';
import {DEFAULT} from '../public/policy.js';
const actor='h_'+'a'.repeat(24),workspace='h_'+'b'.repeat(24),other='h_'+'c'.repeat(24),secret='PRIVATE_EXPORT_CANARY';
function fixture(){
 const stores=new Map(),ledgers=new Map();
 const env={AUTH:{getByName(name){if(!stores.has(name))stores.set(name,{value:null,until:0});const store=stores.get(name);return {async get(){return store.until>Date.now()?structuredClone(store.value):null;},async put(value,ttl){store.value=structuredClone(value);store.until=Date.now()+ttl;},async putExport(value,ttl){store.value=structuredClone(value);store.until=Date.now()+ttl;},async allow(max,ttl){if(store.until<=Date.now()){store.value={count:0};store.until=Date.now()+ttl;}if((store.value?.count??0)>=max)return false;store.value={count:(store.value?.count??0)+1};return true;},async compareAndSwap(version,value,ttl){if((store.value?.version??null)!==version)return false;store.value=structuredClone(value);store.until=Date.now()+ttl;return true;}};}},LIVE_HOSTS:{getByName(id){const ledger=ledgers.get(id);if(!ledger)throw Error('Unexpected host read: '+id);return {exportPage:o=>ledger.exportPage(o),exportContribution:(member,account)=>ledger.exportContribution(member,account)};}}};
 function ledger(id){const db=new DatabaseSync(':memory:'),storage={sql:{exec(q,...args){const rows=db.prepare(q).all(...args);return {toArray:()=>rows};}},setAlarm:async()=>{},transactionSync(fn){db.exec('BEGIN');try{const value=fn();db.exec('COMMIT');return value;}catch(e){db.exec('ROLLBACK');throw e;}}};const l=new BookingLedger({storage},{});l.init({id,name:'Owner',email:'owner@example.test',privateToken:secret});ledgers.set(id,l);return l;}
 const personal=ledger(actor),company=ledger(workspace);ledger(other);
 const user={hostId:actor,email:'owner@example.test'};
 const set=(key,value)=>env.AUTH.getByName(key).put(value,3600000);
 const booking=(l,id,over={})=>l.sql.exec('INSERT INTO live_bookings VALUES(?,?,?,?,?,?)',id,'request-'+id,100,200,'confirmed',JSON.stringify({id,status:'confirmed',start:100,end:200,name:'Guest',email:'guest@example.test',title:'Intro',tokenRecovery:secret,tokenHash:secret,requestKey:secret,providerBody:{secret},config:{secret},...over}));
 return {env,stores,user,personal,company,set,booking};
}
async function collect(call){const pages=[];let body={};do{const page=await call(body);pages.push(page);body={cursor:page.nextCursor};}while(body.cursor);return pages;}
const section=(pages,name)=>pages.flatMap(p=>p.sections).filter(s=>s.name===name).flatMap(s=>Array.isArray(s.data)?s.data:[s.data]);

test('account export pages preserve clean data and omit credential/capability canaries',async()=>{
 const f=fixture();f.personal.putAccount({id:'own',email:'owner@example.test',connected:true,grant:secret,access_token:secret,tokenHash:secret,destinationCalendarId:'primary',conflictCalendarIds:['primary']});
 f.personal.putMeta('meetingTypes',[{...DEFAULT,id:'intro',slug:'intro',published:true,privateToken:secret,questions:[{id:'q',label:'Question',type:'text',required:true,token:secret}]}]);
 for(let i=0;i<23;i++)f.booking(f.personal,'booking-'+String(i).padStart(3,'0'),{answers:{q:'Answer',privateObject:{secret}},additionalGuests:['guest2@example.test']});
 await f.set('mail-tracking-index:'+actor,{version:1,entries:[{id:'tracking-id',expiresAt:Date.now()+60000}]});
 await f.set('mail-tracking:'+actor+':tracking-id',{version:1,id:'tracking-id',hostId:actor,capability:secret,pixelRequests:2,events:[{at:123,count:2,ip:secret}],expiresAt:Date.now()+60000});
 const pages=await collect(body=>exportAccount(f.env,f.user,body));assert.ok(pages.length>8);assert.equal(section(pages,'bookings').length,23);assert.equal(new Set(section(pages,'bookings').map(b=>b.id)).size,23);assert.equal(section(pages,'emailTracking')[0].pixelRequests,2);assert.equal(section(pages,'bookings')[0].answers.q,'Answer');assert.ok(!JSON.stringify(pages).includes(secret));
 assert.ok(pages.every(p=>p.schema===1&&p.scope==='account'&&p.generatedAt===pages[0].generatedAt&&Buffer.byteLength(JSON.stringify(p))<=262144));
});

test('signed cursors are repeatable, actor/scope-bound and reject tampering or unknown fields',async()=>{
 const f=fixture();await f.set('workspace:'+workspace,{id:workspace,version:1,members:[{id:actor,role:'owner'}]});
 const first=await exportAccount(f.env,f.user,{}),a=await exportAccount(f.env,f.user,{cursor:first.nextCursor}),b=await exportAccount(f.env,f.user,{cursor:first.nextCursor});assert.deepEqual(a,b);
 await assert.rejects(exportAccount(f.env,{hostId:other},{cursor:first.nextCursor}),e=>e.status===403);
 await assert.rejects(exportWorkspace(f.env,f.user,workspace,{cursor:first.nextCursor}),e=>e.status===403);
 const c=first.nextCursor;await assert.rejects(exportAccount(f.env,f.user,{cursor:c.slice(0,-1)+(c.endsWith('A')?'B':'A')}),e=>e.status===400);
 for(const body of [{target:workspace},{pageSize:1000},{cursor:4}])await assert.rejects(exportAccount(f.env,f.user,body),e=>e.status===400);
});

test('source mutation including direct SQL invalidates later pages without triggering providers',async()=>{
 const f=fixture();const page=await exportAccount(f.env,f.user,{});f.personal.sql.exec("UPDATE live_meta SET body=? WHERE key='profile'",JSON.stringify({id:actor,name:'Changed'}));
 await assert.rejects(exportAccount(f.env,f.user,{cursor:page.nextCursor}),e=>e.status===409&&e.code==='export_changed');
 const fresh=await exportAccount(f.env,f.user,{});await f.set('mail-tracking-index:'+actor,{version:2,entries:[]});await assert.rejects(exportAccount(f.env,f.user,{cursor:fresh.nextCursor}),e=>e.code==='export_changed');
});

test('workspace exports exclude member-private busy calendars, hours and grant fields',async()=>{
 const f=fixture();await f.set('workspace:'+workspace,{id:workspace,name:'Company',version:1,members:[{id:actor,email:'owner@example.test',role:'owner',joinedAt:1,token:secret},{id:other,email:'member@example.test',role:'member'}],invitations:[{tokenHash:secret}]});
 f.company.putAccount({id:'member',ownerMemberId:other,email:'member@example.test',connected:true,grant:secret,conflictCalendarIds:[secret],memberSchedule:{name:secret},destinationCalendarId:'member-destination'});
 f.company.putMeta('meetingTypes',[{...DEFAULT,id:'intro',slug:'intro',teamScheduling:{mode:'any',hosts:[{id:'member',name:'Member',accountId:'member',conflictCalendarIds:[secret],scheduleId:secret,calendarId:'member-destination'}]}}]);
 f.booking(f.company,'booking-company',{cancellationReason:'Guest cancellation'});
 const pages=await collect(body=>exportWorkspace(f.env,f.user,workspace,body));assert.ok(!JSON.stringify(pages).includes(secret));assert.ok(!JSON.stringify(pages).includes('member-destination'));assert.equal(section(pages,'members').length,2);assert.equal(section(pages,'bookings')[0].cancellationReason,'Guest cancellation');assert.equal(section(pages,'calendars')[0].ownerMemberId,other);
});

test('workspace loss of authority and version changes stop every page including cursor replay',async()=>{
 const f=fixture();const record={id:workspace,version:1,members:[{id:actor,role:'admin'}]};await f.set('workspace:'+workspace,record);const first=await exportWorkspace(f.env,f.user,workspace,{});
 await f.set('workspace:'+workspace,{...record,version:2,members:[{id:actor,role:'member'}]});await assert.rejects(exportWorkspace(f.env,f.user,workspace,{cursor:first.nextCursor}),e=>e.status===403);
 await f.set('workspace:'+workspace,{...record,version:2});await assert.rejects(exportWorkspace(f.env,f.user,workspace,{cursor:first.nextCursor}),e=>e.code==='export_changed');
});

test('personal export includes only own membership and owned contributions, with per-source revision pins',async()=>{
 const f=fixture();await f.set('workspace-index:'+actor,{version:1,ids:[workspace]});await f.set('workspace:'+workspace,{id:workspace,name:'Company',version:1,members:[{id:actor,role:'member',email:'owner@example.test'},{id:other,role:'owner',email:secret}]});
 await f.set('calendar-contributions:'+actor,{version:1,contributions:[{workspaceId:workspace,accountId:'mine'},{workspaceId:workspace,accountId:'foreign'}]});
 f.company.putAccount({id:'mine',ownerMemberId:actor,email:'owner@example.test',grant:secret,conflictCalendarIds:['own-busy'],memberSchedule:{zone:'UTC',weeklyHours:{1:[{start:540,end:1020}]}}});f.company.putAccount({id:'foreign',ownerMemberId:other,grant:secret});
 const pages=await collect(body=>exportAccount(f.env,f.user,body));assert.ok(!JSON.stringify(pages).includes(secret));assert.equal(section(pages,'memberships').length,1);assert.equal(section(pages,'memberships')[0].role,'member');assert.equal(section(pages,'calendarContributions').length,1);assert.deepEqual(section(pages,'calendarContributions')[0].conflictCalendarIds,['own-busy']);assert.equal(section(pages,'bookings').length,0);
});

test('expired export capabilities fail closed and cannot be extended by reads',async()=>{
 const f=fixture();const first=await exportAccount(f.env,f.user,{}),store=[...f.stores.entries()].find(([key])=>key.startsWith('account-export:'))[1];const expiry=store.value.expiresAt;await exportAccount(f.env,f.user,{cursor:first.nextCursor});assert.equal(store.value.expiresAt,expiry);store.value.expiresAt=Date.now()-1;
 await assert.rejects(exportAccount(f.env,f.user,{cursor:first.nextCursor}),e=>e.status===410&&e.code==='export_expired');
});

test('a company role lost during an awaited ledger page prevents the response',async()=>{
 const f=fixture();await f.set('workspace:'+workspace,{id:workspace,version:1,members:[{id:actor,role:'owner'}]});const first=await exportWorkspace(f.env,f.user,workspace,{}),get=f.env.LIVE_HOSTS.getByName;
 f.env.LIVE_HOSTS.getByName=id=>{const stub=get(id);return {...stub,exportPage:async options=>{const value=stub.exportPage(options);if(options.section==='meetingTypes')await f.set('workspace:'+workspace,{id:workspace,version:2,members:[{id:actor,role:'viewer'}]});return value;}};};
 await assert.rejects(exportWorkspace(f.env,f.user,workspace,{cursor:first.nextCursor}),e=>e.status===403);
});

test('repeated tracking page detects source changes rather than mixing new counts into a cursor',async()=>{
 const f=fixture();await f.set('mail-tracking-index:'+actor,{version:1,entries:[{id:'tracking',expiresAt:Date.now()+60000}]});const record={version:1,id:'tracking',hostId:actor,pixelRequests:1,expiresAt:Date.now()+60000};await f.set('mail-tracking:'+actor+':tracking',record);
 let p=await exportAccount(f.env,f.user,{}),cursor;
 while(p.nextCursor){cursor=p.nextCursor;p=await exportAccount(f.env,f.user,{cursor});if(p.sections[0].name==='emailTracking')break;}
 const repeated=await exportAccount(f.env,f.user,{cursor});assert.deepEqual(repeated,p);await f.set('mail-tracking:'+actor+':tracking',{...record,version:2,pixelRequests:2});await assert.rejects(exportAccount(f.env,f.user,{cursor}),e=>e.code==='export_changed');
});

test('revision triggers roll back with the source transaction and catch account/booking deletion',async()=>{
 const f=fixture(),revision=f.personal.exportPage({section:'check'}).revision;
 assert.throws(()=>f.personal.ctx.storage.transactionSync(()=>{f.personal.putMeta('test','rolled-back');throw Error('rollback');}));assert.equal(f.personal.exportPage({section:'check'}).revision,revision);
 f.personal.putAccount({id:'account',grant:secret});const before=f.personal.exportPage({section:'check'}).revision;f.personal.sql.exec('DELETE FROM live_accounts');assert.ok(f.personal.exportPage({section:'check'}).revision>before);
 f.booking(f.personal,'book');const booked=f.personal.exportPage({section:'check'}).revision;f.personal.sql.exec('DELETE FROM live_bookings');assert.ok(f.personal.exportPage({section:'check'}).revision>booked);
});


test('export source failures are sanitized and new plans have a bounded admission rate',async()=>{
 const f=fixture();for(let i=0;i<5;i++)await exportAccount(f.env,f.user,{});await assert.rejects(exportAccount(f.env,f.user,{}),e=>e.status===429);
 const fresh=fixture();fresh.env.LIVE_HOSTS.getByName=()=>({exportPage(){throw Error('PRIVATE_EXPORT_CANARY');}});await assert.rejects(exportAccount(fresh.env,fresh.user,{}),e=>e.status===503&&!e.message.includes(secret));
});


test('typed lifecycle RPC refusals never become a partial export response',async()=>{
 for(const stopAt of [1,3]){
  const f=fixture(),get=f.env.LIVE_HOSTS.getByName;let calls=0;
  f.env.LIVE_HOSTS.getByName=id=>{const host=get(id);return {...host,exportPage:options=>++calls===stopAt?{error:'PRIVATE_EXPORT_CANARY',status:403,code:'lifecycle_fenced'}:host.exportPage(options)};};
  await assert.rejects(exportAccount(f.env,f.user,{}),error=>error.status===403&&!error.message.includes(secret));
 }
});


test('a fenced actor cannot finish exporting an otherwise active company',async()=>{
 const f=fixture();await f.set('workspace:'+workspace,{id:workspace,version:1,members:[{id:actor,role:'owner'}]});
 const get=f.env.LIVE_HOSTS.getByName;let reads=0;
 f.env.LIVE_HOSTS.getByName=id=>{const host=get(id);return {...host,exportPage:async options=>{const value=host.exportPage(options);if(++reads===2)await f.set('lifecycle:'+actor,{kind:'lifecycle',hostId:actor,generation:1,state:'fencing',operationId:'fenced-export-operation',version:1,ledgerIds:[],ledgerAcks:{},admissions:{}});return value;}};};
 await assert.rejects(exportWorkspace(f.env,f.user,workspace,{}),error=>error.status===403&&error.code==='lifecycle_fenced');
});
