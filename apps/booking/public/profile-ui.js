import {BRAND_IMAGES,normalizeBrandImage} from '/branding.js';

async function cropImage(file,key,isCurrent=()=>true){
 if(file.size>8*1024*1024)throw Error('Choose an image smaller than 8 MB.');
 const header=new Uint8Array(await file.slice(0,12).arrayBuffer());
 if(!((header[0]===255&&header[1]===216&&header[2]===255)||(header[0]===137&&String.fromCharCode(...header.slice(1,4))==='PNG')||(String.fromCharCode(...header.slice(0,4))==='RIFF'&&String.fromCharCode(...header.slice(8,12))==='WEBP')))throw Error('Choose a PNG, JPEG or WebP image.');
 const mime=header[0]===255?'image/jpeg':header[0]===137?'image/png':'image/webp';
 const url=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(Error('This file could not be read.'));reader.readAsDataURL(new Blob([file],{type:mime}));}),image=new Image();image.src=url;
 try{await image.decode();}catch{throw Error('This image could not be opened.');}
 if(!isCurrent())return null;
 if(!image.naturalWidth||image.naturalWidth*image.naturalHeight>16000000){throw Error('Choose an image up to 16 megapixels.');}
 const spec=BRAND_IMAGES[key],dialog=document.createElement('dialog');dialog.className='booking-dialog crop-dialog';dialog.setAttribute('aria-label','Crop '+spec.label.toLowerCase());
 dialog.innerHTML=`<form method="dialog"><header class="booking-detail-head"><strong>Crop ${spec.label.toLowerCase()}</strong><button type="button" data-cancel-crop class="icon-button" aria-label="Cancel crop">×</button></header><div class="booking-detail-body"><canvas class="crop-canvas ${key==='avatarImage'?'crop-avatar':''}" width="${spec.width}" height="${spec.height}" aria-label="Crop preview"></canvas>${[['x','Horizontal position'],['y','Vertical position'],['zoom','Zoom']].map(([id,label])=>`<label class="crop-control">${label}<input type="range" name="${id}" min="${id==='zoom'?1:0}" max="${id==='zoom'?3:100}" step="${id==='zoom'?.01:1}" value="${id==='zoom'?1:50}"></label>`).join('')}</div><footer class="booking-detail-footer"><button type="button" data-cancel-crop class="secondary">Cancel</button><button class="primary" value="apply">Use image</button></footer></form>`;
 document.body.append(dialog);const canvas=dialog.querySelector('canvas'),ctx=canvas.getContext('2d'),controls=dialog.querySelector('form').elements;
 function draw(){const scale=Math.max(spec.width/image.naturalWidth,spec.height/image.naturalHeight)*Number(controls.zoom.value),w=image.naturalWidth*scale,h=image.naturalHeight*scale;ctx.fillStyle='#fff';ctx.fillRect(0,0,spec.width,spec.height);ctx.drawImage(image,-(w-spec.width)*Number(controls.x.value)/100,-(h-spec.height)*Number(controls.y.value)/100,w,h);}
 dialog.querySelectorAll('[data-cancel-crop]').forEach(button=>button.onclick=()=>dialog.close('cancel'));dialog.addEventListener('input',draw);draw();dialog.showModal();dialog.querySelector('[name=x]').focus();
 return new Promise((resolve,reject)=>{dialog.addEventListener('close',()=>{try{if(dialog.returnValue!=='apply'){resolve(null);return;}for(const quality of [.8,.65,.5,.35,.2]){const value=canvas.toDataURL('image/jpeg',quality);try{resolve(normalizeBrandImage(value,key));return;}catch{}}reject(Error('Image is too detailed. Choose a simpler crop.'));}finally{dialog.remove();}},{once:true});});
}
// Settings → Profile stages a chosen, cropped image; nothing is saved until Save.
export function chooseProfileImage(key,{isCurrent=()=>true}={}){
 if(!BRAND_IMAGES[key])return Promise.resolve(null);
 return new Promise((resolve,reject)=>{
  const input=document.createElement('input');input.type='file';input.accept='image/png,image/jpeg,image/webp';input.hidden=true;input.dataset.profileUpload=key;document.body.append(input);
  input.addEventListener('cancel',()=>{input.remove();resolve(null);},{once:true});
  input.onchange=async()=>{try{resolve(input.files[0]?await cropImage(input.files[0],key,isCurrent):null);}catch(error){reject(error);}finally{input.remove();}};
  input.click();
 });
}
