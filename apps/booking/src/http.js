export class HttpError extends Error {constructor(status,message){super(message);this.status=status;}}
export async function readJson(request,max=12000) {
  if(!request.headers.get('Content-Type')?.toLowerCase().startsWith('application/json'))throw new HttpError(415,'JSON required.');
  if(Number(request.headers.get('Content-Length'))>max)throw new HttpError(413,'Request too large.');
  const reader=request.body?.getReader();if(!reader)throw new HttpError(400,'Request required.');
  const chunks=[];let length=0;
  for(;;){const {done,value}=await reader.read();if(done)break;length+=value.byteLength;if(length>max){await reader.cancel();throw new HttpError(413,'Request too large.');}chunks.push(value);}
  const bytes=new Uint8Array(length);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
  try{const value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));if(!value||Array.isArray(value)||typeof value!=='object')throw Error();return value;}catch{throw new HttpError(400,'Invalid request.');}
}
export function response(data,status=200){return Response.json(data,{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'}});}
export function secureAsset(response,request) {
  const out=new Response(response.body,response);
  out.headers.set('X-Content-Type-Options','nosniff');out.headers.set('Referrer-Policy','no-referrer');out.headers.set('Permissions-Policy','camera=(), microphone=(), geolocation=()');
  // Static Assets may already supply a stricter policy. Preserve it, rather
  // than replacing it and silently dropping frame-ancestors or other controls.
  if(!out.headers.has('Content-Security-Policy'))out.headers.set('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'");
  const path=request?new URL(request.url).pathname:'';
  const publicGuest=path==='/book'||/^\/b\/[^/]+\/[^/]+\/?$/.test(path);
  // Only the accountless guest journey is intentionally embeddable. Additional
  // CSP policies intersect with upstream policies; none are loosened here.
  if(!publicGuest)out.headers.append('Content-Security-Policy',"frame-ancestors 'none'");
  return out;
}
