// Only small, locally re-encoded raster images are accepted for public profiles.
export const BRAND_IMAGES={avatarImage:{width:192,height:192,maxBytes:16384,label:'Profile picture'},bannerImage:{width:720,height:240,maxBytes:40960,label:'Banner image'}};
export function validateBrandImage(value,key){
 const spec=BRAND_IMAGES[key],bad=()=>{throw Error('Choose a cropped '+(spec?.label||'image').toLowerCase()+'.');};
 if(value===null||value==='')return null;
 if(!spec||typeof value!=='string'||value.length>Math.ceil(spec.maxBytes/3)*4+23||!/^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/.test(value))return bad();
 let bytes;try{const text=atob(value.slice(23));if(btoa(text)!==value.slice(23))return bad();bytes=Uint8Array.from(text,c=>c.charCodeAt(0));}catch{return bad();}
 if(bytes.length>spec.maxBytes||bytes.length<32||bytes[0]!==255||bytes[1]!==216||bytes.at(-2)!==255||bytes.at(-1)!==217)return bad();
 let offset=2,dimensions=false;
 while(offset<bytes.length-2){
  if(bytes[offset++]!==255)return bad();const marker=bytes[offset++],length=(bytes[offset]<<8)|bytes[offset+1];
  if(length<2||offset+length>bytes.length-2)return bad();
  // Reject EXIF/GPS, comments, scripts, animation and non-canvas image formats.
  if(![0xe0,0xe2,0xdb,0xc0,0xc4,0xdd,0xda].includes(marker))return bad();
  if(marker===0xe0&&String.fromCharCode(...bytes.slice(offset+2,offset+7))!=='JFIF\0')return bad();
  if(marker===0xe2&&(length<16||length>4096||String.fromCharCode(...bytes.slice(offset+2,offset+14))!=='ICC_PROFILE\0'||bytes[offset+14]<1||bytes[offset+15]>4||bytes[offset+14]>bytes[offset+15]))return bad();
  if(marker===0xc0){if(dimensions||length<11||bytes[offset+2]!==8||((bytes[offset+3]<<8)|bytes[offset+4])!==spec.height||((bytes[offset+5]<<8)|bytes[offset+6])!==spec.width||![1,3].includes(bytes[offset+7])||length!==8+3*bytes[offset+7])return bad();dimensions=true;}
  if(marker===0xda){if(!dimensions)return bad();return value;}
  offset+=length;
 }
 return bad();
}

// Browser JPEG encoders differ: WebKit adds EXIF/Photoshop chunks even for a
// fresh canvas. Remove those before saving; keep only the colour profile (ICC).
export function normalizeBrandImage(value,key){
 if(typeof value!=='string'||!value.startsWith('data:image/jpeg;base64,')||value.length>1400000)throw Error('Image could not be encoded.');
 const bytes=Uint8Array.from(atob(value.slice(23)),c=>c.charCodeAt(0));if(bytes[0]!==255||bytes[1]!==216)throw Error('Image could not be encoded.');
 const chunks=[bytes.slice(0,2)];let offset=2,scan=false;
 while(offset<bytes.length-2){const start=offset;if(bytes[offset++]!==255)throw Error('Image could not be encoded.');const marker=bytes[offset++],length=(bytes[offset]<<8)|bytes[offset+1];if(length<2||offset+length>bytes.length-2)throw Error('Image could not be encoded.');if(marker===0xda){chunks.push(bytes.slice(start));scan=true;break;}offset+=length;if(!(marker>=0xe1&&marker<=0xef)&&marker!==0xfe||marker===0xe2)chunks.push(bytes.slice(start,offset));}
 if(!scan)throw Error('Image could not be encoded.');
 const parts=[];for(const chunk of chunks)for(let i=0;i<chunk.length;i+=8192)parts.push(String.fromCharCode(...chunk.subarray(i,i+8192)));
 return validateBrandImage('data:image/jpeg;base64,'+btoa(parts.join('')),key);
}
