import {rememberVerifiedIdentity} from '../src/identity.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {workspaceAccess,workspaceList,createWorkspace,workspaceDetail,inviteMember,inspectInvitation,acceptInvitation,revokeInvitation,changeMember,authorizeWorkspaceRoute,projectWorkspaceSettings,projectWorkspaceBooking} from '../src/workspaces.js';
globalThis.crypto??=webcrypto;
const owner={hostId:'h_'+ 'a'.repeat(24),email:'owner@example.com'},admin={hostId:'h_'+'b'.repeat(24),email:'admin@example.com'},member={hostId:'h_'+'c'.repeat(24),email:'member@example.com'},viewer={hostId:'h_'+'d'.repeat(24),email:'viewer@example.com'};
function fixture(){const records=new Map(),initialized=[];const env={AUTH:{getByName(name){if(!records.has(name))records.set(name,{body:null,async get(){return structuredClone(this.body);},async register(id){initialized.push({registered:id});},async compareAndSwap(expected,body){if((this.body?.version??null)!==expected)return false;this.body=structuredClone(body);return true;}});return records.get(name);}},LIVE_HOSTS:{getByName(id){return {async init(profile){initialized.push({id,profile});},async fenceMemberCalendar(){return 1;}};}}};return {env,records,initialized};}
const status=(code)=>error=>error.status===code;
async function company(env){return (await createWorkspace(env,owner,{name:'Acme'})).workspace.id;}
async function join(env,id,user,role){const invitation=await inviteMember(env,owner,id,{email:user.email,role},'https://meet.example');const token=decodeURIComponent(invitation.url.split('#invite=')[1]);await acceptInvitation(env,user,token);return token;}
test('company storage is independent and discovery indexes never authorize another identity',async()=>{
 const {env,initialized}=fixture(),id=await company(env);assert.notEqual(id,owner.hostId);assert.equal(initialized.find(x=>x.profile).id,id);assert.equal(initialized.find(x=>x.profile).profile.company,'');assert.equal(initialized.find(x=>x.profile).profile.workspaceKind,'company');const list=await workspaceList(env,owner,id);assert.equal(list.workspaces.length,2);assert.equal(list.activeWorkspaceId,id);assert.equal((await workspaceAccess(env,owner,id)).role,'owner');await assert.rejects(workspaceAccess(env,member,id),status(403));await assert.rejects(workspaceAccess(env,member,owner.hostId),status(404));assert.equal((await workspaceList(env,member,id)).activeWorkspaceId,member.hostId);
});
test('invites require verified-session email, expose no stored secret and admit exactly once under race',async()=>{
 const {env,records}=fixture(),id=await company(env),created=await inviteMember(env,owner,id,{email:'MEMBER@example.com',role:'member'},'https://meet.example');const token=decodeURIComponent(created.url.split('#invite=')[1]);assert.ok(!JSON.stringify(records.get('workspace:'+id).body).includes(token));await assert.rejects(inspectInvitation(env,viewer,token),status(403));const preview=await inspectInvitation(env,member,token);assert.equal(preview.invitation.workspaceName,'Acme');const results=await Promise.allSettled([acceptInvitation(env,member,token),acceptInvitation(env,member,token)]);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal((await workspaceDetail(env,owner,id)).members.filter(m=>m.id===member.hostId).length,1);await assert.rejects(acceptInvitation(env,member,token),status(404));await assert.rejects(inspectInvitation(env,member,token),status(404));
});
test('expired, revoked and superseded invitations cannot add a member',async()=>{
 const {env,records}=fixture(),id=await company(env);const make=()=>inviteMember(env,owner,id,{email:viewer.email,role:'viewer'},'https://meet.example');let invite=await make(),token=decodeURIComponent(invite.url.split('#invite=')[1]);await revokeInvitation(env,owner,id,{id:invite.invitation.id});await assert.rejects(acceptInvitation(env,viewer,token),status(404));invite=await make();token=decodeURIComponent(invite.url.split('#invite=')[1]);records.get('workspace:'+id).body.invitations.find(i=>i.id===invite.invitation.id).expiresAt=Date.now()-1;await assert.rejects(acceptInvitation(env,viewer,token),status(404));invite=await make();token=decodeURIComponent(invite.url.split('#invite=')[1]);await make();await assert.rejects(acceptInvitation(env,viewer,token),status(404));assert.equal((await workspaceAccess(env,owner,id)).role,'owner');
});
test('role changes, admin grants and ownership transfer preserve one owner and stop privilege escalation',async()=>{
 const {env}=fixture(),id=await company(env);await join(env,id,admin,'admin');await join(env,id,member,'member');await assert.rejects(inviteMember(env,admin,id,{email:viewer.email,role:'admin'},'https://meet.example'),status(403));await assert.rejects(changeMember(env,member,id,{action:'role',memberId:member.hostId,role:'admin'}),status(403));await assert.rejects(changeMember(env,admin,id,{action:'role',memberId:member.hostId,role:'admin'}),status(403));await assert.rejects(changeMember(env,owner,id,{action:'remove',memberId:owner.hostId}),status(409));await assert.rejects(changeMember(env,owner,id,{action:'role',memberId:owner.hostId,role:'member'}),status(409));await changeMember(env,owner,id,{action:'transfer',memberId:member.hostId});const details=await workspaceDetail(env,member,id);assert.equal(details.members.filter(m=>m.role==='owner').length,1);assert.equal((await workspaceAccess(env,member,id)).role,'owner');assert.equal((await workspaceAccess(env,owner,id)).role,'admin');await assert.rejects(changeMember(env,owner,id,{action:'transfer',memberId:admin.hostId}),status(403));await changeMember(env,member,id,{action:'remove',memberId:admin.hostId});await assert.rejects(workspaceAccess(env,admin,id),status(403));assert.equal((await workspaceList(env,admin,id)).workspaces.length,1);
});
test('CAS retries recheck the acting role rather than replaying an authorization captured before revocation',async()=>{
 const {env,records}=fixture(),id=await company(env);await join(env,id,admin,'admin');const target=records.get('workspace:'+id),original=target.compareAndSwap.bind(target);let first=true;target.compareAndSwap=async(expected,body)=>{if(first){first=false;target.body.members.find(m=>m.id===admin.hostId).role='viewer';target.body.version++;}return original(expected,body);};await assert.rejects(inviteMember(env,admin,id,{email:viewer.email,role:'member'},'https://meet.example'),status(403));assert.equal((await workspaceDetail(env,owner,id)).invitations.length,0);
});
test('member/viewer routes and projections never expose admin configuration or reusable guest credentials',async()=>{
 const {env}=fixture(),id=await company(env);await join(env,id,member,'member');await join(env,id,viewer,'viewer');const m=await workspaceAccess(env,member,id),v=await workspaceAccess(env,viewer,id);for(const access of [m,v]){authorizeWorkspaceRoute(access,'/api/live/bookings','GET');authorizeWorkspaceRoute(access,'/api/live/analytics','GET');assert.throws(()=>authorizeWorkspaceRoute(access,'/api/live/calendars','GET'),status(403));assert.throws(()=>authorizeWorkspaceRoute(access,'/api/live/settings','POST'),status(403));assert.throws(()=>authorizeWorkspaceRoute(access,'/api/live/integrations','GET'),status(403));const source={revision:'revision',profile:{name:'Acme',email:'private@example.com'},accounts:[{grant:'secret'}],availabilitySchedules:[{secret:'hours'}],meetingTypes:[{id:'x',title:'Intro',calendarId:'private-calendar',accountId:'private-account',weeklyHours:{1:[]}}]};const projected=projectWorkspaceSettings(source,access);assert.equal(projected.accounts.length,0);assert.ok(!JSON.stringify(projected).includes('private'));assert.ok(!JSON.stringify(projected).includes('hours'));assert.deepEqual(projectWorkspaceBooking({booking:{id:'b'},managementToken:'reusable-guest-secret'},access),{booking:{id:'b'}});}
 authorizeWorkspaceRoute(m,'/api/live/bookings/'+'x'.repeat(16)+'/decision','POST');assert.throws(()=>authorizeWorkspaceRoute(v,'/api/live/bookings/'+'x'.repeat(16)+'/decision','POST'),status(403));assert.equal((await workspaceDetail(env,viewer,id)).invitations.length,0);
});

test('an admin cannot supersede an owner-issued admin invitation through another role',async()=>{
 const {env}=fixture(),id=await company(env);await join(env,id,admin,'admin');const original=await inviteMember(env,owner,id,{email:viewer.email,role:'admin'},'https://meet.example');
 await assert.rejects(inviteMember(env,admin,id,{email:viewer.email,role:'viewer'},'https://meet.example'),status(403));await assert.rejects(revokeInvitation(env,admin,id,{id:original.invitation.id}),status(403));
 const token=decodeURIComponent(original.url.split('#invite=')[1]);await acceptInvitation(env,viewer,token);assert.equal((await workspaceAccess(env,viewer,id)).role,'admin');
});
test('concurrent ownership transfers keep exactly one owner and bind authority to the successful version',async()=>{
 const {env}=fixture(),id=await company(env);await join(env,id,admin,'admin');await join(env,id,member,'member');const results=await Promise.allSettled([changeMember(env,owner,id,{action:'transfer',memberId:admin.hostId}),changeMember(env,owner,id,{action:'transfer',memberId:member.hostId})]);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);const list=await workspaceDetail(env,owner,id);assert.equal(list.members.filter(m=>m.role==='owner').length,1);assert.equal((await workspaceAccess(env,owner,id)).role,'admin');
});

test('stale discovery entries are pruned so former workspaces do not permanently fill the limit',async()=>{
 const {env,records}=fixture();const target=env.AUTH.getByName('workspace-index:'+owner.hostId);target.body={version:1,ids:Array.from({length:40},(_,i)=>'h_'+String(i).padStart(24,'0'))};
 const id=await company(env);assert.deepEqual(records.get('workspace-index:'+owner.hostId).body.ids,[id]);assert.equal((await workspaceList(env,owner,id)).workspaces.length,2);
});
test('failed creation reservations expire and pruning cannot erase a competing fresh admission',async()=>{
 const {env,records}=fixture(),originalInit=env.LIVE_HOSTS.getByName,originalNow=Date.now;let now=originalNow();Date.now=()=>now;
 try{
  env.LIVE_HOSTS.getByName=()=>({async init(){throw Error('interrupted init');}});await assert.rejects(createWorkspace(env,owner,{name:'Interrupted'}));const target=records.get('workspace-index:'+owner.hostId),abandoned=target.body.ids[0];assert.ok(target.body.pins[abandoned].until>now);
  env.LIVE_HOSTS.getByName=originalInit;now+=3600001;const id=await company(env);assert.deepEqual(target.body.ids,[id]);
  const competing='h_'+'z'.repeat(24),cas=target.compareAndSwap.bind(target);let first=true;target.compareAndSwap=async(expected,body)=>{if(first){first=false;target.body.ids.push(competing);target.body.pins[competing]=now+3600000;target.body.version++;}return cas(expected,body);};const next=await company(env);assert.ok(target.body.ids.includes(competing));assert.ok(target.body.ids.includes(next));assert.ok(!target.body.ids.includes(abandoned));
 }finally{Date.now=originalNow;}
});

test('non-owner members can leave only their own membership and lose access immediately',async()=>{
 for(const [user,role] of [[admin,'admin'],[member,'member'],[viewer,'viewer']]){const {env}=fixture(),id=await company(env);await join(env,id,user,role);await assert.rejects(changeMember(env,user,id,{action:'remove',memberId:owner.hostId}),status(role==='admin'?409:403));const left=await changeMember(env,user,id,{action:'remove',memberId:user.hostId});assert.equal(left.left,true);assert.equal(left.workspace,null);assert.deepEqual(left.members,[]);await assert.rejects(workspaceAccess(env,user,id),status(403));assert.equal((await workspaceList(env,user,id)).workspaces.length,1);}
});
test('admitted workspace entries release discovery reservations so removal frees capacity immediately',async()=>{
 const {env,records,initialized}=fixture(),id=await company(env);assert.ok(initialized.some(item=>item.registered===id));assert.equal(records.get('workspace-index:'+owner.hostId).body.pins[id],undefined);await join(env,id,viewer,'viewer');assert.equal(records.get('workspace-index:'+viewer.hostId).body.pins[id],undefined);await changeMember(env,owner,id,{action:'remove',memberId:viewer.hostId});const next=(await createWorkspace(env,viewer,{name:'Next company'})).workspace.id;assert.deepEqual(records.get('workspace-index:'+viewer.hostId).body.ids,[next]);
});

test('interrupted watchdog registration is repaired idempotently on authenticated workspace access',async()=>{
 const {env,records,initialized}=fixture(),registry=env.AUTH.getByName('host-registry'),original=registry.register;let fail=true,calls=0;registry.register=async id=>{if(++calls>1&&fail)throw Error('registry temporarily unavailable');return original.call(registry,id);};await assert.rejects(createWorkspace(env,owner,{name:'Recoverable company'}));const list=await workspaceList(env,owner),id=list.workspaces.find(w=>!w.personal).id;assert.equal(records.get('workspace:'+id).body.registryRegistered,undefined);await assert.rejects(workspaceAccess(env,viewer,id),status(403));fail=false;assert.equal((await workspaceAccess(env,owner,id)).role,'owner');assert.equal(records.get('workspace:'+id).body.registryRegistered,true);assert.equal(initialized.filter(item=>item.registered===id).length,2);await workspaceAccess(env,owner,id);assert.equal(initialized.filter(item=>item.registered===id).length,2);
});

test('fresh verified identity updates membership email and cached sessions cannot revert it',async()=>{
 const {env,records}=fixture(),id=await company(env),updated={...owner,email:'current@example.com'};
 await rememberVerifiedIdentity(env,updated);await workspaceAccess(env,updated,id);assert.equal(records.get('workspace:'+id).body.members[0].email,updated.email);
 await workspaceAccess(env,owner,id);const detail=await workspaceDetail(env,owner,id);assert.equal(detail.members[0].email,updated.email);assert.equal(records.get('identity:'+owner.hostId).body.email,updated.email);
});
test('verified email collision never merges member identities or changes permissions',async()=>{
 const {env,records}=fixture(),id=await company(env);await join(env,id,viewer,'viewer');await rememberVerifiedIdentity(env,{...owner,email:viewer.email});await assert.rejects(workspaceAccess(env,owner,id),status(409));const members=records.get('workspace:'+id).body.members;assert.equal(members.length,2);assert.equal(members.find(m=>m.id===owner.hostId).role,'owner');assert.equal(members.find(m=>m.id===viewer.hostId).role,'viewer');
});

test('company admins receive authenticated actions rather than reusable guest credentials',async()=>{
 const {env}=fixture(),id=await company(env),companyAccess=await workspaceAccess(env,owner,id),personalAccess=await workspaceAccess(env,owner);
 const detail={booking:{id:'booking-id'},managementToken:'guest-capability'};assert.deepEqual(projectWorkspaceBooking(detail,companyAccess),{booking:{id:'booking-id'},hostActions:{manage:true}});assert.equal(projectWorkspaceBooking(detail,personalAccess).managementToken,'guest-capability');
 await join(env,id,member,'member');const limited=await workspaceAccess(env,member,id);for(const action of ['cancel','reschedule'])assert.throws(()=>authorizeWorkspaceRoute(limited,'/api/live/bookings/'+'x'.repeat(16)+'/'+action,'POST'),status(403));
});

test('first named profile keeps a preferred context without granting membership from that preference',async()=>{
 const {env,initialized,records}=fixture();const created=await createWorkspace(env,owner,{name:'Globex',website:'globex.example',firstProfile:true});const id=created.workspace.id;
 assert.equal(initialized.find(x=>x.profile).profile.website,'https://globex.example/');assert.equal((await workspaceList(env,owner)).activeWorkspaceId,id);
 await createWorkspace(env,owner,{name:'Another'});assert.equal((await workspaceList(env,owner)).activeWorkspaceId,id);
 assert.equal((await workspaceList(env,owner,owner.hostId)).activeWorkspaceId,owner.hostId);
 await assert.rejects(createWorkspace(env,owner,{name:'Bad',website:'https://user:secret@example.com'}),status(400));
 env.AUTH.getByName('workspace-index:'+member.hostId).body={version:1,ids:[],primaryId:id};assert.equal((await workspaceList(env,member)).activeWorkspaceId,member.hostId);await assert.rejects(workspaceAccess(env,member,id),status(403));
});
