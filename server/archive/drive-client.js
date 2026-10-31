import {createHash} from 'node:crypto';
import {ArchiveError,categories} from './security.js';
const API='https://www.googleapis.com/drive/v3';
export class DriveClient {
  constructor(env,{fetcher=fetch,sleep=ms=>new Promise(r=>setTimeout(r,ms))}={}){this.env=env;this.fetch=fetcher;this.sleep=sleep;}
  async token(){
    if(this.cached&&this.cached.until>Date.now())return this.cached.token;
    const r=await this.fetch('https://oauth2.googleapis.com/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:this.env.GOOGLE_DRIVE_CLIENT_ID,client_secret:this.env.GOOGLE_DRIVE_CLIENT_SECRET,refresh_token:this.env.GOOGLE_DRIVE_REFRESH_TOKEN,grant_type:'refresh_token'}),signal:AbortSignal.timeout(20000),redirect:'error'});
    if(!r.ok)throw new ArchiveError('DRIVE_AUTH_FAILED',503);
    const d=await r.json();if(!d.access_token)throw new ArchiveError('DRIVE_AUTH_FAILED',503);
    this.cached={token:d.access_token,until:Date.now()+Math.max(0,(Number(d.expires_in)||300)-60)*1000};return d.access_token;
  }
  validSession(url){const u=new URL(url);if(u.protocol!=='https:'||u.hostname!=='www.googleapis.com'||!u.pathname.startsWith('/upload/drive/v3/files')||u.username||u.password)throw new ArchiveError('INVALID_UPLOAD_SESSION',502);return u.href;}
  async request(url,options={},accepted=[]){
    for(let i=0;i<3;i++){
      let r;
      try{r=await this.fetch(url,{...options,headers:{...options.headers,Authorization:'Bearer '+await this.token()},signal:AbortSignal.timeout(20000),redirect:'error'});}catch(error){if(error instanceof ArchiveError)throw error;if(i===2)throw new ArchiveError('DRIVE_NETWORK_ERROR',503);await this.sleep(150*2**i);continue;}
      if(r.ok||accepted.includes(r.status))return r;
      if(r.status===401){this.cached=null;if(i<2)continue;}
      if((r.status===429||r.status>=500)&&i<2){await r.body?.cancel();await this.sleep(Math.min(2000,Math.max(150*2**i,Number(r.headers.get('retry-after'))*1000||0)));continue;}
      await r.body?.cancel();throw new ArchiveError(r.status===404?'DRIVE_FILE_MISSING':'DRIVE_REQUEST_FAILED',r.status===404?404:503);
    }
    throw new ArchiveError('DRIVE_REQUEST_FAILED',503);
  }
  async checkRoot(){
    const d=await (await this.request(`${API}/files/${encodeURIComponent(this.env.GOOGLE_DRIVE_ROOT_FOLDER_ID)}?fields=id,mimeType,trashed,owners(emailAddress),capabilities(canAddChildren),permissions(type)&supportsAllDrives=true`)).json();
    if(d.trashed||d.mimeType!=='application/vnd.google-apps.folder'||!d.capabilities?.canAddChildren||!d.owners?.some(o=>o.emailAddress===this.env.GOOGLE_DRIVE_OWNER_EMAIL)||d.permissions?.some(p=>p.type==='anyone'))throw new ArchiveError('DRIVE_DESTINATION_NOT_APPROVED',403);
    return d;
  }
  async folder(category){
    let folders;try{folders=JSON.parse(this.env.GOOGLE_DRIVE_FOLDER_IDS_JSON||'{}');}catch{throw new ArchiveError('DRIVE_FOLDERS_NOT_CONFIGURED',503);}
    const id=folders[category];if(!/^[\w-]{10,200}$/.test(id||''))throw new ArchiveError('DRIVE_FOLDERS_NOT_CONFIGURED',503);
    const m=await (await this.request(`${API}/files/${id}?fields=id,mimeType,parents,trashed&supportsAllDrives=true`)).json();
    if(m.trashed||m.mimeType!=='application/vnd.google-apps.folder'||!m.parents?.includes(this.env.GOOGLE_DRIVE_ROOT_FOLDER_ID))throw new ArchiveError('DRIVE_FOLDER_MISMATCH',403);
    return id;
  }
  async allocate(){const d=await (await this.request(`${API}/files/generateIds?count=1&space=drive`)).json();return d.ids[0];}
  async initiate(job){
    await this.checkRoot();const parent=await this.folder(job.category);
    const metadata={id:job.driveFileId,name:job.name,mimeType:job.mime,parents:[parent],appProperties:{kardexJob:job.id,kardexKey:job.key,sha256:job.sha256,sourceModifiedAt:job.modifiedAt||''}};
    if(job.modifiedAt)metadata.modifiedTime=job.modifiedAt;
    const r=await this.request('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id&supportsAllDrives=true',{method:'POST',headers:{'Content-Type':'application/json; charset=UTF-8','X-Upload-Content-Type':job.mime,'X-Upload-Content-Length':String(job.size)},body:JSON.stringify(metadata)});
    const session=this.validSession(r.headers.get('location'));await r.body?.cancel();return session;
  }
  async progress(session,size,body,offset){
    const query=body===undefined;
    const r=await this.request(this.validSession(session),{method:'PUT',headers:{'Content-Type':'application/octet-stream','Content-Range':query?`bytes */${size}`:`bytes ${offset}-${offset+body.length-1}/${size}`},body:query?Buffer.alloc(0):body},[308,404,410]);
    await r.body?.cancel();
    if([404,410].includes(r.status))throw new ArchiveError('UPLOAD_SESSION_EXPIRED',409);
    if(r.status!==308)return size;
    const range=r.headers.get('range');return range?Number(range.match(/^bytes=0-(\d+)$/)?.[1])+1:0;
  }
  async metadata(id){return (await this.request(`${API}/files/${encodeURIComponent(id)}?fields=id,name,size,mimeType,trashed,headRevisionId,sha256Checksum,parents,appProperties&supportsAllDrives=true`)).json();}
  async media(id,revision){
    if(!revision)throw new ArchiveError('UNVERIFIED_REVISION',409);
    return this.request(`${API}/files/${encodeURIComponent(id)}/revisions/${encodeURIComponent(revision)}?alt=media`);
  }
  async verify(job){
    await this.checkRoot();
    const m=await this.metadata(job.driveFileId);
    if(m.trashed||Number(m.size)!==job.size||m.appProperties?.kardexKey!==job.key||!m.headRevisionId)throw new ArchiveError('DRIVE_METADATA_MISMATCH',409);
    const parent=await this.folder(job.category);if(!m.parents?.includes(parent))throw new ArchiveError('DRIVE_PARENT_MISMATCH',409);
    const r=await this.media(job.driveFileId,m.headRevisionId),hash=createHash('sha256');let size=0;
    for await(const chunk of r.body){size+=chunk.length;hash.update(chunk);}
    if(size!==job.size||hash.digest('hex')!==job.sha256)throw new ArchiveError('CHECKSUM_MISMATCH',409);
    return {revisionId:m.headRevisionId};
  }
}
