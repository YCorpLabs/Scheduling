import {WorkerEntrypoint} from 'cloudflare:workers';
const ID=/^[a-f0-9]{64}$/,HOST=/^h_[A-Za-z0-9_-]{24}$/,SCAN=/^[A-Za-z0-9_-]{16,100}$/;
const ttl=()=>Number.MAX_SAFE_INTEGER-Date.now();
const fixed=['identity:','browser-sessions:','desktop-sessions:','workspace-index:','calendar-contributions:','mail-tracking-index:','account-export-starts:'];
/** Platform service-binding RPC only. No HTTP handler or public credential grants
 * access. Operators run this through their existing Cloudflare account login. */
export class AccountDataOperator extends WorkerEntrypoint {
 async inventoryBegin(scanId){
  if(!SCAN.test(scanId))throw Error('Invalid inventory');const value={kind:'account-cleanup-inventory-epoch',schema:1,scanId,complete:false,activatedAt:Date.now()};
  await this.env.AUTH.getByName('account-cleanup-inventory-epoch').put(value,ttl());return {activatedAt:value.activatedAt};
 }
 async inspectObjects(ids){
  if(!Array.isArray(ids)||ids.length>20||ids.some(id=>!ID.test(id)))throw Error('Invalid inventory page');
  const out=[];for(const id of ids){const stub=this.env.AUTH.get(this.env.AUTH.idFromString(id)),value=await stub.accountCleanupInspect(),extra=await stub.accountCleanupReferences();
   const references=[...new Set([...value.references,...extra])].map(name=>this.env.AUTH.idFromName(name).toString());
   out.push({id,owners:value.owners,references,protected:value.protected,hasState:value.hasState,type:value.type,...(value.fieldNames?{fieldNames:value.fieldNames}:{}),...(value.workspaceId?{workspaceId:value.workspaceId}:{})});
  }return out;
 }
 async inspectHosts(ids){if(!Array.isArray(ids)||ids.length>20||ids.some(id=>!ID.test(id)))throw Error('Invalid host page');const out=[];for(const id of ids){const state=await this.env.LIVE_HOSTS.get(this.env.LIVE_HOSTS.idFromString(id)).accountCleanupIdentity();if(state.hostId){if(!HOST.test(state.hostId))throw Error('Invalid host identity');out.push(state.hostId);}}return out;}
 async registerHosts(ids){if(!Array.isArray(ids)||ids.length>100||ids.some(id=>!HOST.test(id)))throw Error('Invalid hosts');for(const id of ids)await this.env.AUTH.getByName('host-registry').register(id);return {registered:ids.length};}
 async registeredHosts(after=''){return this.env.AUTH.getByName('host-registry').list(after);}
 identityReferences(hosts){if(!Array.isArray(hosts)||hosts.length>100||hosts.some(id=>!HOST.test(id)))throw Error('Invalid hosts');return hosts.map(hostId=>({hostId,ids:fixed.map(prefix=>this.env.AUTH.idFromName(prefix+hostId).toString())}));}
 async inventoryWrite({scanId,hostId,objectIds}){
  if(!SCAN.test(scanId)||!HOST.test(hostId)||!Array.isArray(objectIds)||objectIds.length>10000||objectIds.some(id=>!ID.test(id)))throw Error('Invalid inventory record');
  const epoch=await this.env.AUTH.getByName('account-cleanup-inventory-epoch').get();if(epoch?.scanId!==scanId||epoch.complete)throw Error('Inventory changed');
  await this.env.AUTH.getByName('account-cleanup-inventory:'+hostId).put({kind:'account-cleanup-inventory',schema:1,hostId,complete:true,scanId,schemaActivatedAt:epoch.activatedAt,completedAt:Date.now(),objectIds:[...new Set(objectIds)].sort()},ttl());return {written:true};
 }
 async inventoryFinish({scanId,knownHostIds}){if(!Array.isArray(knownHostIds)||knownHostIds.length>10000||knownHostIds.some(id=>!HOST.test(id)))throw Error('Invalid host manifest');const target=this.env.AUTH.getByName('account-cleanup-inventory-epoch'),epoch=await target.get();if(epoch?.scanId!==scanId||epoch.complete)throw Error('Inventory changed');await target.put({...epoch,complete:true,completedAt:Date.now(),knownHostIds:[...new Set(knownHostIds)].sort()},ttl());return {complete:true};}
}
