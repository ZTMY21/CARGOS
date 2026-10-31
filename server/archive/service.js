import {randomUUID} from 'node:crypto';
import {ArchiveError,validateInput,seal,unseal,safeJob} from './security.js';
export class ArchiveService {
  constructor(store,drive,key){this.store=store;this.drive=drive;this.key=key;}
  async locked(id,run){
    const owner=randomUUID(),job=await this.store.claim(id,owner);
    try{return safeJob(await run(job,owner));}
    catch(error){
      job.errorCode=error instanceof ArchiveError?error.code:'TRANSFER_INTERRUPTED';
      if(job.status==='verified')job.status='attention';
      if(job.errorCode==='UPLOAD_SESSION_EXPIRED'){job.sessionCipher=null;job.offset=0;job.status='pending';}
      try{await this.store.save(job,owner);}catch{/* The durable lease expires; reconciliation retains the remote file ID. */}
      if(error instanceof ArchiveError)throw error;throw new ArchiveError('TRANSFER_INTERRUPTED',503);
    }
  }
  async start(input){
    const job=await this.store.create(validateInput(input));
    if(job.status==='verified')return safeJob(job);
    if(job.adopted)return this.finish(job.id);
    return this.locked(job.id,async(job,owner)=>{
      if(!job.driveFileId){job.driveFileId=await this.drive.allocate();await this.store.save(job,owner,false);}
      if(!job.sessionCipher){
        let existing;try{existing=await this.drive.metadata(job.driveFileId);}catch(e){if(e.code!=='DRIVE_FILE_MISSING')throw e;}
        if(existing){job.status='uploaded';job.offset=job.size;}
        else{job.sessionCipher=seal(await this.drive.initiate(job),this.key);job.status='uploading';}
      }
      job.errorCode=null;return this.store.save(job,owner);
    });
  }
  async adopt(input,fileId){
    if(typeof fileId!=='string'||!/^[-\w]{10,200}$/.test(fileId))throw new ArchiveError('INVALID_DRIVE_FILE');
    const job=await this.store.create(validateInput(input));
    // An existing logical reference can never be replaced by another file.
    if(job.driveFileId&&job.driveFileId!==fileId)throw new ArchiveError('DRIVE_REFERENCE_CONFLICT',409);
    return this.locked(job.id,async(job,owner)=>{
      job.driveFileId=fileId;job.adopted=true;job.status='uploaded';job.offset=job.size;job.sessionCipher=null;
      await this.store.save(job,owner,false);
      const proof=await this.drive.verify(job);
      Object.assign(job,proof,{status:'verified',verifiedAt:new Date().toISOString(),errorCode:null});
      return this.store.save(job,owner);
    });
  }
  async chunk(id,offset,bytes){
    if(!Buffer.isBuffer(bytes)||!bytes.length||bytes.length>1024**2)throw new ArchiveError('INVALID_CHUNK');
    if(!Number.isSafeInteger(offset)||offset<0)throw new ArchiveError('INVALID_OFFSET');
    return this.locked(id,async(job,owner)=>{
      if(job.status==='verified')return this.store.save(job,owner);
      if(!job.sessionCipher)throw new ArchiveError('UPLOAD_NOT_STARTED',409);
      const session=unseal(job.sessionCipher,this.key);
      job.offset=await this.drive.progress(session,job.size);
      if(job.offset===job.size){job.status='uploaded';return this.store.save(job,owner);}
      if(job.offset!==offset)throw new ArchiveError('OFFSET_CONFLICT',409);
      if(offset+bytes.length>job.size||(offset+bytes.length<job.size&&bytes.length%(256*1024)!==0))throw new ArchiveError('INVALID_CHUNK_RANGE');
      job.offset=await this.drive.progress(session,job.size,bytes,offset);
      if(!Number.isSafeInteger(job.offset)||job.offset<offset||job.offset>job.size)throw new ArchiveError('INVALID_REMOTE_OFFSET',502);
      job.status=job.offset===job.size?'uploaded':'uploading';job.errorCode=null;
      return this.store.save(job,owner);
    });
  }
  async finish(id){return this.locked(id,async(job,owner)=>{
    if(!job.driveFileId)throw new ArchiveError('UPLOAD_NOT_STARTED',409);
    if(job.status!=='verified'&&job.offset!==job.size)throw new ArchiveError('UPLOAD_INCOMPLETE',409);
    const verified=await this.drive.verify(job);
    Object.assign(job,verified,{status:'verified',verifiedAt:new Date().toISOString(),errorCode:null,sessionCipher:null});
    return this.store.save(job,owner);
  });}
  async reconcile(id){return this.locked(id,async(job,owner)=>{
    if(job.status==='verified'){await this.drive.verify(job);job.errorCode=null;return this.store.save(job,owner);}
    if(job.sessionCipher){job.offset=await this.drive.progress(unseal(job.sessionCipher,this.key),job.size);job.status=job.offset===job.size?'uploaded':'uploading';}
    else if(job.driveFileId){const m=await this.drive.metadata(job.driveFileId);if(m){job.offset=job.size;job.status='uploaded';}}
    else throw new ArchiveError('UPLOAD_NOT_STARTED',409);
    job.errorCode=null;return this.store.save(job,owner);
  });}
  async download(id){
    const job=await this.store.get(id);
    if(job.status!=='verified'||job.errorCode)throw new ArchiveError('FILE_NOT_VERIFIED',409);
    return {job:safeJob(job),response:await this.drive.media(job.driveFileId,job.revisionId)};
  }
}
