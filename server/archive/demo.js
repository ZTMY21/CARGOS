// Test-only adapters. Live routes never use this store or substitute it on failure.
import {randomUUID} from 'node:crypto';
import {ArchiveError,sha256} from './security.js';
import {ArchiveService} from './service.js';
export class MemoryArchiveStore {
  constructor(){this.rows=new Map();this.leases=new Map();}
  async create(input){let r=[...this.rows.values()].find(r=>r.key===input.key);if(!r){r={...input,id:randomUUID(),status:'pending',offset:0};this.rows.set(r.id,r);}return structuredClone(r);}
  async get(id){const r=this.rows.get(id);if(!r)throw new ArchiveError('ARCHIVE_NOT_FOUND',404);return structuredClone(r);}
  async list(id){return [...this.rows.values()].filter(r=>r.documentId===id).map(r=>structuredClone(r));}
  async claim(id,owner){if(this.leases.has(id))throw new ArchiveError('TRANSFER_BUSY',409);const r=this.rows.get(id);if(!r)throw new ArchiveError('ARCHIVE_NOT_FOUND',404);this.leases.set(id,owner);return structuredClone(r);}
  async save(job,owner,release=true){if(this.leases.get(job.id)!==owner)throw new ArchiveError('TRANSFER_LEASE_EXPIRED',409);this.rows.set(job.id,structuredClone(job));if(release)this.leases.delete(job.id);return structuredClone(job);}
}
export class MemoryDrive {
  constructor(){this.files=new Map();this.sessions=new Map();this.created=0;}
  async allocate(){return 'demo-drive-'+randomUUID();}
  async initiate(job){const url='https://www.googleapis.com/upload/drive/v3/files?upload_id='+job.driveFileId;this.sessions.set(url,{job:structuredClone(job),bytes:Buffer.alloc(0)});this.created++;return url;}
  async metadata(id){const f=this.files.get(id);if(!f)throw new ArchiveError('DRIVE_FILE_MISSING',404);return {id,size:String(f.bytes.length),headRevisionId:'demo-revision'};}
  async progress(url,size,bytes){const s=this.sessions.get(url);if(!s)throw new ArchiveError('DRIVE_FILE_MISSING',404);if(bytes){if(this.failNextChunk){this.failNextChunk=false;throw new ArchiveError('DRIVE_NETWORK_ERROR',503);}s.bytes=Buffer.concat([s.bytes,bytes]);if(s.bytes.length===size)this.files.set(s.job.driveFileId,s);}return s.bytes.length;}
  async verify(job){const f=this.files.get(job.driveFileId);if(!f)throw new ArchiveError('DRIVE_FILE_MISSING',404);if(this.corruptRead||sha256(f.bytes)!==job.sha256)throw new ArchiveError('CHECKSUM_MISMATCH',409);return {revisionId:'demo-revision'};}
  async media(id){const f=this.files.get(id);if(!f)throw new ArchiveError('DRIVE_FILE_MISSING',404);return new Response(f.bytes);}
}
export const demoBytes=Buffer.from(JSON.stringify([{cargo:'DEMO-001',codigo:'F-0001'},{cargo:'DEMO-001',codigo:'F-0001'},{cargo:'DEMO-001',codigo:'F-0002'}])+'\n');
export const demoInput={documentId:'00000000-0000-4000-8000-000000000001',sourceKey:'fictional-fixture',sourceVersion:'1',name:'solo-datos-ficticios.json',mime:'application/json',category:'history',size:demoBytes.length,sha256:sha256(demoBytes),modifiedAt:'2026-10-31T00:00:00.000Z'};
export async function executeDemo(){
  const store=new MemoryArchiveStore(),drive=new MemoryDrive(),service=new ArchiveService(store,drive,Buffer.alloc(32,7).toString('base64'));
  let first=await service.start(demoInput);first=await service.chunk(first.id,0,demoBytes);first=await service.finish(first.id);
  const repeated=await service.start(demoInput);
  const second=await service.start({...demoInput,documentId:'00000000-0000-4000-8000-000000000002'});
  drive.failNextChunk=true;let failure;
  try{await service.chunk(second.id,0,demoBytes);}catch(e){failure=e.code;}
  const pending=await store.get(second.id);
  await service.chunk(second.id,0,demoBytes);await service.finish(second.id);
  const downloaded=await service.download(first.id),restored=Buffer.from(await downloaded.response.arrayBuffer());
  return {mode:'isolated-demo',realFilesTransferred:0,syntheticFilesVerified:2,sha256:first.sha256,sourceRetained:true,duplicateRowsPreserved:JSON.parse(restored).filter(r=>r.codigo==='F-0001').length===2,idempotent:repeated.id===first.id,distinctRelationsPreserved:second.id!==first.id,failedTransferNotCompleted:pending.status!=='verified',failure,retryRecovered:(await store.get(second.id)).status==='verified',restoredChecksumMatches:sha256(restored)===first.sha256,steps:['Registro ficticio','Carga en adaptador de prueba','Lectura de recuperación','SHA-256 coincidente','Reintento sin duplicar','Fallo simulado conservado','Recuperación comprobada']};
}
