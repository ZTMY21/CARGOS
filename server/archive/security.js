import {createHash,randomBytes,createCipheriv,createDecipheriv} from 'node:crypto';
export class ArchiveError extends Error {
  constructor(code,status=400){super(code);this.code=code;this.status=status;}
}
export const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
export const categories=Object.freeze({scans:'01_Escaneados',originals:'02_Excel_originales',backups:'03_Respaldos',history:'04_Historico',manifests:'05_Manifiestos'});
export function validateInput(value){
  const v=Object.fromEntries(['documentId','importId','sourceKey','sourceVersion','name','sha256','size','mime','category','modifiedAt'].filter(k=>value?.[k]!==undefined).map(k=>[k,value[k]]));
  const uuid=x=>/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(x||'');
  if(v.importId!==undefined&&!uuid(v.importId))throw new ArchiveError('INVALID_IMPORT');
  const global=v.documentId===null&&(['backups','manifests'].includes(v.category)||(v.category==='originals'&&uuid(v.importId)));
  if(!global&&!uuid(v.documentId))throw new ArchiveError('INVALID_DOCUMENT');
  for(const k of ['sourceKey','sourceVersion'])if(typeof v[k]!=='string'||!v[k].trim()||v[k].length>200||/[\x00-\x1f]/.test(v[k]))throw new ArchiveError('INVALID_SOURCE');
  if(typeof v.name!=='string'||!v.name.trim()||v.name.length>180||/[\\/\x00-\x1f]/.test(v.name))throw new ArchiveError('INVALID_NAME');
  if(!/^[a-f0-9]{64}$/.test(v.sha256||''))throw new ArchiveError('INVALID_SHA256');
  if(!Number.isSafeInteger(v.size)||v.size<1||v.size>100*1024**2)throw new ArchiveError('INVALID_SIZE');
  if(typeof v.mime==='string')v.mime=v.mime.toLowerCase();
  const allowed=['application/pdf','image/jpeg','image/png','application/json','application/zip','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','application/vnd.ms-excel.sheet.macroenabled.12','application/octet-stream'];
  if(!allowed.includes(v.mime))throw new ArchiveError('INVALID_MIME');
  if(!Object.hasOwn(categories,v.category))throw new ArchiveError('INVALID_CATEGORY');
  if(v.modifiedAt!==undefined&&(!Number.isFinite(Date.parse(v.modifiedAt))||new Date(v.modifiedAt).toISOString()!==v.modifiedAt))throw new ArchiveError('INVALID_DATE');
  const identity=[v.documentId,v.sourceKey,v.sourceVersion,v.sha256,v.category];if(v.importId)identity.push(v.importId);v.key=sha256(JSON.stringify(identity));
  return v;
}
export function configuration(env=process.env){
  const project=new URL(env.SUPABASE_URL||'https://unconfigured.invalid').hostname.split('.')[0];
  const reasons=[];
  if(env.KARDEX_DRIVE_ENABLED!=='true')reasons.push('NOT_ENABLED');
  if(!env.KARDEX_DRIVE_AUTHORIZATION_REF)reasons.push('INSTITUTIONAL_AUTHORIZATION_PENDING');
  if(env.VERCEL_ENV==='production'&&env.KARDEX_DRIVE_RELEASE_APPROVED!=='true')reasons.push('PRODUCTION_RELEASE_NOT_APPROVED');
  const isolated=project!=='uhjwhamzjxhjqlrhgxho'&&project===env.KARDEX_DRIVE_SANDBOX_PROJECT_ID;
  const approvedCopy=env.VERCEL_ENV==='preview'&&env.VERCEL_GIT_COMMIT_REF==='preview/drive-archive-20261031'&&project===env.KARDEX_DRIVE_REAL_COPY_PROJECT_ID&&Boolean(env.KARDEX_DRIVE_REAL_COPY_APPROVAL_REF);
  if(env.VERCEL_ENV!=='production'&&!isolated&&!approvedCopy)reasons.push(project==='uhjwhamzjxhjqlrhgxho'?'REAL_COPY_METADATA_APPROVAL_REQUIRED':'ISOLATED_DATABASE_REQUIRED');
  if(!env.SUPABASE_SERVICE_ROLE_KEY&&!env.KARDEX_DRIVE_METADATA_KEY)reasons.push('BACKEND_CONFIGURATION_PENDING');
  if(!env.GOOGLE_DRIVE_REFRESH_TOKEN&&env.KARDEX_DRIVE_OAUTH_STORAGE!=='encrypted-runtime')reasons.push('BACKEND_CONFIGURATION_PENDING');
  for(const name of ['GOOGLE_DRIVE_CLIENT_ID','GOOGLE_DRIVE_CLIENT_SECRET','GOOGLE_DRIVE_ROOT_FOLDER_ID','GOOGLE_DRIVE_OWNER_EMAIL','KARDEX_DRIVE_SESSION_KEY','GOOGLE_DRIVE_FOLDER_IDS_JSON'])if(!env[name])reasons.push('BACKEND_CONFIGURATION_PENDING');
  if(env.GOOGLE_DRIVE_FOLDER_IDS_JSON){try{const folders=JSON.parse(env.GOOGLE_DRIVE_FOLDER_IDS_JSON);if(Object.keys(categories).some(k=>!/^[-\w]{10,200}$/.test(folders[k]||''))||new Set(Object.values(folders)).size!==5)reasons.push('DRIVE_FOLDERS_NOT_CONFIGURED');}catch{reasons.push('DRIVE_FOLDERS_NOT_CONFIGURED');}}
  if(env.KARDEX_DRIVE_SESSION_KEY&&Buffer.from(env.KARDEX_DRIVE_SESSION_KEY,'base64').length!==32)reasons.push('INVALID_SESSION_KEY');
  return {enabled:reasons.length===0,reasons:[...new Set(reasons)],mode:reasons.length?'pending-activation':approvedCopy?'connected-copy-only':'connected',sourceMutationsEnabled:false};
}
export function seal(value,key){
  const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',Buffer.from(key,'base64'),iv);
  const data=Buffer.concat([cipher.update(value,'utf8'),cipher.final()]);
  return Buffer.concat([iv,cipher.getAuthTag(),data]).toString('base64');
}
export function unseal(value,key){
  const data=Buffer.from(value,'base64'),cipher=createDecipheriv('aes-256-gcm',Buffer.from(key,'base64'),data.subarray(0,12));
  cipher.setAuthTag(data.subarray(12,28));return Buffer.concat([cipher.update(data.subarray(28)),cipher.final()]).toString('utf8');
}
export function safeJob(job){
  const keys=['id','documentId','importId','sourceKey','sourceVersion','name','mime','size','sha256','category','modifiedAt','status','offset','driveFileId','revisionId','verifiedAt','errorCode','adopted','backendVerified'];
  return Object.fromEntries(keys.filter(k=>job[k]!==undefined).map(k=>[k,job[k]]));
}
