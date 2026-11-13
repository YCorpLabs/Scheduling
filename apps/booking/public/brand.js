// Instance identity. Every value is operator configuration (Worker vars, see
// docs/self-hosting.md). Unset or invalid values fall back to neutral defaults,
// so an unconfigured instance never shows another operator's name, logo or links.
export const DEFAULT_PRODUCT_NAME='Scheduling';
export const DEFAULT_BRAND=Object.freeze({productName:DEFAULT_PRODUCT_NAME,brandName:'',desktopAppName:'',organization:null,supportEmail:'',privacyUrl:'',termsUrl:''});
const unsafe=/[\u0000-\u001f\u007f<>]/;
export const escapeHTML=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function text(value,max=60){if(typeof value!=='string')return '';const v=value.trim();return v&&v.length<=max&&!unsafe.test(v)?v:'';}
// Absolute HTTPS links (HTTP only on loopback). The configured spelling is kept.
export function safeLink(value){
  const v=typeof value==='string'?value.trim():'';if(!v||v.length>500||unsafe.test(v))return '';
  try{const u=new URL(v);if(u.username||u.password)return '';if(u.protocol==='https:'||(u.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(u.hostname)))return v;}catch{}
  return '';
}
function mailbox(value){const v=text(value,254);return /^[^\s@"(),:;<>[\\\]]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/.test(v)?v:'';}
// SVG path data drawn inside the 32×32 organization mark. Path commands only.
function markPath(value){const v=typeof value==='string'?value.trim():'';return v.length<=400&&/^[Mm][MmLlHhVvCcSsQqTtAaZz0-9 .,-]*$/.test(v)?v:'';}
export function normalizeBrand(value){
  const b=value&&typeof value==='object'?value:{},productName=text(b.productName)||DEFAULT_PRODUCT_NAME,brandName=text(b.brandName);
  const org=b.organization&&typeof b.organization==='object'?b.organization:null,orgName=text(org?.name,80);
  return {productName,brandName,desktopAppName:text(b.desktopAppName)||brandName,
    organization:orgName?{name:orgName,url:safeLink(org.url),markPath:markPath(org.markPath)}:null,
    supportEmail:mailbox(b.supportEmail),privacyUrl:safeLink(b.privacyUrl),termsUrl:safeLink(b.termsUrl)};
}
export function brandFromEnv(env={}){
  return normalizeBrand({productName:env.PRODUCT_NAME,brandName:env.BRAND_NAME,desktopAppName:env.DESKTOP_APP_NAME,
    organization:{name:env.ORGANIZATION_NAME,url:env.ORGANIZATION_URL,markPath:env.ORGANIZATION_MARK_PATH},
    supportEmail:env.SUPPORT_EMAIL,privacyUrl:env.PRIVACY_URL,termsUrl:env.TERMS_URL});
}
/** Name guests see on booking pages and in the booking-page footer. */
export const brandLabel=b=>b.brandName||b.productName;
/** Short wordmark: first letter of the label, e.g. "Scheduling" → "s.". */
export const brandMark=b=>([...brandLabel(b)][0]||'').toLowerCase()+'.';
/** Studio tab title suffix, e.g. "Acme Scheduling" or "Scheduling". */
export const studioName=b=>b.brandName?`${b.brandName} ${b.productName}`:b.productName;
/** Optional operator links. Empty when none are configured. */
export function legalLinksMarkup(b){
  const links=[[b.privacyUrl,'Privacy'],[b.termsUrl,'Terms'],[b.supportEmail&&'mailto:'+b.supportEmail,'Support']].filter(([href])=>href);
  return links.map(([href,label])=>`<a class="legal-link" href="${escapeHTML(href)}"${href.startsWith('mailto:')?'':' target="_blank" rel="noopener"'}>${label}</a>`).join('');
}
export function organizationMarkup(b){
  const org=b.organization;if(!org)return '';
  const mark=org.markPath?`<svg viewBox="0 0 32 32" width="28" height="28" aria-hidden="true"><rect width="32" height="32" rx="8" fill="currentColor"/><path d="${escapeHTML(org.markPath)}" fill="none" stroke="var(--surface)" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`:'';
  return org.url?`<a href="${escapeHTML(org.url)}" class="sign-in-brand" tabindex="0" aria-label="${escapeHTML(org.name)} home">${mark}<span>${escapeHTML(org.name)}</span></a>`:`<span class="sign-in-brand">${mark}<span>${escapeHTML(org.name)}</span></span>`;
}
