import test from 'node:test';
import assert from 'node:assert/strict';
import {accountName,initials,accountMenuMarkup} from '../public/account-menu.js';
import {appView,clientMark,accessLine,capability,mcpAddress,addAppSteps,appsPageMarkup,appDetailMarkup,changeTime,changeSummary} from '../public/apps-ui.js';
import {parseSettingsHash,settingsHash,pageTitle,lastUsed,browserRow,accountPageMarkup,profilePageMarkup,profileCardMarkup,settingsSidebarMarkup,settingsListMarkup,forTeam,pageHead} from '../public/settings-ui.js';
import {browserLabel} from '../public/browser-label.js';
import {bookingsMarkup} from '../public/bookings-ui.js';

const DAY=86400000,NOW=Date.UTC(2026,10,17,12);
const fmt=(ms,opts)=>new Intl.DateTimeFormat('en-GB',{timeZone:'UTC',...opts}).format(ms);

test('the account button names the signed-in person, also in a team before personal settings load',()=>{
  // In a team after a reload the personal profile arrives after the first paint: the email stands in.
  assert.equal(accountName({profileName:undefined,email:'alex@fernhill.example'}),'alex@fernhill.example');
  assert.equal(accountName({profileName:'  ',email:'alex@fernhill.example'}),'alex@fernhill.example');
  assert.equal(accountName({profileName:'Alex Morgan',email:'alex@fernhill.example'}),'Alex Morgan');
  assert.equal(accountName({}),'Your account');
  assert.equal(initials('Alex Morgan'),'AM');assert.equal(initials('Alex'),'A');assert.equal(initials('alex@fernhill.example'),'A');
  const html=accountMenuMarkup({name:'Alex Morgan',email:'alex@fernhill.example'});
  assert.match(html,/<span class="host-avatar">AM<\/span>/);assert.match(html,/<strong>Alex Morgan<\/strong><span>alex@fernhill\.example<\/span>/);
  assert.match(html,/data-theme-choice="light"[^>]*>Light<.*data-theme-choice="dark"[^>]*>Dark<.*data-theme-choice="auto"[^>]*>Auto</);
  for(const gone of ['Edit profile','Change picture','Manage account','Calendar access','Dark mode','Troubleshooting','data-section'])assert.ok(!html.includes(gone),gone);
  assert.match(html,/id="sign-out" data-sign-out>Sign out</);
});

test('settings pages have addresses, and the old Activity and Integrations links land on them',()=>{
  assert.deepEqual(parseSettingsHash('#settings'),{page:null,app:null});
  assert.deepEqual(parseSettingsHash('#settings/apps/4bb117d5-e9b1-48d5-8013-242340e2ee6d'),{page:'Apps',app:'4bb117d5-e9b1-48d5-8013-242340e2ee6d'});
  assert.deepEqual(parseSettingsHash('#activity'),{page:'Apps',app:null});
  assert.deepEqual(parseSettingsHash('#integrations'),{page:'Notifications',app:null});
  assert.equal(parseSettingsHash('#settings/profile/x'),null);assert.equal(parseSettingsHash('#links'),null);
  assert.equal(settingsHash('Account'),'#settings/account');assert.equal(settingsHash('Apps','a1'),'#settings/apps/a1');assert.equal(settingsHash('Profile','a1'),'#settings/profile');assert.equal(settingsHash(''),'#settings');
  assert.deepEqual(['Profile','Apps','Notifications','Account'].map(pageTitle),['Profile','Connected apps','Notifications','Sign-in & data']);
  const side=settingsSidebarMarkup({pages:['Apps','Account'],current:'Account',account:'<i>me</i>'});
  assert.match(side,/data-settings-back><svg[^]*<span>Back<\/span>/);assert.match(side,/data-settings-page="Account" aria-current="page">Sign-in &amp; data/);assert.ok(!side.includes('Profile'));
  assert.match(settingsListMarkup([{page:'Apps',summary:'Email, Claude'}]),/<h1>Settings<\/h1>[^]*Connected apps<\/span><span class="st-line">Email, Claude</);
});

test('connected apps: Email desktop sessions and AI apps get their own name, icon and one line',()=>{
  const email=appView({id:'d1',name:"Email on Alex's MacBook Pro",scope:'booking:read email:tracking',createdAt:NOW-3*DAY});
  assert.deepEqual([email.title,email.line,email.desktop],['Email',"Alex's MacBook Pro · Read only",true]);
  const activity=[{at:NOW-DAY,summary:'Moved Intro call with Sam Lee',actor:{name:'Claude',sessionId:'c1'},target:{type:'booking',id:'b1'}},{at:NOW-2*DAY,summary:'Changed Product demo to 45 minutes',actor:{name:'Claude',sessionId:'c1'}},{at:NOW-9*DAY,summary:'Old change',actor:{name:'Claude',sessionId:'c1'}},{at:NOW-DAY,summary:'Another Claude',actor:{name:'Claude',sessionId:'c2'}},{at:NOW-DAY,summary:'Before session ids',actor:{name:'Claude'}}];
  const claude=appView({id:'c1',kind:'mcp',name:'Claude',scope:'booking:read booking:settings booking:manage',createdAt:NOW-5*DAY},{activity,now:NOW});
  assert.deepEqual([claude.title,claude.line,claude.mark],['Claude','Can make changes · 3 this week','claude']);
  // Entries from before session ids were recorded match on the app's name.
  assert.deepEqual(claude.changes.map(c=>c.summary),['Moved Intro call with Sam Lee','Before session ids','Changed Product demo to 45 minutes','Old change']);
  assert.equal(appView({id:'c9',kind:'mcp',name:'Claude',scope:'booking:read'},{activity:[{at:NOW,summary:'x',actor:{name:'Claude'}}],now:NOW}).line,'Read only · 1 this week');
  assert.equal(appView({id:'c1',kind:'mcp',name:'Claude',scope:'booking:read'}).changes,null);
  assert.deepEqual(['Claude','claude.ai','ChatGPT','OpenAI Codex','Cursor','Zed','MCP client'].map(clientMark),['claude','claude','openai','openai','cursor','','']);
  assert.equal(accessLine('booking:read email:tracking booking:settings'),'Can make changes');assert.equal(accessLine('booking:read booking:settings'),'Can make changes');assert.equal(capability('booking:read booking:settings'),'Can change your links and hours.');assert.equal(accessLine('booking:read'),'Read only');assert.equal(capability('booking:read email:tracking'),'Can see your links and bookings.');
  const page=appsPageMarkup({apps:[{id:'d1',name:"Email on Alex's MacBook Pro",scope:'booking:read'},{id:'z1',kind:'mcp',name:'Zed',scope:'booking:read'}],activity:[]},{origin:'https://meet.example',head:a=>`<h1>Connected apps</h1>${a}`,status:''});
  assert.match(page,/<img src="\/email-app-icon\.png"/);assert.match(page,/data-add-app[^>]*>Add AI app</);assert.match(page,/<h3 id="add-app-title">Add an AI app<\/h3>/);
  assert.match(page,/data-app="z1"><span class="st-tile"><svg[^>]*stroke="currentColor"/);assert.doesNotMatch(page,/>Z</);
});

test('Add AI app gives the three steps with the address shown short and copied in full',()=>{
  assert.deepEqual(mcpAddress('https://meet.example'),{full:'https://meet.example/mcp',shown:'meet.example/mcp'});
  const steps=addAppSteps('https://meet.example');
  assert.match(steps,/<li><span>In Claude, open Settings, then Connectors, then Add custom connector\. Other AI apps have a similar option\.<\/span><\/li>/);
  assert.match(steps,/<li><span>Paste this address:<\/span><div class="st-copy"><code>meet\.example\/mcp<\/code><button type="button" data-copy-mcp="https:\/\/meet\.example\/mcp"/);
  assert.match(steps,/<li><span>Sign in to Scheduling and approve it\. It shows up here\.<\/span><\/li><\/ol>$/);
  // With nothing connected the page shows the steps instead of an empty list.
  const empty=appsPageMarkup({apps:[],activity:[]},{origin:'https://meet.example',head:a=>`<h1>Connected apps</h1>${a}`,status:''});
  assert.match(empty,/^<h1>Connected apps<\/h1><ol class="st-steps">/);assert.doesNotMatch(empty,/Add AI app|data-app=/);
});

test('an app page shows what it can do, its recent changes and Disconnect',()=>{
  const view=appView({id:'c1',kind:'mcp',name:'Claude',scope:'booking:read booking:settings booking:manage',createdAt:Date.UTC(2026,10,12,9)},{activity:[{at:NOW-60000,summary:'Moved Intro call with Sam Lee to Thu 20 Nov, 14:00',actor:{sessionId:'c1'},target:{type:'booking',id:'b1'}},{at:NOW-DAY,summary:'Changed Product demo to 45 minutes',actor:{sessionId:'c1'}}],now:NOW});
  const html=appDetailMarkup(view,{fmt,status:''});
  assert.match(html,/data-apps-back>[^]*Connected apps<\/button><div class="st-head"><h1>Claude<\/h1><\/div><p class="st-lead">Can change your links, hours and bookings\. Connected 12 Nov\.<\/p>/);
  assert.match(html,/<h2 id="app-changes-title">Recent changes<\/h2>/);assert.match(html,/data-activity-booking="b1">Moved Intro call/);
  assert.match(html,/data-disconnect-app="c1">Disconnect Claude</);
  assert.equal(changeTime(NOW-60000,{fmt,now:NOW}),'Today, 11:59');assert.equal(changeTime(NOW-DAY,{fmt,now:NOW}),'Yesterday');assert.equal(changeTime(NOW-5*DAY,{fmt,now:NOW}),'12 Nov');
  const desktop=appDetailMarkup(appView({id:'d1',name:"Email on Alex's MacBook Pro",scope:'booking:read'}),{fmt,status:''});
  assert.match(desktop,/<p class="st-lead">On Alex&#39;s MacBook Pro\. Can see your links and bookings\.<\/p>/);assert.doesNotMatch(desktop,/Recent changes/);
});

test('Sign-in & data lists browsers inline with laptop or phone tiles and the data rows',()=>{
  const rows=[{id:'s1',current:true,createdAt:NOW-DAY,lastSeenAt:NOW},{id:'s2',device:'Safari on iPhone',mobile:true,createdAt:NOW-9*DAY,lastSeenAt:NOW-3*DAY-1000},{id:'s3',createdAt:NOW-9*DAY,lastSeenAt:NOW-DAY-5}];
  const mac='Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
  const current=browserRow(rows[0],{now:NOW,userAgent:mac});
  assert.match(current,/<rect x="4" y="5"[^]*Chrome on Mac<\/span><span class="st-line">This browser</);assert.doesNotMatch(current,/data-revoke-session/);
  const phone=browserRow(rows[1],{now:NOW});assert.match(phone,/<rect x="7" y="3"[^]*Safari on iPhone[^]*Last used 3 days ago[^]*data-revoke-session="s2" aria-label="Sign out Safari on iPhone">Sign out</);
  assert.match(browserRow(rows[2],{now:NOW}),/>Browser<[^]*Last used yesterday/);
  assert.equal(lastUsed(NOW-1000,NOW),'Last used today');
  const page=accountPageMarkup({email:'alex@fernhill.example',head:'<h1>Sign-in &amp; data</h1>',status:'',sessions:rows,contributions:[{email:'alex@fernhill.example',workspaceId:'w1',accountId:'a1'}],workspaceName:()=>'Fernhill',legal:''});
  assert.match(page,/<p class="st-lead">You sign in with Google as alex@fernhill\.example\.<\/p>/);
  assert.match(page,/<h2 id="browsers-title">Browsers<\/h2>[^]*data-revoke-others>Sign out other browsers</);
  assert.match(page,/<h2 id="calendar-access-title">Calendar access<\/h2>[^]*data-withdraw="0" aria-label="Stop sharing alex@fernhill\.example with Fernhill">Stop sharing</);
  assert.match(page,/<h2 id="your-data-title">Your data<\/h2><div class="st-rows"><div class="st-row" data-account-export><\/div>[^]*Delete your account[^]*Your Google Calendar events stay[^]*class="st-pill red" data-delete-account>Delete…</);
  // Theme is on every screen size (it left the name menu); the extra Sign out is for phones.
  assert.match(page,/data-theme-choice="auto"[^]*st-phone-only[^]*data-sign-out>Sign out</);
  assert.doesNotMatch(accountPageMarkup({email:'a@b.example',head:'',status:'',sessions:[]}),/Calendar access/);
});

test('the profile page edits everything the old dialog did, plus name and company, with a preview',()=>{
  const values={name:'Alex Morgan',company:'Fernhill',avatarImage:null,bannerImage:'data:image/jpeg;base64,AAAA'};
  const html=profilePageMarkup({values,meeting:{title:'Intro call',duration:30,locationType:'google_meet'},head:'<h1>Profile</h1>',status:''});
  assert.match(html,/<p class="st-lead">Guests see this on your booking pages\.<\/p>/);
  assert.match(html,/data-pick-image="avatarImage"[^>]*>Change photo</);assert.match(html,/data-remove-image="avatarImage" aria-label="Remove photo" hidden/);
  assert.match(html,/data-pick-image="bannerImage"[^>]*>Change banner</);assert.match(html,/data-remove-image="bannerImage" aria-label="Remove banner"  >Remove/);
  assert.match(html,/id="profile-name" name="name" value="Alex Morgan"/);assert.match(html,/id="profile-company" name="company" value="Fernhill"/);
  assert.match(html,/<button type="submit" class="st-pill dark" >Save<\/button><\/div><\/form><div class="pf-preview">/);
  assert.match(profileCardMarkup(values,{title:'Intro call',duration:30,locationType:'google_meet'}),/pf-card-banner[^]*>AM<\/span><span class="pf-card-name">Alex Morgan<\/span><span class="pf-card-company">Fernhill<\/span><span class="pf-card-title">Intro call<\/span><span class="pf-card-meta">30 minutes · Google Meet</);
});

test('browser labels are coarse and only name a phone as a phone',()=>{
  assert.deepEqual(browserLabel('Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1'),{name:'Safari on iPhone',mobile:true});
  assert.deepEqual(browserLabel('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0'),{name:'Edge on Windows',mobile:false});
  assert.deepEqual(browserLabel('Mozilla/5.0 (X11; Linux x86_64; rv:133.0) Gecko/20100101 Firefox/133.0'),{name:'Firefox on Linux',mobile:false});
  assert.deepEqual(browserLabel('Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36'),{name:'Chrome on Android',mobile:true});
  assert.equal(browserLabel(''),null);assert.equal(browserLabel('curl/8.7.1'),null);assert.equal(browserLabel(undefined),null);
});

test('Bookings links Stats for people without Links',()=>{
  const fmtLocal=(ms,o)=>new Intl.DateTimeFormat('en-GB',{timeZone:'UTC',...o}).format(ms);
  assert.match(bookingsMarkup({bookings:[],fmt:fmtLocal,zoneName:'UTC',stats:true}),/Cancelled<\/button> · <button type="button" class="link-button" data-section="Analytics">Stats<\/button>/);
  assert.doesNotMatch(bookingsMarkup({bookings:[],fmt:fmtLocal,zoneName:'UTC'}),/data-section="Analytics"/);
});

test('changes read with Studio times in the host zone, from detail or from the known older summaries',()=>{
  const oslo=(ms,o)=>new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/Oslo',...o}).format(ms),wall=(ms,o)=>new Intl.DateTimeFormat('en-GB',{...o,timeZone:'UTC'}).format(ms);
  const from=Date.UTC(2026,10,17,14),to=Date.UTC(2026,10,18,8,45);
  assert.equal(changeSummary({action:'reschedule_booking',summary:'(ignored)',detail:{title:'Intro call',name:'Sam Lee',from,to}},{fmt:oslo,wall}),'Moved Intro call with Sam Lee from Tue 17 Nov, 15:00 to Wed 18 Nov, 09:45');
  assert.equal(changeSummary({action:'cancel_booking',summary:'x',detail:{title:'Intro call',name:'Sam Lee',at:from}},{fmt:oslo,wall}),'Cancelled Intro call with Sam Lee on Tue 17 Nov, 15:00');
  assert.equal(changeSummary({action:'decide_booking',summary:'x',detail:{title:'Product demo',name:'Priya Shah',at:to,decision:'decline'}},{fmt:oslo,wall}),'Declined Product demo with Priya Shah on Wed 18 Nov, 09:45');
  assert.equal(changeSummary({action:'update_link',summary:'x',detail:{link:'Product demo'}},{fmt:oslo,wall}),'Changed the Product demo link');
  // Entries stored before detail existed: host wall-clock stamps and link paths are rewritten.
  assert.equal(changeSummary({action:'reschedule_booking',summary:'Moved Intro call with Sam Lee on 2026-11-17 15:00 to 2026-11-18 09:45'},{fmt:oslo,wall}),'Moved Intro call with Sam Lee from Tue 17 Nov, 15:00 to Wed 18 Nov, 09:45');
  assert.equal(changeSummary({summary:'Approved Intro with Grace on 2026-11-20 10:30'},{fmt:oslo,wall}),'Approved Intro with Grace on Fri 20 Nov, 10:30');
  assert.equal(changeSummary({summary:'Cancelled Coffee on the dock with Bo on 2026-12-01 08:00'},{fmt:oslo,wall}),'Cancelled Coffee on the dock with Bo on Tue 1 Dec, 08:00');
  assert.equal(changeSummary({summary:'Updated link Product demo (/demo)'},{fmt:oslo,wall}),'Changed the Product demo link');
  assert.equal(changeSummary({summary:'Created link Intro (/intro)'},{fmt:oslo,wall}),'Created the Intro link');
  assert.equal(changeSummary({summary:'Deleted link Coffee (/coffee-chat)'},{fmt:oslo,wall}),'Deleted the Coffee link');
  for(const summary of ['Updated availability: weekly hours','Changed settings: profile.name','Moved things on 2026-11-17','Connected Slack: #bookings'])assert.equal(changeSummary({summary},{fmt:oslo,wall}),summary);
  const view=appView({id:'c1',kind:'mcp',name:'Claude',scope:'booking:read'},{activity:[{at:from,actor:{sessionId:'c1'},action:'reschedule_booking',summary:'Moved Intro call with Sam Lee on 2026-11-17 15:00 to 2026-11-18 09:45',target:{type:'booking',id:'b1'}}],now:to});
  const html=appDetailMarkup(view,{fmt:oslo,status:''});assert.match(html,/data-activity-booking="b1">Moved Intro call with Sam Lee from \w{3} 17 Nov, 15:00 to \w{3} 18 Nov, 09:45</);assert.doesNotMatch(html,/2026-11-17/);
});

test('in a team, Profile and Notifications say which team they change; a personal profile shows nothing extra',()=>{
  assert.equal(forTeam({id:'h_f',name:'Fernhill',personal:false}),'<p class="st-for">For Fernhill</p>');
  assert.equal(forTeam({id:'h_me',name:'Alex Morgan',personal:true}),'');assert.equal(forTeam(null),'');
  assert.equal(forTeam({name:'<b>Acme</b>',personal:false}),'<p class="st-for">For &lt;b&gt;Acme&lt;/b&gt;</p>');
  const html=profilePageMarkup({values:{name:'Fernhill',company:''},meeting:null,head:pageHead('Profile')+forTeam({name:'Fernhill',personal:false}),status:''});
  assert.match(html,/<h1>Profile<\/h1><\/div><p class="st-for">For Fernhill<\/p><p class="st-lead">Guests see this on your booking pages\.<\/p>/);
});
