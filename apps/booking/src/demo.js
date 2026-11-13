import { DurableObject } from 'cloudflare:workers';
import { DEFAULT, slots, validateConfig } from '../public/policy.js';
import {secureAsset} from './http.js';
const json=(data,status=200)=>Response.json(data,{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
export class BookingHost extends DurableObject {
  constructor(ctx,env) {
    super(ctx,env);
    this.sql=ctx.storage.sql;
    this.sql.exec('CREATE TABLE IF NOT EXISTS config (id INTEGER PRIMARY KEY, body TEXT NOT NULL)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS reservations (id TEXT PRIMARY KEY, request_key TEXT UNIQUE NOT NULL, start INTEGER NOT NULL, end INTEGER NOT NULL, token TEXT NOT NULL, cancelled INTEGER NOT NULL DEFAULT 0)');
  }
  config() { return JSON.parse(this.sql.exec('SELECT body FROM config WHERE id=1').toArray()[0]?.body ?? JSON.stringify(DEFAULT)); }
  snapshot() {
    const config=this.config();
    const reservations=this.sql.exec('SELECT start,end FROM reservations WHERE cancelled=0 AND end>?',Date.now()).toArray();
    return {config,slots:slots(config,Date.now(),reservations),mode:'demo',version:1};
  }
  save(config) {
    const c=validateConfig(config);
    this.sql.exec('INSERT INTO config(id,body) VALUES (1,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body',JSON.stringify(c));
    return this.snapshot();
  }
  reserve(start,key) {
    // Synchronous admission: no await between availability check and insertion.
    const existing=this.sql.exec('SELECT id,start,end,token,cancelled FROM reservations WHERE request_key=?',key).toArray()[0];
    if(existing) {
      if(existing.start!==start) return {error:'This request was already used for another time.',status:409};
      if(existing.cancelled) return {error:'This demo reservation was released. Choose a time to start again.',status:410};
      return {...existing,mode:'demo'};
    }
    const slot=this.snapshot().slots.find(s=>s.start===start);
    if(!slot) return {error:'That time just became unavailable. Your details are saved—please choose another.',status:409};
    const id=crypto.randomUUID(),token=crypto.randomUUID();
    this.sql.exec('INSERT INTO reservations(id,request_key,start,end,token) VALUES (?,?,?,?,?)',id,key,slot.start,slot.end,token);
    return {id,token,...slot,mode:'demo'};
  }
  cancel(id,token) {
    const row=this.sql.exec('SELECT token FROM reservations WHERE id=?',id).toArray()[0];
    if(!row || row.token!==token) return {error:'This booking link is not valid.',status:404};
    this.sql.exec('UPDATE reservations SET cancelled=1 WHERE id=?',id);
    return {cancelled:true};
  }
}
export default {
  async fetch(request,env) {
    const url=new URL(request.url);
    if(!url.pathname.startsWith('/api/')) {
      return secureAsset(await env.ASSETS.fetch(request),request);
    }
    // This runnable pilot is deliberately local. Public hosting requires auth,
    // anti-abuse, live OAuth/calendar reconciliation and notification delivery.
    if(!['localhost','127.0.0.1','[::1]'].includes(url.hostname)) return json({error:'This booking pilot is not enabled for public hosting.'},503);
    const host=env.HOSTS.getByName('local-demo-host');
    try {
      if(request.method==='GET' && url.pathname==='/api/availability') return json(await host.snapshot());
      if(request.method!=='POST') return json({error:'Not found'},404);
      if(request.headers.get('Origin')!==url.origin || !request.headers.get('Content-Type')?.startsWith('application/json')) return json({error:'Request not allowed'},403);
      const body=await request.text();
      if(body.length>10000) return json({error:'Request too large'},413);
      const data=JSON.parse(body);
      if(url.pathname==='/api/settings') return json(await host.save(data));
      if(url.pathname==='/api/book') {
        if(!Number.isSafeInteger(data.start)||typeof data.key!=='string'||data.key.length>100||data.key.length<16) return json({error:'Invalid booking request'},400);
        const result=await host.reserve(data.start,data.key); return json(result,result.status??200);
      }
      if(url.pathname==='/api/cancel') {
        if(typeof data.id!=='string'||typeof data.token!=='string') return json({error:'Invalid booking request'},400);
        const result=await host.cancel(data.id,data.token); return json(result,result.status??200);
      }
      return json({error:'Not found'},404);
    } catch(error) { return json({error:error instanceof SyntaxError?'Invalid request.':error.message},400); }
  }
};
