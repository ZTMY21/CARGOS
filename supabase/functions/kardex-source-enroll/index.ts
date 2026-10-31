// Google-owned enrollment never receives or returns a raw webhook secret.
const sources:Record<string,string>={cargos:'14GzTxs9-hk3_vPTI7AYLc3jiqLAaAC5q7y910wo8Jh0',im:'1VWmKFmE8UcXV6ukG8k-wqKqCzuJbPGYOf9RFowojhSw'};
Deno.serve(async(req:Request)=>{
 const json=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});
 if(req.method!=='POST')return json({error:'METHOD_NOT_ALLOWED'},405);
 try{
  if(Number(req.headers.get('content-length')||0)>4096)return json({error:'BODY_TOO_LARGE'},413);
  const bearer=req.headers.get('authorization')||'';if(!bearer.startsWith('Bearer ')||bearer.length>5000)return json({error:'GOOGLE_AUTH_REQUIRED'},401);
  const raw=await req.text();if(raw.length>4096)return json({error:'BODY_TOO_LARGE'},413);const input=JSON.parse(raw);
  if(sources[input.kind]!==input.sheet_id||!/^[-a-f0-9]{64}$/.test(input.token_sha256||''))return json({error:'INVALID_SOURCE'},400);
  const headers={Authorization:bearer};
  const account=await fetch('https://www.googleapis.com/drive/v3/about?fields=user(emailAddress)',{headers,signal:AbortSignal.timeout(10000),redirect:'error'});
  if(!account.ok||(await account.json()).user?.emailAddress?.toLowerCase()!=='jaguliquidacion@gmail.com')return json({error:'GOOGLE_OWNER_REQUIRED'},403);
  const file=await fetch('https://www.googleapis.com/drive/v3/files/'+input.sheet_id+'?fields=id,mimeType,trashed,owners(emailAddress)',{headers,signal:AbortSignal.timeout(10000),redirect:'error'});
  if(!file.ok)return json({error:'SOURCE_NOT_ACCESSIBLE'},403);const meta=await file.json();
  if(meta.trashed||meta.mimeType!=='application/vnd.google-apps.spreadsheet'||!meta.owners?.some((o:{emailAddress:string})=>o.emailAddress==='jaguliquidacion@gmail.com'))return json({error:'SOURCE_OWNER_MISMATCH'},403);
  const key=Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')||JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS')||'{}').default;
  const r=await fetch(Deno.env.get('SUPABASE_URL')+'/rest/v1/rpc/kardex_enroll_live_source',{method:'POST',headers:{'Content-Type':'application/json',apikey:key,...(key.startsWith('eyJ')?{Authorization:'Bearer '+key}:{})},body:JSON.stringify({p_kind:input.kind,p_sheet_id:input.sheet_id,p_token_sha256:input.token_sha256,p_build:input.build_id??null,p_display_rows:input.display_rows??null,p_display_sha256:input.display_sha256??null}),signal:AbortSignal.timeout(15000),redirect:'error'});
  if(!r.ok)return json({error:'SOURCE_ENROLLMENT_REJECTED'},409);return json(await r.json());
 }catch{return json({error:'SOURCE_ENROLLMENT_UNAVAILABLE'},503);}
});
