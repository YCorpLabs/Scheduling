import test from 'node:test';
import assert from 'node:assert/strict';
import { authorizationUrl, exchangeCode, refreshTokens, getUserInfo, googleRequest, listCalendars, freeBusy, createEvent, getEvent, patchEvent, deleteEvent, conferenceDetails } from '../src/google.js';
const json = (value, status = 200) => new Response(JSON.stringify(value), { status });
const managed = { id: 'event1', status: 'confirmed', etag: '"v1"', extendedProperties: { private: { emailBooking: 'booking1' } } };
const args = { calendarId: 'host@example.com', eventId: 'event1', bookingId: 'booking1' };
test('OAuth requests bind state, PKCE, offline consent and required scopes', async () => {
  const url = new URL(authorizationUrl({ clientId: 'client', redirectUri: 'https://booking.example/callback', state: 'state', codeChallenge: 'challenge' }));
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('state'), 'state');
  assert.equal(url.searchParams.get('access_type'), 'offline');
  assert.ok(url.searchParams.get('scope').includes('calendar.calendarlist.readonly'));
  assert.equal(url.searchParams.get('include_granted_scopes'), 'false');
  assert.ok(!url.searchParams.get('scope').includes('gmail'));
  assert.ok(!url.searchParams.get('scope').includes('contacts'));
  let body;
  const tokens = await exchangeCode({ clientId: 'client', clientSecret: 'secret', redirectUri: 'https://booking.example/callback', code: 'code', codeVerifier: 'verifier' }, { fetchImpl: async (target, init) => {
    assert.equal(target, 'https://oauth2.googleapis.com/token'); body = new URLSearchParams(init.body);
    return json({ access_token: 'access', refresh_token: 'refresh', expires_in: 3600 });
  } });
  assert.equal(body.get('code_verifier'), 'verifier');
  assert.ok(tokens.expires_at > Date.now());
  await assert.rejects(refreshTokens({ clientId: 'c', clientSecret: 's', refreshToken: 'r' }, { fetchImpl: async () => json({ error: 'invalid_grant', error_description: 'SECRET' }, 400) }), error => error.code === 'invalid_grant' && !error.retryable && !error.message.includes('SECRET'));
});
test('provider errors are sanitized and classified, and timeout bounds even a hung fetch', async () => {
  for (const [status, retryable] of [[401, false], [429, true], [503, true], [412, false]]) {
    await assert.rejects(googleRequest('TOKEN', '/freeBusy', { fetchImpl: async () => json({ error: { message: 'PRIVATE' } }, status) }), error => error.status === status && error.retryable === retryable && !error.message.includes('PRIVATE'));
  }
  let signal;
  await assert.rejects(googleRequest('token', '/freeBusy', { timeoutMs: 10, fetchImpl: async (_, init) => { signal = init.signal; return new Promise(() => {}); } }), error => error.code === 'timeout' && error.retryable);
  assert.equal(signal.aborted, true);
  await assert.rejects(googleRequest('t', '/freeBusy', { fetchImpl: async () => new Response('not json') }), error => error.code === 'invalid_response');
  await assert.rejects(googleRequest('t', '/freeBusy', { fetchImpl: async () => json({ oversized: 'x'.repeat(2 * 1024 * 1024) }) }), error => error.code === 'invalid_response');
});
test('userinfo requires Google verified email', async () => {
  await assert.rejects(getUserInfo('t', { fetchImpl: async () => json({ sub: 'id', email: 'x@example.com', email_verified: false }) }), error => error.code === 'unverified_identity');
  assert.equal((await getUserInfo('t', { fetchImpl: async () => json({ sub: 'id', email: 'x@example.com', email_verified: true }) })).sub, 'id');
});
test('calendar pagination is complete and bounded', async () => {
  let calls = 0;
  const calendars = await listCalendars('t', { fetchImpl: async target => {
    calls++; const url = new URL(target);
    if (calls === 1) return json({ items: [{ id: 'one' }], nextPageToken: 'next' });
    assert.equal(url.searchParams.get('pageToken'), 'next');
    return json({ items: [{ id: 'two' }] });
  } });
  assert.deepEqual(calendars.map(c => c.id), ['one', 'two']);
  let pages = 0;
  await assert.rejects(listCalendars('t', { fetchImpl: async () => json({ items: [], nextPageToken: String(++pages) }) }), error => error.code === 'pagination_limit');
  assert.equal(pages, 20);
});
test('availability fails closed on missing calendars, any errors and malformed intervals', async () => {
  const input = { calendarIds: ['a', 'b'], timeMin: '2026-11-10T10:00:00Z', timeMax: '2026-11-10T11:00:00Z' };
  for (const calendars of [{ a: { busy: [] } }, { a: null, b: { busy: [] } }, { a: { busy: [] }, b: { busy: [], errors: [{ reason: 'notFound' }] } }, { a: { busy: [] }, b: { busy: [{ start: 'bad', end: 'bad' }] } }]) {
    await assert.rejects(freeBusy('t', input, { fetchImpl: async () => json({ calendars }) }), error => error.code === 'availability_unavailable');
  }
  const busy = [{ start: input.timeMin, end: input.timeMax }];
  assert.deepEqual(await freeBusy('t', input, { fetchImpl: async () => json({ calendars: { a: { busy }, b: { busy: [] } } }) }), busy);
});
test('events use deterministic IDs, attendee notifications and managed marker', async () => {
  await createEvent('t', { ...args, event: { summary: 'Meeting', attendees: [{ email: 'guest@example.com' }] } }, { fetchImpl: async (target, init) => {
    assert.equal(new URL(target).searchParams.get('sendUpdates'), 'all');
    const body = JSON.parse(init.body);
    assert.equal(body.id, args.eventId); assert.equal(body.extendedProperties.private.emailBooking, args.bookingId);
    assert.equal(body.attendees[0].email, 'guest@example.com'); return json(managed);
  } });
  assert.equal(await getEvent('t', args, { fetchImpl: async () => json({ error: {} }, 404) }), null);
  await assert.rejects(getEvent('t', args, { fetchImpl: async () => json({ id: args.eventId }) }), error => error.code === 'unmanaged_event');
});
test('mutations check ownership and use ETag preconditions', async () => {
  for (const mutate of [patchEvent, deleteEvent]) {
    let calls = 0;
    await mutate('t', { ...args, etag: '"v1"', event: { summary: 'Changed' } }, { fetchImpl: async (target, init) => {
      if (++calls === 1) { assert.equal(init.method, 'GET'); return json(managed); }
      assert.equal(init.headers['If-Match'], '"v1"');
      assert.equal(new URL(target).searchParams.get('sendUpdates'), 'all');
      return mutate === deleteEvent ? new Response(null, { status: 204 }) : json(managed);
    } });
    assert.equal(calls, 2);
    let attempts = 0;
    await assert.rejects(mutate('t', { ...args, etag: '"v1"', event: {} }, { fetchImpl: async () => { attempts++; return json({ id: 'event1' }); } }), error => error.code === 'unmanaged_event');
    assert.equal(attempts, 1);
  }
});
test('insert acknowledgement requires exact owned live identity; ambiguous success stays recoverable',async()=>{
 for(const response of [{},{...managed,id:'different'},{...managed,extendedProperties:{}},{...managed,status:undefined},{...managed,status:'cancelled'},{...managed,status:'unknown'}]){
  let inserts=0;
  await assert.rejects(createEvent('t',{...args,event:{attendees:[{email:'guest@example.test'}]}},{fetchImpl:async()=>{inserts++;return json(response);}}),error=>error.status===502&&error.code==='invalid_response'&&error.retryable===true);
  assert.equal(inserts,1,'The adapter must not retry a possibly successful insert');
 }
});
test('deleted-event tombstones require the exact requested ID and permit no mutations',async()=>{
 let calls=0;const options={fetchImpl:async()=>{calls++;return json({id:args.eventId,status:'cancelled'});}};
 assert.deepEqual(await getEvent('t',args,options),{id:args.eventId,status:'cancelled'});
 await assert.rejects(patchEvent('t',{...args,etag:'etag',event:{summary:'Unsafe revival'}},options),error=>error.status===404);
 assert.equal(await deleteEvent('t',{...args,etag:'etag'},options),null);assert.equal(calls,3);
 for(const event of [{id:'other',status:'cancelled'},{status:'cancelled'},{id:'other',...managed,id:'other'}]){
  await assert.rejects(getEvent('t',args,{fetchImpl:async()=>json(event)}),error=>error.code==='unmanaged_event');
 }
 // A live event with the requested ID still requires the private ownership marker.
 await assert.rejects(getEvent('t',args,{fetchImpl:async()=>json({id:args.eventId,status:'confirmed'})}),error=>error.code==='unmanaged_event');
});

test('Google Meet is requested once with deterministic conference identity and explicit API support', async () => {
 const bodies=[];for(let i=0;i<2;i++)await createEvent('t',{...args,conference:true,event:{attendees:[{email:'guest@example.com'}]}},{fetchImpl:async(target,init)=>{assert.equal(new URL(target).searchParams.get('conferenceDataVersion'),'1');bodies.push(JSON.parse(init.body));return json(managed);}});
 assert.deepEqual(bodies[0].conferenceData,bodies[1].conferenceData);assert.equal(bodies[0].conferenceData.createRequest.requestId,'email-event1');assert.equal(bodies[0].conferenceData.createRequest.conferenceSolutionKey.type,'hangoutsMeet');
 await createEvent('t',{...args,event:{attendees:[{email:'guest@example.com'}]}},{fetchImpl:async(target,init)=>{assert.equal(new URL(target).searchParams.has('conferenceDataVersion'),false);assert.equal(JSON.parse(init.body).conferenceData,undefined);return json(managed);}});
});
test('conference state distinguishes pending, failed and ready and accepts only exact Google Meet rooms',()=>{
 assert.deepEqual(conferenceDetails({}),{conferenceStatus:'pending'});
 assert.deepEqual(conferenceDetails({conferenceData:{createRequest:{status:{statusCode:'failure'}}}}),{conferenceStatus:'failed'});
 assert.deepEqual(conferenceDetails({hangoutLink:'https://meet.google.com/abc-defg-hij'}),{conferenceStatus:'ready',meetingUrl:'https://meet.google.com/abc-defg-hij'});
 assert.deepEqual(conferenceDetails({conferenceData:{entryPoints:[{entryPointType:'video',uri:'https://meet.google.com/abc-defg-hij'}]}}),{conferenceStatus:'ready',meetingUrl:'https://meet.google.com/abc-defg-hij'});
 for(const url of ['javascript:alert(1)','https://meet.google.com.evil.test/abc-defg-hij','https://user:pw@meet.google.com/abc-defg-hij','https://meet.google.com/abc-defg-hij?token=secret','http://meet.google.com/abc-defg-hij','https://meet.google.com/abc-defg-hij#x'])assert.deepEqual(conferenceDetails({hangoutLink:url,conferenceData:{createRequest:{status:{statusCode:'success'}}}}),{conferenceStatus:'failed'});
});

test('owner identity sign-in requests no calendar grant, offline refresh or forced consent',()=>{
 const url=new URL(authorizationUrl({clientId:'client',redirectUri:'https://booking.example/callback',state:'state',codeChallenge:'challenge',identityOnly:true}));
 assert.equal(url.searchParams.get('scope'),'openid email profile');assert.equal(url.searchParams.has('access_type'),false);assert.equal(url.searchParams.has('prompt'),false);assert.equal(url.searchParams.get('include_granted_scopes'),'false');assert.equal(url.searchParams.get('code_challenge_method'),'S256');
});
