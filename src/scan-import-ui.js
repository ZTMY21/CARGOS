import {parseScanPaste,validateScanRows,compareScanRows} from './scan-rows.js';
import {readScanWorkbook,SCAN_FILE_ROWS} from './scan-workbook.js';
const PREVIEW_BATCH=3000,UPLOAD_BATCH=400;
const split=(rows,size)=>Array.from({length:Math.ceil(rows.length/size)},(_,i)=>rows.slice(i*size,(i+1)*size));
export function attachScanImport({supabase,isAdmin,appReady,isPreview}){
  const byId=id=>document.getElementById(id);
  const paste=byId('scanPaste'),file=byId('scanFile'),validate=byId('scanValidate'),save=byId('scanSave'),
    status=byId('scanStatus'),summary=byId('scanSummary'),sample=byId('scanSample'),
    progress=byId('scanProgress'),stage=byId('scanStage');
  let candidate=[],reviewedSource='',busy=false,generation=0;
  const notice=(value,error=false)=>{status.textContent=value;status.style.color=error?'var(--red)':'var(--muted)';};
  const progressTo=(percent,label)=>{progress.hidden=false;progress.value=Math.max(0,Math.min(100,percent));stage.textContent=label;};
  const clear=()=>{
    if(busy)return;
    candidate=[];reviewedSource='';generation++;save.dataset.valid='';save.disabled=true;
    summary.hidden=true;sample.replaceChildren();byId('scanReceipt').textContent='';progress.hidden=true;stage.textContent='';
  };
  const td=(row,value)=>{const cell=document.createElement('td');cell.textContent=String(value??'');row.append(cell);};
  const api=async(action,rows)=>{
    const {data,error}=await supabase.auth.getSession();
    if(error||!data?.session?.access_token)throw Error('Debes iniciar sesión nuevamente.');
    const response=await fetch('/api/scan-ingest',{
      method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+data.session.access_token},
      credentials:'same-origin',body:JSON.stringify({action,rows})});
    const dataOut=await response.json().catch(()=>({}));
    if(!response.ok){
      if(dataOut.error==='FILAS_INVALIDAS'&&dataOut.errors?.length)
        throw Error('Fila '+dataOut.errors[0].line+': '+dataOut.errors[0].reason);
      throw Error((dataOut.message||dataOut.error||'No fue posible validar contra Google Sheets')+'. No repitas una carga incompleta sin revisar los registros.');
    }
    return dataOut;
  };
  const getInput=async()=>{
    if(file.files?.length){
      progressTo(4,'Leyendo Excel localmente…');
      const parsed=await readScanWorkbook(file.files[0]);
      byId('scanFileName').textContent=parsed.fileName+' · Hoja «'+parsed.sheetName+'» · '+parsed.count.toLocaleString('es-PE')+' registros';
      return {rows:parsed.rows,source:'file:'+file.files[0].name+':'+file.files[0].size+':'+file.files[0].lastModified};
    }
    const rows=parseScanPaste(paste.value);
    byId('scanFileName').textContent='Modo copiar y pegar';
    return {rows,source:'paste:'+paste.value};
  };
  paste.addEventListener('input',()=>{
    if(busy)return;
    if(paste.value.trim()){file.value='';byId('scanFileName').textContent='Modo copiar y pegar';}
    clear();notice('Datos modificados. Vuelve a validar antes de guardar.');
  });
  file.addEventListener('change',()=>{
    if(busy)return;
    paste.value='';clear();
    byId('scanFileName').textContent=file.files?.[0]?file.files[0].name:'No se ha seleccionado un Excel';
    notice('Archivo seleccionado. Pulsa «Validar Excel» para revisar todas las líneas.');
  });
  validate.addEventListener('click',async()=>{
    if(busy)return;
    clear();
    if(!appReady()||!isAdmin())return notice('Acceso reservado a administradores.',true);
    const epoch=generation;busy=true;validate.disabled=true;file.disabled=true;
    try{
      const source=await getInput(),rows=source.rows;
      if(generation!==epoch)return;
      progressTo(10,'Verificando '+rows.length.toLocaleString('es-PE')+' filas…');
      const checked=validateScanRows(rows,SCAN_FILE_ROWS);
      summary.hidden=false;
      byId('scanTotal').textContent=String(rows.length);
      byId('scanValid').textContent=String(checked.ready.length);
      byId('scanErrors').textContent=String(checked.errors.length);
      byId('scanDuplicates').textContent='0';byId('scanCrossCargo').textContent='0';
      const table=document.createElement('table'),head=document.createElement('tr');
      for(const title of ['Fecha','Cargo','Grupo','Código']){const th=document.createElement('th');th.textContent=title;head.append(th);}table.append(head);
      for(const row of checked.ready.slice(0,8)){
        const tr=document.createElement('tr');for(const col of row.values.slice(0,4))td(tr,col);table.append(tr);
      }
      sample.append(table);
      if(checked.errors.length){
        progressTo(100,'Validación detenida por errores');
        const examples=checked.errors.slice(0,3).map(e=>'Fila '+e.line+': '+e.reason).join(' | ');
        return notice(checked.errors.length+' filas contienen errores. '+examples+' Corrige el Excel y vuelve a cargarlo.',true);
      }
      // Desduplicar TODO el archivo antes de dividirlo: dos bloques nunca reenvían el mismo registro.
      const local=compareScanRows(checked.ready,[]);
      candidate=local.newRows.map(x=>x.values);
      let accepted=0,duplicates=local.duplicates.length,crossCargo=0;
      byId('scanDuplicates').textContent=String(duplicates);
      if(isPreview()){
        byId('scanValid').textContent=String(candidate.length);
        progressTo(100,'Vista previa aislada, sin escritura');
        return notice('Excel validado localmente: '+candidate.length+' filas. En Preview no se permite modificar la hoja real.');
      }
      const groups=split(candidate,PREVIEW_BATCH);
      for(let i=0;i<groups.length;i++){
        progressTo(10+Math.round((i/groups.length)*85),'Contrastando '+((i*PREVIEW_BATCH)+1)+'–'+Math.min(candidate.length,(i+1)*PREVIEW_BATCH)+' con la hoja oficial…');
        const result=await api('preview',groups[i]);
        accepted+=result.accepted;duplicates+=result.duplicates.length;crossCargo+=result.otherCargos.length;
      }
      byId('scanValid').textContent=String(accepted);
      byId('scanDuplicates').textContent=String(duplicates);
      byId('scanCrossCargo').textContent=String(crossCargo);
      reviewedSource=source.source;
      save.dataset.valid=accepted>0?'1':'';
      save.disabled=accepted===0;
      progressTo(100,'Validación completa');
      notice(accepted.toLocaleString('es-PE')+' registros nuevos; '+duplicates+' duplicados exactos. '+crossCargo+' coincidencias con otros cargos (se conservan). '+(accepted?'Puedes confirmar la carga.':'No hay registros nuevos que guardar.'));
    }catch(error){
      candidate=[];save.dataset.valid='';save.disabled=true;
      progressTo(0,'No se guardó ningún registro en esta validación');
      notice(error?.message||'Error al abrir o validar el Excel.',true);
    }finally{busy=false;file.disabled=false;validate.disabled=false;}
  });
  save.addEventListener('click',async()=>{
    if(busy||isPreview()||!appReady()||!isAdmin()||!reviewedSource||!candidate.length)return notice('Valida primero el Excel antes de guardar.',true);
    const sourceNow=file.files?.length
      ?'file:'+file.files[0].name+':'+file.files[0].size+':'+file.files[0].lastModified
      :'paste:'+paste.value;
    if(sourceNow!==reviewedSource)return notice('El archivo cambió. Repite la validación.',true);
    if(!confirm('¿Confirmas enviar hasta '+candidate.length.toLocaleString('es-PE')+' filas a la hoja CARGOS NUEVOS? Se omiten los códigos ya registrados. Los datos históricos no se reemplazan.'))return;
    busy=true;save.disabled=true;save.dataset.valid='';validate.disabled=true;file.disabled=true;paste.disabled=true;
    let saved=0,duplicates=0,processed=0;const groups=split(candidate,UPLOAD_BATCH);
    progressTo(0,'Iniciando carga por lotes…');
    try{
      for(let i=0;i<groups.length;i++){
        progressTo(Math.floor(100*i/groups.length),'Procesando lote '+(i+1)+' de '+groups.length+' — '+processed+' de '+candidate.length+' filas revisadas');
        const result=await api('commit',groups[i]);
        if(result.googleVerified!==true)throw Error('El lote '+(i+1)+' no devolvió confirmación verificable.');
        saved+=result.saved;duplicates+=result.duplicates.length;processed+=groups[i].length;
        progressTo(Math.floor(100*(i+1)/groups.length),'Confirmadas '+processed.toLocaleString('es-PE')+' de '+candidate.length.toLocaleString('es-PE')+' filas · '+saved+' nuevas');
        byId('scanReceipt').textContent='Progreso confirmado: '+saved+' nuevas, '+duplicates+' ya registradas, '+processed+' revisadas.';
      }
      candidate=[];reviewedSource='';
      paste.value='';file.value='';byId('scanFileName').textContent='No se ha seleccionado un Excel';
      progressTo(100,'Carga terminada y confirmada en Google Sheets');
      notice('Carga terminada: '+saved.toLocaleString('es-PE')+' filas nuevas verificadas y '+duplicates+' ya registradas. La sincronización del Kárdex se confirma aparte mediante la rutina existente.');
    }catch(error){
      progressTo(Math.floor(100*processed/candidate.length),'Proceso interrumpido tras '+processed+' filas revisadas');
      notice('Carga parcial o pendiente de conciliación. Lotes confirmados: '+processed+' filas, '+saved+' nuevas. '+(error?.message||'Error de red')+' Conserva el Excel: valida de nuevo antes de cualquier reintento.',true);
    }finally{busy=false;validate.disabled=false;file.disabled=false;paste.disabled=false;}
  });
  clear();
  notice('Sube un Excel (.xlsx / .xlsm), valida todas sus filas y confirma. La opción de pegar registros sigue disponible.');
}
