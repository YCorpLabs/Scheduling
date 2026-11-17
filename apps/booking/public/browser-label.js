// A coarse name for a signed-in browser, such as "Chrome on Mac", for the Browsers list in
// Settings. Only this label and whether it is a phone are kept; never the User-Agent itself.
const OS=[[/iPhone|iPod/,'iPhone'],[/iPad/,'iPad'],[/Android/,'Android'],[/CrOS/,'ChromeOS'],[/Macintosh|Mac OS X/,'Mac'],[/Windows/,'Windows'],[/Linux/,'Linux']];
const BROWSER=[[/Edg(e|A|iOS)?\//,'Edge'],[/OPR\/|Opera/,'Opera'],[/Firefox\/|FxiOS/,'Firefox'],[/CriOS|Chrome\//,'Chrome'],[/Safari\//,'Safari']];
export function browserLabel(userAgent){
  const ua=typeof userAgent==='string'?userAgent.slice(0,512):'';if(!ua)return null;
  const os=OS.find(([test])=>test.test(ua))?.[1]||'',browser=BROWSER.find(([test])=>test.test(ua))?.[1]||'';
  if(!os&&!browser)return null;
  return {name:browser&&os?`${browser} on ${os}`:browser||os,mobile:/iPhone|iPod/.test(ua)||/Android/.test(ua)&&/Mobile/.test(ua)};
}
