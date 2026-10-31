// Scoped internal gateway: the platform's service key never leaves Supabase.
// Only archive metadata and encrypted OAuth settings are accessible here.
export async function handle(req:Request,env:{get(name:string):string|undefined},fetcher=fetch){
 const json=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json','Cache-Control':'private, no-store'}});
 if(req.method!=='POST')return json({error:'METHOD_NOT_ALLOWED'},405);
 try{
  if(Number(req.headers.get('content-length')||0)>32768)return json({error:'BODY_TOO_LARGE'},413);
  const reader=req.body?.getReader(),chunks:Uint8Array[]=[];let size=0;
  if(reader)for(;;){const part=await reader.read();if(part.done)break;size+=part.value.length;if(size>32768){await reader.cancel();return json({error:'BODY_TOO_LARGE'},413);}chunks.push(part.value);}
  const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}const raw=new TextDecoder().decode(bytes);
  const body=JSON.parse(raw);if(typeof body.capability!=='string'||body.capability.length!==44)return json({error:'UNAUTHORIZED'},401);
  const digest=[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(body.capability)))].map(x=>x.toString(16).padStart(2,'0')).join('');
  const base=env.get('SUPABASE_URL'),key=env.get('SUPABASE_SERVICE_ROLE_KEY')||JSON.parse(env.get('SUPABASE_SECRET_KEYS')||'{}').default;
  if(!base||!key)return json({error:'ARCHIVE_RUNTIME_UNCONFIGURED'},503);
  const headers:Record<string,string>={'Content-Type':'application/json',apikey:key,...(key.startsWith('eyJ')?{Authorization:'Bearer '+key}:{})};
  const rpc=async(name:string,payload:unknown)=>fetcher(base+'/rest/v1/rpc/'+name,{method:'POST',headers,body:JSON.stringify(payload),signal:AbortSignal.timeout(15000),redirect:'error'});
  const auth=await rpc('kardex_drive_runtime_access',{p_key_sha256:digest,p_action:'authorize'});
  if(!auth.ok)return json({error:'UNAUTHORIZED'},401);await auth.body?.cancel();
  if(body.operation==='history-manifest'){
    const r=await rpc('kardex_history_archive_manifest',{});
    if(!r.ok)return json({error:'MANIFEST_READ_FAILED'},503);
    return json(await r.json());
  }
  if(body.operation==='history-page'){
    const {start,end,after,limit}=body;
    if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||!Number.isSafeInteger(after)||
      !Number.isSafeInteger(limit)||start<1||end<start||end-start>500||limit<1||limit>100)
      return json({error:'INVALID_HISTORY_RANGE'},400);
    const r=await rpc('kardex_history_archive_page',{p_start:start,p_end:end,p_after:after,p_limit:limit});
    if(!r.ok)return json({error:'HISTORY_READ_FAILED'},503);
    return json(await r.json());
  }
  if(body.operation==='history-record'){
    const {start,end,count,sha256,fileId,revisionId,bytes}=body;
    if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||end-start>500||end<start||
      !Number.isSafeInteger(count)||count<1||!Number.isSafeInteger(bytes)||bytes<1||
      typeof sha256!=='string'||!/^[0-9a-f]{64}$/.test(sha256)||typeof fileId!=='string'||
      typeof revisionId!=='string')return json({error:'INVALID_ARCHIVE_RECORD'},400);
    const r=await rpc('kardex_history_archive_record',{
      p_start:start,p_end:end,p_count:count,p_sha256:sha256,
      p_drive_file_id:fileId,p_revision_id:revisionId,p_compressed_bytes:bytes
    });
    if(!r.ok)return json({error:'HISTORY_RECORD_FAILED'},503);
    return json(await r.json());
  }
  if(body.operation==='runtime'){
   if(!['get-oauth','set-oauth','create-session','consume-session'].includes(body.action))return json({error:'INVALID_OPERATION'},400);
   const r=await rpc('kardex_drive_runtime_access',{p_key_sha256:digest,p_action:body.action,p_id:body.id??null,p_payload:body.payload??null});
   if(!r.ok)return json({error:'ARCHIVE_RUNTIME_ERROR'},409);return json(await r.json());
  }
  if(body.operation!=='metadata'||typeof body.path!=='string')return json({error:'INVALID_OPERATION'},400);
  const url=new URL(body.path,'https://archive.invalid/'),method=body.method||'GET';
  const uuid=(x:unknown)=>typeof x==='string'&&/^[a-f0-9-]{36}$/i.test(x);
  if(url.pathname==='/kardex_drive_jobs'){
   if(method==='GET'){
    const q=url.searchParams,allowed=['select','id','idempotency_key','document_id','order','limit','offset'];
    if([...q.keys()].some(k=>!allowed.includes(k))||q.get('select')!=='*')return json({error:'INVALID_QUERY'},400);
    const id=q.get('id'),hash=q.get('idempotency_key'),doc=q.get('document_id');
    if(id&&(!id.startsWith('eq.')||!uuid(id.slice(3))))return json({error:'INVALID_ID'},400);
    if(hash&&!/^eq\.[a-f0-9]{64}$/.test(hash))return json({error:'INVALID_KEY'},400);
    if(doc&&doc!=='is.null'&&(!doc.startsWith('eq.')||!uuid(doc.slice(3))))return json({error:'INVALID_DOCUMENT'},400);
    if(!id&&!hash&&!doc)return json({error:'FILTER_REQUIRED'},400);
    if(q.has('limit')&&(!/^\d+$/.test(q.get('limit')!)||Number(q.get('limit'))>500))return json({error:'INVALID_LIMIT'},400);
    if(q.has('offset')&&!/^\d{1,9}$/.test(q.get('offset')!))return json({error:'INVALID_OFFSET'},400);
    if(q.has('order')&&q.get('order')!=='created_at.asc,id.asc')return json({error:'INVALID_ORDER'},400);
   }else if(method==='POST'){
    const p=body.payload;
    if(url.search!=='?on_conflict=idempotency_key'||!p||!uuid(p.id)||!/^[-a-f0-9]{64}$/.test(p.idempotency_key)||p.data?.status!=='pending'||p.data?.offset!==0)return json({error:'INVALID_CREATE'},400);
    if(p.document_id!==null&&!uuid(p.document_id))return json({error:'INVALID_DOCUMENT'},400);
    if(p.import_id!==null&&p.import_id!==undefined&&!uuid(p.import_id))return json({error:'INVALID_IMPORT'},400);
   }else return json({error:'METHOD_NOT_ALLOWED'},405);
  }else if(['/rpc/kardex_drive_claim','/rpc/kardex_drive_save'].includes(url.pathname)){
   if(method!=='POST'||url.search||!uuid(body.payload?.p_id)||!uuid(body.payload?.p_owner))return json({error:'INVALID_LEASE'},400);
   if(url.pathname.endsWith('_save')){
    const patch=body.payload.p_patch,fields=['status','offset','driveFileId','sessionCipher','revisionId','verifiedAt','errorCode','adopted','backendVerified'];
    if(!patch||Object.keys(patch).some(k=>!fields.includes(k)))return json({error:'INVALID_PATCH'},400);
   }
  }else return json({error:'PATH_NOT_ALLOWED'},403);
  const r=await fetcher(base+'/rest/v1'+url.pathname+url.search,{method,headers:{...headers,...(method==='POST'&&url.pathname==='/kardex_drive_jobs'?{Prefer:'resolution=ignore-duplicates,return=minimal'}:{})},body:method==='POST'?JSON.stringify(body.payload):undefined,signal:AbortSignal.timeout(15000),redirect:'error'});
  if(!r.ok)return json({error:r.status===404?'ARCHIVE_SCHEMA_PENDING':'ARCHIVE_DATABASE_ERROR'},503);
  if(r.status===204)return new Response(null,{status:204,headers:{'Cache-Control':'no-store'}});return json(await r.json());
 }catch{return json({error:'ARCHIVE_GATEWAY_UNAVAILABLE'},503);}
}
declare const Deno:{env:{get(name:string):string|undefined};serve(handler:(req:Request)=>Promise<Response>):void};
if(typeof Deno!=='undefined')Deno.serve(req=>handle(req,Deno.env));
