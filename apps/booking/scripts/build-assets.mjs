// Builds the static assets the Worker serves from public/ into dist-assets/.
//
// public/ stays the source: tests import its modules directly and every file in
// it is copied as is, so stable URLs such as /embed.js and the stylesheets used
// by Worker-rendered pages keep working. On top of that, the booking app's
// JavaScript and CSS are bundled into content-hashed files under /assets/,
// which browsers cache for a year without revalidating. index.html and
// studio.html load one stylesheet and one script, and _headers preloads the
// Studio chunks for Studio routes so they download in parallel with the entry.
//
// Wrangler runs this before `wrangler dev` and `wrangler deploy` (see
// wrangler.jsonc "build"). Run it by hand with `node scripts/build-assets.mjs`.
import {build,transform} from 'esbuild';
import {cp,mkdir,readFile,rm,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {dirname,join,relative,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const source=join(root,'public'),out=join(root,'dist-assets'),assets=join(out,'assets');
const IMMUTABLE='public, max-age=31536000, immutable';
// Studio routes: '/' and '/studio' (app.js `admin`).
const STUDIO_ROUTES=['/','/studio'];

// Modules import each other by site path ('/policy.js'); resolve those inside public/.
const sitePaths={name:'site-paths',setup(b){b.onResolve({filter:/^\//},args=>{if(args.kind==='entry-point')return;const file=resolve(source,'.'+args.path);if(!file.startsWith(source+'/'))return {errors:[{text:'Outside public/: '+args.path}]};return {path:file};});}};
const hashed=(name,body,ext)=>`${name}-${createHash('sha256').update(body).digest('hex').slice(0,10)}.${ext}`;
const site=file=>'/'+relative(out,file).split('\\').join('/');

export async function buildAssets(){
  await rm(out,{recursive:true,force:true});
  await cp(source,out,{recursive:true});
  await mkdir(assets,{recursive:true});
  const html=await readFile(join(source,'index.html'),'utf8');

  // One stylesheet, in the order index.html lists them.
  const sheets=[...html.matchAll(/<link rel="stylesheet" href="([^"]+)">/g)].map(m=>m[1]);
  if(!sheets.length)throw Error('index.html lists no stylesheets');
  const css=await build({stdin:{contents:sheets.map(h=>`@import ${JSON.stringify(h)};`).join('\n'),resolveDir:source,loader:'css',sourcefile:'app.css'},bundle:true,minify:true,write:false,plugins:[sitePaths],logLevel:'silent',target:['chrome100','firefox100','safari15']});
  const cssName=hashed('app',css.outputFiles[0].contents,'css');
  await writeFile(join(assets,cssName),css.outputFiles[0].contents);

  // The app, split at its dynamic imports (Studio, booking management, ...).
  const js=await build({entryPoints:{app:join(source,'app.js')},bundle:true,splitting:true,format:'esm',minify:true,target:['es2022'],outdir:assets,entryNames:'[name]-[hash]',chunkNames:'[name]-[hash]',metafile:true,plugins:[sitePaths],logLevel:'silent',legalComments:'none'});
  const outputs=js.metafile.outputs;
  const outputFor=entry=>Object.keys(outputs).find(file=>outputs[file].entryPoint&&resolve(root,outputs[file].entryPoint)===join(source,entry));
  // A chunk and every chunk it imports statically, in load order.
  const closure=file=>{const seen=new Set(),walk=f=>{if(seen.has(f))return;seen.add(f);for(const i of outputs[f].imports)if(i.kind==='import-statement')walk(i.path);};walk(file);return [...seen];};
  const entry=outputFor('app.js'),studio=outputFor('host-ui.js');
  if(!entry||!studio)throw Error('Bundle is missing the app or Studio entry');
  const entryChunks=closure(entry),studioChunks=closure(studio).filter(f=>!entryChunks.includes(f));
  const url=f=>site(resolve(root,f));

  // Applies the saved Studio theme before first paint (CSP allows no inline script).
  const theme=(await transform(await readFile(join(source,'boot-theme.js'),'utf8'),{minify:true,target:'es2020'})).code;
  const themeName=hashed('boot-theme',theme,'js');
  await writeFile(join(assets,themeName),theme);

  const page=extra=>{
    let next=html.replace(/<script src="\/boot-theme\.js"><\/script>/,`<script src="/assets/${themeName}"></script>`);
    next=next.replace(/(<link rel="stylesheet" href="[^"]+">\s*)+/,`<link rel="stylesheet" href="/assets/${cssName}">`);
    const preloads=[...entryChunks.slice(1),...extra].map(f=>`<link rel="modulepreload" href="${url(f)}">`).join('');
    next=next.replace(/<script type="module" src="\/app\.js"><\/script>/,`<script type="module" src="${url(entry)}"></script>${preloads}`);
    if(next.includes('href="/style.css"')||next.includes('src="/app.js"')||!next.includes(cssName))throw Error('index.html changed shape; update scripts/build-assets.mjs');
    return next;
  };
  await writeFile(join(out,'index.html'),page([]));
  // Cloudflare serves /studio from studio.html; '/' is index.html, so its Studio chunks come from _headers.
  await writeFile(join(out,'studio.html'),page(studioChunks));

  const link=studioChunks.map(f=>`<${url(f)}>; rel=modulepreload`).join(', ');
  // A path listed twice in _headers keeps only one block, so the Link header
  // goes inside each route's existing block (which holds its frame-ancestors policy).
  const lines=(await readFile(join(source,'_headers'),'utf8')).trimEnd().split('\n');
  for(const route of STUDIO_ROUTES){
    const at=lines.indexOf(route);
    if(at<0)throw Error(`_headers has no ${route} block; update scripts/build-assets.mjs`);
    lines.splice(at+1,0,`  Link: ${link}`);
  }
  if(lines.some(line=>line.startsWith('/assets')))throw Error('_headers already names /assets');
  lines.push('/assets/*',`  Cache-Control: ${IMMUTABLE}`);
  await writeFile(join(out,'_headers'),lines.join('\n')+'\n');
  return {css:cssName,entry:url(entry),studio:url(studio),studioChunks:studioChunks.length};
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const result=await buildAssets();
  console.log(`dist-assets: ${result.entry}, ${result.css}, Studio ${result.studio} (+${result.studioChunks-1} chunks)`);
}
