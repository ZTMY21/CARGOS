import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {sha256,seal,unseal} from '../server/archive/security.js';
import {createConnectHandler} from '../api/drive-connect.js';
import {handle} from '../supabase/functions/kardex-drive-metadata/index.ts';
test('runtime SQL isolates encrypted settings and consumes OAuth sessions exactly once',async()=>{
 const db=new PGlite();try{
  await db.exec('create schema private;create role anon;create role authenticated;create role service_role;');await db.exec(await readFile(new URL('../supabase/migrations/20261031173042_drive_archive_scoped_backend_runtime.sql',import.meta.url),'utf8'));
  const hash=sha256(randomBytes(32));await db.query('insert into private.kardex_drive_runtime(backend_key_sha256) values($1)',[hash]);
  await db.exec('set role authenticated');await assert.rejects(db.query('select public.kardex_drive_runtime_access($1,$2)',[hash,'get-oauth']));await db.exec('reset role;set role service_role');
  await assert.rejects(db.query('select * from private.kardex_drive_runtime'));await assert.rejects(db.query('select public.kardex_drive_runtime_access($1,$2)',['0'.repeat(64),'get-oauth']));
  const id=randomUUID(),payload={cookieHash:'not-a-token',verifierCipher:seal('verifier',randomBytes(32).toString('base64'))};
  await db.query('select public.kardex_drive_runtime_access($1,$2,$3,$4)',[hash,'create-session',id,JSON.stringify(payload)]);
  const consume=()=>db.query('select public.kardex_drive_runtime_access($1,$2,$3) as value',[hash,'consume-session',id]);assert.deepEqual((await consume()).rows[0].value,payload);assert.equal((await consume()).rows[0].value,null);
 }finally{await db.close();}
});
test('metadata capability cannot proxy business tables or unauthenticated requests',async()=>{
 const cap=randomBytes(32).toString('base64'),env={get:n=>({SUPABASE_URL:'https://test.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'server-platform-key'})[n]};let forwarded=0;
 const fetcher=async(url,opts)=>{if(url.endsWith('/kardex_drive_runtime_access')){const b=JSON.parse(opts.body);return b.p_key_sha256===sha256(cap)?Response.json({authorized:true}):new Response('',{status:403});}forwarded++;throw Error('Business request must never be forwarded');};
 const call=body=>handle(new Request('https://edge.test',{method:'POST',body:JSON.stringify(body)}),env,fetcher);
 assert.equal((await call({operation:'metadata',path:'documentos?select=*'})).status,401);
 assert.equal((await call({capability:cap,operation:'metadata',path:'documentos?select=*'})).status,403);
 assert.equal((await call({capability:cap,operation:'metadata',path:'rpc/kardex_live_ingest',method:'POST',payload:{}})).status,403);
 assert.equal(forwarded,0);
});
test('OAuth state is cookie-bound, one-use and never returns provider credentials',async()=>{
 const key=randomBytes(32).toString('base64'),env={VERCEL_ENV:'preview',KARDEX_DRIVE_CONNECT_ENABLED:'true',GOOGLE_DRIVE_CLIENT_ID:'client',GOOGLE_DRIVE_CLIENT_SECRET:'private-client-secret',KARDEX_DRIVE_METADATA_KEY:randomBytes(32).toString('base64'),KARDEX_DRIVE_SESSION_KEY:key,GOOGLE_DRIVE_REDIRECT_URI:'https://kardex-digital-santa-anita-test-ztmy1.vercel.app/api/drive-connect',GOOGLE_DRIVE_ROOT_FOLDER_ID:'approved-root',GOOGLE_DRIVE_OWNER_EMAIL:'owner@example.test',GOOGLE_DRIVE_FOLDER_IDS_JSON:JSON.stringify(Object.fromEntries(['scans','originals','backups','history','manifests'].map(k=>[k,'approved-folder-'+k])))};
 const sessions=new Map();let encrypted,exchanges=0;
 const fetcher=async(url,o={})=>{
  if(url.includes('/functions/v1/')){const b=JSON.parse(o.body);assert.equal(b.capability,env.KARDEX_DRIVE_METADATA_KEY);if(b.action==='create-session'){sessions.set(b.id,b.payload);return Response.json({created:true});}if(b.action==='consume-session'){const r=sessions.get(b.id);sessions.delete(b.id);return Response.json(r||null);}if(b.action==='set-oauth'){encrypted=b.payload.cipher;return Response.json({saved:true});}return Response.json({cipher:encrypted||null});}
  if(url.includes('oauth2.googleapis.com')){exchanges++;return Response.json({access_token:'private-access',refresh_token:'private-refresh'});}
  if(url.includes('/about?'))return Response.json({user:{emailAddress:'owner@example.test'}});
  if(url.includes('/approved-root?'))return Response.json({mimeType:'application/vnd.google-apps.folder',owners:[{emailAddress:'owner@example.test'}],capabilities:{canAddChildren:true},permissions:[{type:'user'}]});
  return Response.json({mimeType:'application/vnd.google-apps.folder',parents:['approved-root']});
 };
 const handler=createConnectHandler({env,fetcher});
 async function call(query,cookie=''){let body='';const res={headers:{},setHeader(k,v){this.headers[k]=v;},end(x=''){body=x;}};await handler({method:'GET',query,headers:{host:new URL(env.GOOGLE_DRIVE_REDIRECT_URI).host,cookie}},res);return {...res,body};}
 const start=await call({action:'start'}),state=new URL(start.headers.Location).searchParams.get('state');assert.equal(start.statusCode,303);assert.ok(start.headers['Set-Cookie'].includes('HttpOnly'));
 const denied=await call({state,code:'private-code'});assert.equal(denied.statusCode,400);assert.equal(exchanges,0);
 const next=await call({action:'start'}),id=new URL(next.headers.Location).searchParams.get('state'),cookie=next.headers['Set-Cookie'].split(';')[0];
 const connected=await call({state:id,code:'private-code'},cookie);assert.equal(connected.statusCode,303);assert.equal(exchanges,1);assert.equal(JSON.parse(unseal(encrypted,key)).refreshToken,'private-refresh');
 assert.ok(!JSON.stringify(connected).includes('private-refresh'));assert.ok(!JSON.stringify(connected).includes('private-access'));assert.ok(!JSON.stringify(connected).includes('private-client-secret'));
 assert.equal((await call({state:id,code:'private-code'},cookie)).statusCode,400);
});
