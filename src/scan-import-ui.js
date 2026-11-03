import {parseScanPaste,validateScanRows} from './scan-rows.js';
import {readScanWorkbook,SCAN_FILE_ROWS} from './scan-workbook.js';
import {planCargoImport} from './scan-cargo-plan.js';

export function attachScanImport({supabase,isAdmin,appReady,isPreview}){
  const byId=id=>document.getElementById(id);
  const paste=byId('scanPaste'),file=byId('scanFile'),validate=byId('scanValidate'),save=byId('scanSave'),
    status=byId('scanStatus'),summary=byId('scanSummary'),sample=byId('scanSample'),
    progress=byId('scanProgress'),stage=byId('scanStage');
  let plan=null,reviewedSource='',busy=false,generation=0,droppedFile=null;
  const chosenFile=()=>droppedFile||file.files?.[0]||null;
  const notice=(value,error=false)=>{status.textContent=value;status.style.color=error?'var(--red)':'var(--muted)';};
  const progressTo=(percent,label)=>{progress.hidden=false;progress.value=Math.max(0,Math.min(100,percent));stage.textContent=label;};
  const clear=()=>{
    if(busy)return;
    plan=null;reviewedSource='';generation++;save.dataset.valid='';save.disabled=true;
    summary.hidden=true;sample.replaceChildren();byId('scanReceipt').textContent='';progress.hidden=true;stage.textContent='';
  };
  const cell=(tr,value)=>{const td=document.createElement('td');td.textContent=String(value??'');tr.append(td);};
  const sourceId=()=>{
    const selected=chosenFile();
    return selected?'file:'+selected.name+':'+selected.size+':'+selected.lastModified
      :'paste:'+paste.value;
  };
  const api=async(body,method='POST')=>{
    if(isPreview()&&method==='GET'){
      return {year:2026,original:{lastCargo:941,cargos:[941],name:'Original (simulación)'},
        depurado:{lastCargo:941,cargos:[941],name:'Depurado (simulación)'},writesEnabled:false,preview:true};
    }
    const {data,error}=await supabase.auth.getSession();
    if(error||!data?.session?.access_token)throw Error('Debes iniciar sesión nuevamente.');
    const url='/api/cargo-excel'+(method==='GET'?'?action=status':'');
    const response=await fetch(url,{method,headers:{
      Authorization:'Bearer '+data.session.access_token,
      ...(method==='POST'?{'Content-Type':'application/json'}:{})
    },credentials:'same-origin',body:method==='POST'?JSON.stringify(body):undefined});
    const result=await response.json().catch(()=>({}));
    if(!response.ok){
      if(result.error==='FILAS_INVALIDAS')throw Error('Hay filas inválidas en el cargo.');
      if(result.error==='ESCRITURA_PENDIENTE_DE_VERIFICACION')
        throw Error('Google Drive podría haber guardado el archivo. Valida nuevamente antes de continuar.');
      throw Error(result.message||result.error||'No se pudo verificar el almacenamiento.');
    }
    return result;
  };
  const getInput=async(baseline)=>{
    const selected=chosenFile();
    if(selected){
      progressTo(9,'Leyendo únicamente cargos desde el '+(baseline+1)+'…');
      const parsed=await readScanWorkbook(selected,{minCargo:baseline});
      byId('scanFileName').textContent=parsed.fileName+' · Hoja «'+parsed.sheetName+'» · '+
        parsed.count.toLocaleString('es-PE')+' filas candidatas';
      return {rows:parsed.rows,source:sourceId()};
    }
    const rows=parseScanPaste(paste.value);
    byId('scanFileName').textContent='Datos pegados';
    return {rows,source:sourceId()};
  };
  const showPlan=(current)=>{
    summary.hidden=false;
    byId('scanTotal').textContent=String(current.newRows+current.ignoredRows);
    byId('scanValid').textContent=String(current.newRows);
    byId('scanErrors').textContent=String(current.invalid.length);
    byId('scanDuplicates').textContent=String(current.ignoredRows);
    byId('scanCrossCargo').textContent=String(current.cargos.length);
    sample.replaceChildren();
    const table=document.createElement('table'),head=document.createElement('tr');
    for(const title of ['Cargo nuevo','Filas','Códigos distintos','Destino']){
      const th=document.createElement('th');th.textContent=title;head.append(th);
    }
    table.append(head);
    for(const group of current.cargos){
      const tr=document.createElement('tr');
      cell(tr,group.cargo);cell(tr,group.count);cell(tr,group.codes);
      cell(tr,group.missing.original&&group.missing.depurado?'Ambos Excel':
        group.missing.original?'Falta en histórico':'Falta en depurado');
      table.append(tr);
    }
    sample.append(table);
  };
  paste.addEventListener('input',()=>{
    if(busy)return;
    if(paste.value.trim()){
      droppedFile=null;file.value='';
      const zone=byId('ivDropzone');if(zone)delete zone.dataset.droppedFileName;
      byId('scanFileName').textContent='Datos pegados';
    }
    clear();notice('Datos modificados. Valida nuevamente.');
  });
  file.addEventListener('change',()=>{
    if(busy)return;
    droppedFile=null;
    paste.value='';clear();
    byId('scanFileName').textContent=chosenFile()?.name||'Selecciona un Excel';
    notice('Archivo listo. El aplicativo leerá solo los cargos que faltan.');
  });
  byId('ivDropzone')?.addEventListener('scan:file-dropped',event=>{
    if(busy)return notice('Finaliza la validación actual antes de cambiar de archivo.',true);
    const selected=event.detail?.file;
    if(!selected||!/\.(xlsx|xlsm)$/i.test(selected.name||'')||
      !Number.isSafeInteger(selected.size)||selected.size<1||selected.size>500*1024**2)return;
    file.value='';paste.value='';
    droppedFile=selected;clear();
    byId('scanFileName').textContent=selected.name;
    notice('Excel recibido. Pulsa «Validar y previsualizar» para ver los cargos nuevos.');
    event.detail.accepted=true;
  });
  validate.addEventListener('click',async()=>{
    if(busy)return;
    clear();
    if(!appReady()||!isAdmin())return notice('Acceso reservado a administradores.',true);
    const epoch=generation;busy=true;validate.disabled=true;file.disabled=true;
    try{
      progressTo(2,'Consultando los dos Excel maestros de Google Drive…');
      const masters=await api(null,'GET');
      if(generation!==epoch)return;
      const baseline=Math.min(masters.original.lastCargo,masters.depurado.lastCargo,masters.indexedLastCargo??941);
      const source=await getInput(baseline),rows=source.rows;
      if(generation!==epoch)return;
      progressTo(50,'Validando '+rows.length.toLocaleString('es-PE')+' filas candidatas…');
      if(rows.length===0){
        plan={cargos:[],newRows:0,ignoredRows:0,invalid:[]};
        showPlan(plan);progressTo(100,'Sin cargos nuevos');
        return notice('No se encontraron cargos nuevos posteriores al '+baseline+'.');
      }
      const checked=validateScanRows(rows,SCAN_FILE_ROWS);
      if(checked.errors.length){
        const message=checked.errors.slice(0,3).map(x=>'Fila '+x.line+': '+x.reason).join(' | ');
        progressTo(100,'Corrige las filas indicadas');
        return notice(checked.errors.length+' filas con errores. '+message,true);
      }
      const proposed=planCargoImport(checked.ready,masters);
      if(proposed.invalid.length){
        const first=proposed.invalid[0];
        progressTo(100,'Revisión requerida');
        return notice('Cargo incorrecto en fila '+first.line+': '+first.reason,true);
      }
      if(proposed.cargos.some(c=>c.count>15000)){
        progressTo(100,'Dividir el cargo');
        return notice('Un cargo tiene más de 15.000 filas nuevas. Divide esa carga antes de confirmarla.',true);
      }
      plan=proposed;showPlan(plan);
      reviewedSource=source.source;
      save.dataset.valid=plan.cargos.length>0&&!isPreview()?'1':'';
      save.disabled=plan.cargos.length===0||isPreview();
      progressTo(100,'Validación completa');
      notice(plan.cargos.length+' cargos nuevos encontrados · '+plan.newRows.toLocaleString('es-PE')+
        ' filas · '+plan.ignoredRows+' existentes omitidas. '+
        (isPreview()?'Simulación sin escritura.':plan.cargos.length?'Listo para confirmar.':'No hay cambios.'));
    }catch(error){
      plan=null;save.dataset.valid='';save.disabled=true;progressTo(0,'Validación interrumpida');
      notice(error?.message||'Error al leer o validar el Excel.',true);
    }finally{busy=false;file.disabled=false;validate.disabled=false;}
  });
  save.addEventListener('click',async()=>{
    if(busy||isPreview()||!appReady()||!isAdmin()||!plan?.cargos?.length||sourceId()!==reviewedSource)
      return notice('Debes validar el archivo antes de confirmar.',true);
    if(!confirm('¿Confirmas incorporar '+plan.cargos.length+' cargos nuevos ('+plan.newRows.toLocaleString('es-PE')+
      ' filas) a los DOS Excel históricos? No se modificarán cargos anteriores.'))return;
    busy=true;save.disabled=true;save.dataset.valid='';validate.disabled=true;file.disabled=true;paste.disabled=true;
    let saved=0,completed=0,partial=false;
    try{
      for(const group of plan.cargos){
        const steps=[...(['original','depurado'].filter(target=>group.missing[target])),'finalize'];
        for(let i=0;i<steps.length;i++){
          const action=steps[i]==='finalize'?'finalize':'commit';
          progressTo(Math.floor(100*completed/plan.cargos.length),
            'Cargo '+group.cargo+' — '+(action==='finalize'?'verificando índices':'actualizando '+steps[i])+'…');
          const result=await api({action,target:action==='commit'?steps[i]:undefined,cargo:group.cargo,rows:group.rows});
          if(result.verified!==true)throw Error('Falta la verificación de Drive para el cargo '+group.cargo+'.');
          if(action==='commit')partial=true;
          if(action==='finalize')partial=false;
        }
        saved+=group.count;completed++;
        byId('scanReceipt').textContent='Cargos completados: '+completed+'/'+plan.cargos.length+
          ' · Filas incorporadas: '+saved.toLocaleString('es-PE')+'.';
        progressTo(Math.floor(100*completed/plan.cargos.length),
          'Cargo '+group.cargo+' confirmado en ambos Excel y Kárdex');
      }
      plan=null;reviewedSource='';
      paste.value='';file.value='';droppedFile=null;
      const zone=byId('ivDropzone');if(zone)delete zone.dataset.droppedFileName;
      byId('scanFileName').textContent='Selecciona un Excel';
      progressTo(100,'Carga verificada en los dos históricos');
      notice('Se incorporaron '+completed+' cargos y '+saved.toLocaleString('es-PE')+
        ' filas en los dos Excel. El índice del Kárdex también quedó actualizado.');
    }catch(error){
      progressTo(Math.floor(100*completed/Math.max(1,plan.cargos.length)),'Carga pendiente de conciliación');
      notice((partial?'Un Excel puede haber sido actualizado. ':'')+
        'No se confirma la carga completa. '+(error?.message||'Error de conexión')+
        ' Conserva el Excel y vuelve a validar para recuperar el destino pendiente.',true);
    }finally{busy=false;validate.disabled=false;file.disabled=false;paste.disabled=false;}
  });
  clear();notice('');
}
