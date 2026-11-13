import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {PDFDocument} from 'pdf-lib';
import {sha256,seal,unseal,validateInput} from '../server/archive/security.js';
import {ArchiveRepository} from '../server/archive/repository.js';
import {ArchiveService} from '../server/archive/service.js';
import {MemoryDrive} from '../server/archive/demo.js';
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
test('pickup PDF uploads and resumes the same job after an empty PostgREST 201',async()=>{
 const url='https://fixture.supabase.co';
 const cap=randomBytes(32).toString('base64');
 const env={get:name=>({SUPABASE_URL:url,SUPABASE_SERVICE_ROLE_KEY:'fixture-server-key'})[name]};
 const db=new PGlite();
 try{
  await db.exec('create role anon; create role authenticated; create role service_role bypassrls; create table public.documentos(id uuid primary key); create table public.importaciones(id uuid primary key)');
  for(const path of ['../db/proposals/drive-archive.sql',
    '../supabase/migrations/20261031204200_drive_first_global_and_staged_evidence.sql',
    '../supabase/migrations/20261113170611_allow_pickup_pdf_archive_jobs.sql']){
   await db.exec(await readFile(new URL(path,import.meta.url),'utf8'));
  }
  const rest=async(address,options)=>{
   const {pathname,searchParams}=new URL(address);
   const payload=options.body?JSON.parse(options.body):null;
   if(pathname.endsWith('/kardex_drive_runtime_access')){
    assert.equal(payload.p_key_sha256,sha256(cap));
    return Response.json({authorized:true});
   }
   if(pathname.endsWith('/kardex_drive_claim')){
    return Response.json((await db.query('select public.kardex_drive_claim($1,$2) as row',[payload.p_id,payload.p_owner])).rows[0].row);
   }
   if(pathname.endsWith('/kardex_drive_save')){
    return Response.json((await db.query('select public.kardex_drive_save($1,$2,$3,$4) as row',[
     payload.p_id,payload.p_owner,JSON.stringify(payload.p_patch),payload.p_release
    ])).rows[0].row);
   }
   assert.equal(pathname,'/rest/v1/kardex_drive_jobs');
   if(options.method==='POST'){
    assert.equal(options.headers.Prefer,'resolution=ignore-duplicates,return=minimal');
    await db.query('insert into public.kardex_drive_jobs(id,idempotency_key,document_id,data) values ($1,$2,$3,$4) on conflict(idempotency_key) do nothing',[
     payload.id,payload.idempotency_key,payload.document_id,JSON.stringify(payload.data)
    ]);
    return new Response(null,{status:201});
   }
   const column=searchParams.has('id')?'id':'idempotency_key';
   return Response.json((await db.query('select * from public.kardex_drive_jobs where '+column+'=$1',[searchParams.get(column).slice(3)])).rows);
  };
  const viaGateway=(address,options)=>handle(new Request(address,options),env,rest);
  const repo=new ArchiveRepository({SUPABASE_URL:url,KARDEX_DRIVE_METADATA_KEY:cap},{fetcher:viaGateway});
  const directRepo=new ArchiveRepository({SUPABASE_URL:url,SUPABASE_SERVICE_ROLE_KEY:'fixture-server-key'},{fetcher:rest});
  const drive=new MemoryDrive();
  const service=new ArchiveService(repo,drive,randomBytes(32).toString('base64'));
  const pdf=await PDFDocument.create();pdf.addPage();
  const bytes=Buffer.from(await pdf.save()),digest=sha256(bytes);
  const batch=randomUUID(),visit=randomUUID(),actor=randomUUID();
  const input={documentId:null,sourceKey:`pickup:${batch}:${visit}:${actor}`,
   sourceVersion:'sha256:'+digest,name:`IM_RECOJO_2026-11-13_AV-${batch.slice(0,8)}_${visit}.pdf`,
   sha256:digest,size:bytes.length,mime:'application/pdf',category:'scans'};
  // The failed production attempt had already inserted this pending row before returning an error.
  const validated=validateInput(input);
  const pendingId=randomUUID();
  await db.query('insert into public.kardex_drive_jobs(id,idempotency_key,data) values ($1,$2,$3)',[
   pendingId,validated.key,JSON.stringify({...validated,status:'pending',offset:0})
  ]);
  const started=await service.start(input);
  assert.equal(started.id,pendingId);
  await service.chunk(started.id,0,bytes);
  const saved=await service.finish(started.id);
  assert.equal(saved.backendVerified,true);
  assert.deepEqual(Buffer.from(await (await service.download(saved.id)).response.arrayBuffer()),bytes);
  assert.equal((await service.start(input)).id,pendingId);
  assert.equal((await directRepo.create(validated)).id,pendingId);
  assert.equal(drive.created,1);
  assert.equal((await db.query('select count(*)::int as n from public.kardex_drive_jobs')).rows[0].n,1);
 }finally{await db.close();}
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
 const connected=await call({state:id,code:'private-code'},cookie);assert.equal(connected.statusCode,303);assert.equal(connected.headers.Location,'/?drive_connected=1');assert.equal(exchanges,1);assert.equal(JSON.parse(unseal(encrypted,key)).refreshToken,'private-refresh');
 assert.ok(!JSON.stringify(connected).includes('private-refresh'));assert.ok(!JSON.stringify(connected).includes('private-access'));assert.ok(!JSON.stringify(connected).includes('private-client-secret'));
 assert.equal((await call({state:id,code:'private-code'},cookie)).statusCode,400);
});
