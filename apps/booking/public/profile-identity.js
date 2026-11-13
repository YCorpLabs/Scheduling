// Profile websites are metadata only. No page, logo or other resource is fetched.
export function profileWebsite(value){
  const text=String(value??'').trim();if(!text)return '';
  if(text.length>2048)throw Error('Enter a shorter website address.');
  let url;try{url=new URL(/^[a-z][a-z0-9+.-]*:/i.test(text)?text:'https://'+text);}catch{throw Error('Enter a valid website address.');}
  if(!['https:','http:'].includes(url.protocol)||url.username||url.password||!url.hostname.includes('.')||/\s/.test(url.hostname))throw Error('Enter a valid website address.');
  return url.href;
}
export function profileName(name,website){
  const entered=String(name??'').trim();if(entered)return entered;
  if(!website)return '';
  const label=new URL(website).hostname.replace(/^www\./,'').split('.')[0];return label.charAt(0).toUpperCase()+label.slice(1);
}
