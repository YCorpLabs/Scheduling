import test from 'node:test';
import assert from 'node:assert/strict';
import {resolveWorkspaces,sectionsFor,can,canManageMember,inviteRoles,captureInviteToken,teamMarkup} from '../public/workspace-ui.js';
import {integrationPayload,validateIntegration,eventCatalog,eventGroups,eventSummary,deliveryStateLabel,canRetry,errorLabel,integrationsMarkup,integrationsHeading,webhookHostsReady,integrationHealth,testStatus} from '../public/integrations-ui.js';
import {validateDestination} from '../src/integrations.js';

const caps=role=>({manageSettings:['owner','admin'].includes(role),manageMembers:['owner','admin'].includes(role),manageIntegrations:['owner','admin'].includes(role),approveBookings:role!=='viewer',transferOwnership:role==='owner',grantAdmin:role==='owner'});
const listing={workspaces:[{id:'h_me',name:'Personal',role:'owner',personal:true},{id:'h_acme',name:'Acme',role:'admin',personal:false,capabilities:caps('admin')}],activeWorkspaceId:'h_me'};

test('old APIs without workspaces fall back to Personal only',()=>{
  for(const value of [null,{revision:'x',profile:{}},{workspaces:'nope'}]){const r=resolveWorkspaces(value,{account:'h_me',stored:{account:'h_me',id:'h_acme'}});assert.equal(r.supported,false);assert.equal(r.active.personal,true);assert.equal(r.workspaces.length,1);}
});
test('a stored company is used only for the same account and only when still listed',()=>{
  assert.equal(resolveWorkspaces(listing,{account:'h_me',stored:{account:'h_me',id:'h_acme'}}).active.id,'h_acme');
  const other=resolveWorkspaces(listing,{account:'h_other',stored:{account:'h_me',id:'h_acme'}});assert.equal(other.active.personal,true);assert.equal(other.stale,null);
  const removed=resolveWorkspaces({...listing,workspaces:[listing.workspaces[0]]},{account:'h_me',stored:{account:'h_me',id:'h_acme',name:'Acme'}});assert.equal(removed.active.personal,true);assert.deepEqual(removed.stale,{id:'h_acme',name:'Acme'});
});
test('capabilities come from the latest listing, not the stored record',()=>{
  const r=resolveWorkspaces({...listing,workspaces:[listing.workspaces[0],{id:'h_acme',name:'Acme',role:'viewer',capabilities:caps('viewer')}]},{account:'h_me',stored:{account:'h_me',id:'h_acme',role:'owner'}});
  assert.equal(r.active.role,'viewer');assert.equal(can(r.active,'manageSettings'),false);assert.deepEqual(sectionsFor(r.active),['Bookings','Team','Analytics']);
});
test('section and member permissions follow the workspace matrix',()=>{
  const ws=role=>({id:'h_x',name:'X',role,personal:false,capabilities:caps(role)});
  assert.ok(sectionsFor({personal:true}).includes('Integrations'));assert.ok(!sectionsFor({personal:true}).includes('Team'));
  assert.ok(sectionsFor(ws('admin')).includes('Integrations'));assert.deepEqual(sectionsFor(ws('member')),['Bookings','Team','Analytics']);
  assert.equal(can(ws('member'),'approveBookings'),true);assert.equal(can(ws('viewer'),'approveBookings'),false);
  assert.deepEqual(inviteRoles(ws('admin')),['member','viewer']);assert.deepEqual(inviteRoles(ws('owner')),['admin','member','viewer']);
  const me='me@example.com';
  assert.equal(canManageMember(ws('admin'),{email:'a@example.test',role:'admin'},me),false);
  assert.equal(canManageMember(ws('owner'),{email:'a@example.test',role:'admin'},me),true);
  assert.equal(canManageMember(ws('owner'),{email:'ME@example.com',role:'admin'},me),false);
  assert.equal(canManageMember(ws('member'),{email:'a@example.test',role:'viewer'},me),false);
});
test('invite tokens are taken from the fragment and the fragment is cleared',()=>{
  const token='h_'+'a'.repeat(24)+'.'+'b'.repeat(43);let replaced=null;const hist={replaceState:(_s,_t,url)=>{replaced=url;}};
  assert.equal(captureInviteToken({hash:'#invite='+token,pathname:'/studio',search:''},hist),token);assert.equal(replaced,'/studio');
  replaced=null;assert.equal(captureInviteToken({hash:'#invite=%3Cbad',pathname:'/studio',search:''},hist),null);assert.equal(replaced,'/studio');
  replaced=null;assert.equal(captureInviteToken({hash:'#booking=abc',pathname:'/studio',search:''},hist),null);assert.equal(replaced,null);
});
test('team markup hides invitations and controls from members',()=>{
  const data={members:[{id:'1',email:'owner@example.test',role:'owner'},{id:'2',email:'me@example.test',role:'member'}],invitations:[{id:'i',email:'new@example.test',role:'viewer',expiresAt:1}]};
  const html=teamMarkup(data,{workspace:{id:'h',name:'X',role:'member',capabilities:caps('member')},email:'me@example.test',formatDate:String});
  assert.doesNotMatch(html,/Pending invitations|data-manage-member|data-revoke-invite/);assert.match(html,/You/);
});
test('integration payloads never invent a URL and enforce the webhook host gate',()=>{
  const body=integrationPayload({kind:'slack',name:' Ops ',url:'',events:['booking.confirmed'],includeGuestDetails:false,enabled:true},{id:'i1',kind:'slack'});
  assert.equal(body.action,'update');assert.equal('url' in body,false);assert.equal(body.name,'Ops');
  assert.equal(validateIntegration({...body,action:'create'},{requireUrl:true}).field,'url');
  assert.equal(validateIntegration({action:'create',kind:'webhook',name:'W',url:'https://a.example',events:['booking.confirmed']},{requireUrl:true,webhookHosts:false}).field,'kind');
  assert.equal(validateIntegration({action:'create',kind:'slack',name:'S',url:'http://hooks.slack.com/x',events:['booking.confirmed']},{requireUrl:true}).field,'url');
  assert.equal(webhookHostsReady({status:{customWebhookHostsConfigured:true}}),true);assert.equal(webhookHostsReady({}),false);
});
test('delivery states and catalog match the backend contract',()=>{
  assert.deepEqual(eventCatalog({capabilities:{events:['booking.confirmed','booking.expired']}}).map(e=>e.label),['Booking confirmed','Request expired']);
  assert.equal(deliveryStateLabel('in_flight'),'Sending');assert.equal(canRetry({state:'failed'}),true);assert.equal(canRetry({state:'quarantined'}),false);
  assert.match(errorLabel('provider_rejected'),/Rejected/);
  const html=integrationsMarkup({integrations:[{id:'i1',kind:'slack',name:'Ops',enabled:true,events:['booking.confirmed'],includeGuestDetails:true,destinationLabel:'hooks.slack.com',revision:2},{id:'i2',kind:'webhook',name:'CRM',enabled:false,events:['booking.confirmed'],includeGuestDetails:false,destinationLabel:'crm.example',revision:1}],deliveries:[{id:'d1',integrationId:'i1',eventType:'booking.confirmed',state:'failed',attempts:3,lastAttemptAt:1,errorCode:'provider_rejected'}]},{formatTime:()=>'t'});
  // One muted line per row: the problem when there is one, otherwise what the integration sends.
  assert.match(html,/st-line-problem" id="integration-meta-i1">Failing · Rejected by the destination/);assert.match(html,/Off · Webhook · crm\.example · Confirmed/);assert.match(html,/data-retry-delivery="d1"/);
  assert.match(html,/data-integration-menu="i1"/);assert.match(html,/data-integration-menu="i2"/);assert.match(html,/data-edit-integration="i2"/);
  assert.doesNotMatch(html,/data-test-integration|data-toggle-integration|class="pill/);
  const quiet=integrationsMarkup({integrations:[{id:'i3',kind:'slack',name:'Ops',enabled:true,events:['booking.confirmed'],includeGuestDetails:true,revision:1}],deliveries:[]},{formatTime:()=>'t'});
  assert.match(quiet,/Slack · Confirmed · Shares guest details/);assert.doesNotMatch(html,/https:\/\//);assert.doesNotMatch(html,/answers/i);
});
test('the editor groups events and rows summarise them in words',()=>{
  const catalog=eventCatalog({capabilities:{events:['booking.requested','booking.confirmed','booking.rescheduled','booking.cancelled','booking.approval_requested','booking.rejected','booking.expired','booking.future']}});
  assert.deepEqual(eventGroups(catalog).map(g=>[g.label,g.events.map(e=>e.label)]),[['Bookings',['Requested','Confirmed','Rescheduled','Cancelled']],['Approvals',['Needs approval','Declined','Expired']],['Other',['booking.future']]]);
  assert.equal(eventSummary(['booking.cancelled','booking.confirmed'],catalog),'Confirmed, cancelled');
  assert.equal(eventSummary(catalog.map(e=>e.id),catalog),'All events');
  assert.equal(eventSummary(['booking.requested','booking.confirmed','booking.cancelled','booking.expired'],catalog),'4 events');
});
test('the catalog shows the webhook gate and the integration limit instead of a dead-end form',()=>{
  const base={integrations:[],deliveries:[]};
  assert.match(integrationsMarkup(base,{formatTime:String}),/is-unavailable" data-choice="webhook"[^]*Not available on this service/);
  assert.match(integrationsMarkup({...base,status:{customWebhookHostsConfigured:true}},{formatTime:String}),/data-add-integration data-kind="webhook"/);
  const full=integrationsMarkup({...base,integrations:[{id:'i1',kind:'slack',name:'A',enabled:true,events:['booking.confirmed']}],limits:{integrations:1},status:{customWebhookHostsConfigured:true}},{formatTime:String});
  assert.doesNotMatch(full,/data-add-integration/);assert.equal(integrationsHeading({integrations:[{id:'i1'}],limits:{integrations:1}}),'');assert.match(integrationsHeading({integrations:[{id:'i1'}]}),/Add integration/);assert.equal(integrationsHeading({integrations:[]}),'');assert.match(full,/Limit of 1 reached/);
});
test('URL checks in the editor agree with the Worker for Slack and Discord',()=>{
  const cases=[['slack','https://hooks.slack.com/services/T0123456/B0123456/abcdefghijklmnop'],['slack','https://hooks.slack.com/services/T0/B0/short'],['slack','https://hooks.slack.com/services/T0123456/B0123456/abcdefghijklmnop?x=1'],['slack','https://slack.com/services/T0123456/B0123456/abcdefghijklmnop'],['slack','https://hooks.slack.com:8443/services/T0123456/B0123456/abcdefghijklmnop'],
    ['discord','https://discord.com/api/webhooks/123456789/abcdefghijklmnopqrstuvwxyz'],['discord','https://discord.com/api/v10/webhooks/123456789/abcdefghijklmnopqrstuvwxyz'],['discord','https://discordapp.com/api/webhooks/123456789/abcdefghijklmnopqrstuvwxyz'],['discord','https://discord.com/api/webhooks/abc/abcdefghijklmnopqrstuvwxyz'],['discord','http://discord.com/api/webhooks/123456789/abcdefghijklmnopqrstuvwxyz']];
  for(const [kind,url] of cases){
    const ui=validateIntegration({action:'create',kind,name:'N',url,events:['booking.confirmed']},{requireUrl:true})===null;
    let worker=true;try{validateDestination(url,kind,{});}catch{worker=false;}
    assert.equal(ui,worker,`${kind} ${url}`);
  }
  assert.equal(validateIntegration({action:'create',kind:'slack',name:'',url:'https://hooks.slack.com/services/T0123456/B0123456/abcdefghijklmnop',events:['booking.confirmed']},{requireUrl:true}).field,'name');
});
test('rows flag only a failing or retrying newest delivery, and test results read plainly',()=>{
  const ds=[{integrationId:'a',state:'cancelled'},{integrationId:'a',state:'failed',errorCode:'provider_rejected'},{integrationId:'b',state:'delivered'},{integrationId:'b',state:'failed'},{integrationId:'c',state:'retry',errorCode:'rate_limited'}];
  assert.deepEqual(integrationHealth('a',ds),{tone:'failed',label:'Failing',text:'Last delivery failed: Rejected by the destination. Check the URL.'});
  assert.equal(integrationHealth('b',ds),null);assert.equal(integrationHealth('c',ds).tone,'retry');assert.equal(integrationHealth('d',ds),null);
  assert.equal(testStatus({state:'delivered'},'Ops'),'Test delivered to Ops');assert.equal(testStatus({state:'failed',errorCode:'provider_rejected'},'Ops'),'Test to Ops failed. Rejected by the destination. Check the URL.');
  assert.equal(testStatus({state:'failed',errorCode:'queue_capacity'},'Ops'),'Test notification could not be queued');assert.equal(testStatus({state:'queued'},'Ops'),'Test notification queued');
});
