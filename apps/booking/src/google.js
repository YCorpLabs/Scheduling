const CALENDAR = 'https://www.googleapis.com/calendar/v3';
export const IDENTITY_SCOPES = ['openid', 'email', 'profile'];
export const GOOGLE_SCOPES = [...IDENTITY_SCOPES, 'https://www.googleapis.com/auth/calendar.calendarlist.readonly', 'https://www.googleapis.com/auth/calendar.events', 'https://www.googleapis.com/auth/calendar.freebusy'];
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

export class GoogleError extends Error {
  constructor(status, code, retryable = false) {
    super(`Google request failed (${code})`);
    this.name = 'GoogleError'; this.status = status; this.code = code; this.retryable = retryable;
  }
}
export function authorizationUrl({ clientId, redirectUri, state, codeChallenge, identityOnly = false }) {
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.search = new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, response_type: 'code', scope: (identityOnly ? IDENTITY_SCOPES : GOOGLE_SCOPES).join(' '), state, code_challenge: codeChallenge, code_challenge_method: 'S256', ...(identityOnly ? {} : {access_type:'offline',prompt:'consent'}), include_granted_scopes: 'false' });
  return url.toString();
}
async function boundedJSON(response) {
  if (!response.body) throw new GoogleError(502, 'invalid_response');
  const reader = response.body.getReader();
  const chunks = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) { await reader.cancel(); throw new GoogleError(502, 'invalid_response'); }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    const json = JSON.parse(new TextDecoder().decode(bytes));
    if (!json || typeof json !== 'object' || Array.isArray(json)) throw new Error();
    return json;
  } catch (error) {
    if (error instanceof GoogleError) throw error;
    throw new GoogleError(502, 'invalid_response');
  } finally { reader.releaseLock(); }
}
async function request(url, init, { fetchImpl = globalThis.fetch, timeoutMs = 10000 } = {}) {
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(new GoogleError(504, 'timeout', true)); }, timeoutMs);
  });
  const operation = async () => {
    let response;
    try { response = await fetchImpl(url, { ...init, signal: controller.signal, redirect: 'manual' }); }
    catch { throw new GoogleError(502, 'network_error', true); }
    if (!response.ok) {
      let data = {};
      try { data = await boundedJSON(response); } catch { /* Never expose provider response bodies. */ }
      const reason = data.error?.errors?.[0]?.reason;
      const retryable = response.status === 429 || response.status >= 500 || ['rateLimitExceeded', 'userRateLimitExceeded'].includes(reason);
      const code = data.error === 'invalid_grant' ? 'invalid_grant' : response.status === 401 ? 'unauthorized' : response.status === 403 ? 'forbidden' : response.status === 404 ? 'not_found' : response.status === 409 ? 'conflict' : response.status === 412 ? 'precondition_failed' : retryable ? 'temporarily_unavailable' : 'request_failed';
      throw new GoogleError(response.status, code, retryable);
    }
    return response.status === 204 ? null : boundedJSON(response);
  };
  try { return await Promise.race([operation(), timeout]); }
  finally { clearTimeout(timer); }
}
async function tokenRequest(params, options) {
  const tokens = await request('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params).toString() }, options);
  if (typeof tokens?.access_token !== 'string' || !tokens.access_token || !Number.isFinite(tokens.expires_in) || tokens.expires_in <= 0) throw new GoogleError(502, 'invalid_response');
  return { ...tokens, expires_at: Date.now() + tokens.expires_in * 1000 };
}
export function exchangeCode({ clientId, clientSecret, redirectUri, code, codeVerifier }, options) {
  return tokenRequest({ client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri, code, code_verifier: codeVerifier, grant_type: 'authorization_code' }, options);
}
// Google refused the stored grant: revoked, expired (Testing-mode grants last
// 7 days) or issued to another OAuth client. Only a new consent fixes it.
export function grantRejected(error) {
  return error?.code === 'invalid_grant' || error?.status === 401;
}
export const RECONNECT_CODE = 'calendar_reconnect_required';
export function refreshTokens({ clientId, clientSecret, refreshToken }, options) {
  return tokenRequest({ client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken, grant_type: 'refresh_token' }, options);
}
export async function getUserInfo(accessToken, options) {
  const user = await request('https://openidconnect.googleapis.com/v1/userinfo', { headers: { authorization: `Bearer ${accessToken}` } }, options);
  if (typeof user?.sub !== 'string' || typeof user.email !== 'string' || !user.email || !user.sub || user.email_verified !== true) throw new GoogleError(403, 'unverified_identity');
  return user;
}
export function googleRequest(accessToken, path, { method = 'GET', body, headers = {}, ...options } = {}) {
  if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//')) throw new GoogleError(400, 'invalid_path');
  return request(`${CALENDAR}${path}`, { method, headers: { ...headers, authorization: `Bearer ${accessToken}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, options);
}
export async function listCalendars(accessToken, options = {}) {
  const items = []; let pageToken;
  for (let page = 0; page < 20; page++) {
    const query = new URLSearchParams({ maxResults: '250' });
    if (pageToken) query.set('pageToken', pageToken);
    const result = await googleRequest(accessToken, `/users/me/calendarList?${query}`, options);
    if (!Array.isArray(result.items)) throw new GoogleError(502, 'invalid_response');
    items.push(...result.items);
    if (!result.nextPageToken) return items;
    if (typeof result.nextPageToken !== 'string' || result.nextPageToken === pageToken) throw new GoogleError(502, 'invalid_response');
    pageToken = result.nextPageToken;
  }
  throw new GoogleError(502, 'pagination_limit');
}
export async function freeBusy(accessToken, { calendarIds, timeMin, timeMax, timeZone }, options = {}) {
  if (!Array.isArray(calendarIds) || !calendarIds.length || calendarIds.length > 50 || calendarIds.some(id => typeof id !== 'string' || !id)) throw new GoogleError(400, 'invalid_calendars');
  const result = await googleRequest(accessToken, '/freeBusy', { ...options, method: 'POST', body: { timeMin, timeMax, ...(timeZone ? { timeZone } : {}), calendarExpansionMax: 50, items: [...new Set(calendarIds)].map(id => ({ id })) } });
  if (Object.values(result.groups || {}).some(group => !group || group.errors?.length) || Object.values(result.calendars || {}).some(calendar => !calendar || calendar.errors?.length)) throw new GoogleError(502, 'availability_unavailable', true);
  return [...new Set(calendarIds)].flatMap(id => {
    const calendar = result.calendars?.[id];
    if (!calendar || !Array.isArray(calendar.busy) || calendar.busy.some(interval => !Number.isFinite(Date.parse(interval.start)) || !Number.isFinite(Date.parse(interval.end)) || Date.parse(interval.start) >= Date.parse(interval.end))) throw new GoogleError(502, 'availability_unavailable', true);
    return calendar.busy;
  });
}
function eventPath(calendarId, eventId) { return `/calendars/${encodeURIComponent(calendarId)}/events${eventId ? `/${encodeURIComponent(eventId)}` : ''}`; }
export function assertManagedEvent(event, bookingId) {
  if (!bookingId || event?.extendedProperties?.private?.emailBooking !== bookingId) throw new GoogleError(409, 'unmanaged_event');
  return event;
}
export async function createEvent(accessToken, { calendarId, eventId, bookingId, event, conference = false }, options = {}) {
  if (!/^[a-v0-9]{5,1024}$/.test(eventId) || !bookingId || !Array.isArray(event?.attendees) || !event.attendees.length) throw new GoogleError(400, 'invalid_event');
  const created = await googleRequest(accessToken, `${eventPath(calendarId)}?sendUpdates=all${conference ? '&conferenceDataVersion=1' : ''}`, { ...options, method: 'POST', body: { ...event, ...(conference ? {conferenceData:{createRequest:{requestId:`email-${eventId}`,conferenceSolutionKey:{type:'hangoutsMeet'}}}} : {}), id: eventId, extendedProperties: { ...event.extendedProperties, private: { ...event.extendedProperties?.private, emailBooking: bookingId } } } });
  // A successful HTTP status alone does not prove our insert succeeded. Keep
  // the durable attempted hold and recover by GET of the same deterministic ID.
  if (created?.id !== eventId || created?.extendedProperties?.private?.emailBooking !== bookingId || !['confirmed', 'tentative'].includes(created?.status)) throw new GoogleError(502, 'invalid_response', true);
  return created;
}
export async function getEvent(accessToken, { calendarId, eventId, bookingId }, options = {}) {
  try {
    const event = await googleRequest(accessToken, eventPath(calendarId, eventId), options);
    if (!eventId || event?.id !== eventId) throw new GoogleError(409, 'unmanaged_event');
    // Google can omit every field except the ID on deleted-event tombstones.
    // This exception authorizes read-only reconciliation, never a mutation.
    return event.status === 'cancelled' ? event : assertManagedEvent(event, bookingId);
  }
  catch (error) { if (error instanceof GoogleError && error.status === 404) return null; throw error; }
}
export async function patchEvent(accessToken, { calendarId, eventId, bookingId, etag, event }, options = {}) {
  if (!etag) throw new GoogleError(400, 'missing_etag');
  const current = await getEvent(accessToken, { calendarId, eventId, bookingId }, options);
  if (!current || current.status === 'cancelled') throw new GoogleError(404, 'not_found');
  assertManagedEvent(current, bookingId);
  return googleRequest(accessToken, `${eventPath(calendarId, eventId)}?sendUpdates=all`, { ...options, method: 'PATCH', headers: { 'If-Match': etag }, body: { ...event, extendedProperties: { ...current.extendedProperties, ...event.extendedProperties, private: { ...current.extendedProperties?.private, ...event.extendedProperties?.private, emailBooking: bookingId } } } });
}
export async function deleteEvent(accessToken, { calendarId, eventId, bookingId, etag }, options = {}) {
  if (!etag) throw new GoogleError(400, 'missing_etag');
  const current = await getEvent(accessToken, { calendarId, eventId, bookingId }, options);
  if (!current || current.status === 'cancelled') return null;
  assertManagedEvent(current, bookingId);
  return googleRequest(accessToken, `${eventPath(calendarId, eventId)}?sendUpdates=all`, { ...options, method: 'DELETE', headers: { 'If-Match': etag } });
}

// Read-only projection: never treat arbitrary provider URLs as meeting links.
export function conferenceDetails(event) {
  const status = event?.conferenceData?.createRequest?.status?.statusCode;
  if (status === 'failure') return { conferenceStatus: 'failed' };
  const links = [event?.hangoutLink, ...(event?.conferenceData?.entryPoints ?? []).filter(p => p?.entryPointType === 'video').map(p => p.uri)];
  for (const value of links) {
    if (typeof value !== 'string') continue;
    try {
      const url = new URL(value);
      if (url.protocol === 'https:' && url.hostname === 'meet.google.com' && !url.port && !url.username && !url.password && /^\/[a-z]{3}-[a-z]{4}-[a-z]{3}$/.test(url.pathname) && !url.search && !url.hash) return { conferenceStatus: 'ready', meetingUrl: url.href };
    } catch { /* A malformed link is not a room. */ }
  }
  return { conferenceStatus: status === 'success' ? 'failed' : 'pending' };
}
