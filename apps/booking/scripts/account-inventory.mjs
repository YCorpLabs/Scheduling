#!/usr/bin/env node
// Operator-only full legacy inventory. Uses the operator's Cloudflare login and
// an existing Worker service entrypoint; no new deployed service or API secret.
// Default is read-only audit. --apply publishes inventory proofs, never purges.
import {readFileSync,writeFileSync,mkdirSync,chmodSync} from 'node:fs';
import {homedir} from 'node:os';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomBytes} from 'node:crypto';
import {getPlatformProxy} from 'wrangler';
const APP=resolve(dirname(fileURLToPath(import.meta.url)),'..'),apply=process.argv.includes('--apply');
const cfg=JSON.parse(readFileSync(resolve(APP,'wrangler.instance.generated.json'),'utf8'));
let token=process.env.CLOUDFLARE_API_TOKEN;
if(!token)for(const file of [process.env.WRANGLER_AUTH_FILE,resolve(homedir(),'Library/Preferences/.wrangler/config/default.toml'),resolve(homedir(),'.config/.wrangler/config/default.toml')].filter(Boolean))try{const text=readFileSync(file,'utf8');token=/^(?:oauth_token|api_token)\s*=\s*"([^"]+)"/m.exec(text)?.[1];if(token)break;}catch{}
if(!token)throw Error('Sign in with Wrangler or set CLOUDFLARE_API_TOKEN.');
async function api(path){const response=await fetch('https://api.cloudflare.com/client/v4'+path,{headers:{Authorization:'Bearer '+token},signal:AbortSignal.timeout(30000)});const data=await response.json();if(!response.ok||data.success!==true)throw Error('Cloudflare inventory API refused: HTTP '+response.status);return data;}
let account=process.env.CLOUDFLARE_ACCOUNT_ID||cfg.account_id;
if(!account){const accounts=(await api('/accounts?per_page=50')).result;if(accounts.length!==1)throw Error('Set CLOUDFLARE_ACCOUNT_ID for this instance.');account=accounts[0].id;}
const settings=(await api(`/accounts/${account}/workers/scripts/${cfg.name}/settings`)).result;
const ns=name=>{const id=settings.bindings.find(b=>b.name===name&&b.type==='durable_object_namespace')?.namespace_id;if(!/^[a-f0-9]{32}$/.test(id??''))throw Error('Missing deployed namespace '+name);return id;};
async function list(namespace){const ids=new Set(),cursors=new Set();let cursor='';for(let page=0;page<1000;page++){const data=await api(`/accounts/${account}/workers/durable_objects/namespaces/${namespace}/objects?limit=10000${cursor?'&cursor='+encodeURIComponent(cursor):''}`);if(!Array.isArray(data.result))throw Error('Invalid namespace response');for(const item of data.result){if(!/^[a-f0-9]{64}$/.test(item.id??''))throw Error('Invalid object ID');ids.add(item.id);}const next=data.result_info?.cursor;if(!data.result.length||!next){if(data.result.length===10000&&!next)throw Error('Unproven namespace page end');return [...ids].sort();}if(cursors.has(next))throw Error('Repeated inventory cursor');cursors.add(next);cursor=next;}throw Error('Inventory page limit reached');}
const proxyPath=resolve(APP,'.wrangler/account-inventory-config.json');mkdirSync(dirname(proxyPath),{recursive:true});writeFileSync(proxyPath,JSON.stringify({name:'account-inventory-local',account_id:account,compatibility_date:cfg.compatibility_date,services:[{binding:'OPERATOR',service:cfg.name,entrypoint:'AccountDataOperator',remote:true}]}));chmodSync(proxyPath,0o600);
let platform,operator;
if(process.env.INVENTORY_OPERATOR_URL){
 const url=new URL(process.env.INVENTORY_OPERATOR_URL);if(url.protocol!=='http:'||url.hostname!=='127.0.0.1'||url.username||url.password||url.pathname!=='/'||url.search||url.hash)throw Error('Operator bridge must be a loopback HTTP origin.');
 operator=new Proxy({},{get:(_target,method)=>async(...args)=>{const r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({method,args}),signal:AbortSignal.timeout(30000)});if(!r.ok)throw Error('Operator bridge refused: HTTP '+r.status);return r.json();}});
}else{platform=await getPlatformProxy({configPath:proxyPath,persist:false,envFiles:[],remoteBindings:true});operator=platform.env.OPERATOR;}

const chunks=(list,size)=>Array.from({length:Math.ceil(list.length/size)},(_,i)=>list.slice(i*size,(i+1)*size));
try{
 const scanId=randomBytes(24).toString('base64url');if(apply)await operator.inventoryBegin(scanId);
 const hosts=new Set(),objects=new Map();console.log('Inventory transport ready. Reading namespace metadata.');
 for(const group of chunks(await list(ns('LIVE_HOSTS')),20))for(const host of await operator.inspectHosts(group))hosts.add(host);
 let after='';for(let page=0;page<500;page++){const ids=await operator.registeredHosts(after);ids.forEach(id=>hosts.add(id));if(ids.length<20)break;if(page===499)throw Error('Host registry limit reached');after=ids.at(-1);}
 for(const group of chunks(await list(ns('AUTH')),20))for(const item of await operator.inspectObjects(group)){objects.set(item.id,item);item.owners.forEach(host=>hosts.add(host));if(item.workspaceId)hosts.add(item.workspaceId);}
 for(const group of chunks([...hosts],100))for(const row of await operator.identityReferences(group))for(const id of row.ids){const item=objects.get(id);if(item&&!item.owners.includes(row.hostId))item.owners.push(row.hostId);}
 // All references are credentials belonging to the same identity, in either
 // direction (e.g. device-user -> device-grant). Protected records never purge.
 for(let changed=true;changed;){changed=false;for(const item of objects.values())for(const id of item.references){const other=objects.get(id);if(!other)continue;const union=[...new Set([...item.owners,...other.owners])];for(const target of [item,other])if(union.some(owner=>!target.owners.includes(owner))){target.owners=union;changed=true;}}}
 const maps=new Map([...hosts].map(id=>[id,[]]));let shared=0,unclassified=0;
 for(const item of objects.values()){if(!item.hasState)continue;if(item.type==='malformed'){unclassified++;continue;}if(item.protected)continue;if(item.owners.length>1){shared++;continue;}if(item.owners.length===1){maps.get(item.owners[0]).push(item.id);}else if(!['anonymous-rate','watchdog-cursor','operations-fence','device-user','device-grant','oauth'].includes(item.type))unclassified++;}
 const report=resolve(APP,'.wrangler/account-inventory-audit.json');writeFileSync(report,JSON.stringify([...objects.values()].filter(item=>item.type==='malformed'||item.hasState&&!item.protected&&item.owners.length===0&&!['anonymous-rate','watchdog-cursor','operations-fence','device-user','device-grant','oauth'].includes(item.type)),null,2));chmodSync(report,0o600);
 if(shared||unclassified)throw Error(`Inventory needs review: ${shared} shared and ${unclassified} unclassified records. No completion proof published.`);
 if(apply){for(const group of chunks([...hosts],100))await operator.registerHosts(group);for(const [hostId,objectIds] of maps)await operator.inventoryWrite({scanId,hostId,objectIds});await operator.inventoryFinish({scanId,knownHostIds:[...hosts]});}
 console.log(JSON.stringify({mode:apply?'inventory-published':'audit-only',objects:objects.size,hosts:hosts.size,shared,unclassified,deleted:0}));
}finally{await platform?.dispose();}
