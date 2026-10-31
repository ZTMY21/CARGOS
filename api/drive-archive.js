import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {ArchiveError,configuration,safeJob,validateInput} from '../server/archive/security.js';
import {DriveClient} from '../server/archive/drive-client.js';
import {ArchiveRepository,authorize} from '../server/archive/repository.js';
import {ArchiveService} from '../server/archive/service.js';
import {executeDemo,demoBytes} from '../server/archive/demo.js';
import audit from '../docs/drive/real-migration-20261031.json' with {type:'json'};
export const config={maxDuration:60};
async function body(req,binary=false){
  const limit=binary?1024**2:16*1024;
  if(req.body!==undefined){
    if(!binary&&typeof req.body==='object'&&!Buffer.isBuffer(req.body)){if(Buffer.byteLength(JSON.stringify(req.body))>limit)throw new ArchiveError('BODY_TOO_LARGE',413);return req.body;}
    const b=req.body instanceof Uint8Array?Buffer.from(req.body):Buffer.from(String(req.body));if(b.length>limit)throw new ArchiveError('BODY_TOO_LARGE',413);return binary?b:JSON.parse(b.toString());
  }
  const chunks=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>limit)throw new ArchiveError('BODY_TOO_LARGE',413);chunks.push(chunk);}
  const result=Buffer.concat(chunks);return binary?result:JSON.parse(result.toString());
}
export function createHandler({env=process.env,fetcher=fetch}={}){
  let drive,store,service;
  return async function handler(req,res){
    res.setHeader('Cache-Control','private, no-store');res.setHeader('X-Content-Type-Options','nosniff');
    const json=(status,data)=>{res.statusCode=status;res.setHeader('Content-Type','application/json; charset=utf-8');res.end(JSON.stringify(data));};
    try{
      const action=req.query?.action||'status',id=req.query?.id;
      if(typeof action!=='string'||(id!==undefined&&(typeof id!=='string'||!/^[-a-f0-9]{36}$/i.test(id))))throw new ArchiveError('INVALID_REQUEST');
      if(req.method==='GET'&&action==='status')return json(200,{...configuration(env),realMigrationEnabled:configuration(env).enabled,auditSnapshot:Object.fromEntries(['asOf','realFilesCopied','sha256Verified','copiedBytes','restoredTableRows','postgresFreedBytes','completeMigration'].map(k=>[k,audit[k]]))});
      // Preview-only, non-mutating provider probe. Never returns token, IDs, file names or account data.
      if(req.method==='GET'&&action==='health'){
        if(env.VERCEL_ENV!=='preview'&&env.VERCEL_ENV!=='production')throw new ArchiveError('METHOD_NOT_ALLOWED',404);
        const cfg=configuration(env);
        if(!cfg.enabled)return json(503,{driveReady:false,code:cfg.reasons[0]||'ARCHIVE_DISABLED'});
        const healthDrive=new DriveClient(env,{fetcher});
        await healthDrive.checkRoot();
        await healthDrive.folder('originals');
        await healthDrive.folder('scans');
        await healthDrive.folder('backups');
        await healthDrive.folder('history');
        await healthDrive.folder('manifests');
        return json(200,{driveReady:true,rootVerified:true,foldersVerified:true});
      }
      if(req.method==='POST'&&action==='demo')return json(200,await executeDemo());
      if(req.method==='GET'&&action==='demo-file'){res.setHeader('Content-Type','application/json');res.setHeader('Content-Disposition','attachment; filename="solo-datos-ficticios.json"');return res.end(demoBytes);}
      const read=req.method==='GET'&&['list','manifest','download','resolve'].includes(action);
      if(!read&&!(req.method==='POST'&&['start','adopt','chunk','finish','reconcile'].includes(action)))throw new ArchiveError('METHOD_NOT_ALLOWED',405);
      if(req.headers.origin&&new URL(req.headers.origin).host!==req.headers.host)throw new ArchiveError('ORIGIN_NOT_ALLOWED',403);
      const cfg=configuration(env);if(!cfg.enabled)throw new ArchiveError(cfg.reasons[0],503);
      const actor=await authorize(req,env,{admin:!read||action==='manifest',fetcher});
      store||=new ArchiveRepository(env,{fetcher});drive||=new DriveClient(env,{fetcher});service||=new ArchiveService(store,drive,env.KARDEX_DRIVE_SESSION_KEY);
      if(action==='resolve')return json(200,await actor.resolve(req.query.kardex));
      if(action==='start'||action==='adopt'){const raw=await body(req),input=validateInput(raw);const isDirectExcelOriginal=input.documentId===null&&input.importId===undefined&&input.category==='originals'&&/^excel-import:[0-9a-f-]{36}:[a-f0-9]{64}$/i.test(input.sourceKey);
        const isStagedEvidence=input.documentId===null&&input.importId===undefined&&input.category==='scans'&&/^sustento:[0-9a-f-]{36}$/i.test(input.sourceKey);
        if((input.documentId===null&&!isDirectExcelOriginal&&!isStagedEvidence)||['backups','manifests'].includes(input.category))actor.backup();
        if(input.documentId!==null)await actor.document(input.documentId);if(input.importId){const source=await actor.importSource(input.importId);if(input.category==='originals'&&source.sha256!==input.sha256)throw new ArchiveError('IMPORT_CHECKSUM_MISMATCH',409);}return json(200,action==='adopt'?await service.adopt(input,raw.driveFileId):await service.start(input));}
      if(action==='list'||action==='manifest'){
        const doc=req.query.documentId??null;if(doc===null)actor.backup();else{if(typeof doc!=='string'||!/^[-a-f0-9]{36}$/i.test(doc))throw new ArchiveError('INVALID_DOCUMENT');await actor.document(doc);}
        if(action==='manifest'){res.setHeader('Content-Type','application/x-ndjson');res.setHeader('Content-Disposition','attachment; filename="kardex-drive-manifest.ndjson"');res.write(JSON.stringify({version:1,generatedAt:new Date().toISOString()})+'\n');for await(const page of store.pages(doc))for(const job of page)res.write(JSON.stringify(safeJob(job))+'\n');return res.end();}
        return json(200,{version:1,generatedAt:new Date().toISOString(),files:(await store.list(doc)).map(safeJob)});
      }
      if(!id)throw new ArchiveError('INVALID_JOB');const job=await store.get(id);const isDirectExcelJob=job.documentId===null&&job.importId==null&&job.category==='originals'&&/^excel-import:[0-9a-f-]{36}:[a-f0-9]{64}$/i.test(job.sourceKey||'');
      const isStagedEvidenceJob=job.documentId===null&&job.importId==null&&job.category==='scans'&&/^sustento:[0-9a-f-]{36}$/i.test(job.sourceKey||'');
      if((job.documentId===null&&!isStagedEvidenceJob&&(!isDirectExcelJob||read))||['backups','manifests'].includes(job.category))actor.backup();
      if(isStagedEvidenceJob){
        if(read)await actor.document(job.sourceKey.slice('sustento:'.length));
      }else if(job.documentId!==null)await actor.document(job.documentId);
      if(job.importId)await actor.importSource(job.importId);
      if(action==='chunk')return json(200,await service.chunk(id,Number(req.query.offset),await body(req,true)));
      if(action==='finish')return json(200,await service.finish(id));
      if(action==='reconcile')return json(200,await service.reconcile(id));
      const file=await service.download(id);res.setHeader('Content-Type','application/octet-stream');res.setHeader('Content-Disposition',"attachment; filename*=UTF-8''"+encodeURIComponent(file.job.name));
      return await pipeline(Readable.fromWeb(file.response.body),res);
    }catch(error){if(!(error instanceof ArchiveError)||error.status>=500)console.error(JSON.stringify({event:'archive_error',code:error instanceof ArchiveError?error.code:'ARCHIVE_UNAVAILABLE'}));if(res.headersSent){res.destroy();return;}return json(error instanceof ArchiveError?error.status:500,{error:error instanceof ArchiveError?error.code:'ARCHIVE_UNAVAILABLE'});}
  };
}
export default createHandler();
