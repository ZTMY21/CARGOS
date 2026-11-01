import {parseScanPaste,validateScanRows,compareScanRows} from './scan-rows.js';
export function attachScanImport({supabase,isAdmin,appReady,isPreview}){
  const byId=id=>document.getElementById(id);
  const paste=byId('scanPaste'),validate=byId('scanValidate'),save=byId('scanSave'),
    status=byId('scanStatus'),summary=byId('scanSummary'),sample=byId('scanSample');
  let parsed=[],reviewedText='';
  const notice=(value,error=false)=>{status.textContent=value;status.style.color=error?'var(--red)':'var(--muted)';};
  const clear=()=>{parsed=[];reviewedText='';save.dataset.valid='';save.disabled=true;summary.hidden=true;sample.replaceChildren();};
  const td=(row,value)=>{const cell=document.createElement('td');cell.textContent=String(value??'');row.append(cell);};
  const api=async(action,rows)=>{
    const token=(await supabase.auth.getSession()).data?.session?.access_token;
    if(!token)throw Error('Debes iniciar sesión.');
    const req=action==='status'?{method:'GET'}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action,rows})};
    const response=await fetch('/api/scan-ingest',{...req,headers:{...req.headers,Authorization:'Bearer '+token},credentials:'same-origin'});
    const data=await response.json().catch(()=>({}));
    if(!response.ok){if(data.error==='FILAS_INVALIDAS'&&data.errors?.length)throw Error('Fila '+data.errors[0].line+': '+data.errors[0].reason);throw Error((data.message||data.error||'Error al verificar la fuente')+'. No se ha confirmado una nueva carga.');}
    return data;
  };
  paste.addEventListener('input',()=>{clear();notice('Pega los registros y pulsa Validar.');});
  validate.addEventListener('click',async()=>{
    clear();
    if(!appReady()||!isAdmin())return notice('Acceso reservado a administradores.',true);
    try{
      parsed=parseScanPaste(paste.value);
      const checked=validateScanRows(parsed);
      summary.hidden=false;byId('scanTotal').textContent=String(parsed.length);
      byId('scanValid').textContent=String(checked.ready.length);
      byId('scanErrors').textContent=String(checked.errors.length);
      const table=document.createElement('table'),head=document.createElement('tr');
      for(const title of ['Fecha','Cargo','Grupo','Código']){const th=document.createElement('th');th.textContent=title;head.append(th);}table.append(head);
      for(const row of checked.ready.slice(0,8)){const tr=document.createElement('tr');for(const col of row.values.slice(0,4))td(tr,col);table.append(tr);}sample.append(table);
      if(checked.errors.length)return notice('Revisar fila '+checked.errors[0].line+': '+checked.errors[0].reason,true);
      if(isPreview())return notice('Vista previa aislada: validación local correcta. El guardado está bloqueado.',false);
      validate.disabled=true;notice('Contrastando contra la hoja original…');
      const server=await api('preview',parsed);
      byId('scanValid').textContent=String(server.accepted);
      byId('scanDuplicates').textContent=String(server.duplicates.length);
      byId('scanCrossCargo').textContent=String(server.otherCargos.length);
      reviewedText=paste.value;
      save.dataset.valid=server.accepted>0?'1':'';
      save.disabled=server.accepted===0;
      notice(server.accepted+' registros nuevos; '+server.duplicates.length+' ya registrados. '+(server.otherCargos.length?'Hay '+server.otherCargos.length+' coincidencias en otros cargos; no se eliminarán.':'Listo para confirmar.'));
    }catch(error){save.disabled=true;notice(error?.message||'No se pudo validar.',true);}
    finally{validate.disabled=false;}
  });
  save.addEventListener('click',async()=>{
    if(isPreview()||!appReady()||!isAdmin()||!reviewedText||reviewedText!==paste.value||!parsed.length)return notice('Vuelve a validar antes de guardar.',true);
    if(!confirm('¿Confirmas agregar las filas nuevas a CARGOS NUEVOS? Las coincidencias exactas se omiten y la sincronización con Kárdex se verificará por separado.'))return;
    save.dataset.valid='';save.disabled=true;validate.disabled=true;notice('Guardando directamente en Google Sheets…');
    try{
      const result=await api('commit',parsed);
      if(result.googleVerified){
        reviewedText='';parsed=[];
        notice('Guardadas y verificadas '+result.saved+' filas en Google Sheets. '+result.duplicates.length+' ya estaban registradas. Pendiente de confirmación en Kárdex mediante la sincronización existente.');
        byId('scanReceipt').textContent='Último registro: '+result.saved+' filas · '+(result.updatedRange||'sin filas nuevas')+' · '+new Date().toLocaleString('es-PE');
        paste.value='';sample.replaceChildren();
      }else notice('No se pudo comprobar la escritura. Revisa el resultado antes de repetir.',true);
    }catch(error){notice(error?.message||'No se pudo confirmar el guardado. No repitas el envío sin comprobar el estado.',true);}
    finally{validate.disabled=false;}
  });
  clear();
  notice('Formato: Fecha · Cargo · Grupo · Código. Puedes pegar también las columnas E–K del Excel original.');
}
