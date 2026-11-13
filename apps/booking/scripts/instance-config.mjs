#!/usr/bin/env node
// Merge an instance overlay into the shared wrangler.jsonc and write the
// effective Wrangler config for that instance. Offline: no Wrangler call, no
// network, no secrets. Shared keys (Durable Objects, migrations, assets,
// observability, cron) always come from wrangler.jsonc, so an overlay cannot
// drift from the code or rename stored classes.
//
//   SCHEDULING_INSTANCE_CONFIG=<overlay> node scripts/instance-config.mjs [--out <file>]
import {readFileSync,writeFileSync,chmodSync} from 'node:fs';
import {dirname,resolve,relative} from 'node:path';
import {fileURLToPath} from 'node:url';

const APP=resolve(dirname(fileURLToPath(import.meta.url)),'..');
export const BASE_CONFIG=resolve(APP,'wrangler.jsonc');
export const DEFAULT_INSTANCE=resolve(APP,'wrangler.instance.jsonc');
export const DEFAULT_OUTPUT=resolve(APP,'wrangler.instance.generated.json');
export const INSTANCE_KEYS=Object.freeze(['name','account_id','workers_dev','preview_urls','routes','vars','send_email']);
export const INSTANCE_VARS=Object.freeze(['PUBLIC_ORIGIN','LIVE_ENABLED','NOTIFICATION_PROVIDER','MAIL_FROM','INTEGRATION_WEBHOOK_HOSTS',
  'PRODUCT_NAME','BRAND_NAME','DESKTOP_APP_NAME','ORGANIZATION_NAME','ORGANIZATION_URL','ORGANIZATION_MARK_PATH',
  'SUPPORT_EMAIL','PRIVACY_URL','TERMS_URL','WEBHOOK_USER_AGENT']);
const SECRETS=new Set(['GOOGLE_CLIENT_ID','GOOGLE_CLIENT_SECRET','TOKEN_ENCRYPTION_KEY','RESEND_API_KEY']);
const EXAMPLE=/(?:^|[^a-z0-9-])example\.(?:com|org|net)(?:$|[^a-z0-9-])|\.example(?:$|[^a-z0-9.-])|<[^>@]*>/i;

/** JSON with // and /* comments and trailing commas, as Wrangler accepts. */
export function parseJsonc(text){
  let out='',i=0,inString=false;
  while(i<text.length){
    const c=text[i],next=text[i+1];
    if(inString){out+=c;if(c==='\\'){out+=next??'';i+=2;continue;}if(c==='"')inString=false;i++;continue;}
    if(c==='"'){inString=true;out+=c;i++;continue;}
    if(c==='/'&&next==='/'){while(i<text.length&&text[i]!=='\n')i++;continue;}
    if(c==='/'&&next==='*'){const end=text.indexOf('*/',i+2);if(end<0)throw new SyntaxError('Unterminated comment');i=end+2;continue;}
    out+=c;i++;
  }
  let clean='';inString=false;
  for(let j=0;j<out.length;j++){
    const c=out[j];
    if(inString){clean+=c;if(c==='\\'){clean+=out[++j]??'';}else if(c==='"')inString=false;continue;}
    if(c==='"'){inString=true;clean+=c;continue;}
    if(c===','){let k=j+1;while(/\s/.test(out[k]??''))k++;if(out[k]==='}'||out[k]===']')continue;}
    clean+=c;
  }
  return JSON.parse(clean);
}

const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
function httpsOrigin(value){try{const u=new URL(value);return u.protocol==='https:'&&u.origin===value;}catch{return false;}}

/** Returns a list of problems; empty means the overlay can be merged. */
export function validateOverlay(overlay){
  const problems=[];
  if(!plain(overlay))return ['The instance overlay must be a JSON object.'];
  for(const key of Object.keys(overlay)){
    if(!INSTANCE_KEYS.includes(key))problems.push(`"${key}" is shared configuration. Change it in wrangler.jsonc for every instance, not in an overlay.`);
  }
  if(typeof overlay.name!=='string'||!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(overlay.name))problems.push('"name" must be a Worker name: lowercase letters, digits and hyphens.');
  if('account_id' in overlay&&(typeof overlay.account_id!=='string'||!/^[a-f0-9]{32}$/.test(overlay.account_id)))problems.push('"account_id" must be a 32-character Cloudflare account ID.');
  for(const key of ['workers_dev','preview_urls'])if(key in overlay&&typeof overlay[key]!=='boolean')problems.push(`"${key}" must be true or false.`);
  if('routes' in overlay&&(!Array.isArray(overlay.routes)||!overlay.routes.every(r=>plain(r)&&typeof r.pattern==='string'&&r.pattern)))problems.push('"routes" must be a list of {"pattern": ...} entries.');
  if('send_email' in overlay&&(!Array.isArray(overlay.send_email)||!overlay.send_email.every(b=>plain(b)&&typeof b.name==='string'&&b.name)))problems.push('"send_email" must be a list of bindings with a "name".');
  const vars=overlay.vars;
  if(!plain(vars))problems.push('"vars" must be an object with at least PUBLIC_ORIGIN.');
  else{
    for(const [key,value] of Object.entries(vars)){
      if(SECRETS.has(key))problems.push(`${key} is a secret. Set it with "wrangler secret put ${key}", never in a config file.`);
      else if(!INSTANCE_VARS.includes(key))problems.push(`Unknown variable ${key}.`);
      if(typeof value!=='string')problems.push(`${key} must be a string.`);
    }
    if(!httpsOrigin(vars.PUBLIC_ORIGIN))problems.push('PUBLIC_ORIGIN must be an HTTPS origin without a path, for example https://scheduling.your-domain.');
    if('LIVE_ENABLED' in vars&&!['true','false'].includes(vars.LIVE_ENABLED))problems.push('LIVE_ENABLED must be "true" or "false".');
    if('NOTIFICATION_PROVIDER' in vars&&!['cloudflare','resend'].includes(vars.NOTIFICATION_PROVIDER))problems.push('NOTIFICATION_PROVIDER must be "cloudflare" or "resend".');
  }
  if(EXAMPLE.test(JSON.stringify(overlay)))problems.push('Replace every example value (example.com addresses and <placeholders>) with your own.');
  return problems;
}

export function mergeInstance(base,overlay){
  const problems=validateOverlay(overlay);
  if(problems.length)throw Object.assign(new Error('Invalid instance overlay'),{problems});
  const merged=structuredClone(base);
  for(const key of INSTANCE_KEYS){
    if(!(key in overlay))continue;
    merged[key]=key==='vars'?{...(base.vars||{}),...structuredClone(overlay.vars)}:structuredClone(overlay[key]);
  }
  return merged;
}

function main(argv){
  const outIndex=argv.indexOf('--out'),output=outIndex>=0?resolve(argv[outIndex+1]||''):DEFAULT_OUTPUT;
  const instance=resolve(process.env.SCHEDULING_INSTANCE_CONFIG||DEFAULT_INSTANCE);
  let overlay;
  try{overlay=parseJsonc(readFileSync(instance,'utf8'));}
  catch(error){
    console.error(error.code==='ENOENT'?`No instance overlay at ${instance}. Copy wrangler.instance.example.jsonc or set SCHEDULING_INSTANCE_CONFIG.`:`Could not read the instance overlay: ${error.message}`);
    return 1;
  }
  let merged;
  try{merged=mergeInstance(parseJsonc(readFileSync(BASE_CONFIG,'utf8')),overlay);}
  catch(error){console.error(error.problems?['Instance overlay refused:',...error.problems.map(p=>'  - '+p)].join('\n'):error.message);return 1;}
  if(dirname(output)!==APP){console.error('Write the merged config into apps/booking so relative paths keep working.');return 1;}
  writeFileSync(output,JSON.stringify(merged,null,2)+'\n',{mode:0o600});chmodSync(output,0o600);
  const routes=(merged.routes||[]).map(r=>r.pattern+(r.custom_domain?' (custom domain)':'')).join(', ')||'none';
  console.log(`Worker: ${merged.name}\nOrigin: ${merged.vars.PUBLIC_ORIGIN}\nRoutes: ${routes}\nworkers.dev: ${merged.workers_dev?'on':'off'}\nVariables: ${Object.keys(merged.vars).sort().join(', ')}`);
  console.log(`Wrote ${relative(process.cwd(),output)||output}. Nothing was deployed.`);
  return 0;
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))process.exitCode=main(process.argv.slice(2));
