// Fixture admission smoke only. Local workerd cannot validate real PITR.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(new URL('../../apps/booking/package.json',import.meta.url));
const {build}=require('esbuild');
const {Miniflare,convertV4MiniflareOptions}=require('miniflare');
const built=await build({entryPoints:[new URL('./worker.js',import.meta.url).pathname],bundle:true,write:false,format:'esm',platform:'browser',external:['cloudflare:workers']});
const auth='fixture-local-auth';
const mf=new Miniflare(convertV4MiniflareOptions({workers:[{name:'isolated-pitr-fixture',modules:true,script:built.outputFiles[0].text,compatibilityDate:'2026-11-11',
  durableObjects:{HOST:{className:'FixtureHost',useSQLite:true},EFFECTS:{className:'FixtureEffects',useSQLite:true},AUTH:{className:'AuthStore',useSQLite:true}},
  bindings:{DRILL_AUTH:auth,TOKEN_ENCRYPTION_KEY:Buffer.alloc(32,7).toString('base64')},outboundService:async()=>{throw Error('fixture outbound forbidden');}}]}));
const call=async(action,fields={})=>{const response=await mf.dispatchFetch('http://localhost/drill',{method:'POST',headers:{Authorization:'Bearer '+auth,'Content-Type':'application/json'},body:JSON.stringify({action,...fields})});assert.equal(response.status,200,await response.clone().text());return response.json();};
try{
  assert.equal((await mf.dispatchFetch('http://localhost/drill')).status,404);
  const initial=await call('initialize');assert.equal(initial.effects.calendar,2);assert.equal(initial.effects.mail,0);
  const advanced=await call('advance');assert.equal(advanced.effects.mail,1);assert.equal(advanced.effects.duplicates,0);
  const frozen=await call('freeze',{epoch:0});assert.equal(frozen.ok,true);assert.equal(frozen.maintenance.frozen,true);
  const probe=await call('probe');assert.equal(probe.repair.code,'maintenance_frozen');assert.equal(probe.effects.mail,1);
  console.log('Local fixture auth, synthetic effects and freeze smoke passed. Real PITR remains remote-only.');
}finally{await mf.dispose();}
