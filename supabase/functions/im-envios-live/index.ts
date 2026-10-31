import "jsr:@supabase/functions-js/edge-runtime.d.ts";
const SHEETS=new Set(["1aWqIoj5UXAeyKhNN1paoYnTa4jdfN8LhDEcdH_lQ4mk","1VWmKFmE8UcXV6ukG8k-wqKqCzuJbPGYOf9RFowojhSw"]);
const json=(x:unknown,status=200)=>new Response(JSON.stringify(x),{status,headers:{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store"}});
Deno.serve(async(req)=>{
 if(req.method!=="POST")return json({error:"Método no permitido"},405);
 if(Number(req.headers.get("content-length")||"0")>700000)return json({error:"Solicitud demasiado grande"},413);
 const secret=req.headers.get("X-IM-Token")||"";
 if(secret.length<40||secret.length>160)return json({error:"Credencial de integración requerida"},401);
 let body:any;
 try{body=await req.json()}catch{return json({error:"JSON incorrecto"},400)}
 const probe=body?.mode==="probe";
 if(!SHEETS.has(body?.sheet_id)||(!probe&&(!Array.isArray(body?.rows)||body.rows.length>1200)))
 return json({error:"Hoja o datos no válidos"},400);
 const service=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")
 ||JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS")||"{}").default;
 const base=Deno.env.get("SUPABASE_URL");
 if(!service||!base)return json({error:"Receptor no configurado"},503);
 try{
  const res=await fetch(base+"/rest/v1/rpc/"+(probe?"kardex_live_source_probe":"im_sync_new_shipments"),{
    method:"POST",
    headers:{"Content-Type":"application/json","apikey":service,
      ...(service.startsWith("eyJ")?{"Authorization":"Bearer "+service}:{}),
      "Prefer":"return=representation"},
    body:JSON.stringify(probe?{p_kind:"im",p_sheet_id:body.sheet_id,p_secret:secret}:{p_sheet_id:body.sheet_id,p_secret:secret,p_rows:body.rows})
  });
  const raw=await res.text();
  if(!res.ok){
    const detail=(()=>{try{return JSON.parse(raw).message||JSON.parse(raw).details||""}catch{return ""}})();
    return json({error:"La actualización de envíos fue rechazada",detalle:String(detail).slice(0,250)},422);
  }
  return new Response(raw,{status:200,headers:{"Content-Type":"application/json","Cache-Control":"no-store"}});
 }catch(_e){return json({error:"No se pudo consultar Supabase"},503)}
});
