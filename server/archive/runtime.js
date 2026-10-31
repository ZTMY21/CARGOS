import {ArchiveError} from './security.js';
export async function gateway(env,data,fetcher=fetch){
 const r=await fetcher(env.SUPABASE_URL+'/functions/v1/kardex-drive-metadata',{method:'POST',headers:{'Content-Type':'application/json',apikey:env.SUPABASE_ANON_KEY},body:JSON.stringify({capability:env.KARDEX_DRIVE_METADATA_KEY,...data}),signal:AbortSignal.timeout(20000),redirect:'error'});
 if(!r.ok)throw new ArchiveError('ARCHIVE_GATEWAY_UNAVAILABLE',503);return r.status===204?null:r.json();
}
export const runtime=(env,action,payload=null,id=null,fetcher=fetch)=>gateway(env,{operation:'runtime',action,payload,id},fetcher);
