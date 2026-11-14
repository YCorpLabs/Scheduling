import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {GOOGLE_SCOPES} from '../src/google.js';

test('Worker keeps a Google-rejected grant, reports reconnect without 401s, and recovers on a new consent',async()=>{
  const oauthCodes=new Map(),identities=new Map(),valid=new Set();let sequence=0,refreshFailure=null,refreshes=0;
  const mf=new Miniflare(convertV4MiniflareOptions({workers:[{name:'booking-test',modules:true,scriptPath:new URL('../dist/worker.js',import.meta.url).pathname,compatibilityDate:'2026-11-10',durableObjects:{HOSTS:{className:'BookingHost',useSQLite:true},LIVE_HOSTS:{className:'LiveBookingHost',useSQLite:true},AUTH:{className:'AuthStore',useSQLite:true}},bindings:{LIVE_ENABLED:'true',PUBLIC_ORIGIN:'http://localhost',GOOGLE_CLIENT_ID:'test-client',GOOGLE_CLIENT_SECRET:'test-secret',TOKEN_ENCRYPTION_KEY:Buffer.alloc(32,7).toString('base64')},outboundService:async request=>{
    const u=new URL(request.url),json=(x,status=200)=>Response.json(x,{status});
    if(u.hostname==='oauth2.googleapis.com'){
      const body=new URLSearchParams(await request.text());
      if(body.get('grant_type')==='refresh_token'){refreshes++;if(refreshFailure)return json(refreshFailure.body,refreshFailure.status);const access='refreshed-'+refreshes;valid.add(access);return json({access_token:access,expires_in:30});}
      const entry=oauthCodes.get(body.get('code'));assert.ok(entry);const access='access-'+body.get('code');identities.set(access,entry.identity);if(entry.calendar)valid.add(access);
      // Short-lived access tokens make every calendar call refresh first.
      return json({access_token:access,expires_in:30,scope:entry.calendar?GOOGLE_SCOPES.join(' '):'openid email profile',...(entry.calendar?{refresh_token:'refresh-'+entry.identity+'-'+body.get('code')}:{})});
    }
    if(u.hostname==='openidconnect.googleapis.com'){const user=identities.get(request.headers.get('Authorization')?.replace('Bearer ',''));assert.ok(user);return json({sub:user,email:user+'@example.com',email_verified:true,name:'Test Host'});}
    if(u.hostname==='www.googleapis.com'&&!valid.has(request.headers.get('Authorization')?.replace('Bearer ','')))return json({error:{code:401}},401);
    if(u.pathname.endsWith('/calendarList'))return json({items:[{id:'primary@example.com',summary:'Work',accessRole:'owner',primary:true},{id:'readonly@example.com',summary:'Read only',accessRole:'reader'}]});
    if(u.pathname.endsWith('/freeBusy')){const query=await request.json();return json({calendars:Object.fromEntries(query.items.map(i=>[i.id,{busy:[]}]))});}
    throw Error('Unexpected provider request: '+u.pathname);
  }}]}));
  const call=(path,{cookie,body,...options}={})=>mf.dispatchFetch('http://localhost'+path,{redirect:'manual',...options,headers:{...(cookie?{Cookie:cookie}:{}),...(body?{'Content-Type':'application/json',Origin:'http://localhost'}:{})},...(body?{method:'POST',body:JSON.stringify(body)}:{})});
  const json=async response=>{assert.equal(response.status,200,await response.clone().text());return response.json();};
  async function oauth(cookie,connect){
    const begin=await call('/auth/google'+(connect?'?connect=1':''),{cookie});assert.equal(begin.status,302);
    const state=new URL(begin.headers.get('Location')).searchParams.get('state'),binding=begin.headers.get('Set-Cookie').split(';')[0],code='fixture-'+(++sequence);
    oauthCodes.set(code,{identity:'owner-1',calendar:connect});
    const callback=await call('/auth/google/callback?state='+state+'&code='+code,{cookie:[cookie,binding].filter(Boolean).join('; ')});assert.equal(callback.status,303,await callback.clone().text());
    return callback.headers.getSetCookie().find(v=>v.startsWith('email_booking_session='))?.split(';')[0]??cookie;
  }
  try{
    const cookie=await oauth(null,false);await oauth(cookie,true);
    const host=(await json(await call('/api/bootstrap',{cookie}))).hostId;
    await json(await call('/api/live/calendars',{cookie,body:{accounts:[{accountId:'owner-1',destinationCalendarId:'primary@example.com',conflictCalendarIds:['primary@example.com']}]}}));
    let settings=await json(await call('/api/live/settings',{cookie}));
    const type={...settings.meetingTypes[0],published:true,accountId:'owner-1',calendarId:'primary@example.com',useDefaultCalendar:true,zone:'UTC',notice:0,horizon:7,buffer:0,reminder:false,weeklyHours:Object.fromEntries(Array.from({length:7},(_,d)=>[d,[{start:0,end:1440}]]))};
    await json(await call('/api/live/settings',{cookie,body:{patch:{meetingTypes:[type]},expectedRevision:settings.revision}}));
    assert.ok((await json(await call('/api/public/'+host+'/intro/availability'))).slots.length,'link works before Google rejects the grant');

    for(const failure of [{status:401,body:{error:'unauthorized_client'}},{status:400,body:{error:'invalid_grant'}}]){
      refreshFailure=failure;
      const listed=await call('/api/live/calendars',{cookie});
      assert.equal(listed.status,200,'a Google rejection is not reported as an expired Studio or desktop session');
      const account=(await listed.json()).accounts.find(a=>a.id==='owner-1');assert.equal(account.reconnectRequired,true);assert.deepEqual(account.calendars,[]);
      settings=await json(await call('/api/live/settings',{cookie}));const stored=settings.accounts.find(a=>a.id==='owner-1');
      assert.equal(stored.reconnectRequired,true);assert.equal(stored.connected,true);
      const page=await call('/api/public/'+host+'/intro/availability');assert.equal(page.status,503);assert.deepEqual(await page.json(),{error:'Calendar availability is temporarily unavailable.'});
      const book=await call('/api/public/'+host+'/intro/book',{body:{start:Date.now()+86400000,name:'Guest',email:'guest@example.com',key:'reconnect-'+failure.status+'-attempt'}});assert.notEqual(book.status,200,'no booking is accepted against a calendar Google refuses');
      const save=await call('/api/live/calendars',{cookie,body:{accounts:[{accountId:'owner-1',destinationCalendarId:'primary@example.com',conflictCalendarIds:['primary@example.com']}]}});
      assert.equal(save.status,409);assert.equal((await save.json()).code,'calendar_reconnect_required');
      await oauth(cookie,true);refreshFailure=null;
      settings=await json(await call('/api/live/settings',{cookie}));assert.equal(settings.accounts.find(a=>a.id==='owner-1').reconnectRequired,undefined,'a new consent clears the state');
      assert.ok((await json(await call('/api/live/calendars',{cookie}))).accounts.find(a=>a.id==='owner-1').calendars.length);
      assert.ok((await json(await call('/api/public/'+host+'/intro/availability'))).slots.length,'the link works again after reconnecting');
    }
  }finally{await mf.dispose();}
});
