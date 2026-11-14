export {AccountDataOperator} from './account-data-operator.js';
import {prepareAccountDeletion,confirmAccountDeletion,accountDeletionStatus,resumeAccountDeletion} from './account-deletion.js';
import demo, {BookingHost} from './demo.js';
import {LiveBookingHost} from './host.js';
import {AuthStore,configured,originFor,localOrigin,session,oauthStart,oauthCallback,signOut,browserSessions,revokeBrowserSession,revokeOtherBrowserSessions} from './auth.js';
import {handleTracking} from './tracking.js';
import {exportAccount,exportWorkspace} from './export.js';
import {handleDevice,authenticateDevice} from './device.js';
import {notificationConfigured} from './notifications.js';
import {verifiedIdentity} from './identity.js';
import {sha256} from './crypto.js';
import {workspaceAccess,ownCalendarMember,workspaceRoute,authorizeWorkspaceRoute,projectWorkspaceSettings,projectWorkspaceBooking,projectWorkspaceBookingList} from './workspaces.js';
import {HttpError,readJson,response,secureAsset} from './http.js';
import {brandFromEnv} from '../public/brand.js';
export {BookingHost,LiveBookingHost,AuthStore};
const hostPattern=/^h_[A-Za-z0-9_-]{24}$/;
const slugPattern=/^[a-z0-9][a-z0-9-]{0,63}$/;
function requestedDuration(url){
 const values=url.searchParams.getAll('duration');if(!values.length)return undefined;
 if(values.length!==1||!/^\d{1,3}$/.test(values[0]))throw new HttpError(400,'Choose a valid meeting duration.');
 const duration=Number(values[0]);if(duration<5||duration>480)throw new HttpError(400,'Choose a duration between 5 and 480 minutes.');return duration;
}
async function limit(request,env,kind) {
  const ip=request.headers.get('CF-Connecting-IP')||'local';
  const key=await sha256(ip+':'+kind+':'+Math.floor(Date.now()/(kind==='booking'?600000:60000)));
  if(!await env.AUTH.getByName('rate:'+key).allow(kind==='booking'?8:kind==='export'?300:90,kind==='booking'?600000:60000))throw new HttpError(429,'Too many requests. Please try again shortly.');
}
const publicCodes=['deletion_changed','deletion_expired','deletion_account_changed','invalid_deletion','deletion_not_found','deletion_unavailable','export_account_changed','export_changed','export_expired','link_expired','link_used','change_window_closed','idempotency_conflict','invalid_settings','settings_conflict','settings_unavailable','maintenance_frozen','maintenance_fence_conflict','maintenance_fence_unavailable','restore_quarantine','invalid_integration','integration_not_found','integration_conflict','integration_limit','integration_disabled','webhook_host_not_approved','queue_capacity','retry_limit','rate_limited','delivery_not_found','delivery_changed','integration_changed','integration_restore_quarantine','calendar_reconnect_required'];
function result(value){if(value?.error)return response({error:value.error,...(publicCodes.includes(value.code)?{code:value.code}:{})},value.status||400);return response(value);}
// Every company settings response uses the same privacy projection, including
// mutation responses and the nested HostedSettings envelope.
function projectSettingsOutcome(value,access){
 if(value?.error)return value;
 if(value?.settings)return {...value,settings:projectWorkspaceSettings(value.settings,access),...(!access.personal&&value.changes?{changes:value.changes.filter(change=>!/^accounts(?:\.|$)/.test(change.path??''))}:{})};
 return projectWorkspaceSettings(value,access);
}
function sameOrigin(request,env) {if(request.headers.get('Origin')!==originFor(env))throw new HttpError(403,'Request not allowed.');}
async function admin(request,env) {const user=await session(request,env);if(!user)throw new HttpError(401,'Sign in to continue.');const access=await workspaceAccess(env,user,request.headers.get('X-Scheduling-Workspace'));return {user,access,host:env.LIVE_HOSTS.getByName(access.hostId)};}
export default {
  async fetch(request,env,ctx) {
    const url=new URL(request.url),path=url.pathname;
    try {
      const local=localOrigin(url)&&env.LIVE_ENABLED!=='true';
      if(path==='/api/bootstrap') {
        const brand=brandFromEnv(env);
        if(local)return response({mode:'local',authenticated:true,brand});
        if(!configured(env))return response({mode:'setup',authenticated:false,brand});
        if(url.origin!==originFor(env))throw new HttpError(421,'Use the configured booking address.');
        const user=await session(request,env);return response({mode:'live',authenticated:!!user,hostId:user?.hostId,email:user?.email,notificationSender:user&&notificationConfigured(env)?env.MAIL_FROM:null,features:{reminders:notificationConfigured(env),bookingEmails:notificationConfigured(env)},brand});
      }
      if(path.startsWith('/api/tracking/pixel/'))return await handleTracking(request,env,{authenticateDevice});
      if(path==='/api/device/tracking'){
        if(!configured(env))throw new HttpError(503,'Booking service is not configured yet.');
        if(url.origin!==originFor(env))throw new HttpError(421,'Use the configured booking address.');
        await limit(request,env,'browse');return await handleTracking(request,env,{authenticateDevice});
      }
      if(path==='/device'||path==='/device-ui.js'||path.startsWith('/api/device/')){
        if(!configured(env))throw new HttpError(503,'Booking service is not configured yet.');
        if(url.origin!==originFor(env))throw new HttpError(421,'Use the configured booking address.');
        if(/^\/api\/device\/(settings(?:\/preview)?|bookings|analytics|availability|calendars)$/.test(path)){
          await limit(request,env,'browse');
          const device=await authenticateDevice(request,env);if(!device)throw new HttpError(401,'Desktop session expired or was revoked.');
          const host=env.LIVE_HOSTS.getByName(device.hostId),settingsWrite=device.scope.split(' ').includes('booking:settings');
          const needSettings=()=>response({error:'Approve scheduling settings access to continue.',code:'settings_permission_required'},403);
          if(path==='/api/device/settings/preview'&&request.method==='POST'){
            const data=await readJson(request,192*1024);if(Object.keys(data).some(key=>key!=='patch'))throw new HttpError(400,'Choose a settings patch to preview.');
            return result(await host.previewSettings(data.patch));
          }
          if(path==='/api/device/settings'&&request.method==='POST'){
            if(!settingsWrite)return needSettings();
            const data=await readJson(request,192*1024);if(Object.keys(data).some(key=>!['patch','expectedRevision'].includes(key)))throw new HttpError(400,'Choose a settings patch and its reviewed revision.');
            return result(await host.applySettings(data.patch,data.expectedRevision));
          }
          if(request.method!=='GET')throw new HttpError(405,'This desktop operation is read-only.');
          if(path==='/api/device/settings'){const settings=await host.settingsWithRevision();return settings.error?result(settings):response({...settings,hostId:device.hostId});}
          if(path==='/api/device/calendars'){if(!settingsWrite)return needSettings();return result(await host.listCalendars());}
          if(path.endsWith('/bookings'))return result(await host.listBookings());
          if(path.endsWith('/availability'))return result(await host.availability(url.searchParams.get('type')||'intro',{duration:requestedDuration(url)}));
          if(path.endsWith('/analytics'))return result(await host.analytics());
          throw new HttpError(405,'Preview settings with a JSON POST request.');
        }
        return await handleDevice(request,env,{getSession:req=>session(req,env)});
      }
      if(local&&!path.startsWith('/auth/')&&!path.startsWith('/api/live/')&&!path.startsWith('/api/public/')&&!path.startsWith('/api/manage/'))return demo.fetch(request,env,ctx);
      if(!path.startsWith('/api/')&&!path.startsWith('/auth/'))return secureAsset(await env.ASSETS.fetch(request),request);
      if(!configured(env))throw new HttpError(503,'Booking service is not configured yet.');
      if(url.origin!==originFor(env))throw new HttpError(421,'Use the configured booking address.');
      if(path==='/api/health')return response({ready:true});
      if(path==='/auth/google'&&request.method==='GET'){await limit(request,env,'auth');return await oauthStart(request,env);}
      if(path==='/auth/google/callback'&&request.method==='GET')return await oauthCallback(request,env);
      if(path==='/auth/logout'&&request.method==='POST'){sameOrigin(request,env);return signOut(request,env);}
      if(path==='/api/account/deletion/status'){
        if(request.method!=='POST')throw new HttpError(405,'Use a JSON POST.');sameOrigin(request,env);await limit(request,env,'deletion');return response(await accountDeletionStatus(env,await readJson(request,4096)));
      }
      if(path.startsWith('/api/live/')) {
        if(['/api/live/account/deletion/prepare','/api/live/account/deletion/confirm'].includes(path)){
          const user=await session(request,env);if(!user)throw new HttpError(401,'Sign in to continue.');
          if(request.method!=='POST')throw new HttpError(405,'Use a JSON POST.');sameOrigin(request,env);await limit(request,env,'deletion');
          if(request.headers.get('X-Scheduling-Account')!==user.hostId)throw Object.assign(new HttpError(409,'The signed-in account changed. Reload Scheduling.'),{code:'deletion_account_changed'});
          const data=await readJson(request,8192);return response(path.endsWith('/prepare')?await prepareAccountDeletion(env,user,data):await confirmAccountDeletion(env,user,data));
        }
        if(path==='/api/live/account/export'||path==='/api/live/workspace/export'){
          const user=await session(request,env);if(!user)throw new HttpError(401,'Sign in to continue.');
          if(request.method!=='POST')throw new HttpError(405,'Request an export with a JSON POST.');
          const expected=request.headers.get('X-Scheduling-Account');if(expected&&expected!==user.hostId)throw Object.assign(new HttpError(409,'The signed-in account changed. Reload Scheduling.'),{code:'export_account_changed'});
          sameOrigin(request,env);await limit(request,env,'export');const data=await readJson(request,4096);
          return result(path==='/api/live/account/export'?await exportAccount(env,user,data):await exportWorkspace(env,user,request.headers.get('X-Scheduling-Workspace'),data));
        }
        // Contribution withdrawal is identity-owned, even after company access ends.
        if(path==='/api/live/calendar-contributions'||path==='/api/live/calendar-contributions/withdraw'){
          const user=await session(request,env);if(!user)throw new HttpError(401,'Sign in to continue.');const identity=await verifiedIdentity(env,user.hostId);if(!identity||identity.email!==user.email.toLowerCase())throw new HttpError(403,'Sign in again with your verified email.');
          if(path==='/api/live/calendar-contributions'&&request.method==='GET'){
            const saved=await env.AUTH.getByName('calendar-contributions:'+user.hostId).get(),entries=(saved?.contributions??[]).slice(0,200),contributions=new Array(entries.length);let cursor=0;
            await Promise.all(Array.from({length:Math.min(4,entries.length)},async()=>{for(;;){const i=cursor++;if(i>=entries.length)return;const entry=entries[i];if(!hostPattern.test(entry?.workspaceId??'')||typeof entry.accountId!=='string'||entry.accountId.length>1024)continue;try{const state=await env.LIVE_HOSTS.getByName(entry.workspaceId).contributionState({id:user.hostId},entry.accountId);contributions[i]={workspaceId:entry.workspaceId,accountId:entry.accountId,email:entry.email,connected:state.connected===true,withdrawn:state.withdrawn===true};}catch(error){if(error.status===403||error.status===404)continue;contributions[i]={workspaceId:entry.workspaceId,accountId:entry.accountId,email:entry.email,unavailable:true};}}}));
            return response({contributions:contributions.filter(Boolean)});
          }
          if(path.endsWith('/withdraw')&&request.method==='POST'){sameOrigin(request,env);await limit(request,env,'decision');const data=await readJson(request);if(Object.keys(data).some(k=>!['workspaceId','accountId'].includes(k))||!hostPattern.test(data.workspaceId??'')||typeof data.accountId!=='string'||data.accountId.length>1024)throw new HttpError(400,'Choose your calendar contribution.');return result(await env.LIVE_HOSTS.getByName(data.workspaceId).withdrawMemberCalendar({id:user.hostId,email:identity.email},data.accountId));}
          throw new HttpError(405,'Choose a contribution action.');
        }
        if(path==='/api/live/my-calendar'||path==='/api/live/my-calendar/disconnect'||path==='/api/live/my-calendar/readiness'){
          const user=await session(request,env);if(!user)throw new HttpError(401,'Sign in to continue.');const member=await ownCalendarMember(env,user,request.headers.get('X-Scheduling-Workspace')),host=env.LIVE_HOSTS.getByName(member.workspaceId);
          if(path==='/api/live/my-calendar/readiness'&&request.method==='GET')return result(await host.ownCalendarReadiness(member));
          if(path==='/api/live/my-calendar'&&request.method==='GET')return result(await host.ownCalendar(member));
          if(request.method==='POST'&&path!=='/api/live/my-calendar/readiness'){sameOrigin(request,env);await limit(request,env,'decision');const data=await readJson(request,32000);return result(path.endsWith('/disconnect')?await host.disconnectOwnCalendar(member,data):await host.configureOwnCalendar(member,data));}
          throw new HttpError(405,'Choose your calendar settings.');
        }
        // Workspace discovery/invites and browser sessions retain the personal
        // authenticated identity. A company header never retargets its bearer.
        if(path==='/api/live/workspaces'||path.startsWith('/api/live/workspace')){
          const user=await session(request,env);if(!user)throw new HttpError(401,'Sign in to continue.');
          let data={};if(request.method==='POST'){sameOrigin(request,env);await limit(request,env,'decision');data=await readJson(request);}
          return response(await workspaceRoute(path,request.method,data,{env,user,selected:request.headers.get('X-Scheduling-Workspace'),origin:originFor(env)}));
        }
        if(path==='/api/live/sessions'&&request.method==='GET')return await browserSessions(request,env);
        if(path==='/api/live/sessions/revoke'&&request.method==='POST'){sameOrigin(request,env);return await revokeBrowserSession(request,env,await readJson(request));}
        if(path==='/api/live/sessions/revoke-others'&&request.method==='POST'){sameOrigin(request,env);return await revokeOtherBrowserSessions(request,env,await readJson(request));}
        const {user,host,access}=await admin(request,env);authorizeWorkspaceRoute(access,path,request.method);
        if(request.method==='GET') {
          if(path==='/api/live/settings'){const settings=await host.settingsWithRevision();return settings.error?result(settings):response(projectWorkspaceSettings(settings,access));}
          if(path==='/api/live/member-calendars')return result(await host.memberCalendarReadiness());
          if(path==='/api/live/calendars')return result(await host.listCalendars());
          if(path==='/api/live/integrations')return result(await host.integrationStatus());
          if(path==='/api/live/availability')return result(await host.availability(url.searchParams.get('type')||'intro',{preview:true,duration:requestedDuration(url)}));
          if(path==='/api/live/analytics')return result(await host.analytics());
          // Owner-only aggregate status; never exposes guest data, capabilities or payloads.
          if(path==='/api/live/operations')return result(await host.operationalStatus());
          if(path==='/api/live/bookings')return result(projectWorkspaceBookingList(await host.listBookings({includeNotifications:true}),access));
          const bookingDetail=path.match(/^\/api\/live\/bookings\/([-a-zA-Z0-9_]{16,80})$/);
          if(bookingDetail)return result(projectWorkspaceBooking(await host.hostBooking(bookingDetail[1]),access));
        }
        if(request.method==='POST') {
          sameOrigin(request,env);const data=await readJson(request,path==='/api/live/settings'?192*1024:12000);
          if(path==='/api/live/settings'){
            if(typeof data.expectedRevision!=='string')return result(projectSettingsOutcome(await host.applySettings(data.patch,data.expectedRevision),access));
            if(Object.keys(data).some(key=>!['patch','expectedRevision'].includes(key)))throw new HttpError(400,'Choose a settings patch and its reviewed revision.');
            return result(projectSettingsOutcome(await host.applySettings(data.patch,data.expectedRevision),access));
          }
          if(path==='/api/live/calendars')return result(projectSettingsOutcome(await host.configureCalendars(data),access));
          if(['/api/live/integrations','/api/live/integrations/test','/api/live/integrations/retry'].includes(path)){await limit(request,env,'decision');if(path==='/api/live/integrations')return result(await host.configureIntegration(data));if(path.endsWith('/test'))return result(await host.testIntegration(data));return result(await host.retryIntegrationDelivery(data));}
          if(path==='/api/live/disconnect')return result(projectSettingsOutcome(await host.disconnect(data.accountId),access));
          const hostAction=path.match(/^\/api\/live\/bookings\/([-a-zA-Z0-9_]{16,80})\/(cancel|reschedule|availability)$/);
          if(hostAction){
            const allowed=hostAction[2]==='reschedule'?['start','key']:hostAction[2]==='cancel'?['reason']:[];if(Object.keys(data).some(key=>!allowed.includes(key)))throw new HttpError(400,'Choose a booking action.');
            if(hostAction[2]==='reschedule'&&(!Number.isSafeInteger(data.start)||typeof data.key!=='string'||data.key.length<16||data.key.length>150))throw new HttpError(400,'Choose a valid new time.');
            await limit(request,env,'decision');const detail=await host.hostBooking(hostAction[1]);if(detail.error)return result(detail);
            // Never return the guest bearer to company administrators. Recheck
            // their live session/membership after decrypting the internal bearer.
            const current=await admin(request,env);authorizeWorkspaceRoute(current.access,path,'POST');
            if(current.access.hostId!==access.hostId)throw new HttpError(409,'Workspace changed.');
            if(hostAction[2]==='availability')return result(await host.rescheduleAvailability(hostAction[1],detail.managementToken,{},{staff:true}));
            const outcome=hostAction[2]==='cancel'?await host.cancel(hostAction[1],detail.managementToken,data.reason,{staff:true}):await host.reschedule(hostAction[1],detail.managementToken,data.start,data.key,{staff:true});return result(projectWorkspaceBooking(outcome,current.access));
          }
          const decision=path.match(/^\/api\/live\/bookings\/([-a-zA-Z0-9_]{16,80})\/decision$/);
          if(decision){if(Object.keys(data).some(key=>!['action','expectedVersion','key','reason'].includes(key)))throw new HttpError(400,'Choose a booking decision.');await limit(request,env,'decision');return result(projectWorkspaceBooking(await host.decideBooking(decision[1],data),access));}
          if(path==='/api/live/repair')return result(await host.runMaintenance('manual'));
          // Freeze or resume every calendar write, email send and guest change for this host.
          if(path==='/api/live/operations/maintenance'){await limit(request,env,'decision');return result(await host.setMaintenance(data));}
          // Records an operator's reconciled outcome for a parked email. It never re-sends.
          if(path==='/api/live/operations/deliveries/resolve'){await limit(request,env,'decision');return result(await host.resolveParkedDelivery(data));}
        }
        throw new HttpError(404,'Not found.');
      }
      const publicRoute=path.match(/^\/api\/public\/([^/]+)\/([^/]+)\/(availability|book|visit)$/);
      if(publicRoute) {
        const [,id,slug,operation]=publicRoute;
        if(!hostPattern.test(id)||!slugPattern.test(slug))throw new HttpError(404,'Booking page not found.');
        await limit(request,env,'browse');const host=env.LIVE_HOSTS.getByName(id);
        if(operation==='availability'&&request.method==='GET')return result(await host.availability(slug,{duration:requestedDuration(url)}));
        if(operation==='visit'&&request.method==='POST'){sameOrigin(request,env);const data=await readJson(request,256);return result(await host.recordVisit(slug,data.source));}
        if(operation==='book'&&request.method==='POST'){
          sameOrigin(request,env);await limit(request,env,'booking');const data=await readJson(request,100*1024);
          if(['staff','force','override','authority'].some(key=>Object.hasOwn(data,key)))throw new HttpError(400,'Choose valid booking details.');
          return result(await host.reserve(slug,data));
        }
      }
      const management=path.match(/^\/api\/manage\/([^/]+)\/([^/]+)$/);
      if(management&&request.method==='POST') {
        sameOrigin(request,env);await limit(request,env,'browse');const [,id,booking]=management;
        if(!hostPattern.test(id)||!/^[-a-zA-Z0-9_]{16,80}$/.test(booking))throw new HttpError(404,'Booking not found.');
        const data=await readJson(request,6000),host=env.LIVE_HOSTS.getByName(id);
        if(typeof data.token!=='string'||data.token.length>128)throw new HttpError(404,'Booking link is not valid.');
        if(data.action==='availability'){
          if(Object.keys(data).some(key=>!['action','token','from','to'].includes(key))||['from','to'].some(key=>data[key]!==undefined&&!Number.isSafeInteger(data[key])))throw new HttpError(400,'Choose a valid availability window.');
          return result(await host.rescheduleAvailability(booking,data.token,{from:data.from,to:data.to}));
        }
        if(data.action==='view'){if(Object.keys(data).some(key=>!['action','token'].includes(key)))throw new HttpError(400,'Choose a booking action.');return result(await host.manage(booking,data.token));}
        if(data.action==='cancel'){if(Object.keys(data).some(key=>!['action','token','reason'].includes(key)))throw new HttpError(400,'Choose a booking action.');return result(await host.cancel(booking,data.token,data.reason));}
        if(data.action==='reschedule'){if(Object.keys(data).some(key=>!['action','token','start','key'].includes(key)))throw new HttpError(400,'Choose a booking action.');if(data.duration!==undefined)throw new HttpError(400,'A reschedule keeps its original duration.');await limit(request,env,'booking');return result(await host.reschedule(booking,data.token,data.start,data.key));}
        throw new HttpError(400,'Choose a booking action.');
      }
      throw new HttpError(404,'Not found.');
    } catch(error) {
      const status=Number.isInteger(error.status)&&error.status>=400&&error.status<=599?error.status:400;
      // Log only operational codes, never provider bodies, intake or capabilities.
      if(status>=500)console.error(JSON.stringify({event:'booking_request_failed',status,code:error.code||'service_error'}));
      const message=status>=500?'Calendar connection is unavailable. Please try again shortly.':error.message||'Could not complete the request.';
      return response({error:message,...(publicCodes.includes(error.code)?{code:error.code}:{})},status);
    }
  },
  async scheduled(_event,env,ctx) {
    if(!configured(env))return;
    ctx.waitUntil((async()=>{
      const registry=env.AUTH.getByName('host-registry'),cursorStore=env.AUTH.getByName('watchdog-cursor');
      const cursor=(await cursorStore.get())?.after||'',ids=await registry.list(cursor);
      const result=await Promise.allSettled(ids.map(async id=>{const deletion=await resumeAccountDeletion(env,id);if(deletion&&!['not_started','prepared'].includes(deletion.state))return deletion;return env.LIVE_HOSTS.getByName(id).runMaintenance('watchdog');}));
      await cursorStore.put({after:ids.length===20?ids.at(-1):''},86400000);
      // Counts and fixed codes only: host IDs and error messages stay out of logs.
      const failures=result.filter(r=>r.status==='rejected'),codes={};
      for(const failure of failures){const code=typeof failure.reason?.code==='string'&&/^[a-z_]{1,40}$/.test(failure.reason.code)?failure.reason.code:'maintenance_error';codes[code]=(codes[code]??0)+1;}
      console.log(JSON.stringify({event:'booking_watchdog',checked:ids.length,failed:failures.length,wrapped:ids.length<20,...(failures.length?{codes}:{})}));
    })());
  }
};
