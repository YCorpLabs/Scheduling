#!/usr/bin/env node
// Temporary authenticated Wrangler preview for operator inventory only.
// No persistent Worker, binding, HTTP production route or secret is created.
import {readFileSync,writeFileSync,mkdirSync,chmodSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
const app=resolve(dirname(fileURLToPath(import.meta.url)),'..'),config=JSON.parse(readFileSync(resolve(app,'wrangler.instance.generated.json'),'utf8'));
const scratch=resolve(app,'.wrangler/account-inventory-preview');mkdirSync(scratch,{recursive:true});
const source=resolve(scratch,'bridge.mjs'),path=resolve(scratch,'wrangler.json');
writeFileSync(source,readFileSync(resolve(app,'scripts/account-inventory-bridge-handler.mjs'),'utf8'));
writeFileSync(path,JSON.stringify({name:'account-inventory-preview',...(config.account_id?{account_id:config.account_id}:{}),main:source,compatibility_date:config.compatibility_date,services:[{binding:'OPERATOR',service:config.name,entrypoint:'AccountDataOperator',remote:true}]}));chmodSync(path,0o600);
const child=spawn(process.execPath,[resolve(app,'node_modules/wrangler/bin/wrangler.js'),'dev','--remote','--config',path,'--ip','127.0.0.1','--port','8879'],{cwd:app,stdio:'inherit'});
process.on('SIGINT',()=>child.kill('SIGINT'));process.on('SIGTERM',()=>child.kill('SIGTERM'));child.on('exit',code=>process.exitCode=code??1);
