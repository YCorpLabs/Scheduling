import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {BookingLedger} from '../src/ledger.js';
import {validateDestination,publicAddress,signature,adapterPayload} from '../src/integrations.js';
import {FENCE_META} from '../src/maintenance.js';
const KEY=Buffer.alloc(32,7).toString('base64'),SLACK='https://hooks.slack.com/services/T123456/B123456/abcdefghijklmnopqrstuv',DISCORD='https://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuv';
function setup({db=new DatabaseSync(':memory:'),fetch=async()=>new Response('',{status:204}),resolve=async()=>['93.184.216.34'],env={},profile={id:'host',name:'Host'}}={}){
 let alarm=null;const storage={sql:{exec(q,...v){const rows=db.prepare(q).all(...v);return {toArray:()=>rows};}},transactionSync(fn){db.exec('BEGIN');try{const r=fn();db.exec('COMMIT');return r;}catch(e){db.exec('ROLLBACK');throw e;}},setAlarm:async n=>{alarm=n;},getAlarm:async()=>alarm};
 const ledger=new BookingLedger({storage},{TOKEN_ENCRYPTION_KEY:KEY,INTEGRATION_WEBHOOK_HOSTS:'hooks.example.com',...env},{integrations:{fetch,resolve}});ledger.init(profile);let fence=null;ledger.fenceStore={get:async()=>fence,compareAndSwap:async(version,next)=>{if((fence?.version??null)!==version)return false;fence=next;return true;}};return {db,ledger,box:ledger.integrations,alarm:()=>alarm};
}
const create=(ledger,kind='slack',extra={})=>ledger.configureIntegration({kind,name:'Sales',url:kind==='slack'?SLACK:kind==='discord'?DISCORD:'https://hooks.example.com/events?key=private-secret',events:['booking.requested','booking.confirmed','booking.cancelled','booking.rescheduled','booking.approval_requested','booking.rejected','booking.expired'],...extra});
const booking=(extra={})=>({id:'booking_1234567890123456',requestKey:'request-key-1',meetingTypeId:'intro',meetingTypeSlug:'intro',title:'Introductory meeting',start:Date.now()+3600000,end:Date.now()+5400000,status:'pending',version:1,name:'Private Name',email:'private@example.com',tokenRecovery:'private-capability',tokenHash:'private-hash',...extra});
const at=async(t,fn)=>{const now=Date.now;Date.now=()=>t;try{return await fn();}finally{Date.now=now;}};

test('destinations fail closed on credentials, private literals, redirects tricks and unapproved hosts',()=>{
 for(const u of ['http://hooks.example.com','https://127.0.0.1','https://2130706433','https://0x7f000001','https://[::1]','https://user:pass@hooks.example.com/x','https://hooks.example.com:8443/x','https://hooks.example.com/x#secret','https://hooks.example.com\\@evil.com','https://unapproved.com/','https://hooks.example.com./x'])assert.throws(()=>validateDestination(u,'webhook',{INTEGRATION_WEBHOOK_HOSTS:'hooks.example.com'}),u);
 assert.equal(validateDestination('https://hooks.example.com/events','webhook',{INTEGRATION_WEBHOOK_HOSTS:'hooks.example.com'}).hostname,'hooks.example.com');
 assert.throws(()=>validateDestination('https://hooks.slack.com.evil.com/services/T12345/B12345/abcdefghijklmnop','slack'));assert.throws(()=>validateDestination(SLACK+'?x=y','slack'));assert.equal(validateDestination(DISCORD,'discord').search,'');
 for(const address of ['127.0.0.1','10.0.0.1','172.16.4.2','169.254.169.254','100.64.0.1','198.19.1.1','224.0.0.1','::1','::ffff:127.0.0.1','fc00::1','fe80::1','2001:db8::1','2002:7f00:1::','2001::1','2001:0000::1','2001:2::1','3::1','2000:::1','2606:gggg::1','3fff::1'])assert.equal(publicAddress(address),false,address);
 assert.equal(publicAddress('8.8.8.8'),true);assert.equal(publicAddress('2606:4700:4700::1111'),true);
});
test('configuration encrypts secrets, revision fences writes and exposes signing key only on creation/rotation',async()=>{
 const {ledger,box,db}=setup();const c=await create(ledger,'webhook');assert.ok(c.signingSecret);assert.equal(c.integration.revision,1);let raw=db.prepare('SELECT body FROM live_integrations').get().body;assert.ok(!raw.includes('private-secret'));assert.ok(!raw.includes(c.signingSecret));assert.ok(!JSON.stringify(box.status()).includes('private-secret'));assert.ok(!JSON.stringify(box.status()).includes(c.signingSecret));
 assert.equal((await ledger.configureIntegration({action:'update',id:c.integration.id,expectedRevision:0,name:'Changed'})).status,409);
 const updated=await ledger.configureIntegration({action:'update',id:c.integration.id,expectedRevision:1,name:'Changed'});assert.equal(updated.integration.revision,2);assert.ok(!updated.signingSecret);
 const rotated=await ledger.configureIntegration({action:'rotate',id:c.integration.id,expectedRevision:2});assert.ok(rotated.signingSecret);assert.notEqual(rotated.signingSecret,c.signingSecret);
 const other=setup({db,env:{TOKEN_ENCRYPTION_KEY:Buffer.alloc(32,8).toString('base64')}});assert.equal((await other.ledger.configureIntegration({action:'update',id:c.integration.id,expectedRevision:3,name:'No'})).status,400);
});
test('booking state and outbox commit together with stable deduplication and privacy defaults',async()=>{
 const {ledger,box,db}=setup();await create(ledger);const b=booking();ledger.putBooking(b);ledger.putBooking(b);assert.equal(box.status().deliveryCount,1);
 assert.throws(()=>ledger.ctx.storage.transactionSync(()=>{box.enqueueBooking(booking({id:'rollback',requestKey:'rollback'}),null);throw Error('rollback');}));assert.equal(box.status().deliveryCount,1);
 const raw=db.prepare('SELECT body FROM live_integration_deliveries').get().body;for(const secret of [b.name,b.email,b.tokenRecovery,b.tokenHash])assert.ok(!raw.includes(secret),secret);
 b.status='confirmed';ledger.putBooking(b);b.status='cancelled';b.replacementConfirmed=true;b.successorId='new_booking';ledger.putBooking(b);
 assert.deepEqual(new Set(box.status().deliveries.map(d=>d.eventType)),new Set(['booking.requested','booking.confirmed','booking.rescheduled']));
});
test('generic webhook sends stable signed payload and discards response text; repeats do not send twice after acknowledgement',async()=>{
 const calls=[];const {ledger,box}=setup({fetch:async(u,o)=>{calls.push({u,o});return new Response('do not persist provider body',{status:200});}});const c=await create(ledger,'webhook');ledger.putBooking(booking());await box.processBatch();assert.equal(calls.length,1);const event=JSON.parse(calls[0].o.body),h=calls[0].o.headers;assert.equal(h['x-scheduling-event-id'],event.id);assert.equal(h['user-agent'],'Scheduling-Webhooks/1');assert.equal(h['x-scheduling-signature'],await signature(c.signingSecret,h['x-scheduling-timestamp'],calls[0].o.body));assert.equal(calls[0].o.redirect,'manual');assert.equal(box.status().deliveries[0].state,'delivered');await box.processBatch();assert.equal(calls.length,1);assert.ok(!JSON.stringify(box.status()).includes('do not persist'));
});
test('Slack and Discord cannot turn guest strings into mentions, and guest fields require opt-in',()=>{
 const event={type:'booking.confirmed',booking:{title:'@everyone <@U123> <!channel>'},guest:{name:'@here',email:'guest@example.com'}};
 const slack=adapterPayload('slack',event);assert.equal(slack.blocks[0].text.type,'plain_text');assert.equal(slack.link_names,false);assert.ok(!slack.text.includes('@'));assert.ok(!slack.text.includes('<'));
 assert.deepEqual(adapterPayload('discord',event).allowed_mentions,{parse:[]});
});
test('rate limiting schedules bounded retry with stable event identity and manual retries never alter bookings',async()=>{
 let calls=0;const {ledger,box}=setup({fetch:async()=>{calls++;return new Response('',{status:429,headers:{'retry-after':'120'}});}});await create(ledger);ledger.putBooking(booking());await box.processBatch();const first=box.status().deliveries[0],raw=box.delivery(first.id);assert.equal(first.state,'retry');assert.ok(first.nextAttemptAt>=Date.now()+119000);await at(raw.due,()=>box.processBatch());assert.equal(calls,2);assert.equal(box.status().deliveries[0].eventId,first.eventId);assert.equal((await box.retry({deliveryId:first.id})).status,409);
 box.fetch=async()=>new Response('',{status:400});await at(box.delivery(first.id).due,()=>box.processBatch());assert.equal(box.status().deliveries[0].state,'failed');const before=ledger.booking(booking().id);assert.equal((await box.retry({deliveryId:first.id})).eventId,first.eventId);assert.deepEqual(ledger.booking(before.id),before);
});
test('removal and configuration changes cancel queued jobs and fence in-flight acknowledgements',async()=>{
 let release;const pending=new Promise(resolve=>release=resolve);const {ledger,box}=setup({fetch:async()=>pending});const c=await create(ledger);ledger.putBooking(booking());const id=box.status().deliveries[0].id;const process=box.process(id);while(box.delivery(id).state!=='in_flight')await Promise.resolve();await ledger.configureIntegration({action:'update',id:c.integration.id,expectedRevision:1,enabled:false});release(new Response('',{status:200}));await process;assert.equal(box.delivery(id).state,'cancelled');assert.equal((await box.retry({deliveryId:id})).status,409);
});
test('freeze prevents tests and batch effects; restore quarantine blocks replay and resume until discarded',async()=>{
 let calls=0;const {ledger,box}=setup({fetch:async()=>{calls++;return new Response('',{status:200});}});const c=await create(ledger);ledger.putBooking(booking());ledger.putOperationalMeta(FENCE_META,{frozen:true,epoch:1});await box.processBatch();assert.equal(calls,0);assert.equal((await box.test({id:c.integration.id})).status,503);
 ledger.quarantineQueuedDeliveries();const d=box.status().deliveries[0];assert.equal(d.state,'quarantined');assert.equal((await ledger.setMaintenance({action:'resume',expectedEpoch:1})).code,'integration_restore_quarantine');assert.equal((await box.retry({deliveryId:d.id})).status,503);assert.equal((await box.retry({deliveryId:d.id,action:'discard'})).ok,true);assert.equal(box.quarantinedCount(),0);assert.equal(calls,0);
});
test('restart retains outbox; stale in-flight lease retries with same event id and synthetic tests carry no real booking data',async()=>{
 let calls=0;const {ledger,box,db}=setup({fetch:async()=>{calls++;throw Error('ambiguous timeout');}});const c=await create(ledger);ledger.putBooking(booking());await box.processBatch();const id=box.status().deliveries[0].id,eventId=box.delivery(id).eventId;const restarted=setup({db,fetch:async()=>{calls++;return new Response('',{status:200});}});await at(box.delivery(id).due,()=>restarted.box.processBatch());assert.equal(restarted.box.delivery(id).eventId,eventId);assert.equal(restarted.box.delivery(id).state,'delivered');assert.equal(calls,2);
 const testResult=await restarted.box.test({id:c.integration.id});const testJob=restarted.box.delivery(testResult.deliveryId);assert.equal(testJob.event.type,'integration.test');assert.ok(!JSON.stringify(testJob).includes('Private Name'));assert.ok(!JSON.stringify(testJob).includes('private@example.com'));assert.ok(restarted.alarm());
});

test('cosmetic rename preserves queued and in-flight accepted payloads',async()=>{
 let release,started;const began=new Promise(r=>started=r),pending=new Promise(r=>release=r);const {ledger,box}=setup({fetch:async()=>{started();return pending;}});const c=await create(ledger);ledger.putBooking(booking());const id=box.status().deliveries[0].id,run=box.process(id);await began;await ledger.configureIntegration({action:'update',id:c.integration.id,expectedRevision:1,name:'Renamed'});release(new Response(null,{status:204}));await run;assert.equal(box.delivery(id).state,'delivered');assert.equal(box.status().integrations[0].name,'Renamed');
});
test('external time edits and guest replacements emit rescheduled with actual new time',async()=>{
 const {ledger,box}=setup();await create(ledger);const old=booking({status:'confirmed'});ledger.putBooking(old);const moved={...old,start:old.start+900000,end:old.end+900000,version:2};ledger.putBooking(moved);let events=box.status().deliveries.filter(d=>d.eventType==='booking.rescheduled');assert.equal(events.length,1);assert.equal(box.delivery(events[0].id).event.booking.start,moved.start);
 const next=booking({id:'booking_successor_12345',requestKey:'new-request',status:'confirmed',start:moved.start+3600000,end:moved.end+3600000});ledger.putBooking(next);ledger.putBooking({...moved,status:'cancelled',version:3,replacementConfirmed:true,successorId:next.id});events=box.status().deliveries.filter(d=>d.eventType==='booking.rescheduled');assert.equal(events.length,2);const replacement=events.map(d=>box.delivery(d.id).event).find(e=>e.booking.id===next.id);assert.equal(replacement.booking.start,next.start);assert.deepEqual(replacement.previousBooking,{id:old.id,start:moved.start,end:moved.end});
});
test('rate limit cooldown applies to all jobs for the same integration',async()=>{
 let calls=0;const {ledger,box}=setup({fetch:async()=>{calls++;return new Response(null,{status:429,headers:{'retry-after':'120'}});}});await create(ledger);ledger.putBooking(booking());ledger.putBooking(booking({id:'booking_other_123456789',requestKey:'other-request'}));await box.processBatch();assert.equal(calls,1);assert.ok(box.status().deliveries.every(d=>d.nextAttemptAt>=Date.now()+119000));
});
test('resume checks restored integration quarantine after asynchronous fence discovery',async()=>{
 const {ledger,box}=setup();await create(ledger);ledger.putBooking(booking());ledger.putOperationalMeta(FENCE_META,{frozen:true,epoch:1});let release,read;const began=new Promise(r=>read=r),pending=new Promise(r=>release=r);let remote={epoch:2,frozen:true,version:1};let first=true;ledger.fenceStore={get:async()=>{if(first){first=false;read();await pending;}return remote;},compareAndSwap:async(version,next)=>{if(remote.version!==version)return false;remote=next;return true;}};
 const resume=ledger.setMaintenance({action:'resume',expectedEpoch:3});await began;release();const result=await resume;assert.equal(result.code,'integration_restore_quarantine');assert.equal(ledger.maintenanceFrozen(),true);assert.equal(box.quarantinedCount(),1);
});
test('startup alarm repair schedules webhook-only work without sending it',async()=>{
 let calls=0;const {ledger,box,alarm}=setup({fetch:async()=>{calls++;return new Response(null,{status:204});}});await create(ledger);ledger.putBooking(booking({status:'failed'}));await ledger.resumeConfirmedSync();assert.equal(calls,0);assert.ok(alarm());assert.equal(box.healthSummary().queued,1);
});
test('operations reports webhook-only missing alarms and quarantines without payload data',async()=>{
 const {ledger,box}=setup();await create(ledger);ledger.putBooking(booking({status:'failed'}));let status=await ledger.operationalStatus();assert.ok(status.issues.some(i=>i.code==='alarm_missing'));assert.equal(status.integrations.queued,1);ledger.quarantineQueuedDeliveries();status=await ledger.operationalStatus();assert.ok(status.issues.some(i=>i.code==='integration_restore_quarantine'));const raw=JSON.stringify(status);assert.ok(!raw.includes('private@example.com'));assert.ok(!raw.includes('hooks.slack.com'));assert.equal(box.quarantinedCount(),1);
});

test('default DNS preflight rejects private answers and manual redirects never reach their target',async()=>{
 let destinations=0;const {ledger,box}=setup({resolve:null,fetch:async(url,options)=>{if(url.startsWith('https://cloudflare-dns.com/'))return Response.json({Status:0,Answer:[{type:1,data:'127.0.0.1'}]});destinations++;return new Response(null,{status:302,headers:{location:'https://127.0.0.1/'}});}});await create(ledger);ledger.putBooking(booking());await box.processBatch();assert.equal(destinations,0);assert.equal(box.status().deliveries[0].errorCode,'destination_not_public');
 const second=setup({resolve:null,fetch:async(url,options)=>{if(url.startsWith('https://cloudflare-dns.com/'))return Response.json({Status:0,Answer:[{type:1,data:'93.184.216.34'}]});destinations++;assert.equal(options.redirect,'manual');return new Response(null,{status:302,headers:{location:'https://127.0.0.1/'}});}});await create(second.ledger);second.ledger.putBooking(booking());await second.box.processBatch();assert.equal(destinations,1);assert.equal(second.box.status().deliveries[0].state,'failed');assert.equal(second.box.status().deliveries[0].errorCode,'provider_rejected');
});
test('an operator removing a custom host approval does not prevent pausing or removing its integration',async()=>{
 const {ledger}=setup();const c=await create(ledger,'webhook');ledger.env.INTEGRATION_WEBHOOK_HOSTS='';const paused=await ledger.configureIntegration({action:'update',id:c.integration.id,expectedRevision:1,enabled:false});assert.equal(paused.integration.enabled,false);assert.equal((await ledger.configureIntegration({action:'remove',id:c.integration.id,expectedRevision:2})).ok,true);
});

function companyMail({get,identityGet}={}){
 let workspace={id:'host',version:1,members:[{id:'owner-old',email:'old@company.test',role:'owner'}]};
 const {ledger}=setup({profile:{id:'host',name:'Company',workspaceKind:'company',email:'old@company.test'},env:{PUBLIC_ORIGIN:'https://meet.example.test',RESEND_API_KEY:'mock',MAIL_FROM:'notify@example.test',AUTH:{getByName:key=>{if(key.startsWith('lifecycle:'))return {get:async()=>null};if(key.startsWith('identity:'))return {get:identityGet||(async()=>null)};assert.equal(key,'workspace:host');return {get:get||(async()=>structuredClone(workspace))};}}}});
 const b=booking({status:'awaiting_approval',config:{requiresApproval:true},approvalExpiresAt:Date.now()+3600000});ledger.putBooking(b);const job=()=>JSON.parse(ledger.rows("SELECT body FROM live_jobs WHERE json_extract(body,'$.kind')='approval_requested_host'")[0]?.body||'null');
 return {ledger,b,job,transfer(){workspace={id:'host',version:2,members:[{id:'owner-new',email:'new@company.test',role:'owner'}]};},setWorkspace:value=>{workspace=value;},workspace:()=>structuredClone(workspace)};
}
test('company host emails resolve the current owner and never use a removed creator address',async()=>{
 const h=companyMail();h.transfer();const sent=[];h.ledger.notify=async(_,p)=>{sent.push(p);return {id:'sent'};};await h.ledger.processJob(h.job());assert.equal(sent.length,1);assert.equal(sent[0].to,'new@company.test');assert.match(sent[0].text,/studio\?workspace=host#booking=/);assert.ok(!JSON.stringify(sent).includes('old@company.test'));assert.equal(h.job(),null);
});
test('company owner change during awaited preparation defers unattempted mail for the new owner',async()=>{
 let release,began,reads=0;const started=new Promise(r=>began=r),pending=new Promise(r=>release=r);let h;h=companyMail({get:async()=>{reads++;if(reads===2){began();await pending;}return h.workspace();}});const sent=[];h.ledger.notify=async(_,p)=>{sent.push(p);return {id:'sent'};};const run=h.ledger.processJob(h.job());await started;h.transfer();release();await run;assert.equal(sent.length,0);const deferred=h.job();assert.ok(deferred);assert.ok(!deferred.firstAttemptAt);assert.ok(!deferred.payloadCiphertext);assert.equal(deferred.leaseUntil,0);await h.ledger.processJob(deferred);assert.equal(sent.length,1);assert.equal(sent[0].to,'new@company.test');
});
test('attempted company owner mail is parked unchanged after transfer, never redirected',async()=>{
 const h=companyMail(),sent=[];h.ledger.notify=async(_,p)=>{sent.push(p);throw Object.assign(Error('unknown outcome'),{retryable:true});};await h.ledger.processJob(h.job());const first=h.job(),ciphertext=first.payloadCiphertext;assert.equal(sent.length,1);h.transfer();await h.ledger.processJob(first);const parked=h.job();assert.equal(parked.requiresAttention,true);assert.equal(parked.payloadCiphertext,ciphertext);assert.equal(sent.length,1);assert.equal(sent[0].to,'old@company.test');
});
test('company missing/unavailable/ambiguous owner authority fails closed while guest mail is unchanged',async()=>{
 for(const value of [null,{id:'host',members:[]},{id:'host',members:[{id:'one',email:'a@company.test',role:'owner'},{id:'two',email:'b@company.test',role:'owner'}]}]){const h=companyMail();h.setWorkspace(value);let sent=0;h.ledger.notify=async()=>{sent++;};await h.ledger.processJob(h.job());assert.equal(sent,0);assert.ok(!h.job().firstAttemptAt);}
 const unavailable=companyMail({get:async()=>{throw Error('AUTH unavailable');}});let sent=0;unavailable.ledger.notify=async()=>{sent++;};await unavailable.ledger.processJob(unavailable.job());assert.equal(sent,0);
 const h=companyMail({get:async()=>{throw Error('AUTH unavailable');}}),guest=JSON.parse(h.ledger.rows("SELECT body FROM live_jobs WHERE json_extract(body,'$.kind')='approval_requested_guest'")[0].body);h.b.tokenRecovery=await import('../src/crypto.js').then(c=>c.encryptTokens({token:'guest-token'},KEY,'host'));h.ledger.putBooking(h.b);h.ledger.notify=async(_,p)=>{assert.equal(p.to,'private@example.com');return {id:'guest'};};await h.ledger.processJob(guest);assert.ok(!h.ledger.rows('SELECT id FROM live_jobs WHERE id=?',guest.id).length);
});
test('company host approval jobs do not depend on a stale profile email',()=>{
 const h=companyMail(),profile=h.ledger.meta('profile');delete profile.email;h.ledger.putMeta('profile',profile);h.ledger.sql.exec('DELETE FROM live_jobs');h.ledger.putBooking({...h.b,id:'company_new_request_123',requestKey:'next-request'});assert.ok(h.job());
});

test('Discord destinations round-trip through encrypted storage, delivery and cosmetic updates',async()=>{
 const requests=[];const {ledger,box}=setup({fetch:async(url,options)=>{requests.push({url,body:JSON.parse(options.body)});return new Response('{}',{status:200});}});
 const created=await create(ledger,'discord');assert.ok(created.integration);ledger.putBooking(booking());await box.processBatch();assert.equal(requests.length,1);assert.equal(new URL(requests[0].url).search,'?wait=true');assert.deepEqual(requests[0].body.allowed_mentions,{parse:[]});assert.equal(box.status().deliveries[0].state,'delivered');
 const renamed=await ledger.configureIntegration({action:'update',id:created.integration.id,expectedRevision:created.integration.revision,name:'Renamed'});assert.equal(renamed.integration.name,'Renamed');
});
test('cosmetic edits preserve a destination cooldown imposed by a rate limit',async()=>{
 let calls=0;const {ledger,box}=setup({fetch:async()=>{calls++;return new Response('',{status:429,headers:{'retry-after':'120'}});}});const created=await create(ledger);ledger.putBooking(booking());await box.processBatch();const cooldown=box.config(created.integration.id).cooldownUntil;assert.ok(cooldown>Date.now());
 const renamed=await ledger.configureIntegration({action:'update',id:created.integration.id,expectedRevision:created.integration.revision,name:'Renamed'});assert.ok(renamed.integration);assert.equal(box.config(created.integration.id).cooldownUntil,cooldown);ledger.putBooking(booking({id:'another-booking-id-0001',requestKey:'another-request-key-0001'}));await box.processBatch();assert.equal(calls,1);
});

test('expired host notification processor cannot send after a replacement processor completes',async()=>{
 let release,began,reads=0;const started=new Promise(r=>began=r),pending=new Promise(r=>release=r);let h;h=companyMail({get:async()=>{if(++reads===1){began();await pending;}return h.workspace();}});const sent=[];h.ledger.notify=async(_,p)=>{sent.push(p);return {id:'sent'};};const originalNow=Date.now;let now=originalNow();Date.now=()=>now;
 try{const first=h.ledger.processJob(h.job());await started;now+=31000;await h.ledger.processJob(h.job());assert.equal(sent.length,1);assert.equal(h.job(),null);release();await first;assert.equal(sent.length,1);assert.equal(h.job(),null);assert.equal(h.ledger.rows('SELECT COUNT(*) AS n FROM live_notification_receipts')[0].n,1);}finally{Date.now=originalNow;release();}
});
test('stale host authority errors cannot overwrite the replacement processor retry state',async()=>{
 let release,began,reads=0;const started=new Promise(r=>began=r),pending=new Promise(r=>release=r);let h;h=companyMail({get:async()=>{if(++reads===1){began();await pending;throw Error('late AUTH failure');}return h.workspace();}});h.ledger.notify=async()=>{throw Object.assign(Error('provider unavailable'),{retryable:true});};const originalNow=Date.now;let now=originalNow();Date.now=()=>now;
 try{const first=h.ledger.processJob(h.job());await started;now+=31000;await h.ledger.processJob(h.job());const second=h.job();assert.equal(second.attempts,1);assert.ok(second.payloadCiphertext);release();await first;assert.deepEqual(h.job(),second);}finally{Date.now=originalNow;release();}
});
test('stale provider acknowledgements and failures cannot rewrite replacement guest jobs',async()=>{
 for(const lateFailure of [false,true]){const h=companyMail(),crypto=await import('../src/crypto.js');h.b.tokenRecovery=await crypto.encryptTokens({token:'guest-token'},KEY,'host');h.ledger.putBooking(h.b);const guest=()=>JSON.parse(h.ledger.rows("SELECT body FROM live_jobs WHERE json_extract(body,'$.kind')='approval_requested_guest'")[0]?.body||'null');let release,began,calls=0;const started=new Promise(r=>began=r),pending=new Promise(r=>release=r);h.ledger.notify=async()=>{if(++calls===1){began();await pending;if(lateFailure)throw Object.assign(Error('late failure'),{retryable:true});}return {id:'sent'};};const originalNow=Date.now;let now=originalNow();Date.now=()=>now;
 try{const first=h.ledger.processJob(guest());await started;now+=31000;await h.ledger.processJob(guest());assert.equal(guest(),null);release();await first;assert.equal(guest(),null);assert.equal(h.ledger.rows('SELECT COUNT(*) AS n FROM live_notification_receipts')[0].n,1);}finally{Date.now=originalNow;release();}}
});
test('company owner notifications prefer current verified identity and fail closed on invalid identity authority',async()=>{
 const h=companyMail({identityGet:async()=>({hostId:'owner-old',email:'current@company.test',version:2})}),sent=[];h.ledger.notify=async(_,p)=>{sent.push(p);return {id:'sent'};};await h.ledger.processJob(h.job());assert.equal(sent[0].to,'current@company.test');
 for(const identityGet of [async()=>{throw Error('identity unavailable');},async()=>({hostId:'another-user',email:'wrong@company.test'}),async()=>({hostId:'owner-old',email:'invalid'})]){const failed=companyMail({identityGet});let calls=0;failed.ledger.notify=async()=>{calls++;};await failed.ledger.processJob(failed.job());assert.equal(calls,0);assert.ok(!failed.job().firstAttemptAt);}
});

test('expired guest preparation cannot send after another processor completes',async()=>{
 const h=companyMail(),c=await import('../src/crypto.js');h.b.tokenRecovery=await c.encryptTokens({token:'guest-token'},KEY,'host');h.ledger.putBooking(h.b);const guest=()=>JSON.parse(h.ledger.rows("SELECT body FROM live_jobs WHERE json_extract(body,'$.kind')='approval_requested_guest'")[0]?.body||'null');let release,began,reads=0;const started=new Promise(r=>began=r),pending=new Promise(r=>release=r),decrypt=crypto.subtle.decrypt;crypto.subtle.decrypt=async function(...args){if(++reads===1){began();await pending;}return decrypt.apply(this,args);};let calls=0;h.ledger.notify=async()=>{calls++;return {id:'sent'};};const originalNow=Date.now;let now=originalNow();Date.now=()=>now;
 try{const first=h.ledger.processJob(guest());await started;now+=31000;await h.ledger.processJob(guest());assert.equal(calls,1);release();await first;assert.equal(calls,1);assert.equal(guest(),null);assert.equal(h.ledger.rows('SELECT COUNT(*) AS n FROM live_notification_receipts')[0].n,1);}finally{crypto.subtle.decrypt=decrypt;Date.now=originalNow;release();}
});
test('fresh owner identity email changes defer unattempted mail and park attempted old-address mail',async()=>{
 let identity={hostId:'owner-old',email:'old@company.test',version:1},reads=0,release,began;const started=new Promise(r=>began=r),pending=new Promise(r=>release=r);const h=companyMail({identityGet:async()=>{if(++reads===2){began();await pending;}return structuredClone(identity);}});const sent=[];h.ledger.notify=async(_,p)=>{sent.push(p);return {id:'sent'};};const run=h.ledger.processJob(h.job());await started;identity={hostId:'owner-old',email:'new@company.test',version:2};release();await run;assert.equal(sent.length,0);assert.ok(!h.job().payloadCiphertext);await h.ledger.processJob(h.job());assert.equal(sent[0].to,'new@company.test');
 let target={hostId:'owner-old',email:'old@company.test',version:1};const attempted=companyMail({identityGet:async()=>target});let calls=0;attempted.ledger.notify=async()=>{calls++;throw Object.assign(Error('unknown'),{retryable:true});};await attempted.ledger.processJob(attempted.job());const original=attempted.job().payloadCiphertext;target={hostId:'owner-old',email:'new@company.test',version:2};await attempted.ledger.processJob(attempted.job());assert.equal(calls,1);assert.equal(attempted.job().requiresAttention,true);assert.equal(attempted.job().payloadCiphertext,original);
});
