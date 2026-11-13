import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {validateBrandImage,normalizeBrandImage} from '../public/branding.js';
const fixture=kind=>'data:image/jpeg;base64,'+readFileSync(new URL('./fixtures/'+kind+'.jpg',import.meta.url)).toString('base64');
test('branding accepts bounded cropped JPEGs and explicit removal',()=>{
 assert.equal(validateBrandImage(fixture('avatar'),'avatarImage'),fixture('avatar'));
 assert.equal(validateBrandImage(fixture('banner'),'bannerImage'),fixture('banner'));
 assert.equal(validateBrandImage(null,'avatarImage'),null);
 assert.equal(validateBrandImage('','bannerImage'),null);
});
test('branding refuses external addresses, executable formats, oversized data and wrong dimensions',()=>{
 for(const image of ['https://example.com/photo.jpg','javascript:alert(1)','data:image/svg+xml,<svg/>','data:image/png;base64,AAAA','data:image/jpeg;base64,'+'A'.repeat(100000),true,{},fixture('banner')])assert.throws(()=>validateBrandImage(image,'avatarImage'));
});
test('branding refuses metadata and malformed image structure',()=>{
 const bytes=readFileSync(new URL('./fixtures/avatar.jpg',import.meta.url));
 const metadata=Buffer.concat([bytes.subarray(0,2),Buffer.from([255,225,0,8,69,120,105,102,0,0]),bytes.subarray(2)]);
 const asImage=bytes=>'data:image/jpeg;base64,'+bytes.toString('base64');
 for(const image of [metadata,bytes.subarray(0,bytes.length-4),Buffer.concat([bytes,Buffer.from('<script>')])])assert.throws(()=>validateBrandImage(asImage(image),'avatarImage'));
});

test('canvas normalization strips EXIF and comments without changing the image payload',()=>{
 const original=readFileSync(new URL('./fixtures/avatar.jpg',import.meta.url));
 const tagged=Buffer.concat([original.subarray(0,2),Buffer.from([255,225,0,8,69,120,105,102,0,0,255,254,0,5,71,80,83]),original.subarray(2)]);
 assert.equal(normalizeBrandImage('data:image/jpeg;base64,'+tagged.toString('base64'),'avatarImage'),fixture('avatar'));
});
