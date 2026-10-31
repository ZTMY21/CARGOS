import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {readFile,mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Readable,Writable} from 'node:stream';
import {PGlite} from '@electric-sql/pglite';
import {ArchiveError,sha256,configuration,validateInput,seal,unseal} from '../server/archive/security.js';
import {DriveClient} from '../server/archive/drive-client.js';
import {MemoryArchiveStore,MemoryDrive,demoBytes,demoInput,executeDemo} from '../server/archive/demo.js';
import {ArchiveService} from '../server/archive/service.js';
import {authorize,ArchiveRepository} from '../server/archive/repository.js';
import {createHandler} from '../api/drive-archive.js';
import {encryptStream,decryptTo,digestFile} from '../scripts/archive/backup.mjs';
const setup=()=>{const store=new MemoryArchiveStore(),drive=new MemoryDrive(),key=randomBytes(32).toString('base64');return {store,drive,key,service:new ArchiveService(store,drive,key)};};
const upload=async s=>{const j=await s.start(demoInput);await s.chunk(j.id,0,demoBytes);return s.finish(j.id);};
test('archive: full isolated flow preserves repeated rows and separate document relations',async()=>{
 const r=await executeDemo();for(const k of ['sourceRetained','duplicateRowsPreserved','idempotent','distinctRelationsPreserved','failedTransferNotCompleted','retryRecovered','restoredChecksumMatches'])assert.equal(r[k],true,k);assert.equal(r.realFilesTransferred,0);
});
test('archive: same logical source is idempotent; a new version creates another reference',async()=>{
 const {service,drive}=setup();const a=await upload(service),b=await service.start(demoInput),c=await service.start({...demoInput,sourceVersion:'2'});assert.equal(a.id,b.id);assert.notEqual(a.id,c.id);assert.equal(drive.created,2);
});
test('archive: interrupted upload retains source and can resume without another object',async()=>{
 const {service,drive,store}=setup();const j=await service.start(demoInput);drive.failNextChunk=true;await assert.rejects(service.chunk(j.id,0,demoBytes),{code:'DRIVE_NETWORK_ERROR'});assert.notEqual((await store.get(j.id)).status,'verified');await service.chunk(j.id,0,demoBytes);assert.equal((await service.finish(j.id)).status,'verified');assert.equal(drive.created,1);assert.equal(sha256(demoBytes),demoInput.sha256);
});
test('archive: checksum mismatch never marks uploaded bytes as verified',async()=>{
 const {service,drive,store}=setup();const j=await service.start(demoInput);await service.chunk(j.id,0,demoBytes);drive.corruptRead=true;await assert.rejects(service.finish(j.id),{code:'CHECKSUM_MISMATCH'});assert.equal((await store.get(j.id)).status,'uploaded');await assert.rejects(service.download(j.id),{code:'FILE_NOT_VERIFIED'});
});
test('archive: a missing formerly verified file is flagged for reconciliation, never served',async()=>{
 const {service,drive,store}=setup();const j=await upload(service);drive.files.delete(j.driveFileId);await assert.rejects(service.reconcile(j.id),{code:'DRIVE_FILE_MISSING'});assert.equal((await store.get(j.id)).status,'attention');await assert.rejects(service.download(j.id),{code:'FILE_NOT_VERIFIED'});
});
test('archive: acknowledge-loss recovery consults remote offset before sending bytes again',async()=>{
 const {service,store,drive}=setup();const j=await service.start(demoInput);const save=store.save.bind(store);let fail=true;store.save=async(...args)=>{if(fail&&args[0].offset===demoBytes.length){fail=false;throw Error('database unavailable');}return save(...args);};await assert.rejects(service.chunk(j.id,0,demoBytes),{code:'TRANSFER_INTERRUPTED'});await service.reconcile(j.id);await service.chunk(j.id,0,demoBytes);const r=await service.finish(j.id);assert.equal(r.status,'verified');assert.equal(drive.files.get(j.driveFileId).bytes.length,demoBytes.length);
});
test('archive: strict chunk boundaries and offsets protect the stream',async()=>{
 const {service}=setup();const j=await service.start({...demoInput,size:2*1024**2});await assert.rejects(service.chunk(j.id,0,Buffer.alloc(3)),{code:'INVALID_CHUNK_RANGE'});await assert.rejects(service.chunk(j.id,1,Buffer.alloc(256*1024)),{code:'OFFSET_CONFLICT'});await assert.rejects(service.chunk(j.id,0,Buffer.alloc(1024**2+1)),{code:'INVALID_CHUNK'});
});
test('archive: caller cannot inject verified state, remote IDs or session credentials',()=>{
 const v=validateInput({...demoInput,status:'verified',driveFileId:'other',sessionCipher:'secret'});for(const k of ['status','driveFileId','sessionCipher'])assert.equal(v[k],undefined);assert.throws(()=>validateInput({...demoInput,name:'../outside.pdf'}));assert.throws(()=>validateInput({...demoInput,size:101*1024**2}));
});
test('archive: approval, backend credentials and an isolated Preview database are mandatory',()=>{
 const env={SUPABASE_URL:'https://uhjwhamzjxhjqlrhgxho.supabase.co',KARDEX_DRIVE_ENABLED:'true',KARDEX_DRIVE_AUTHORIZATION_REF:'test-reference'};assert.equal(configuration(env).enabled,false);assert.ok(configuration(env).reasons.includes('ISOLATED_DATABASE_REQUIRED'));assert.ok(configuration({}).reasons.includes('INSTITUTIONAL_AUTHORIZATION_PENDING'));
});
test('archive: upload capability URLs are encrypted and tampering is rejected',()=>{
 const key=randomBytes(32).toString('base64'),url='https://www.googleapis.com/upload/drive/v3/files?upload_id=private';const encrypted=seal(url,key);assert.ok(!encrypted.includes('private'));assert.equal(unseal(encrypted,key),url);assert.throws(()=>unseal(encrypted,randomBytes(32).toString('base64')));
});
test('archive: Google retry is bounded and never sends bearer tokens to arbitrary hosts',async()=>{
 let calls=0;const d=new DriveClient({},{sleep:async()=>{},fetcher:async url=>{if(url.includes('oauth2'))return Response.json({access_token:'test-only',expires_in:3600});calls++;return calls<3?new Response('',{status:503}):Response.json({ok:true});}});assert.deepEqual(await (await d.request('https://www.googleapis.com/drive/v3/files')).json(),{ok:true});assert.equal(calls,3);assert.throws(()=>d.validSession('https://attacker.example/upload/drive/v3/files'));
});
test('archive: user metadata never authorizes access; membership RPC must grant it',async()=>{
 let calls=0;await assert.rejects(authorize({headers:{authorization:'Bearer test.jwt'}},{SUPABASE_URL:'https://sandbox.test',SUPABASE_ANON_KEY:'public'},{admin:true,fetcher:async()=>{calls++;return calls===1?Response.json({user_metadata:{is_admin:true}}):Response.json({allowed:true,is_admin:false});}}),{code:'ACCESS_DENIED'});assert.equal(calls,2);
});
test('archive: public demo has no real provider access and exposes no configured secrets',async()=>{
 const handler=createHandler({env:{GOOGLE_DRIVE_REFRESH_TOKEN:'never-expose',SUPABASE_SERVICE_ROLE_KEY:'never-expose'},fetcher:()=>{throw Error('network forbidden');}});let output='';const res={headers:{},setHeader(k,v){this.headers[k]=v;},end(t){output=t;}};await handler({method:'GET',query:{action:'status'},headers:{}},res);assert.ok(!output.includes('never-expose'));await handler({method:'POST',query:{action:'demo'},headers:{}},res);assert.equal(JSON.parse(output).realFilesTransferred,0);
});
test('archive: encrypted full-backup stream restores byte for byte and rejects tampering',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'kardex-archive-'));try{const file=join(dir,'dump.enc'),key=randomBytes(32),payload=Buffer.concat([demoBytes,randomBytes(1024**2)]);const m=await encryptStream(Readable.from([payload]),file,key);const chunks=[];const digest=await decryptTo(file,new Writable({write(b,e,next){chunks.push(b);next();}}),key);assert.equal(digest,m.plaintextSha256);assert.equal(await digestFile(file),m.ciphertextSha256);assert.deepEqual(Buffer.concat(chunks),payload);const broken=await readFile(file);broken[40]^=1;await writeFile(file,broken);await assert.rejects(decryptTo(file,new Writable({write(b,e,next){next();}}),key));}finally{await rm(dir,{recursive:true,force:true});}
});
test('archive: isolated SQL enforces roles, FK, unique reference and exclusive leases',async()=>{
 const db=new PGlite();try{
  await db.exec('create role anon; create role authenticated; create role service_role bypassrls; create table public.documentos(id uuid primary key);');
  const id=randomUUID(),owner=randomUUID();await db.query('insert into public.documentos values ($1)',[demoInput.documentId]);await db.exec(await readFile(new URL('../db/proposals/drive-archive.sql',import.meta.url),'utf8'));
  await db.exec('set role authenticated');await assert.rejects(db.query('select * from public.kardex_drive_jobs'));await assert.rejects(db.query('select public.kardex_drive_claim($1,$2)',[id,owner]));await db.exec('reset role;set role service_role');
  await db.query('insert into public.kardex_drive_jobs(id,document_id,idempotency_key,data) values ($1,$2,$3,$4)',[id,demoInput.documentId,'a'.repeat(64),JSON.stringify({status:'pending'})]);
  const first=await db.query('select public.kardex_drive_claim($1,$2) as job',[id,owner]);assert.equal(first.rows[0].job.id,id);
  assert.equal((await db.query('select public.kardex_drive_claim($1,$2) as job',[id,randomUUID()])).rows[0].job,null);
  assert.equal((await db.query('select public.kardex_drive_save($1,$2,$3,true) as job',[id,randomUUID(),JSON.stringify({status:'verified'})])).rows[0].job,null);
  await db.exec('reset role');assert.equal((await db.query('select count(*)::int as n from public.documentos')).rows[0].n,1);
 }finally{await db.close();}
});

test('archive: an expired upload session restarts safely with the same logical reference',async()=>{
 const {service,drive,store}=setup();const j=await service.start(demoInput),progress=drive.progress.bind(drive);drive.progress=async()=>{throw new ArchiveError('UPLOAD_SESSION_EXPIRED',409);};await assert.rejects(service.reconcile(j.id),{code:'UPLOAD_SESSION_EXPIRED'});assert.equal((await store.get(j.id)).sessionCipher,null);drive.progress=progress;const resumed=await service.start(demoInput);assert.equal(resumed.id,j.id);await service.chunk(j.id,0,demoBytes);assert.equal((await service.finish(j.id)).status,'verified');
});

test('archive: isolated database backup and restore preserve schema, duplicate rows and relationships',async()=>{
 const db=new PGlite(),dir=await mkdtemp(join(tmpdir(),'kardex-db-restore-'));let restored;
 try{
  await db.exec('create table cargos(id integer primary key);create table originales(id integer primary key,cargo integer references cargos(id),codigo text);insert into cargos values(1);insert into originales values(1,1,\'F-001\'),(2,1,\'F-001\');');
  const archive=Buffer.from(await(await db.dumpDataDir('gzip')).arrayBuffer()),key=randomBytes(32),file=join(dir,'fixture.enc');await encryptStream(Readable.from([archive]),file,key);const chunks=[];await decryptTo(file,new Writable({write(b,e,next){chunks.push(b);next();}}),key);
  restored=new PGlite({loadDataDir:new Blob(chunks)});const rows=await restored.query('select cargo,codigo,count(*)::int as n from originales group by cargo,codigo');assert.deepEqual(rows.rows,[{cargo:1,codigo:'F-001',n:2}]);await assert.rejects(restored.exec("insert into originales values(3,99,'F-002')"));
 }finally{await db.close();if(restored)await restored.close();await rm(dir,{recursive:true,force:true});}
});

test('archive: HTTP upload → SQL reference → Drive readback → authenticated download',async()=>{
 const db=new PGlite();try{
  await db.exec('create role anon;create role authenticated;create role service_role bypassrls;create table public.documentos(id uuid primary key,kardex text);');await db.exec(await readFile(new URL('../db/proposals/drive-archive.sql',import.meta.url),'utf8'));await db.query('insert into public.documentos values($1,$2)',[demoInput.documentId,'SA-00001']);
  const env={SUPABASE_URL:'https://archive-sandbox.supabase.co',SUPABASE_ANON_KEY:'test-public',SUPABASE_SERVICE_ROLE_KEY:'server-only',KARDEX_DRIVE_ENABLED:'true',KARDEX_DRIVE_AUTHORIZATION_REF:'fixture-approval',KARDEX_DRIVE_SANDBOX_PROJECT_ID:'archive-sandbox',GOOGLE_DRIVE_CLIENT_ID:'fixture',GOOGLE_DRIVE_CLIENT_SECRET:'server-only',GOOGLE_DRIVE_REFRESH_TOKEN:'server-only',GOOGLE_DRIVE_ROOT_FOLDER_ID:'fixture-root',GOOGLE_DRIVE_OWNER_EMAIL:'fixture@example.test',GOOGLE_DRIVE_FOLDER_IDS_JSON:JSON.stringify({scans:'fixture-scans',originals:'fixture-originals',backups:'fixture-backups',history:'fixture-history',manifests:'fixture-manifests'}),KARDEX_DRIVE_SESSION_KEY:randomBytes(32).toString('base64')};
  let remote=null,bytes=Buffer.alloc(0),driveCalls=0;
  const fetcher=async(url,o={})=>{
   const u=new URL(url),p=u.pathname;
   if(u.hostname==='oauth2.googleapis.com')return Response.json({access_token:'fixture-drive-token',expires_in:3600});
   if(u.hostname==='archive-sandbox.supabase.co'){
    if(p==='/auth/v1/user')return o.headers.Authorization==='Bearer client.jwt'?Response.json({id:'fixture-user'}):new Response('',{status:401});
    if(p.endsWith('/rpc/kardex_access'))return Response.json({allowed:true,is_admin:true});
    if(p.endsWith('/documentos'))return Response.json([{id:demoInput.documentId,kardex:'SA-00001'}]);
    if(p.endsWith('/rpc/kardex_drive_claim')){const d=JSON.parse(o.body);return Response.json((await db.query('select public.kardex_drive_claim($1,$2) as row',[d.p_id,d.p_owner])).rows[0].row);}
    if(p.endsWith('/rpc/kardex_drive_save')){const d=JSON.parse(o.body);return Response.json((await db.query('select public.kardex_drive_save($1,$2,$3,$4) as row',[d.p_id,d.p_owner,JSON.stringify(d.p_patch),d.p_release])).rows[0].row);}
    if(p.endsWith('/kardex_drive_jobs')){
     if(o.method==='POST'){const d=JSON.parse(o.body);await db.query('insert into public.kardex_drive_jobs(id,idempotency_key,document_id,data) values($1,$2,$3,$4) on conflict(idempotency_key) do nothing',[d.id,d.idempotency_key,d.document_id,JSON.stringify(d.data)]);return new Response(null,{status:204});}
     const key=['id','idempotency_key','document_id'].find(k=>u.searchParams.has(k));const rows=await db.query('select * from public.kardex_drive_jobs where '+key+'=$1',[u.searchParams.get(key).slice(3)]);return Response.json(rows.rows);
    }
   }
   if(u.hostname==='www.googleapis.com'){
    driveCalls++;
    if(p.endsWith('/generateIds'))return Response.json({ids:['fixture-file']});
    if(p.endsWith('/fixture-root'))return Response.json({mimeType:'application/vnd.google-apps.folder',owners:[{emailAddress:'fixture@example.test'}],capabilities:{canAddChildren:true},permissions:[{type:'user'}]});
    if(p.endsWith('/fixture-history'))return Response.json({mimeType:'application/vnd.google-apps.folder',parents:['fixture-root']});
    if(p==='/upload/drive/v3/files'){
     if(o.method==='POST'){remote=JSON.parse(o.body);return new Response('',{headers:{location:'https://www.googleapis.com/upload/drive/v3/files?upload_id=fixture'}});}
     if(o.headers['Content-Range'].startsWith('bytes */'))return bytes.length===demoBytes.length?Response.json({id:'fixture-file'}):new Response(null,{status:308,headers:bytes.length?{range:'bytes=0-'+(bytes.length-1)}:{}});
     bytes=Buffer.concat([bytes,Buffer.from(o.body)]);return Response.json({id:'fixture-file'});
    }
    if(p.endsWith('/fixture-file'))return remote&&bytes.length?Response.json({...remote,size:String(bytes.length),headRevisionId:'fixture-revision'}):new Response('',{status:404});
    if(p.endsWith('/revisions/fixture-revision'))return new Response(bytes);
   }
   throw Error('Unexpected fixture request');
  };
  const handler=createHandler({env,fetcher});
  async function call(method,action,{id,body,authorization='Bearer client.jwt',offset}={}){
   const chunks=[];const res=new Writable({write(b,e,next){chunks.push(Buffer.from(b));next();}});res.headers={};res.setHeader=(k,v)=>res.headers[k]=v;res.statusCode=200;
   await handler({method,query:{action,id,offset},headers:{authorization},body},res);
   const data=Buffer.concat(chunks);return {status:res.statusCode,data,json:res.headers['Content-Type']?.includes('json')?JSON.parse(data.toString()):null};
  }
  const first=await call('POST','start',{body:demoInput});assert.equal(first.status,200);assert.ok(!JSON.stringify(first.json).includes('upload_id'));await call('POST','chunk',{id:first.json.id,offset:0,body:demoBytes});const finished=await call('POST','finish',{id:first.json.id,body:{}});assert.equal(finished.json.status,'verified');const file=await call('GET','download',{id:first.json.id});assert.deepEqual(file.data,demoBytes);const before=driveCalls;assert.equal((await call('POST','start',{body:{...demoInput,documentId:null,category:'backups'}})).status,403);assert.equal(driveCalls,before);assert.equal((await call('GET','download',{id:first.json.id,authorization:'Bearer wrong.jwt'})).status,401);assert.equal(driveCalls,before);assert.equal((await call('POST','start',{body:demoInput})).json.id,first.json.id);
 }finally{await db.close();}
});

test('archive: global backups need a separate operator grant and no invented cargo',async()=>{
 assert.equal(validateInput({...demoInput,category:'backups',documentId:null}).documentId,null);assert.throws(()=>validateInput({...demoInput,category:'scans',documentId:null}));const actor=await authorize({headers:{authorization:'Bearer fixture.jwt'}},{SUPABASE_URL:'https://sandbox.test'},{admin:true,fetcher:async url=>Response.json(url.includes('/auth/')?{id:'operator'}:{allowed:true,is_admin:true})});assert.throws(()=>actor.backup(),{code:'BACKUP_OPERATOR_REQUIRED'});
 const {service}=setup();const j=await service.start({...demoInput,category:'backups',documentId:null});assert.equal(j.documentId,null);
});
test('archive: manifests traverse every metadata page without silently truncating references',async()=>{
 let pages=0;const repo=new ArchiveRepository({SUPABASE_URL:'https://sandbox.test',SUPABASE_SERVICE_ROLE_KEY:'fixture'},{fetcher:async()=>{pages++;return Response.json(Array.from({length:pages===1?500:2},(_,i)=>({id:String((pages-1)*500+i),idempotency_key:'fixture',data:{status:'verified'}})));}});assert.equal((await repo.list(null)).length,502);assert.equal(pages,2);
});

test('archive: a 32 MB binary fixture crosses 1 MiB requests without storing its body in SQL metadata',async()=>{
 const {service,store}=setup(),data=Buffer.alloc(32082853,90);let j=await service.start({...demoInput,name:'fixture-32mb.bin',mime:'application/octet-stream',size:data.length,sha256:sha256(data)});let chunks=0;
 while(j.offset<data.length){j=await service.chunk(j.id,j.offset,data.subarray(j.offset,Math.min(data.length,j.offset+1024**2)));chunks++;}
 j=await service.finish(j.id);assert.equal(j.status,'verified');assert.equal(chunks,31);assert.ok(JSON.stringify(await store.get(j.id)).length<2500);const downloaded=await service.download(j.id);assert.equal(sha256(Buffer.from(await downloaded.response.arrayBuffer())),sha256(data));
});
