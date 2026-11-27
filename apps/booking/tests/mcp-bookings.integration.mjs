// Booking actions through the MCP on the real Worker. Google (sign-in and Calendar), DNS and Slack
// are faked at the runtime boundary; every booking state change runs the production ledger.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {sha256} from '../src/crypto.js';
import {GOOGLE_SCOPES} from '../src/google.js';
import {intakeRevision} from '../public/intake.js';

const ORIGIN='http://localhost',REDIRECT='http://127.0.0.1:33418/callback';
test('an agent approves, declines, reschedules and cancels bookings and connects Slack through the MCP',{timeout:90000},async()=>{
  const events=new Map(),codes=new Map(),slack=[],twenty=[];let sequence=0;
  const mf=new Miniflare(convertV4MiniflareOptions({workers:[{name:'mcp-bookings',modules:true,scriptPath:new URL('../dist/worker.js',import.meta.url).pathname,compatibilityDate:'2026-11-10',
    durableObjects:{HOSTS:{className:'BookingHost',useSQLite:true},LIVE_HOSTS:{className:'LiveBookingHost',useSQLite:true},AUTH:{className:'AuthStore',useSQLite:true}},
    bindings:{LIVE_ENABLED:'true',PUBLIC_ORIGIN:ORIGIN,GOOGLE_CLIENT_ID:'test-client',GOOGLE_CLIENT_SECRET:'test-secret',TOKEN_ENCRYPTION_KEY:Buffer.alloc(32,7).toString('base64')},
    outboundService:async request=>{
      const u=new URL(request.url),json=(x,status=200)=>Response.json(x,{status});
      if(u.hostname==='oauth2.googleapis.com'){const body=new URLSearchParams(await request.text()),entry=codes.get(body.get('code'));if(body.get('grant_type')==='refresh_token')return json({access_token:'access-refresh',expires_in:3600,scope:GOOGLE_SCOPES.join(' ')});return json({access_token:'access-'+body.get('code'),expires_in:3600,scope:entry?.calendar?GOOGLE_SCOPES.join(' '):'openid email profile',...(entry?.calendar?{refresh_token:'refresh-ada'}:{})});}
      if(u.hostname==='openidconnect.googleapis.com')return json({sub:'ada',email:'ada@example.com',email_verified:true,name:'Ada'});
      if(u.hostname==='cloudflare-dns.com')return json({Status:0,Answer:[{type:1,data:'93.184.216.34'}]});
      if(u.hostname==='hooks.slack.com'){slack.push(await request.json());return new Response('ok');}
      if(u.hostname==='api.twenty.com'){twenty.push({method:request.method,path:u.pathname+u.search,auth:request.headers.get('authorization')});return json({data:{people:[]}});}
      if(u.pathname.endsWith('/calendarList'))return json({items:[{id:'primary@example.com',summary:'Work',accessRole:'owner',timeZone:'Europe/Oslo'}]});
      if(u.pathname.endsWith('/freeBusy')){const q=await request.json();return json({calendars:Object.fromEntries(q.items.map(i=>[i.id,{busy:[]}]))});}
      if(u.pathname.endsWith('/events')&&request.method==='POST'){const e=await request.json(),id=e.id||'evt'+(++sequence);events.set(id,{...e,id,status:'confirmed',hangoutLink:e.conferenceData?'https://meet.google.com/abc-defg-hij':undefined,conferenceData:e.conferenceData?{...e.conferenceData,entryPoints:[{entryPointType:'video',uri:'https://meet.google.com/abc-defg-hij'}]}:undefined});return json(events.get(id));}
      if(u.pathname.includes('/events/')){const id=decodeURIComponent(u.pathname.split('/').at(-1));if(!events.has(id))return json({error:{message:'not found'}},404);
        if(request.method==='DELETE'){events.delete(id);return new Response(null,{status:204});}
        if(request.method==='PATCH'){events.set(id,{...events.get(id),...await request.json()});return json(events.get(id));}
        return json(events.get(id));}
      throw Error('Unexpected provider request: '+u.href);
    }}]}));
  const call=(path,{cookie,body,form,headers={},origin=ORIGIN}={})=>mf.dispatchFetch(ORIGIN+path,{redirect:'manual',method:body||form?'POST':'GET',
    headers:{...headers,...(cookie?{Cookie:cookie}:{}),...(body?{'Content-Type':'application/json',Origin:origin}:{}),...(form?{'Content-Type':'application/x-www-form-urlencoded',Origin:origin}:{})},
    ...(body?{body:JSON.stringify(body)}:{}),...(form?{body:new URLSearchParams(form).toString()}:{})});
  async function google({cookie,connect}={}){
    const begin=await call('/auth/google'+(connect?'?connect=1':''),{cookie});assert.equal(begin.status,302,await begin.clone().text());
    const state=new URL(begin.headers.get('Location')).searchParams.get('state'),binding=begin.headers.get('Set-Cookie').split(';')[0],code='code-'+(++sequence);codes.set(code,{calendar:!!connect});
    const done=await call('/auth/google/callback?state='+state+'&code='+code,{cookie:[cookie,binding].filter(Boolean).join('; ')});assert.equal(done.status,303,await done.clone().text());
    return done.headers.getSetCookie().find(v=>v.startsWith('email_booking_session='))?.split(';')[0];
  }
  try{
    const cookie=await google();await google({cookie,connect:true});
    assert.equal((await call('/api/live/calendars',{cookie,body:{accounts:[{id:'ada',destinationCalendarId:'primary@example.com',conflictCalendarIds:['primary@example.com']}]}})).status,200);

    // Connect an MCP client with a loopback redirect on a different port (RFC 8252).
    const client=await (await call('/oauth/register',{body:{client_name:'Claude Code',redirect_uris:['http://127.0.0.1/callback']}})).json();
    const verifier='x'.repeat(50),challenge=await sha256(verifier);
    const page=await (await call('/oauth/authorize?'+new URLSearchParams({response_type:'code',client_id:client.client_id,redirect_uri:REDIRECT,code_challenge:challenge,code_challenge_method:'S256'}),{cookie})).text();
    const sealed=/name="request" value="([^"]+)"/.exec(page)[1].replaceAll('&amp;','&');
    const code=new URL((await call('/oauth/authorize',{cookie,form:{request:sealed,account:'ada@example.com',decision:'allow'}})).headers.get('Location')).searchParams.get('code');
    const {access_token}=await (await call('/oauth/token',{form:{grant_type:'authorization_code',code,code_verifier:verifier,redirect_uri:REDIRECT,client_id:client.client_id}})).json();
    let id=0;const tool=async(name,args={},{expectError}={})=>{const r=await (await call('/mcp',{body:{jsonrpc:'2.0',id:++id,method:'tools/call',params:{name,arguments:args}},headers:{Authorization:'Bearer '+access_token}})).json();
      if(expectError){assert.equal(r.result.isError,true,name);return r.result.content[0].text;}assert.ok(!r.result.isError,`${name}: ${r.result.content?.[0]?.text}`);return r.result.structuredContent;};

    // An approval link with open hours every day, created by the agent.
    const everyDay=Object.fromEntries(['monday','tuesday','wednesday','thursday','friday','saturday','sunday'].map(d=>[d,['00:00-24:00']]));
    const {link}=await tool('create_link',{title:'Intro',duration_minutes:30,published:true,requires_approval:true,google_meet:true,hours:everyDay,settings:{notice:0}});assert.equal(link.requiresApproval,true);assert.equal(link.location,'Google Meet');
    const times=await tool('find_times',{link:link.slug,limit:5});assert.equal(times.slots.length,5);assert.match(times.slots[0].start,/[+-]\d{2}:\d{2}$/);

    const host=(await (await call('/api/bootstrap',{cookie})).json()).hostId,availability=await (await call(`/api/public/${host}/${link.slug}/availability`)).json();
    const book=async(slot,name)=>{const r=await call(`/api/public/${host}/${link.slug}/book`,{body:{intakeRevision:await intakeRevision(availability.config),start:availability.slots[slot].start,idempotencyKey:crypto.randomUUID(),name,email:name.toLowerCase()+'@example.com',timeZone:'Europe/Oslo',answers:{}}});assert.equal(r.status,200,await r.clone().text());return (await r.json()).booking;};
    const first=await book(2,'Grace'),second=await book(6,'Linus');assert.equal(first.status,'awaiting_approval');

    const requests=await tool('list_bookings',{view:'requests'});assert.deepEqual(requests.bookings.map(b=>b.guestProvided.name),['Grace','Linus']);assert.ok(requests.bookings[0].approvalExpires);
    const overview=await tool('get_overview');assert.equal(overview.requests.length,2);
    const approved=await tool('decide_booking',{booking_id:first.id,decision:'approve'});assert.equal(approved.booking.status,'confirmed');assert.equal(events.size,1);
    const declined=await tool('decide_booking',{booking_id:second.id,decision:'decline',reason:'Fully booked that week'});assert.equal(declined.booking.status,'rejected');
    assert.match(await tool('decide_booking',{booking_id:first.id,decision:'approve'},{expectError:true}),/not waiting for approval/);

    const options=await tool('reschedule_options',{booking_id:first.id,limit:3});assert.equal(options.slots.length,3);
    const moved=await tool('reschedule_booking',{booking_id:first.id,start:options.slots[2].start});assert.equal(moved.booking.status,'confirmed');assert.equal(moved.booking.start,options.slots[2].start);
    const upcoming=await tool('list_bookings');assert.equal(upcoming.bookings.length,1);const current=upcoming.bookings[0];assert.equal(current.start,options.slots[2].start);
    assert.equal((await tool('get_booking',{booking_id:current.id})).booking.guestProvided.email,'grace@example.com');
    const cancelled=await tool('cancel_booking',{booking_id:current.id,reason:'Out sick'});assert.ok(['cancelling','cancelled'].includes(cancelled.booking.status));assert.equal((await tool('list_bookings',{view:'cancelled'})).bookings.filter(b=>b.guestProvided.name==='Grace').length>=1,true);assert.equal((await tool('list_bookings')).bookings.length,0);
    assert.match(await tool('reschedule_booking',{booking_id:current.id,start:'tomorrow at 3'},{expectError:true}),/ISO 8601/);

    // Integrations: connect, test (delivered in the request), list.
    const connected=await tool('connect_integration',{kind:'slack',url:'https://hooks.slack.com/services/T0123456/B0123456/abcdefghijklmnop',name:'Team'});
    assert.equal((await tool('test_integration',{integration_id:connected.integration.id})).state,'delivered');assert.equal(slack.length,1);assert.equal(slack[0].text,'Test notification');
    const crm=await tool('connect_integration',{kind:'twenty',api_key:'twenty_mcp_secret_1234567890',name:'Twenty CRM'});
    assert.equal(crm.integration.kind,'twenty');
    assert.equal((await tool('test_integration',{integration_id:crm.integration.id})).state,'delivered');
    assert.equal(twenty.length,1);assert.equal(twenty[0].path,'/rest/people?limit=1');assert.equal(twenty[0].auth,'Bearer twenty_mcp_secret_1234567890');
    const listed=await tool('list_integrations');
    assert.ok(listed.integrations.some(i=>i.name==='Team'));assert.ok(listed.integrations.some(i=>i.kind==='twenty'&&i.destination==='api.twenty.com'));
    assert.ok(!JSON.stringify(listed).includes('twenty_mcp_secret'));

    const activity=(await tool('get_activity')).activity.map(a=>a.action);
    for(const action of ['create_link','decide_booking','reschedule_booking','cancel_booking','connect_integration','test_integration'])assert.ok(activity.includes(action),action);
    const summaries=(await (await call('/api/live/activity',{cookie})).json()).activity.map(a=>a.summary);
    // Summaries read like the Studio ("Tue 17 Nov, 15:00" in the host's zone); the epoch times sit beside them as detail.
    const day='(Mon|Tue|Wed|Thu|Fri|Sat|Sun) \\d{1,2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec), \\d{2}:\\d{2}';
    assert.ok(summaries.some(s=>new RegExp(`^Approved Intro with Grace on ${day}$`).test(s)),summaries.join('\n'));assert.ok(summaries.some(s=>new RegExp(`^Moved Intro with Grace from ${day} to ${day}$`).test(s)),summaries.join('\n'));assert.ok(!summaries.some(s=>/\d{4}-\d{2}-\d{2}/.test(s)),summaries.join('\n'));
    const entries=(await (await call('/api/live/activity',{cookie})).json()).activity,move=entries.find(a=>a.action==='reschedule_booking'),approval=entries.find(a=>a.action==='decide_booking'&&a.detail?.decision==='approve');
    assert.deepEqual(Object.keys(move.detail).sort(),['from','name','title','to']);assert.ok(Number.isSafeInteger(move.detail.from)&&Number.isSafeInteger(move.detail.to));assert.deepEqual({title:approval.detail.title,name:approval.detail.name},{title:'Intro',name:'Grace'});assert.ok(summaries.some(s=>s.startsWith('Declined Intro with Linus')));assert.ok(summaries.some(s=>s.startsWith('Cancelled Intro with Grace')));
  }finally{await mf.dispose();}
});
