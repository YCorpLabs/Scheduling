import {lifecycleFetch} from './host-lifecycle.js';
import {encryptTokens,decryptTokens,randomToken} from './crypto.js';

export const INTEGRATION_EVENTS=Object.freeze(['booking.requested','booking.confirmed','booking.rescheduled','booking.cancelled','booking.approval_requested','booking.rejected','booking.expired']);
const DAY=86400000,MAX_INTEGRATIONS=10,MAX_PENDING=1000,MAX_HISTORY=1000,MAX_ATTEMPTS=8,LEASE_MS=30000;
const pendingStates=new Set(['queued','retry','in_flight']);
const deliveryVersion=c=>c.deliveryRevision??c.revision;
const encoder=new TextEncoder();
const refusal=(error,status=400,code='invalid_integration')=>({error,status,code});
const validId=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{16,80}$/.test(value);
// Operators identify their own instance to receivers; the neutral default names no operator.
export function webhookUserAgent(env={}){const value=typeof env.WEBHOOK_USER_AGENT==='string'?env.WEBHOOK_USER_AGENT.trim():'';return /^[A-Za-z0-9][A-Za-z0-9._-]{0,60}\/[A-Za-z0-9._-]{1,20}$/.test(value)?value:'Scheduling-Webhooks/1';}
function allowedHosts(env){return new Set(String(env.INTEGRATION_WEBHOOK_HOSTS||'').split(',').map(s=>s.trim().toLowerCase()).filter(s=>/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(s)&&s.includes('.')).slice(0,100));}
function publicHost(host){return host.includes('.')&&!host.endsWith('.')&&!host.includes(':')&&!/^\d+(?:\.\d+)*$/.test(host)&&!/(?:^|\.)(?:localhost|local|internal|lan|home|test|invalid|example)$/.test(host)&&/^[a-z0-9.-]+$/.test(host);}
// An operator-approved hostname is required in addition to DNS preflight. Workers
// fetch resolves independently; preflight alone is NOT DNS-rebinding protection.
export function validateDestination(value,kind,env={}){
 if(typeof value!=='string'||value.length>2048||/[\u0000-\u0020\u007f\\]/.test(value))throw Error('Choose a valid HTTPS destination.');
 let u;try{u=new URL(value);}catch{throw Error('Choose a valid HTTPS destination.');}
 if(u.protocol!=='https:'||u.username||u.password||u.hash||(u.port&&u.port!=='443')||!publicHost(u.hostname))throw Error('Choose a public HTTPS destination on port 443.');
 if(kind==='slack'){
  if(u.hostname!=='hooks.slack.com'||!/^\/services\/[A-Za-z0-9]{5,80}\/[A-Za-z0-9]{5,80}\/[A-Za-z0-9_-]{10,256}$/.test(u.pathname)||u.search)throw Error('Choose a Slack incoming webhook URL.');
 }else if(kind==='discord'){
  if(u.hostname!=='discord.com'||!/^\/api(?:\/v10)?\/webhooks\/[0-9]{5,30}\/[A-Za-z0-9_-]{20,256}$/.test(u.pathname)||u.search)throw Error('Choose a Discord incoming webhook URL.');
 }else if(kind==='webhook'){
  if(!allowedHosts(env).has(u.hostname))throw Object.assign(Error('This webhook host needs operator approval.'),{code:'webhook_host_not_approved'});
 }else throw Error('Choose Webhook, Slack or Discord.');
 return u;
}
// Reject all IP literals at the URL boundary. DNS responses only accept global
// unicast addresses; IPv6 is deliberately conservative (2000::/3 only).
export function publicAddress(value){
 if(typeof value!=='string')return false;
 if(value.includes(':')){
  if(!/^[0-9a-f:]+$/i.test(value)||value.split('::').length>2)return false;const halves=value.split('::'),left=halves[0]?halves[0].split(':'):[],right=halves.length===2&&halves[1]?halves[1].split(':'):[];
  if([...left,...right].some(x=>!x||x.length>4)||halves.length===1&&left.length!==8||halves.length===2&&left.length+right.length>=8)return false;
  const words=halves.length===1?left:[...left,...Array(8-left.length-right.length).fill('0'),...right],a=parseInt(words[0],16),b=parseInt(words[1],16);
  return a>=0x2000&&a<=0x3fff&&a!==0x2002&&a!==0x3fff&&!(a===0x2001&&(b<0x200||b===0xdb8));
 }
 const parts=value.split('.');if(parts.length!==4||parts.some(p=>!/^\d{1,3}$/.test(p)||Number(p)>255))return false;
 const [a,b,c]=parts.map(Number);
 return !(a===0||a===10||a===127||a>=224||a===100&&b>=64&&b<=127||a===169&&b===254||a===172&&b>=16&&b<=31||a===192&&(b===168||b===0||b===2||b===88&&c===99)||a===198&&(b===18||b===19||b===51&&c===100)||a===203&&b===0&&c===113);
}
async function dnsAddresses(host,fetcher){
 const responses=await Promise.all(['A','AAAA'].map(async type=>{
  const r=await fetcher('https://cloudflare-dns.com/dns-query?name='+encodeURIComponent(host)+'&type='+type,{headers:{accept:'application/dns-json'},redirect:'manual',signal:AbortSignal.timeout(5000)});
  if(!r.ok)throw Error('dns_unavailable');
  const contentLength=Number(r.headers.get('content-length'));if(contentLength>16384)throw Error('dns_unavailable');
  // Responses are bounded while streaming rather than buffering arbitrary bodies.
  const reader=r.body?.getReader();let text='',length=0;if(!reader)throw Error('dns_unavailable');
  try{for(;;){const {value,done}=await reader.read();if(done)break;length+=value.byteLength;if(length>16384)throw Error('dns_unavailable');text+=new TextDecoder().decode(value,{stream:true});}}finally{await reader.cancel().catch(()=>{});}
  const data=JSON.parse(text);if(data.Status!==0)throw Error('dns_unavailable');return (data.Answer||[]).filter(a=>a.type===1||a.type===28).map(a=>a.data);
 }));
 const addresses=responses.flat();if(!addresses.length||addresses.some(a=>!publicAddress(a)))throw Error('destination_not_public');return addresses;
}
export async function signature(secret,timestamp,body){const key=await crypto.subtle.importKey('raw',encoder.encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']);const bytes=new Uint8Array(await crypto.subtle.sign('HMAC',key,encoder.encode(timestamp+'.'+body)));return 'v1='+[...bytes].map(n=>n.toString(16).padStart(2,'0')).join('');}
const plain=value=>String(value??'').replace(/@/g,'＠').replace(/</g,'‹').replace(/>/g,'›').slice(0,600);
export function adapterPayload(kind,event){
 if(kind==='webhook')return event;
 const b=event.booking||{},text=[event.type.replace(/^booking\./,'').replace(/_/g,' '),b.title,b.start?new Date(b.start).toISOString():null,event.guest?`${event.guest.name} · ${event.guest.email}`:null].filter(Boolean).map(plain).join('\n');
 if(kind==='slack')return {text,parse:'none',link_names:false,unfurl_links:false,unfurl_media:false,blocks:[{type:'section',text:{type:'plain_text',text,emoji:false}}]};
 return {content:text,allowed_mentions:{parse:[]}};
}
function eventTypes(b,previous){
 const types=[];if(!previous)types.push('booking.requested');
 if(previous?.status!==b.status){if(b.status==='awaiting_approval')types.push('booking.approval_requested');if(b.status==='confirmed')types.push('booking.confirmed');if(b.status==='cancelled')types.push(b.replacementConfirmed?'booking.rescheduled':'booking.cancelled');if(['rejected','expired'].includes(b.status))types.push('booking.'+b.status);}
 if(previous?.status==='confirmed'&&b.status==='confirmed'&&(previous.start!==b.start||previous.end!==b.end))types.push('booking.rescheduled');
 return types;
}
function payload(ledger,b,type,now,includeGuestDetails){
 const successor=type==='booking.rescheduled'&&b.replacementConfirmed&&b.successorId?ledger.booking(b.successorId):null,meeting=successor?.status==='confirmed'?successor:b;
 const value={schemaVersion:1,id:`${b.id}.${type}.${b.version??1}`,type,occurredAt:new Date(now).toISOString(),workspaceId:ledger.hostId(),booking:{id:meeting.id,meetingTypeId:meeting.meetingTypeId,title:meeting.title,start:meeting.start,end:meeting.end,status:meeting.status,version:meeting.version??1,...(b.successorId?{successorId:b.successorId}:{})}};
 if(successor?.status==='confirmed')value.previousBooking={id:b.id,start:b.start,end:b.end};
 if(includeGuestDetails)value.guest={name:meeting.name||'',email:meeting.email||''};
 return value;
}

export class IntegrationOutbox{
 constructor(ledger,dependencies={}){
  this.ledger=ledger;this.fetch=lifecycleFetch(ledger,dependencies.fetch??globalThis.fetch.bind(globalThis));this.resolve=dependencies.resolve??(host=>dnsAddresses(host,this.fetch));
  this.sql=ledger.sql;this.rows=(...args)=>ledger.rows(...args);
  this.sql.exec('CREATE TABLE IF NOT EXISTS live_integrations (id TEXT PRIMARY KEY, body TEXT NOT NULL)');
  this.sql.exec('CREATE TABLE IF NOT EXISTS live_integration_deliveries (id TEXT PRIMARY KEY,event_id TEXT NOT NULL,integration_id TEXT NOT NULL,state TEXT NOT NULL,due INTEGER NOT NULL,updated_at INTEGER NOT NULL,body TEXT NOT NULL,UNIQUE(event_id,integration_id))');
  this.sql.exec('CREATE INDEX IF NOT EXISTS live_integration_due ON live_integration_deliveries(state,due)');
 }
 config(id){const row=this.rows('SELECT body FROM live_integrations WHERE id=?',id)[0];return row?JSON.parse(row.body):null;}
 configurations(){return this.rows('SELECT body FROM live_integrations ORDER BY id').map(r=>JSON.parse(r.body));}
 delivery(id){const row=this.rows('SELECT body FROM live_integration_deliveries WHERE id=?',id)[0];return row?JSON.parse(row.body):null;}
 saveDelivery(job){this.sql.exec('INSERT INTO live_integration_deliveries VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state,due=excluded.due,updated_at=excluded.updated_at,body=excluded.body',job.id,job.eventId,job.integrationId,job.state,job.due??0,job.updatedAt,JSON.stringify(job));}
 publicConfig(c){return Object.fromEntries(['id','kind','name','revision','enabled','events','includeGuestDetails','destinationLabel','createdAt','updatedAt'].map(k=>[k,c[k]]));}
 healthSummary(now=Date.now()){
  const row=this.rows("SELECT SUM(state IN ('queued','retry','in_flight')) AS queued,SUM(state='quarantined') AS quarantined,SUM(state='failed') AS failed,SUM(state='in_flight' AND due>?) AS in_flight,SUM(state IN ('queued','retry','in_flight') AND due<?) AS overdue,MIN(CASE WHEN state IN ('queued','retry','in_flight') AND due<? THEN due END) AS oldest FROM live_integration_deliveries",now,now-15*60000,now-15*60000)[0];
  return {queued:row.queued||0,quarantined:row.quarantined||0,failed:row.failed||0,inFlight:row.in_flight||0,overdue:row.overdue||0,oldestOverdueMs:row.oldest==null?null:Math.max(0,now-row.oldest)};
 }
 status(){
  this.prune();const rows=this.rows('SELECT body FROM live_integration_deliveries ORDER BY updated_at DESC,id DESC LIMIT 51'),count=this.rows('SELECT COUNT(*) AS n FROM live_integration_deliveries')[0].n;
  return {summary:this.healthSummary(),integrations:this.configurations().map(c=>this.publicConfig(c)),deliveries:rows.slice(0,50).map(r=>{const j=JSON.parse(r.body);return {id:j.id,integrationId:j.integrationId,eventId:j.eventId,eventType:j.eventType,state:j.state,attempts:j.attempts,nextAttemptAt:pendingStates.has(j.state)?j.due:null,lastAttemptAt:j.lastAttemptAt??null,errorCode:j.errorCode??null};}),deliveryCount:count,deliveriesTruncated:rows.length>50,customWebhookHostsConfigured:allowedHosts(this.ledger.env).size>0,capabilities:{kinds:['slack','discord','webhook'],events:INTEGRATION_EVENTS,customWebhooksRequireApprovedHost:true,atLeastOnce:true},limits:{integrations:MAX_INTEGRATIONS,queued:MAX_PENDING,history:MAX_HISTORY,historyDays:30},overflowCount:this.ledger.meta('integrations:overflowCount')||0};
 }
 async configure(data){
  if(!data||typeof data!=='object')return refusal('Choose an integration.');
  const action=data.action||'create',old=data.id?this.config(data.id):null;
  if(!['create','update','remove','rotate'].includes(action))return refusal('Choose a valid integration action.');
  if(action==='create'&&data.id!==undefined)return refusal('Create a new integration without an existing ID.');
  if(action==='rotate'&&old?.kind!=='webhook')return refusal('Only generic webhooks have a signing secret.');
  if(action!=='create'&&(!old||!validId(data.id)))return refusal('Integration not found.',404,'integration_not_found');
  if(old&&data.expectedRevision!==old.revision)return refusal('Integration changed. Refresh before saving.',409,'integration_conflict');
  if(action==='create'&&this.configurations().length>=MAX_INTEGRATIONS)return refusal('Integration limit reached.',409,'integration_limit');
  if(action==='remove'){this.ledger.ctx.storage.transactionSync(()=>{this.sql.exec('DELETE FROM live_integrations WHERE id=?',old.id);this.cancelPending(old.id,'integration_removed');});return {ok:true};}
  try{
   const id=old?.id||randomToken(18),kind=data.kind??old?.kind,name=String(data.name??old?.name??'').trim();if(!name||name.length>80||/[\u0000-\u001f\u007f]/.test(name))return refusal('Enter an integration name up to 80 characters.');
   if(old&&kind!==old.kind)return refusal('Create a new integration to change its kind.');
   const events=data.events??old?.events??['booking.confirmed','booking.cancelled'];if(!Array.isArray(events)||!events.length||events.length>INTEGRATION_EVENTS.length||events.some(e=>!INTEGRATION_EVENTS.includes(e))||new Set(events).size!==events.length)return refusal('Choose valid booking events.');
   const enabled=data.enabled??old?.enabled??true,includeGuestDetails=data.includeGuestDetails??old?.includeGuestDetails??false;if(typeof enabled!=='boolean'||typeof includeGuestDetails!=='boolean')return refusal('Choose valid integration settings.');
   const previousSecrets=old?await decryptTokens(old.ciphertext,this.ledger.env.TOKEN_ENCRYPTION_KEY,this.binding(id)):null;
   const url=old&&data.url===undefined&&enabled===false?new URL(previousSecrets.url):validateDestination(data.url??previousSecrets?.url,kind,this.ledger.env),newSecret=kind==='webhook'&&(!old||action==='rotate')?randomToken(32):null,secret=newSecret??previousSecrets?.secret??null;
   const ciphertext=await encryptTokens({url:url.href,secret},this.ledger.env.TOKEN_ENCRYPTION_KEY,this.binding(id)),current=this.config(id);
   if(old&&(current?.revision!==old.revision))return refusal('Integration changed. Refresh before saving.',409,'integration_conflict');
   if(action==='create'&&this.configurations().length>=MAX_INTEGRATIONS)return refusal('Integration limit reached.',409,'integration_limit');
   const changed=!old||action==='rotate'||url.href!==previousSecrets.url||enabled!==old.enabled||includeGuestDetails!==old.includeGuestDetails||events.length!==old.events.length||events.some(e=>!old.events.includes(e));
   const cooldownUntil=url.href===previousSecrets?.url?Math.max(old?.cooldownUntil||0,current?.cooldownUntil||0):0;
   const now=Date.now(),config={id,kind,name,events,enabled,includeGuestDetails,...(cooldownUntil?{cooldownUntil}:{}),ciphertext,destinationLabel:url.hostname,deliveryRevision:old?deliveryVersion(old)+(changed?1:0):1,revision:(old?.revision||0)+1,createdAt:old?.createdAt||now,updatedAt:now};
   this.ledger.ctx.storage.transactionSync(()=>{this.sql.exec('INSERT INTO live_integrations VALUES(?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body',id,JSON.stringify(config));if(old&&changed)this.cancelPending(id,'integration_changed');});
   return {integration:this.publicConfig(config),...(newSecret?{signingSecret:newSecret}:{})};
  }catch(error){return refusal(error.code==='webhook_host_not_approved'?error.message:'Integration could not be saved. Check its destination and encryption setup.',400,error.code==='webhook_host_not_approved'?error.code:'invalid_integration');}
 }
 binding(id){return this.ledger.hostId()+':integration:'+id;}
 cancelPending(id,code){for(const r of this.rows("SELECT body FROM live_integration_deliveries WHERE integration_id=? AND state IN ('queued','retry','in_flight')",id)){const j=JSON.parse(r.body);Object.assign(j,{state:'cancelled',due:0,leaseToken:null,errorCode:code,updatedAt:Date.now()});this.saveDelivery(j);}}
 enqueueBooking(b,previous){for(const type of eventTypes(b,previous)){for(const c of this.configurations()){if(c.enabled&&c.events.includes(type))this.enqueue(c,payload(this.ledger,b,type,Date.now(),c.includeGuestDetails));}}}
 enqueue(c,event){
  if(this.rows('SELECT id FROM live_integration_deliveries WHERE event_id=? AND integration_id=?',event.id,c.id).length)return null;
  this.prune();const full=this.rows("SELECT COUNT(*) AS n FROM live_integration_deliveries WHERE state IN ('queued','retry','in_flight','quarantined')")[0].n>=MAX_PENDING,now=Date.now();
  const job={id:randomToken(18),eventId:event.id,eventType:event.type,integrationId:c.id,integrationRevision:deliveryVersion(c),event,createdAt:now,updatedAt:now,due:full?0:now,state:full?'failed':'queued',attempts:0};if(full){job.errorCode='queue_capacity';this.ledger.putOperationalMeta('integrations:overflowCount',(this.ledger.meta('integrations:overflowCount')||0)+1);}
  this.saveDelivery(job);return job;
 }
 async test(data){
  if(this.ledger.maintenanceFrozen())return refusal('Outbound integrations are paused for maintenance.',503,'maintenance_frozen');
  const c=this.config(data?.id);if(!c)return refusal('Integration not found.',404,'integration_not_found');if(!c.enabled)return refusal('Enable the integration before testing.',409,'integration_disabled');
  const now=Date.now(),event={schemaVersion:1,id:randomToken(24),type:'integration.test',occurredAt:new Date(now).toISOString(),workspaceId:this.ledger.hostId(),booking:{title:'Integration test',start:now+3600000,end:now+5400000,status:'test'}};
  const job=this.enqueue(c,event);await this.ledger.wake();return {ok:true,deliveryId:job.id,state:job.state};
 }
 async retry(data){
  const j=this.delivery(data?.deliveryId);if(!j)return refusal('Delivery not found.',404,'delivery_not_found');
  if(data.action==='discard'){if(!['quarantined','failed'].includes(j.state))return refusal('Only failed or quarantined deliveries can be discarded.',409,'delivery_changed');Object.assign(j,{state:'cancelled',due:0,errorCode:'operator_discarded',updatedAt:Date.now()});this.saveDelivery(j);return {ok:true};}
  if(this.ledger.maintenanceFrozen())return refusal('Outbound integrations are paused for maintenance.',503,'maintenance_frozen');
  if(j.state!=='failed')return refusal('Only failed deliveries can be retried. Restored deliveries must be discarded.',409,'delivery_changed');
  const c=this.config(j.integrationId);if(!c?.enabled||deliveryVersion(c)!==j.integrationRevision)return refusal('The integration changed. This delivery cannot be replayed.',409,'integration_changed');
  if((j.manualRetries||0)>=3)return refusal('Manual retry limit reached.',409,'retry_limit');
  if(this.rows("SELECT COUNT(*) AS n FROM live_integration_deliveries WHERE state IN ('queued','retry','in_flight','quarantined')")[0].n>=MAX_PENDING)return refusal('Delivery queue is full.',409,'queue_capacity');
  Object.assign(j,{state:'queued',due:Date.now(),updatedAt:Date.now(),manualRetries:(j.manualRetries||0)+1,attemptsThisRun:0,errorCode:null});this.saveDelivery(j);await this.ledger.wake();return {ok:true,eventId:j.eventId};
 }
 quarantine(now=Date.now()){
  let count=0;for(const r of this.rows("SELECT body FROM live_integration_deliveries WHERE state IN ('queued','retry','in_flight')")){const j=JSON.parse(r.body);Object.assign(j,{state:'quarantined',due:0,errorCode:'restored',leaseToken:null,updatedAt:now});this.saveDelivery(j);count++;}return count;
 }
 quarantinedCount(){return this.rows("SELECT COUNT(*) AS n FROM live_integration_deliveries WHERE state='quarantined'")[0].n;}
 nextDue(){return this.rows("SELECT MIN(due) AS due FROM live_integration_deliveries WHERE state IN ('queued','retry','in_flight')")[0]?.due??null;}
 prune(now=Date.now()){
  this.sql.exec("DELETE FROM live_integration_deliveries WHERE state IN ('delivered','failed','cancelled') AND updated_at<?",now-30*DAY);
  this.sql.exec("DELETE FROM live_integration_deliveries WHERE id IN (SELECT id FROM live_integration_deliveries WHERE state IN ('delivered','failed','cancelled') ORDER BY updated_at DESC,id DESC LIMIT -1 OFFSET ?)",MAX_HISTORY);
 }
 async processBatch(){
  if(this.ledger.maintenanceFrozen())return;this.prune();
  const jobs=this.rows("SELECT body FROM live_integration_deliveries WHERE state IN ('queued','retry','in_flight') AND due<=? ORDER BY due,id LIMIT 3",Date.now());
  for(const row of jobs){if(this.ledger.maintenanceFrozen())break;await this.process(JSON.parse(row.body).id);}
 }
 async process(id){
  if(this.ledger.maintenanceFrozen())return;
  let j=this.delivery(id);if(!j||!pendingStates.has(j.state)||j.due>Date.now())return;
  const c=this.config(j.integrationId);if(!c?.enabled||deliveryVersion(c)!==j.integrationRevision){Object.assign(j,{state:'cancelled',errorCode:'integration_changed',due:0,updatedAt:Date.now()});this.saveDelivery(j);return;}
  if((c.cooldownUntil||0)>Date.now()){j.due=c.cooldownUntil;j.updatedAt=Date.now();this.saveDelivery(j);return;}
  const now=Date.now(),lease=randomToken(18);Object.assign(j,{state:'in_flight',attempts:j.attempts+1,attemptsThisRun:(j.attemptsThisRun||0)+1,lastAttemptAt:now,due:now+LEASE_MS,leaseToken:lease,updatedAt:now});this.saveDelivery(j);
  let outcome='retry',errorCode='delivery_unavailable',retryAfter=0;
  try{
   const secret=await decryptTokens(c.ciphertext,this.ledger.env.TOKEN_ENCRYPTION_KEY,this.binding(c.id)),url=validateDestination(secret.url,c.kind,this.ledger.env);
   await this.resolve(url.hostname);
   const current=this.delivery(id),config=this.config(c.id);if(this.ledger.maintenanceFrozen()||current?.leaseToken!==lease||!config||deliveryVersion(config)!==deliveryVersion(c))return;
   const body=JSON.stringify(adapterPayload(c.kind,j.event)),timestamp=String(Math.floor(Date.now()/1000)),headers={'content-type':'application/json','user-agent':webhookUserAgent(this.ledger.env),'x-scheduling-event-id':j.eventId,'x-scheduling-event':j.eventType};
   if(c.kind==='webhook'){headers['x-scheduling-timestamp']=timestamp;headers['x-scheduling-signature']=await signature(secret.secret,timestamp,body);}
   // Check again after crypto yields. Existing in-flight effects cannot be undone.
   if(this.ledger.maintenanceFrozen()||this.delivery(id)?.leaseToken!==lease||deliveryVersion(this.config(c.id)||{})!==deliveryVersion(c))return;
   if(c.kind==='discord')url.search='?wait=true';
   const response=await this.fetch(url.href,{method:'POST',headers,body,redirect:'manual',signal:AbortSignal.timeout(8000)});await response.body?.cancel().catch(()=>{});
   if(response.ok){outcome='delivered';errorCode=null;}else if(response.status===429||response.status>=500){errorCode=response.status===429?'rate_limited':'provider_unavailable';const value=response.headers.get('retry-after');retryAfter=/^\d+$/.test(value||'')?Number(value)*1000:Math.max(0,Date.parse(value||'')-Date.now());}else{outcome='failed';errorCode='provider_rejected';}
  }catch(error){errorCode=error?.message==='destination_not_public'?'destination_not_public':error?.code==='webhook_host_not_approved'?'webhook_host_not_approved':'delivery_unavailable';if(['destination_not_public','webhook_host_not_approved'].includes(errorCode))outcome='failed';}
  const current=this.delivery(id);if(current?.leaseToken!==lease||current.state!=='in_flight')return;
  if(errorCode==='rate_limited'){const latest=this.config(c.id);if(latest&&deliveryVersion(latest)===deliveryVersion(c)){latest.cooldownUntil=Date.now()+Math.max(15000,Math.min(DAY,Number.isFinite(retryAfter)?retryAfter:0),15000*2**Math.min(current.attemptsThisRun||1,8));this.sql.exec('UPDATE live_integrations SET body=? WHERE id=?',JSON.stringify(latest),c.id);}}
  const attempts=current.attemptsThisRun||current.attempts;if(outcome==='retry'&&(attempts>=MAX_ATTEMPTS||Date.now()-current.createdAt>=7*DAY))outcome='failed';
  Object.assign(current,{state:outcome,errorCode,leaseToken:null,updatedAt:Date.now(),due:outcome==='retry'?Date.now()+Math.max(15000,Math.min(DAY,Number.isFinite(retryAfter)?retryAfter:0),Math.min(3600000,15000*2**Math.min(attempts,8))):0});this.saveDelivery(current);
 }
}
