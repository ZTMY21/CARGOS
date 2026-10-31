import {randomUUID} from 'node:crypto';
import {ArchiveError} from './security.js';
export class ArchiveRepository {
  constructor(env,{fetcher=fetch}={}){this.env=env;this.fetch=fetcher;}
  async request(path,options={}){
    const r=await this.fetch(this.env.SUPABASE_URL+'/rest/v1/'+path,{...options,headers:{apikey:this.env.SUPABASE_SERVICE_ROLE_KEY,Authorization:'Bearer '+this.env.SUPABASE_SERVICE_ROLE_KEY,'Content-Type':'application/json',...options.headers},signal:AbortSignal.timeout(15000),redirect:'error'});
    if(!r.ok)throw new ArchiveError(r.status===404?'ARCHIVE_SCHEMA_PENDING':'ARCHIVE_DATABASE_ERROR',503);
    if(r.status===204)return null;return r.json();
  }
  unpack(row){return row?{...row.data,id:row.id,key:row.idempotency_key}:null;}
  async create(input){
    const id=randomUUID();
    await this.request('kardex_drive_jobs?on_conflict=idempotency_key',{method:'POST',headers:{Prefer:'resolution=ignore-duplicates,return=minimal'},body:JSON.stringify({id,idempotency_key:input.key,document_id:input.documentId,data:{...input,status:'pending',offset:0}})});
    const rows=await this.request('kardex_drive_jobs?select=*&idempotency_key=eq.'+input.key);return this.unpack(rows[0]);
  }
  async get(id){const rows=await this.request('kardex_drive_jobs?select=*&id=eq.'+encodeURIComponent(id));if(!rows[0])throw new ArchiveError('ARCHIVE_NOT_FOUND',404);return this.unpack(rows[0]);}
  async *pages(documentId){for(let offset=0;;offset+=500){const rows=await this.request('kardex_drive_jobs?select=*&document_id='+(documentId===null?'is.null':'eq.'+encodeURIComponent(documentId))+'&order=created_at.asc,id.asc&limit=500&offset='+offset);yield rows.map(r=>this.unpack(r));if(rows.length<500)return;}}
  async list(documentId){const rows=[];for await(const page of this.pages(documentId))rows.push(...page);return rows;}
  async claim(id,owner){const r=await this.request('rpc/kardex_drive_claim',{method:'POST',body:JSON.stringify({p_id:id,p_owner:owner})});if(!r)throw new ArchiveError('TRANSFER_BUSY',409);return this.unpack(r);}
  async save(job,owner,release=true){
    const fields=['status','offset','driveFileId','sessionCipher','revisionId','verifiedAt','errorCode'];
    const patch=Object.fromEntries(fields.filter(k=>job[k]!==undefined).map(k=>[k,job[k]]));
    const r=await this.request('rpc/kardex_drive_save',{method:'POST',body:JSON.stringify({p_id:job.id,p_owner:owner,p_patch:patch,p_release:release})});if(!r)throw new ArchiveError('TRANSFER_LEASE_EXPIRED',409);return this.unpack(r);
  }
}
export async function authorize(req,env,{admin=false,fetcher=fetch}={}){
  const bearer=req.headers.authorization||'';
  if(!/^Bearer [\w.-]+$/.test(bearer))throw new ArchiveError('LOGIN_REQUIRED',401);
  const headers={apikey:env.SUPABASE_ANON_KEY,Authorization:bearer};
  const user=await fetcher(env.SUPABASE_URL+'/auth/v1/user',{headers,signal:AbortSignal.timeout(10000),redirect:'error'});
  if(!user.ok)throw new ArchiveError('SESSION_INVALID',401);
  const identity=await user.json();
  const r=await fetcher(env.SUPABASE_URL+'/rest/v1/rpc/kardex_access',{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:'{}',signal:AbortSignal.timeout(10000),redirect:'error'});
  if(!r.ok)throw new ArchiveError('ACCESS_DENIED',403);
  const access=await r.json();if(!access.allowed||(admin&&!access.is_admin))throw new ArchiveError('ACCESS_DENIED',403);
  return {backup(){if(!access.is_admin||!(env.KARDEX_DRIVE_BACKUP_OPERATOR_IDS||'').split(',').map(x=>x.trim()).includes(identity.id))throw new ArchiveError('BACKUP_OPERATOR_REQUIRED',403);},async resolve(kardex){
    if(!/^SA-\d{1,10}$/.test(kardex||''))throw new ArchiveError('INVALID_KARDEX');
    const r=await fetcher(env.SUPABASE_URL+'/rest/v1/documentos?select=id,kardex&kardex=eq.'+encodeURIComponent(kardex),{headers,signal:AbortSignal.timeout(10000),redirect:'error'});
    if(!r.ok)throw new ArchiveError('DOCUMENT_NOT_ACCESSIBLE',404);const rows=await r.json();if(rows.length!==1)throw new ArchiveError('DOCUMENT_NOT_ACCESSIBLE',404);return rows[0];
  },async document(id){
    const r=await fetcher(env.SUPABASE_URL+'/rest/v1/documentos?select=id&id=eq.'+encodeURIComponent(id),{headers,signal:AbortSignal.timeout(10000),redirect:'error'});
    if(!r.ok||!(await r.json()).length)throw new ArchiveError('DOCUMENT_NOT_ACCESSIBLE',404);
  }};
}
