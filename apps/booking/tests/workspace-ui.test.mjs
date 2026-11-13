import test from 'node:test';
import assert from 'node:assert/strict';
import {resolveWorkspaces,sectionsFor,can,canManageMember,inviteRoles,captureInviteToken,teamMarkup} from '../public/workspace-ui.js';
import {integrationPayload,validateIntegration,eventCatalog,deliveryStateLabel,canRetry,errorLabel,integrationsMarkup,webhookHostsReady} from '../public/integrations-ui.js';

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
  assert.equal(r.active.role,'viewer');assert.equal(can(r.active,'manageSettings'),false);assert.deepEqual(sectionsFor(r.active),['Bookings','Analytics','Team']);
});
test('section and member permissions follow the workspace matrix',()=>{
  const ws=role=>({id:'h_x',name:'X',role,personal:false,capabilities:caps(role)});
  assert.ok(sectionsFor({personal:true}).includes('Integrations'));assert.ok(!sectionsFor({personal:true}).includes('Team'));
  assert.ok(sectionsFor(ws('admin')).includes('Integrations'));assert.deepEqual(sectionsFor(ws('member')),['Bookings','Analytics','Team']);
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
  const html=integrationsMarkup({integrations:[{id:'i1',kind:'slack',name:'Ops',enabled:true,events:['booking.confirmed'],includeGuestDetails:true,destinationLabel:'hooks.slack.com',revision:2}],deliveries:[{id:'d1',integrationId:'i1',eventType:'booking.confirmed',state:'failed',attempts:3,lastAttemptAt:1,errorCode:'provider_rejected'}]},{formatTime:()=>'t'});
  assert.match(html,/hooks\.slack\.com/);assert.match(html,/data-retry-delivery="d1"/);assert.doesNotMatch(html,/https:\/\//);assert.doesNotMatch(html,/answers/i);
});
