// Twenty CRM REST API adapter: validates Twenty Cloud and operator-approved self-hosted
// destinations, verifies connections without mutating CRM records, and syncs booking
// guests as People with Markdown booking Notes linked via NoteTargets.
export const TWENTY_CLOUD_HOST='api.twenty.com';
export const TWENTY_CLOUD_URL='https://api.twenty.com';

const MAX_RESPONSE_BYTES=65536;
const DAY=86400000;
const EVENT_TITLES={
  'booking.requested':'Booking requested',
  'booking.confirmed':'Booking confirmed',
  'booking.rescheduled':'Booking rescheduled',
  'booking.cancelled':'Booking cancelled',
  'booking.approval_requested':'Approval needed',
  'booking.rejected':'Request declined',
  'booking.expired':'Request expired',
  'integration.test':'Test connection'
};

export function allowedTwentyHosts(env={}){
  return new Set(String(env.INTEGRATION_TWENTY_HOSTS||'').split(',').map(s=>s.trim().toLowerCase()).filter(s=>/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(s)&&s.includes('.')).slice(0,100));
}

function publicHost(host){
  return host.includes('.')&&!host.endsWith('.')&&!host.includes(':')&&!/^\d+(?:\.\d+)*$/.test(host)&&!/(?:^|\.)(?:localhost|local|internal|lan|home|test|invalid|example)$/.test(host)&&/^[a-z0-9.-]+$/.test(host);
}

// Accepts https://api.twenty.com (or an operator-approved self-hosted origin), with an
// optional /rest suffix, and normalises it to the bare origin.
export function validateTwentyDestination(value,env={}){
  if(typeof value!=='string'||value.length>2048||/[\u0000-\u0020\u007f\\]/.test(value))throw Error('Choose a valid Twenty API URL.');
  let u;try{u=new URL(value);}catch{throw Error('Choose a valid Twenty API URL.');}
  if(u.protocol!=='https:'||u.username||u.password||u.hash||u.search||(u.port&&u.port!=='443')||!publicHost(u.hostname))throw Error('Choose a public HTTPS Twenty API URL on port 443.');
  if(!/^\/(?:rest\/?)?$/.test(u.pathname))throw Error('Use the Twenty API base URL, such as https://api.twenty.com.');
  if(u.hostname!==TWENTY_CLOUD_HOST&&!allowedTwentyHosts(env).has(u.hostname)){
    throw Object.assign(Error('This self-hosted Twenty host needs operator approval.'),{code:'twenty_host_not_approved'});
  }
  return new URL(u.origin);
}

export function validateTwentyApiKey(value){
  if(typeof value!=='string')throw Error('Enter a Twenty API key.');
  const trimmed=value.trim();
  if(!/^[\x21-\x7e]{8,2048}$/.test(trimmed))throw Error('Enter a valid Twenty API key.');
  return trimmed;
}

const short=(value,max=200)=>String(value??'').replace(/[\u0000-\u001f\u007f]/g,' ').replace(/\s+/g,' ').trim().slice(0,max);
const mdSafe=(value,max=200)=>short(value,max).replace(/:\/\//g,':\u200b//').replace(/[\\`*_{}[\]()#+\-.!|>]/g,'\\$&');
const epoch=value=>{const ms=typeof value==='string'?Date.parse(value):value;return Number.isFinite(ms)?Math.floor(ms/1000):null;};
const utc=seconds=>new Date(seconds*1000).toISOString().slice(0,16).replace('T',' ')+' UTC';

function formatRange(start,end){
  const s=epoch(start),e=epoch(end);
  if(s===null)return '';
  return e!==null?`${utc(s)} – ${utc(e).slice(11)}`:utc(s);
}

export function normalizeEmail(value){
  const cleaned=short(value,254).toLowerCase();
  if(!cleaned||!/^[^\s@"'\\]+@[^\s@"'\\]+\.[^\s@"'\\]+$/.test(cleaned))return '';
  return cleaned;
}

export function splitName(name,email=''){
  const cleaned=short(name,200);
  if(!cleaned){
    const local=short(String(email||'').split('@')[0],100);
    return {firstName:local||'Guest',lastName:''};
  }
  const parts=cleaned.split(' ').filter(Boolean);
  return {firstName:parts[0].slice(0,100),lastName:parts.slice(1).join(' ').slice(0,100)};
}

export function twentyNote(event){
  const b=event.booking||{};
  const label=EVENT_TITLES[event.type]||String(event.type||'Booking update').replace(/^booking\./,'').replace(/_/g,' ');
  const meetingTitle=short(b.title,140);
  const title=meetingTitle?`${label}: ${meetingTitle}`.slice(0,200):label;
  const lines=[`**${label}**`];
  if(meetingTitle)lines.push(`- Meeting: ${mdSafe(meetingTitle,140)}`);
  const when=formatRange(b.start,b.end);
  if(when)lines.push(`- Time: ${when}`);
  const previous=event.previousBooking?formatRange(event.previousBooking.start,event.previousBooking.end):'';
  if(previous)lines.push(`- Previously: ${previous}`);
  if(b.status)lines.push(`- Status: ${mdSafe(b.status,60)}`);
  if(event.guest){
    const guestParts=[event.guest.name,event.guest.email].map(v=>short(v,200)).filter(Boolean);
    if(guestParts.length)lines.push(`- Guest: ${guestParts.map(v=>mdSafe(v,200)).join(' · ')}`);
  }
  if(b.id)lines.push(`- Booking ID: ${mdSafe(b.id,80)}`);
  return {title,bodyV2:{markdown:lines.join('\n')}};
}

async function readBoundedJson(response){
  const contentLength=Number(response.headers.get('content-length'));
  if(Number.isFinite(contentLength)&&contentLength>MAX_RESPONSE_BYTES){
    await response.body?.cancel().catch(()=>{});
    return null;
  }
  const reader=response.body?.getReader();
  if(!reader)return null;
  let text='',length=0;
  try{
    const decoder=new TextDecoder();
    for(;;){
      const {value,done}=await reader.read();
      if(done)break;
      length+=value.byteLength;
      if(length>MAX_RESPONSE_BYTES)return null;
      text+=decoder.decode(value,{stream:true});
    }
    text+=decoder.decode();
  }finally{await reader.cancel().catch(()=>{});}
  if(!text.trim())return null;
  try{return JSON.parse(text);}catch{return null;}
}

function retryAfterMs(response){
  const value=response.headers.get('retry-after');
  if(!value)return 0;
  if(/^\d+$/.test(value))return Math.min(DAY,Number(value)*1000);
  const parsed=Date.parse(value);
  return Number.isFinite(parsed)?Math.max(0,Math.min(DAY,parsed-Date.now())):0;
}

function classifyFailure(response){
  if(response.status===401||response.status===403)return {outcome:'failed',errorCode:'provider_unauthorized',retryAfter:0};
  if(response.status===429)return {outcome:'retry',errorCode:'rate_limited',retryAfter:retryAfterMs(response)};
  if(response.status>=500)return {outcome:'retry',errorCode:'provider_unavailable',retryAfter:0};
  return {outcome:'failed',errorCode:'provider_rejected',retryAfter:0};
}

function extractPeople(json){
  const list=json?.data?.people??(Array.isArray(json?.data)?json.data:null);
  return Array.isArray(list)?list:[];
}

function extractId(json,...keys){
  for(const key of keys){
    const id=json?.data?.[key]?.id;
    if(typeof id==='string'&&id.length>0&&id.length<=128)return id;
  }
  const fallback=json?.data?.id??json?.id;
  return typeof fallback==='string'&&fallback.length>0&&fallback.length<=128?fallback:null;
}

export async function deliverTwenty({baseUrl,apiKey,event,state={},saveState,fetch,userAgent,leaseValid}){
  const origin=String(baseUrl).replace(/\/+$/,'');
  const headers={'authorization':'Bearer '+apiKey,'accept':'application/json','user-agent':userAgent};
  const request=async(method,path,body)=>{
    const response=await fetch(origin+path,{
      method,
      headers:body!==undefined?{...headers,'content-type':'application/json'}:headers,
      ...(body!==undefined?{body:JSON.stringify(body)}:{}),
      redirect:'manual',
      signal:AbortSignal.timeout(8000)
    });
    const json=await readBoundedJson(response);
    return {response,json};
  };

  if(event.type==='integration.test'){
    const {response,json}=await request('GET','/rest/people?limit=1');
    if(!response.ok)return classifyFailure(response);
    if(!json||typeof json!=='object'||!json.data||typeof json.data!=='object')return {outcome:'failed',errorCode:'provider_rejected',retryAfter:0};
    return {outcome:'delivered',errorCode:null,retryAfter:0};
  }

  const progress={...(state?.personId?{personId:state.personId}:{}),...(state?.noteId?{noteId:state.noteId}:{})};
  const persist=()=>{if(typeof saveState==='function')saveState(progress);};
  const stillValid=()=>typeof leaseValid!=='function'||leaseValid();

  const email=event.guest?normalizeEmail(event.guest.email):'';
  const lookupPerson=async()=>{
    const filter=`emails.primaryEmail[eq]:"${email}"`;
    const {response,json}=await request('GET','/rest/people?limit=5&filter='+encodeURIComponent(filter));
    if(!response.ok)return {error:classifyFailure(response)};
    const people=extractPeople(json);
    const match=people.find(p=>typeof p?.id==='string'&&String(p?.emails?.primaryEmail||'').toLowerCase()===email)||people.find(p=>typeof p?.id==='string');
    return {id:match?.id||null};
  };

  if(email&&!progress.personId){
    if(!stillValid())return {aborted:true};
    const found=await lookupPerson();
    if(found.error)return found.error;
    if(found.id){
      progress.personId=found.id;
      persist();
    }else{
      if(!stillValid())return {aborted:true};
      const {response,json}=await request('POST','/rest/people',{name:splitName(event.guest?.name,email),emails:{primaryEmail:email}});
      if(response.ok){
        const personId=extractId(json,'createPerson','person');
        if(!personId)return {outcome:'failed',errorCode:'provider_rejected',retryAfter:0};
        progress.personId=personId;
        persist();
      }else if(response.status===400||response.status===409){
        // Handle concurrent contact creation for the same email by re-querying once.
        if(!stillValid())return {aborted:true};
        const retryLookup=await lookupPerson();
        if(retryLookup.error)return retryLookup.error;
        if(!retryLookup.id)return {outcome:'failed',errorCode:'provider_rejected',retryAfter:0};
        progress.personId=retryLookup.id;
        persist();
      }else{
        return classifyFailure(response);
      }
    }
  }

  if(!progress.noteId){
    if(!stillValid())return {aborted:true};
    const {response,json}=await request('POST','/rest/notes',twentyNote(event));
    if(!response.ok)return classifyFailure(response);
    const noteId=extractId(json,'createNote','note');
    if(progress.personId&&!noteId)return {outcome:'failed',errorCode:'provider_rejected',retryAfter:0};
    if(noteId){
      progress.noteId=noteId;
      persist();
    }
  }

  if(progress.personId&&progress.noteId){
    if(!stillValid())return {aborted:true};
    let {response}=await request('POST','/rest/noteTargets',{noteId:progress.noteId,targetPersonId:progress.personId});
    // Older self-hosted Twenty releases (before morph relations) expect personId instead of targetPersonId.
    if(response.status===400){
      if(!stillValid())return {aborted:true};
      ({response}=await request('POST','/rest/noteTargets',{noteId:progress.noteId,personId:progress.personId}));
    }
    if(!response.ok)return classifyFailure(response);
  }

  return {outcome:'delivered',errorCode:null,retryAfter:0};
}
