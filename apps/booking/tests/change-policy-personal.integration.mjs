import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {sha256} from '../src/crypto.js';
import {GOOGLE_SCOPES} from '../src/google.js';
import {intakeRevision} from '../public/intake.js';

test('Worker personal guest cutoffs cannot be bypassed while private owner actions retain authority',async()=>{
  const sentMail=[],events=new Map(),oauthCodes=new Map(),accessIdentities=new Map(),validCalendarTokens=new Set(),tokenExchanges=[];let identity='owner-1',inserts=0,oauthSequence=0;
  const mf=new Miniflare(convertV4MiniflareOptions({workers:[{name:'booking-test',modules:true,scriptPath:new URL('../dist/worker.js',import.meta.url).pathname,compatibilityDate:'2026-11-10',durableObjects:{HOSTS:{className:'BookingHost',useSQLite:true},LIVE_HOSTS:{className:'LiveBookingHost',useSQLite:true},AUTH:{className:'AuthStore',useSQLite:true}},bindings:{LIVE_ENABLED:'true',PUBLIC_ORIGIN:'http://localhost',GOOGLE_CLIENT_ID:'test-client',GOOGLE_CLIENT_SECRET:'test-secret',TOKEN_ENCRYPTION_KEY:Buffer.alloc(32,7).toString('base64'),RESEND_API_KEY:'mock-key',MAIL_FROM:'Scheduling <meet@example.com>'},outboundService:async request=>{
    const u=new URL(request.url),json=(x,status=200)=>Response.json(x,{status});
    if(u.hostname==='api.resend.com'){assert.equal(request.headers.get('Authorization'),'Bearer mock-key');const body=await request.json();sentMail.push({body,key:request.headers.get('Idempotency-Key')});return json({id:'mail-'+sentMail.length});}
    if(u.hostname==='oauth2.googleapis.com'){const body=new URLSearchParams(await request.text()),entry=oauthCodes.get(body.get('code'));assert.ok(entry,'Expected a registered mock OAuth code');tokenExchanges.push(entry);const access='access-'+body.get('code');accessIdentities.set(access,entry.identity);return json({access_token:access,expires_in:3600,scope:entry.scopes??(entry.calendar?GOOGLE_SCOPES.join(' '):'openid email profile'),...(entry.refreshToken===undefined?{}:{refresh_token:entry.refreshToken})});}
    if(u.hostname==='openidconnect.googleapis.com'){const user=accessIdentities.get(request.headers.get('Authorization')?.replace('Bearer ',''));assert.ok(user);return json({sub:user,email:user+'@example.com',email_verified:true,name:'Test Host'});}
    if(u.hostname==='www.googleapis.com')assert.ok(validCalendarTokens.has(request.headers.get('Authorization')?.replace('Bearer ','')),'Only an explicitly connected calendar grant can access Google Calendar');
    if(u.pathname.endsWith('/calendarList'))return json({items:[{id:'primary@example.com',summary:'Work',accessRole:'owner'},{id:'team@example.com',summary:'Team',accessRole:'writer'},{id:'readonly@example.com',summary:'Read only',accessRole:'reader'}]});
    if(u.pathname.endsWith('/freeBusy')){const query=await request.json();assert.equal(new Set(query.items.map(i=>i.id)).size,query.items.length);return json({calendars:Object.fromEntries(query.items.map(i=>[i.id,{busy:[]}]))});}
    if(u.pathname.endsWith('/events')&&request.method==='POST'){const e=await request.json();assert.ok(!JSON.stringify(e).includes('/manage/'),'Shared Google event must not carry a guest management capability');assert.equal(u.searchParams.get('conferenceDataVersion'),'1');assert.equal(e.conferenceData.createRequest.requestId,'email-'+e.id);assert.equal(e.conferenceData.createRequest.conferenceSolutionKey.type,'hangoutsMeet');inserts++;events.set(e.id,{...e,hangoutLink:'https://meet.google.com/abc-defg-hij',etag:'"1"',status:'confirmed'});return json(events.get(e.id));}
    const id=u.pathname.split('/').at(-1);if(u.pathname.includes('/events/')){if(!events.has(id))return json({error:{message:'not found'}},404);if(request.method==='DELETE'){events.delete(id);return new Response(null,{status:204});}return json(events.get(id));}
    throw Error('Unexpected provider request: '+u.pathname);
  }}]}));
  const call=(path,{cookie,body,headers={},origin='http://localhost',...options}={})=>mf.dispatchFetch('http://localhost'+path,{redirect:'manual',...options,headers:{...headers,...(cookie?{Cookie:cookie}:{}),...(body?{'Content-Type':'application/json',Origin:origin}:{})},...(body?{method:'POST',body:JSON.stringify(body)}:{})});
  async function beginOAuth({cookie,connect=false,returnTo=''}={}){
    const query=new URLSearchParams();if(connect)query.set('connect','1');if(returnTo)query.set('returnTo',returnTo);
    const begin=await call('/auth/google'+(query.size?'?'+query:''),{cookie});assert.equal(begin.status,302,await begin.clone().text());
    const google=new URL(begin.headers.get('Location'));assert.equal(google.hostname,'accounts.google.com');assert.equal(google.searchParams.get('code_challenge_method'),'S256');
    assert.equal(google.searchParams.get('include_granted_scopes'),'false');
    if(connect){assert.equal(google.searchParams.get('prompt'),'consent');assert.equal(google.searchParams.get('access_type'),'offline');assert.ok(google.searchParams.get('scope').includes('calendar.events'));}
    else{assert.equal(google.searchParams.get('scope'),'openid email profile');assert.equal(google.searchParams.get('prompt'),null);assert.equal(google.searchParams.get('access_type'),null);}
    return {state:google.searchParams.get('state'),binding:begin.headers.get('Set-Cookie').split(';')[0],cookie,connect,returnTo};
  }
  async function finishOAuth(pending,{ownerCookie=pending.cookie,user=identity,calendar=pending.connect,scopes,refreshToken=calendar?'refresh-'+user:undefined,error}={}){
    const code='fixture-'+(++oauthSequence);oauthCodes.set(code,{identity:user,calendar,scopes,refreshToken});
    const cookie=[ownerCookie,pending.binding].filter(Boolean).join('; '),callback=await call('/auth/google/callback?state='+pending.state+(error?'&error='+error:'&code='+code),{cookie});
    if(callback.status===303&&!error&&calendar)validCalendarTokens.add('access-'+code);
    return {callback,cookie,code};
  }
  function sessionCookie(callback){return callback.headers.getSetCookie().find(value=>value.startsWith('email_booking_session='))?.split(';')[0];}
  async function login(returnTo=''){
    const pending=await beginOAuth({returnTo}),{callback,cookie}=await finishOAuth(pending);assert.equal(callback.status,303,await callback.clone().text());
    assert.equal(new URL(callback.headers.get('Location')).pathname,returnTo==='device'?'/device':'/studio');
    assert.equal((await call('/auth/google/callback?state='+pending.state+'&code=replay',{cookie})).status,400);
    return sessionCookie(callback);
  }
  async function connectCalendar(cookie,options={}){const pending=await beginOAuth({cookie,connect:true});return finishOAuth(pending,options);}
  async function saveBrowser(cookie,patch,expectedRevision){expectedRevision??=(await(await call('/api/live/settings',{cookie})).json()).revision;return call('/api/live/settings',{cookie,body:{patch,expectedRevision}});}
  const json=async response=>{assert.equal(response.status,200,await response.clone().text());return response.json();};
  try{
    const cookie=await login();await connectCalendar(cookie);const settings=await json(await call('/api/live/settings',{cookie})),host=(await json(await call('/api/bootstrap',{cookie}))).hostId;await json(await call('/api/live/calendars',{cookie,body:{accounts:[{accountId:'owner-1',destinationCalendarId:'primary@example.com',conflictCalendarIds:['primary@example.com']}]}}));let type={...settings.meetingTypes[0],published:true,accountId:'owner-1',calendarId:'primary@example.com',useDefaultCalendar:true,locationType:'google_meet',zone:'UTC',notice:0,horizon:7,buffer:0,reminder:false,weeklyHours:Object.fromEntries(Array.from({length:7},(_,d)=>[d,[{start:0,end:1440}]])),cancellationNoticeMinutes:43200,rescheduleNoticeMinutes:43200};await json(await saveBrowser(cookie,{meetingTypes:[type]}));const page=await json(await call('/api/public/'+host+'/intro/availability'));assert.equal(page.config.cancellationNoticeMinutes,43200);const at=page.slots[0].start,first=await json(await call('/api/public/'+host+'/intro/book',{body:{start:at,name:'Guest',email:'guest@example.com',key:'change-policy-personal-first',intakeRevision:await intakeRevision(page.config)}}));assert.equal(first.booking.status,'confirmed');
    type={...type,cancellationNoticeMinutes:0,rescheduleNoticeMinutes:0};await json(await saveBrowser(cookie,{meetingTypes:[type]}));const manage='/api/manage/'+host+'/'+first.booking.id;assert.equal((await call('/api/public/'+host+'/intro/book',{body:{start:at,name:'Guest',email:'guest@example.com',key:'not-a-staff-booking-key',intakeRevision:await intakeRevision(page.config),staff:true}})).status,400);
    for(const body of [{action:'cancel',reason:'closed'},{action:'reschedule',start:at+3*3600000,key:'change-policy-personal-denied'},{action:'availability'}]){const denied=await call(manage,{body:{...body,token:first.managementToken}});assert.equal(denied.status,409);assert.equal((await denied.json()).code,'change_window_closed');}
    for(const flag of ['staff','force','override','authority'])assert.equal((await call(manage,{body:{action:'cancel',token:first.managementToken,[flag]:true}})).status,400);
    const staffPage=await json(await call('/api/live/bookings/'+first.booking.id+'/availability',{cookie,body:{}}));assert.ok(staffPage.slots.length);assert.equal(staffPage.managementToken,undefined);const moved=await json(await call('/api/live/bookings/'+first.booking.id+'/reschedule',{cookie,body:{start:at+3*3600000,key:'change-policy-personal-forced'}}));assert.equal(moved.booking.status,'confirmed');assert.equal(moved.booking.changePolicy.cancellationNoticeMinutes,43200);const cancelled=await json(await call('/api/live/bookings/'+moved.booking.id+'/cancel',{cookie,body:{reason:'PRIVATE-PERSONAL-REASON'}}));assert.equal(cancelled.booking.cancellationReason,'PRIVATE-PERSONAL-REASON');const retry=await json(await call('/api/live/bookings/'+moved.booking.id+'/cancel',{cookie,body:{reason:'Different'}}));assert.equal(retry.booking.cancellationReason,'PRIVATE-PERSONAL-REASON');assert.ok(!JSON.stringify(sentMail).includes('PRIVATE-PERSONAL-REASON'));assert.equal(events.size,0);
  }finally{await mf.dispose();}
});
