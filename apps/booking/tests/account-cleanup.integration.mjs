import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
const HOST='h_'+'a'.repeat(24);
test('actual AuthStore inventory inspects physical expired rows and cleanup resumes without credentials or provider calls',async()=>{
 const source=`import {AuthStore} from './src/auth.js';import {discoverAccountDeletion,purgeAccountData} from './src/account-cleanup.js';import {beginLifecycle} from './src/lifecycle.js';export class FixtureAuth extends AuthStore{fixtureAlarm(){return this.alarm();}};const host='${HOST}',op='delete_operation_123456';
 export default {async fetch(request,env){const path=new URL(request.url).pathname,data=request.method==='POST'?await request.json():{};let value;
 if(path==='/seed'){const orphan=env.AUTH.getByName('legacy-orphan:fixture');await orphan.put({hostId:host,email:'private@example.test',refresh_token:'private-refresh-canary'},-1);await env.AUTH.getByName('identity:'+host).put({hostId:host,email:'private@example.test'},86400000);const objectId=env.AUTH.idFromName('legacy-orphan:fixture').toString();await env.AUTH.getByName('account-cleanup-inventory-epoch').put({schema:1,complete:true,scanId:'scan-1',activatedAt:1,completedAt:2},86400000);await env.AUTH.getByName('account-cleanup-inventory:'+host).put({schema:1,hostId:host,complete:true,scanId:'scan-1',schemaActivatedAt:1,completedAt:2,objectIds:[objectId]},86400000);value=await orphan.accountCleanupInspect();}
 else if(path==='/discover')value=await discoverAccountDeletion(env,host);
 else if(path==='/fence')value=await beginLifecycle(env,host,{operationId:op,expectedGeneration:0,ledgerIds:[]});
 else if(path==='/purge')value=await purgeAccountData(env,host,{operationId:op,generation:1,manifest:data.manifest});
 else if(path==='/after')value={orphan:await env.AUTH.getByName('legacy-orphan:fixture').accountCleanupInspect(),identity:await env.AUTH.getByName('identity:'+host).accountCleanupInspect(),receipt:await env.AUTH.getByName('account-cleanup-receipt:'+host).get()};
 else if(path==='/ephemeral'){await env.AUTH.getByName('ephemeral:fixture').putEphemeral({verifier:'secret'},1);value={ok:true};}
 else if(path==='/ephemeral-alarm'){await env.AUTH.getByName('ephemeral:fixture').fixtureAlarm();value=await env.AUTH.getByName('ephemeral:fixture').accountCleanupInspect();}
 else return new Response(null,{status:404});return Response.json(value);}};`;
 const bundled=await build({stdin:{contents:source,resolveDir:new URL('..',import.meta.url).pathname},bundle:true,format:'esm',platform:'browser',external:['cloudflare:workers'],write:false});
 const mf=new Miniflare(convertV4MiniflareOptions({workers:[{name:'cleanup-fixture',modules:true,script:bundled.outputFiles[0].text,compatibilityDate:'2026-11-10',durableObjects:{AUTH:{className:'FixtureAuth',useSQLite:true}},outboundService:()=>{throw Error('No provider requests permitted');}}]}));
 const call=async(path,body={})=>{const response=await mf.dispatchFetch('http://localhost'+path,{method:'POST',body:JSON.stringify(body)}),text=await response.text();assert.equal(response.status,200,path+': '+text);return JSON.parse(text);};
 try{const scan=await call('/seed');assert.equal(scan.hasState,true);assert.deepEqual(scan.owners,[HOST]);assert(!JSON.stringify(scan).includes('private-refresh'));
 const discovery=await call('/discover');assert.deepEqual(discovery.blockers,[]);assert.equal(discovery.manifest.objectIds.length,1);assert.equal((await call('/fence')).state,'fenced');assert.equal((await call('/purge',{manifest:discovery.manifest})).done,true);assert.equal((await call('/purge',{manifest:discovery.manifest})).done,true);
 const after=await call('/after');assert.equal(after.orphan.hasState,false);assert.equal(after.identity.hasState,false);assert.equal(after.receipt.stage,'done');assert(!JSON.stringify(after.receipt).includes('private@example'));
 await call('/ephemeral');await new Promise(resolve=>setTimeout(resolve,10));assert.equal((await call('/ephemeral-alarm')).hasState,false);
 }finally{await mf.dispose();}
});
