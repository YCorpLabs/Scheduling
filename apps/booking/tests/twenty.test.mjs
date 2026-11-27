import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {BookingLedger} from '../src/ledger.js';
import {validateDestination} from '../src/integrations.js';
import {TWENTY_CLOUD_URL,validateTwentyDestination,validateTwentyApiKey,splitName,normalizeEmail,twentyNote} from '../src/twenty.js';
import {FENCE_META} from '../src/maintenance.js';

const KEY=Buffer.alloc(32,7).toString('base64');
const API_KEY='twenty_test_api_key_1234567890abcdef';

function setup({db=new DatabaseSync(':memory:'),fetch=async()=>Response.json({data:{people:[]}}),resolve=async()=>['93.184.216.34'],env={},profile={id:'host',name:'Host'}}={}){
  let alarm=null;
  const storage={
    sql:{exec(q,...v){const rows=db.prepare(q).all(...v);return {toArray:()=>rows};}},
    transactionSync(fn){db.exec('BEGIN');try{const r=fn();db.exec('COMMIT');return r;}catch(e){db.exec('ROLLBACK');throw e;}},
    setAlarm:async n=>{alarm=n;},
    getAlarm:async()=>alarm
  };
  const ledger=new BookingLedger({storage},{TOKEN_ENCRYPTION_KEY:KEY,...env},{integrations:{fetch,resolve}});
  ledger.init(profile);
  return {db,ledger,box:ledger.integrations,alarm:()=>alarm};
}

const booking=(extra={})=>({
  id:'booking_twenty_1234567890',
  requestKey:'req-twenty-1',
  meetingTypeId:'intro',
  meetingTypeSlug:'intro',
  title:'Discovery call',
  start:Date.UTC(2026,10,17,13,0),
  end:Date.UTC(2026,10,17,13,30),
  status:'confirmed',
  version:1,
  name:'Ada Lovelace',
  email:'Ada@Example.com',
  tokenRecovery:'private-capability',
  tokenHash:'private-hash',
  ...extra
});

const at=async(t,fn)=>{const now=Date.now;Date.now=()=>t;try{return await fn();}finally{Date.now=now;}};

test('Twenty URL validation accepts Twenty Cloud and approved self-hosted origins and rejects unsafe URLs',()=>{
  assert.equal(validateTwentyDestination('https://api.twenty.com').origin,TWENTY_CLOUD_URL);
  assert.equal(validateTwentyDestination('https://api.twenty.com/').origin,TWENTY_CLOUD_URL);
  assert.equal(validateTwentyDestination('https://api.twenty.com/rest').origin,TWENTY_CLOUD_URL);
  assert.equal(validateTwentyDestination('https://api.twenty.com/rest/').origin,TWENTY_CLOUD_URL);
  assert.equal(validateDestination('https://api.twenty.com/rest','twenty').origin,TWENTY_CLOUD_URL);
  assert.equal(validateTwentyDestination('https://crm.acme.org/rest',{INTEGRATION_TWENTY_HOSTS:'crm.acme.org'}).origin,'https://crm.acme.org');

  assert.throws(()=>validateTwentyDestination('https://crm.acme.org',{}),err=>err.code==='twenty_host_not_approved');
  for(const bad of [
    'http://api.twenty.com',
    'https://api.twenty.com:8443',
    'https://user:pass@api.twenty.com',
    'https://api.twenty.com/rest/people',
    'https://api.twenty.com?token=1',
    'https://api.twenty.com#frag',
    'https://api.twenty.com\\@evil.com',
    'https://127.0.0.1',
    'https://localhost',
    'https://api.twenty.com.evil.org'
  ]){
    assert.throws(()=>validateTwentyDestination(bad,{INTEGRATION_TWENTY_HOSTS:'127.0.0.1,localhost'}),bad);
  }
});

test('Twenty API key validation, name splitting, email normalisation and markdown escaping',()=>{
  assert.equal(validateTwentyApiKey('  '+API_KEY+'  '),API_KEY);
  for(const bad of ['',null,undefined,'short','has space here','line\nbreak','non-ascii-éééééééé']){
    assert.throws(()=>validateTwentyApiKey(bad),String(bad));
  }
  assert.deepEqual(splitName('Ada Lovelace','ada@example.com'),{firstName:'Ada',lastName:'Lovelace'});
  assert.deepEqual(splitName('Grace Brewster Hopper','g@example.com'),{firstName:'Grace',lastName:'Brewster Hopper'});
  assert.deepEqual(splitName('Prince','p@example.com'),{firstName:'Prince',lastName:''});
  assert.deepEqual(splitName('','ada.lovelace@example.com'),{firstName:'ada.lovelace',lastName:''});
  assert.equal(normalizeEmail(' Ada@Example.COM '), 'ada@example.com');
  assert.equal(normalizeEmail('not-an-email'), '');
  assert.equal(normalizeEmail('bad"quote@example.com'), '');

  const note=twentyNote({
    type:'booking.rescheduled',
    booking:{id:'bk_1',title:'Intro [call](https://evil.test)',start:Date.UTC(2026,10,17,13,0),end:Date.UTC(2026,10,17,13,30),status:'confirmed'},
    previousBooking:{start:Date.UTC(2026,10,16,13,0),end:Date.UTC(2026,10,16,13,30)},
    guest:{name:'[Click](https://phish.test) **now**',email:'ada@example.com'}
  });
  assert.equal(note.title,'Booking rescheduled: Intro [call](https://evil.test)');
  assert.match(note.bodyV2.markdown,/^\*\*Booking rescheduled\*\*/);
  assert.match(note.bodyV2.markdown,/2026-11-17 13:00 UTC – 13:30 UTC/);
  assert.match(note.bodyV2.markdown,/Previously: 2026-11-16 13:00 UTC – 13:30 UTC/);
  assert.ok(!note.bodyV2.markdown.includes('https://phish.test'));
  assert.ok(!note.bodyV2.markdown.includes('https://evil.test'));
});

test('Twenty configuration encrypts API key, defaults cloud URL and guest sync, and never leaks secrets',async()=>{
  const {ledger,box,db}=setup();
  const missingKey=await ledger.configureIntegration({kind:'twenty',name:'Twenty CRM'});
  assert.equal(missingKey.status,400);

  const created=await ledger.configureIntegration({kind:'twenty',name:'Sales CRM',apiKey:API_KEY});
  assert.ok(created.integration);
  assert.equal(created.integration.kind,'twenty');
  assert.equal(created.integration.destinationLabel,'api.twenty.com');
  assert.equal(created.integration.includeGuestDetails,true);
  assert.equal(created.signingSecret,undefined);

  const raw=db.prepare('SELECT body FROM live_integrations').get().body;
  assert.ok(!raw.includes(API_KEY));
  assert.ok(!JSON.stringify(box.status()).includes(API_KEY));
  assert.ok(box.status().capabilities.kinds.includes('twenty'));

  // Cosmetic rename preserves API key without requiring it again.
  const renamed=await ledger.configureIntegration({action:'update',id:created.integration.id,expectedRevision:1,name:'CRM'});
  assert.equal(renamed.integration.name,'CRM');
  assert.equal(renamed.integration.revision,2);

  // Rotate action is only for generic webhooks.
  assert.equal((await ledger.configureIntegration({action:'rotate',id:created.integration.id,expectedRevision:2})).status,400);

  // Replacing API key succeeds and stays encrypted.
  const newKey='twenty_rotated_key_9876543210fedcba';
  const replaced=await ledger.configureIntegration({action:'update',id:created.integration.id,expectedRevision:2,apiKey:newKey});
  assert.equal(replaced.integration.revision,3);
  assert.ok(!db.prepare('SELECT body FROM live_integrations').get().body.includes(newKey));
});

test('Twenty connection test verifies credentials via GET /rest/people?limit=1 without mutating CRM records',async()=>{
  const requests=[];
  let status=200,body={data:{people:[]}};
  const {ledger,box}=setup({
    fetch:async(url,init)=>{
      requests.push({url,method:init.method,headers:init.headers,redirect:init.redirect});
      return new Response(typeof body==='string'?body:JSON.stringify(body),{status,headers:{'content-type':'application/json'}});
    }
  });
  const created=await ledger.configureIntegration({kind:'twenty',name:'Twenty',apiKey:API_KEY});
  const ok=await box.test({id:created.integration.id});
  assert.equal(ok.state,'delivered');
  assert.equal(requests.length,1);
  assert.equal(requests[0].method,'GET');
  assert.equal(requests[0].url,'https://api.twenty.com/rest/people?limit=1');
  assert.equal(requests[0].headers.authorization,'Bearer '+API_KEY);
  assert.equal(requests[0].redirect,'manual');

  status=401;body={error:'Unauthorized'};
  const unauthorized=await box.test({id:created.integration.id});
  assert.equal(unauthorized.state,'failed');
  assert.equal(unauthorized.errorCode,'provider_unauthorized');

  status=200;body='<html>not twenty</html>';
  const invalidJson=await box.test({id:created.integration.id});
  assert.equal(invalidJson.state,'failed');
  assert.equal(invalidJson.errorCode,'provider_rejected');
});

test('Twenty booking sync creates missing Person, creates Note and links NoteTarget, reusing existing Person on later events',async()=>{
  const calls=[];
  const people=new Map();
  let seq=0;
  const {ledger,box}=setup({
    fetch:async(url,init)=>{
      const u=new URL(url);
      const body=init.body?JSON.parse(init.body):null;
      calls.push({method:init.method,path:u.pathname+u.search,body,auth:init.headers.authorization});
      if(u.pathname==='/rest/people'&&init.method==='GET'){
        const found=[...people.values()].filter(p=>u.search.includes(encodeURIComponent(p.emails.primaryEmail)));
        return Response.json({data:{people:found}});
      }
      if(u.pathname==='/rest/people'&&init.method==='POST'){
        const p={id:'person_'+(++seq),...body};
        people.set(p.emails.primaryEmail,p);
        return Response.json({data:{createPerson:p}},{status:201});
      }
      if(u.pathname==='/rest/notes'&&init.method==='POST'){
        return Response.json({data:{createNote:{id:'note_'+(++seq),...body}}},{status:201});
      }
      if(u.pathname==='/rest/noteTargets'&&init.method==='POST'){
        return Response.json({data:{createNoteTarget:{id:'target_'+(++seq),...body}}},{status:201});
      }
      throw Error('Unexpected Twenty request: '+init.method+' '+u.href);
    }
  });
  await ledger.configureIntegration({kind:'twenty',name:'Twenty',apiKey:API_KEY,events:['booking.confirmed','booking.cancelled']});
  const b=booking();
  ledger.putBooking(b);
  await box.processBatch();

  assert.equal(box.status().deliveries[0].state,'delivered');
  assert.deepEqual(calls.map(c=>`${c.method} ${c.path.split('?')[0]}`),['GET /rest/people','POST /rest/people','POST /rest/notes','POST /rest/noteTargets']);
  assert.deepEqual(calls[1].body,{name:{firstName:'Ada',lastName:'Lovelace'},emails:{primaryEmail:'ada@example.com'}});
  assert.equal(calls[2].body.title,'Booking confirmed: Discovery call');
  assert.match(calls[2].body.bodyV2.markdown,/Ada Lovelace/);
  assert.deepEqual(calls[3].body,{noteId:'note_2',targetPersonId:'person_1'});

  // Cancelling the booking finds the existing Person and attaches a second Note without creating another Person.
  calls.length=0;
  ledger.putBooking({...b,status:'cancelled',version:2});
  await box.processBatch();
  assert.deepEqual(calls.map(c=>`${c.method} ${c.path.split('?')[0]}`),['GET /rest/people','POST /rest/notes','POST /rest/noteTargets']);
  assert.equal(calls[1].body.title,'Booking cancelled: Discovery call');
  assert.deepEqual(calls[2].body,{noteId:'note_4',targetPersonId:'person_1'});
  assert.equal(people.size,1);
});

test('Twenty retries resume from persisted provider IDs without creating duplicate People or Notes',async()=>{
  const calls=[];
  let failTargetOnce=true;
  const {ledger,box}=setup({
    fetch:async(url,init)=>{
      const u=new URL(url),body=init.body?JSON.parse(init.body):null;
      calls.push(`${init.method} ${u.pathname}`);
      if(u.pathname==='/rest/people'&&init.method==='GET')return Response.json({data:{people:[]}});
      if(u.pathname==='/rest/people'&&init.method==='POST')return Response.json({data:{createPerson:{id:'person_1',...body}}},{status:201});
      if(u.pathname==='/rest/notes'&&init.method==='POST')return Response.json({data:{createNote:{id:'note_1',...body}}},{status:201});
      if(u.pathname==='/rest/noteTargets'&&init.method==='POST'){
        if(failTargetOnce){failTargetOnce=false;return new Response('unavailable',{status:503});}
        return Response.json({data:{createNoteTarget:{id:'target_1',...body}}},{status:201});
      }
      throw Error('Unexpected: '+url);
    }
  });
  await ledger.configureIntegration({kind:'twenty',name:'Twenty',apiKey:API_KEY,events:['booking.confirmed']});
  ledger.putBooking(booking());
  await box.processBatch();

  const first=box.status().deliveries[0];
  assert.equal(first.state,'retry');
  assert.equal(first.errorCode,'provider_unavailable');
  assert.equal(first.providerState,undefined); // never exposed in public status
  assert.deepEqual(box.delivery(first.id).providerState,{personId:'person_1',noteId:'note_1'});

  calls.length=0;
  await at(box.delivery(first.id).due,()=>box.processBatch());
  // Retry only executes POST /rest/noteTargets; person and note are not duplicated.
  assert.deepEqual(calls,['POST /rest/noteTargets']);
  assert.equal(box.status().deliveries[0].state,'delivered');
  assert.equal(box.delivery(first.id).providerState,undefined);
});

test('Twenty handles duplicate-person race, pre-v1.17 personId fallback, anonymous notes and rate-limit cooldown',async()=>{
  const targetPayloads=[];
  let lookupCount=0;
  const {ledger,box}=setup({
    fetch:async(url,init)=>{
      const u=new URL(url),body=init.body?JSON.parse(init.body):null;
      if(u.pathname==='/rest/people'&&init.method==='GET'){
        lookupCount++;
        return Response.json({data:{people:lookupCount===1?[]:[{id:'person_raced',emails:{primaryEmail:'ada@example.com'}}]}});
      }
      if(u.pathname==='/rest/people'&&init.method==='POST')return Response.json({message:'Duplicate email'},{status:409});
      if(u.pathname==='/rest/notes'&&init.method==='POST')return Response.json({data:{createNote:{id:'note_legacy'}}},{status:201});
      if(u.pathname==='/rest/noteTargets'&&init.method==='POST'){
        targetPayloads.push(body);
        if('targetPersonId' in body)return Response.json({message:'Unknown field targetPersonId'},{status:400});
        return Response.json({data:{createNoteTarget:{id:'target_legacy'}}},{status:201});
      }
      throw Error('Unexpected: '+url);
    }
  });
  await ledger.configureIntegration({kind:'twenty',name:'Twenty',apiKey:API_KEY,events:['booking.confirmed']});
  ledger.putBooking(booking());
  await box.processBatch();
  assert.equal(box.status().deliveries[0].state,'delivered');
  assert.deepEqual(targetPayloads,[{noteId:'note_legacy',targetPersonId:'person_raced'},{noteId:'note_legacy',personId:'person_raced'}]);

  // With includeGuestDetails: false, no Person lookup/create happens and guest PII never leaves the host.
  const anonCalls=[];
  const anon=setup({
    fetch:async(url,init)=>{
      const u=new URL(url);
      anonCalls.push({method:init.method,path:u.pathname,body:init.body?JSON.parse(init.body):null});
      if(u.pathname==='/rest/notes')return Response.json({data:{createNote:{id:'note_anon'}}},{status:201});
      throw Error('Unexpected: '+url);
    }
  });
  await anon.ledger.configureIntegration({kind:'twenty',name:'Anon Twenty',apiKey:API_KEY,includeGuestDetails:false,events:['booking.confirmed']});
  anon.ledger.putBooking(booking());
  await anon.box.processBatch();
  assert.equal(anonCalls.length,1);
  assert.equal(anonCalls[0].path,'/rest/notes');
  assert.ok(!JSON.stringify(anonCalls).includes('Ada'));
  assert.ok(!JSON.stringify(anonCalls).includes('example.com'));

  // 429 triggers cooldown; maintenance freeze blocks test & delivery.
  const limited=setup({fetch:async()=>new Response('',{status:429,headers:{'retry-after':'90'}})});
  const c=await limited.ledger.configureIntegration({kind:'twenty',name:'Limited',apiKey:API_KEY,events:['booking.confirmed']});
  limited.ledger.putBooking(booking());
  await limited.box.processBatch();
  assert.equal(limited.box.status().deliveries[0].state,'retry');
  assert.equal(limited.box.status().deliveries[0].errorCode,'rate_limited');
  assert.ok(limited.box.config(c.integration.id).cooldownUntil>=Date.now()+89000);
  limited.ledger.putOperationalMeta(FENCE_META,{frozen:true,epoch:1});
  assert.equal((await limited.box.test({id:c.integration.id})).status,503);
});

test('self-hosted Twenty respects INTEGRATION_TWENTY_HOSTS and still allows pausing or removing after host removal',async()=>{
  const seen=[];
  const {ledger,box}=setup({
    env:{INTEGRATION_TWENTY_HOSTS:'crm.acme.org'},
    fetch:async(url)=>{seen.push(url);return Response.json({data:{people:[]}});}
  });
  const refused=await ledger.configureIntegration({kind:'twenty',name:'Other',url:'https://other.acme.org',apiKey:API_KEY});
  assert.equal(refused.status,400);
  assert.equal(refused.code,'twenty_host_not_approved');

  const created=await ledger.configureIntegration({kind:'twenty',name:'Self-hosted',url:'https://crm.acme.org/rest',apiKey:API_KEY});
  assert.equal(created.integration.destinationLabel,'crm.acme.org');
  assert.equal(box.status().customTwentyHostsConfigured,true);
  assert.equal((await box.test({id:created.integration.id})).state,'delivered');
  assert.equal(seen[0],'https://crm.acme.org/rest/people?limit=1');

  // Removing host approval still permits disabling and removing the integration.
  ledger.env.INTEGRATION_TWENTY_HOSTS='';
  const paused=await ledger.configureIntegration({action:'update',id:created.integration.id,expectedRevision:1,enabled:false});
  assert.equal(paused.integration.enabled,false);
  assert.equal((await ledger.configureIntegration({action:'remove',id:created.integration.id,expectedRevision:2})).ok,true);
});
