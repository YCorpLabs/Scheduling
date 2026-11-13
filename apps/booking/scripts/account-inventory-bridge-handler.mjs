// CLI-only handler for the temporary authenticated preview. Browser origins and
// simple cross-origin form posts cannot invoke privileged operator RPCs.
const methods=new Set(['inventoryBegin','inspectObjects','inspectHosts','registeredHosts','registerHosts','identityReferences','inventoryWrite','inventoryFinish']);
export default {async fetch(request,env){
 if(request.headers.has('Origin'))return new Response(null,{status:403});
 if(request.method==='GET')return new Response(null,{status:204});
 if(request.method!=='POST')return new Response(null,{status:405});
 if(!request.headers.get('Content-Type')?.toLowerCase().startsWith('application/json'))return new Response(null,{status:415});
 const text=await request.text();if(text.length>1048576)return new Response(null,{status:413});
 let data;try{data=JSON.parse(text);}catch{return new Response(null,{status:400});}
 if(!methods.has(data?.method)||!Array.isArray(data.args))return new Response(null,{status:404});
 return Response.json(await env.OPERATOR[data.method](...data.args));
}};
