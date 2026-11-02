import {parseScanPaste,validateScanRows,compareScanRows} from './scan-rows.js';
import {readScanWorkbook,SCAN_FILE_ROWS} from './scan-workbook.js';
const PREVIEW_BATCH=3000,UPLOAD_BATCH=400;
const split=(rows,size)=>Array.from({length:Math.ceil(rows.length/size)},(_,i)=>rows.slice(i*size,(i+1)*size));
export function attachScanImport({supabase,isAdmin,appReady,isPreview}){
  const byId=id=>document.getElementById(id);
  const paste=byId('scanPaste'),file=byId('scanFile'),validate=byId('scanValidate'),save=byId('scanSave'),
    status=byId('scanStatus'),summary=byId('scanSummary'),sample=byId('scanSample'),
    progress=byId('scanProgress'),stage=byId('scanStage');
  let candidate=[],reviewedSource='',busy=false,generation=0,plannedUpdates=0;
  const notice=(value,error=false)=>{status.textContent=value;status.style.color=error?'var(--red)':'var(--muted)';};
  const progressTo=(percent,label)=>{progress.hidden=false;progress.value=Math.max(0,Math.min(100,percent));stage.textContent=label;};
  const clear=()=>{
    if(busy)return;
    candidate=[];reviewedSource='';plannedUpdates=0;generation++;save.dataset.valid='';save.disabled=true;
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
      progressTo(4,'Abriendo Excel…');
      const parsed=await readScanWorkbook(file.files[0]);
      byId('scanFileName').textContent=parsed.fileName+' · Hoja «'+parsed.sheetName+'» · '+parsed.count.toLocaleString('es-PE')+' registros';
      return {rows:parsed.rows,source:'file:'+file.files[0].name+':'+file.files[0].size+':'+file.files[0].lastModified};
    }
    const rows=parseScanPaste(paste.value);
    byId('scanFileName').textContent='Datos pegados';
    return {rows,source:'paste:'+paste.value};
  };
  paste.addEventListener('input',()=>{
    if(busy)return;
    if(paste.value.trim()){file.value='';byId('scanFileName').textContent='Datos pegados';}
    clear();notice('Datos modificados. Valida nuevamente.');
  });
  file.addEventListener('change',()=>{
    if(busy)return;
    paste.value='';clear();
    byId('scanFileName').textContent=file.files?.[0]?file.files[0].name:'Selecciona un Excel';
    notice('Archivo listo para validar.');
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
      byId('scanUpdates').textContent='0';byId('scanUpdateCells').textContent='0';byId('scanConflicts').textContent='0';
      const table=document.createElement('table'),head=document.createElement('tr');
      for(const title of ['Fecha','Cargo','Grupo','Código']){const th=document.createElement('th');th.textContent=title;head.append(th);}table.append(head);
      for(const row of checked.ready.slice(0,8)){
        const tr=document.createElement('tr');for(const col of row.values.slice(0,4))td(tr,col);table.append(tr);
      }
      sample.append(table);
      if(checked.errors.length){
        progressTo(100,'Revisa las filas indicadas');
        const examples=checked.errors.slice(0,3).map(e=>'Fila '+e.line+': '+e.reason).join(' | ');
        return notice(checked.errors.length+' filas con errores. '+examples,true);
      }
      // Desduplicar TODO el archivo, sin confundir archivos distintos del mismo código.
      const local=compareScanRows(checked.ready,[]);
      candidate=local.newRows.map(x=>x.values);
      let accepted=0,updatable=0,updateCells=0,
        duplicates=local.duplicates.length,crossCargo=0,conflicts=local.conflicts.length;
      const issues=[...local.conflicts.map(x=>'Excel · fila '+x.line+': '+x.reason)];
      byId('scanDuplicates').textContent=String(duplicates);
      // Preview está aislado de la base productiva por configuración de seguridad.
      // Simular SOLO el Excel local; jamás afirmar que se cotejó la hoja oficial.
      if(isPreview()){
        byId('scanValid').textContent=String(candidate.length);
        byId('scanConflicts').textContent=String(conflicts);
        byId('scanUpdates').textContent='—';
        byId('scanUpdateCells').textContent='—';
        if(issues.length){
          const list=document.createElement('ul');
          for(const note of issues.slice(0,12)){
            const li=document.createElement('li');li.textContent=note;list.append(li);
          }
          sample.append(list);
        }
        save.disabled=true;
        progressTo(100,'Simulación local terminada, sin escrituras');
        return notice('PREVIEW: '+candidate.length+' documentos candidatos · '+duplicates
          +' repetidos dentro del Excel · '+conflicts+' conflictos locales. '
          +'Sin conexión a Google Sheets ni al histórico productivo; los cambios reales se determinarán en un entorno autorizado.',conflicts>0);
      }
      const groups=split(candidate,PREVIEW_BATCH);
      for(let i=0;i<groups.length;i++){
        progressTo(10+Math.round((i/Math.max(1,groups.length))*85),
          'Contrastando '+((i*PREVIEW_BATCH)+1)+'–'+Math.min(candidate.length,(i+1)*PREVIEW_BATCH)+' con Google Sheets y el histórico…');
        const result=await api('preview',groups[i]);
        accepted+=result.accepted;
        updatable+=result.updates||0;
        updateCells+=result.updateCells||0;
        duplicates+=(result.duplicates||[]).length;
        crossCargo+=(result.otherCargos||[]).length;
        conflicts+=(result.conflicts||[]).length;
        for(const c of (result.conflicts||[]).slice(0,8))if(issues.length<12)
          issues.push('Revisión · fila '+c.line+': '+c.reason);
        for(const u of (result.changes||[]).slice(0,5))if(issues.length<12)
          issues.push('Completar · fila '+u.line+' → hoja '+u.rowNumber+': '+u.fields.join(', '));
      }
      byId('scanValid').textContent=String(accepted);
      byId('scanDuplicates').textContent=String(duplicates);
      byId('scanCrossCargo').textContent=String(crossCargo);
      byId('scanUpdates').textContent=String(updatable);
      byId('scanUpdateCells').textContent=String(updateCells);
      byId('scanConflicts').textContent=String(conflicts);
      if(issues.length){
        const heading=document.createElement('p');
        heading.textContent='Observaciones y cambios propuestos (muestra):';
        sample.append(heading);
        const ul=document.createElement('ul');
        for(const note of issues){const li=document.createElement('li');li.textContent=note;ul.append(li);}
        sample.append(ul);
      }
      plannedUpdates=updatable;
      reviewedSource=source.source;
      save.dataset.valid=(accepted+updatable>0&&conflicts===0&&!isPreview())?'1':'';
      save.disabled=accepted+updatable===0||conflicts>0||isPreview();
      progressTo(100,'Validación y conciliación completas');
      const label=accepted+' nuevos · '+updatable+' existentes para completar ('+updateCells+' celdas) · '
        +duplicates+' idénticos · '+conflicts+' para revisar';
      notice(label+(isPreview()?' · Simulación: no se escribirá en Google Sheets.'
        :conflicts?' · Corrige los conflictos antes de confirmar.'
        :accepted+updatable?' · Listo para confirmar.':' · Sin cambios pendientes.'),conflicts>0);
    }catch(error){
      candidate=[];save.dataset.valid='';save.disabled=true;
      progressTo(0,'No se guardó ningún registro en esta validación');
      notice(error?.message||'Error al abrir o validar el Excel.',true);
    }finally{busy=false;file.disabled=false;validate.disabled=false;}
  });
  save.addEventListener('click',async()=>{
    if(busy||isPreview()||!appReady()||!isAdmin()||!reviewedSource||!(candidate.length||plannedUpdates))return notice('Valida primero el Excel antes de guardar.',true);
    const sourceNow=file.files?.length
      ?'file:'+file.files[0].name+':'+file.files[0].size+':'+file.files[0].lastModified
      :'paste:'+paste.value;
    if(sourceNow!==reviewedSource)return notice('El archivo cambió. Repite la validación.',true);
    if(!confirm('¿Confirmas los cambios verificados en CARGOS NUEVOS? '+candidate.length.toLocaleString('es-PE')+' filas revisadas; '+plannedUpdates+' registros podrían completar campos vacíos. Nunca se reemplazarán celdas ocupadas.'))return;
    busy=true;save.disabled=true;save.dataset.valid='';validate.disabled=true;file.disabled=true;paste.disabled=true;
    let saved=0,updated=0,duplicates=0,processed=0;const groups=split(candidate,UPLOAD_BATCH);
    progressTo(0,'Iniciando carga por lotes…');
    try{
      for(let i=0;i<groups.length;i++){
        progressTo(Math.floor(100*i/groups.length),'Procesando lote '+(i+1)+' de '+groups.length+' — '+processed+' de '+candidate.length+' filas revisadas');
        const result=await api('commit',groups[i]);
        if(result.googleVerified!==true)throw Error('El lote '+(i+1)+' no devolvió confirmación verificable.');
        saved+=result.saved;updated+=result.updated||0;duplicates+=result.duplicates.length;processed+=groups[i].length;
        progressTo(Math.floor(100*(i+1)/groups.length),'Confirmadas '+processed.toLocaleString('es-PE')+' de '+candidate.length.toLocaleString('es-PE')+' filas · '+saved+' nuevas');
        byId('scanReceipt').textContent='Progreso confirmado: '+saved+' nuevas, '+updated+' completadas, '+duplicates+' idénticas, '+processed+' revisadas.';
      }
      candidate=[];reviewedSource='';
      paste.value='';file.value='';byId('scanFileName').textContent='Selecciona un Excel';
      progressTo(100,'Carga terminada y confirmada en Google Sheets');
      notice(saved.toLocaleString('es-PE')+' nuevos registros · '+updated+' completados · '+duplicates+' idénticos. Actualización del Kárdex pendiente de sincronización.');
    }catch(error){
      progressTo(Math.floor(100*processed/candidate.length),'Proceso interrumpido tras '+processed+' filas revisadas');
      notice('Carga parcial o pendiente de conciliación. Lotes confirmados: '+processed+' filas, '+saved+' nuevas. '+(error?.message||'Error de red')+' Conserva el Excel: valida de nuevo antes de cualquier reintento.',true);
    }finally{busy=false;validate.disabled=false;file.disabled=false;paste.disabled=false;}
  });
  clear();
  notice('');
}
