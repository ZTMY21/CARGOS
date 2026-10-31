const SHEETS=new Set(["18TbKWiVUWKfkJOXvR0kGEMb5eVKTDCfoXAUtD5rCxts","14GzTxs9-hk3_vPTI7AYLc3jiqLAaAC5q7y910wo8Jh0"]);
const json=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status,headers:{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store"}});
Deno.serve(async(req)=>{
  if(req.method!=="POST")return json({error:"Método no permitido"},405);
  if(Number(req.headers.get("content-length")||"0")>950000)return json({error:"Solicitud demasiado grande"},413);
  const secret=req.headers.get("X-Cargos-Token")||"";
  if(secret.length<30||secret.length>180)return json({error:"No autorizado"},401);
  let data:unknown;
  try{data=await req.json()}catch{return json({error:"JSON inválido"},400)}
  if(!data||typeof data!=="object")return json({error:"Solicitud inválida"},400);
  const input=data as Record<string,unknown>;
  const mode=input.mode;
  if(!SHEETS.has(String(input.sheet_id)))return json({error:"Fuente incorrecta"},400);
  const sheet=String(input.sheet_id),probe=mode==="probe";
  const archive=mode==="archive",reconcile=mode==="reconcile",ingest=mode==="ingest",archiveRows=mode==="archive_rows";
  if(!probe&&!archive&&!reconcile&&!ingest&&!archiveRows)return json({error:"Modo inválido"},400);
  if(archive){
    if(!Array.isArray(input.codes)||input.codes.length<1||input.codes.length>15000||
      !input.codes.every(x=>typeof x==="string"&&x.length<201)||
      typeof input.cargo!=="string"||!/^\d{1,7}A?$/.test(input.cargo)||
      !Number.isInteger(input.anio)||Number(input.anio)<2026||
      !Number.isInteger(input.row_count)||Number(input.row_count)<1||
      typeof input.backup_id!=="string"||input.backup_id.length<15||input.backup_id.length>255)
      return json({error:"Archivo inválido"},400);
  }else if(!probe&&(!Array.isArray(input.rows)||input.rows.length>(reconcile?1200:100)||(!reconcile&&input.rows.length===0))){
    return json({error:"Hoja o lote de filas inválidos"},400);
  }
  if(archiveRows && (!Number.isInteger(input.anio)||Number(input.anio)<2026||
      typeof input.cargo!=="string"||!/^\d{1,7}A?$/.test(input.cargo)))return json({error:"Cargo inválido para respaldo"},400);
  const service=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")||JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS")||"{}").default;
  const base=Deno.env.get("SUPABASE_URL");
  if(!service||!base)return json({error:"Receptor sin configuración de base de datos"},503);
  const method=probe?"kardex_live_source_probe":archive?"kardex_live_archive":archiveRows?"kardex_live_guardar_detalle":(reconcile?"kardex_live_reconcile":"kardex_live_ingest");
  const body=probe?{p_kind:"cargos",p_sheet_id:sheet,p_secret:secret}:archive?{p_sheet_id:sheet,p_secret:secret,p_anio:input.anio,p_cargo:input.cargo,p_codes:input.codes,p_backup_id:input.backup_id,p_rows:input.row_count}
                    :archiveRows?{p_sheet_id:sheet,p_secret:secret,p_anio:input.anio,p_cargo:input.cargo,p_filas:input.rows}
                    :{p_sheet_id:sheet,p_secret:secret,p_rows:input.rows};
  try{
    const resp=await fetch(base+"/rest/v1/rpc/"+method,{
      method:"POST",headers:{"Content-Type":"application/json","apikey":service,
        ...(service.startsWith("eyJ")?{"Authorization":"Bearer "+service}:{}),
        "Prefer":"return=representation"},
      body:JSON.stringify(body)
    });
    const raw=await resp.text();
    if(!resp.ok){
      const authFail=resp.status===401||resp.status===403;
      return json({error:authFail?"No autorizado o falta permiso de servicio":"Error de validación en Supabase",detalle:raw.slice(0,350)},authFail?401:422);
    }
    return new Response(raw,{status:200,headers:{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store"}});
  }catch(_err){return json({error:"No se pudo contactar la base de datos"},503)}
});
