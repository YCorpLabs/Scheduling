import test from 'node:test';
import assert from 'node:assert/strict';
import handler from '../scripts/account-inventory-bridge-handler.mjs';
test('operator preview refuses browser-origin and form posts before any RPC',async()=>{
 let calls=0;const env={OPERATOR:{inventoryBegin:()=>{calls++;return {};}}},body=JSON.stringify({method:'inventoryBegin',args:['fake-scan']});
 for(const headers of [{'Content-Type':'application/json',Origin:'https://foreign.invalid'},{'Content-Type':'text/plain'},{'Content-Type':'application/x-www-form-urlencoded'}]){
  const res=await handler.fetch(new Request('https://preview.invalid/',{method:'POST',headers,body}),env);assert.ok([403,415].includes(res.status));
 }assert.equal(calls,0);
});
test('operator preview dispatches only the fixed CLI JSON RPC surface',async()=>{
 let calls=0;const env={OPERATOR:{registeredHosts:after=>{calls++;assert.equal(after,'');return ['fixture'];}}};
 const call=method=>handler.fetch(new Request('https://preview.invalid/',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({method,args:['']})}),env);
 assert.equal((await call('fetch')).status,404);const res=await call('registeredHosts');assert.deepEqual(await res.json(),['fixture']);assert.equal(calls,1);
});
