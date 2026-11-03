import {parseScanPaste,validateScanRows} from './scan-rows.js';
import {readScanWorkbook,SCAN_FILE_ROWS} from './scan-workbook.js';
import {planCargoImport} from './scan-cargo-plan.js';

export function attachScanImport({supabase,isAdmin,appReady,isPreview,onCompleted=async()=>{}}){
  const byId=id=>document.getElementById(id);
  const paste=byId('scanPaste'),file=byId('scanFile'),validate=byId('scanValidate'),save=byId('scanSave'),
    status=byId('scanStatus'),summary=byId('scanSummary'),sample=byId('scanSample'),
    progress=byId('scanProgress'),stage=byId('scanStage');
  let plan=null,reviewedSource='',busy=false,generation=0,droppedFile=null;
  const chosenFile=()=>droppedFile||file.files?.[0]||null;
  const resultStatus=byId('scanResultStatus');
  const notice=(value,error=false)=>{
    status.textContent=value;status.style.color=error?'var(--red)':'var(--muted)';
    if(resultStatus){
      resultStatus.hidden=!value;
      resultStatus.textContent=value;
      resultStatus.style.color=error?'var(--red)':'var(--muted)';
    }
  };
  const autoValidate=()=>{
    // La selección NO guarda nada: solo identifica cargos nuevos.
    Promise.resolve().then(()=>{
      if(!busy&&chosenFile()&&appReady()&&isAdmin())validate.click();
    });
  };
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
  const localPreview=(ready)=>{
    const found=new Map();
    for(const item of ready){
      const cargo=Number(item.cargo);
      if(item.iso.slice(0,4)!=='2026'||!Number.isSafeInteger(cargo)||cargo<942)continue;
      const group=found.get(cargo)||{cargo,rows:[],codes:new Set(),
        missing:{original:true,depurado:true},count:0};
      group.rows.push(item.values);group.count++;
      group.codes.add(item.codigo.replace(/[^A-Za-z0-9]/g,'').toUpperCase());
      found.set(cargo,group);
    }
    const cargos=[...found.values()].sort((a,b)=>a.cargo-b.cargo)
      .map(group=>({...group,codes:group.codes.size}));
    return {cargos,newRows:cargos.reduce((n,g)=>n+g.count,0),
      ignoredRows:ready.length-cargos.reduce((n,g)=>n+g.count,0),invalid:[]};
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
    notice('Archivo recibido. Buscando cargos nuevos…');
    autoValidate();
  });
  byId('ivDropzone')?.addEventListener('scan:file-dropped',event=>{
    if(busy)return notice('Finaliza la validación actual antes de cambiar de archivo.',true);
    const selected=event.detail?.file;
    if(!selected||!/\.(xlsx|xlsm)$/i.test(selected.name||'')||
      !Number.isSafeInteger(selected.size)||selected.size<1||selected.size>500*1024**2)return;
    file.value='';paste.value='';
    droppedFile=selected;clear();
    byId('scanFileName').textContent=selected.name;
    notice('Excel recibido. Buscando cargos nuevos…');
    event.detail.accepted=true;
    autoValidate();
  });
  validate.addEventListener('click',async()=>{
    if(busy)return;
    clear();
    summary.hidden=false;
    sample.textContent='Analizando el Excel para encontrar los cargos posteriores al 941…';
    if(!appReady()||!isAdmin())
      return notice('Necesitas iniciar sesión como administrador para validar el archivo.',true);
    const epoch=generation;busy=true;validate.disabled=true;file.disabled=true;
    let previewShown=false;
    try{
      // Leer PRIMERO el archivo elegido: no bloquear Resultados por los Excel
      // maestros de Drive (que pesan 32 y 64 MB).
      progressTo(8,'Leyendo el Excel seleccionado (solo cargos nuevos)…');
      const source=await getInput(941),rows=source.rows;
      if(generation!==epoch)return;
      progressTo(45,'Se encontraron '+rows.length.toLocaleString('es-PE')+' filas candidatas.');
      if(rows.length===0){
        showPlan({cargos:[],newRows:0,ignoredRows:0,invalid:[]});
        progressTo(100,'Sin cargos posteriores al 941');
        return notice('No se detectaron cargos posteriores al 941 en el archivo. No se guardó nada.');
      }
      const checked=validateScanRows(rows,SCAN_FILE_ROWS);
      if(checked.errors.length){
        byId('scanTotal').textContent=String(rows.length);
        byId('scanValid').textContent=String(checked.ready.length);
        byId('scanErrors').textContent=String(checked.errors.length);
        byId('scanDuplicates').textContent='0';byId('scanCrossCargo').textContent='0';
        sample.replaceChildren();
        const list=document.createElement('div');
        list.textContent=checked.errors.slice(0,5).map(e=>'Fila '+e.line+': '+e.reason).join(' | ');
        sample.append(list);
        progressTo(100,'Datos del Excel por corregir');
        return notice(checked.errors.length+' filas con errores. No se modificó ningún Excel.',true);
      }
      const provisional=localPreview(checked.ready);
      showPlan(provisional);
      previewShown=true;
      progressTo(60,'Cargos detectados: '+provisional.cargos.map(g=>g.cargo).join(', ')+'.');
      notice(provisional.cargos.length+' cargos detectados provisionalmente. Verificando permisos e índice antes de confirmar…');
      // Validación remota ligera: únicamente IDs de los dos Excel y el índice
      // de los cargos; el contenido completo se verifica al confirmar.
      const masters=await api(null,'GET');
      if(generation!==epoch)return;
      progressTo(85,'Contrastando cargos contra los dos históricos…');
      const proposed=planCargoImport(checked.ready,masters);
      if(proposed.invalid.length){
        const first=proposed.invalid[0];
        progressTo(100,'Revisión requerida');
        return notice('Fila '+first.line+': '+first.reason+' No se guardó nada.',true);
      }
      if(proposed.cargos.some(g=>g.count>15000)){
        progressTo(100,'Revisión requerida');
        return notice('Un cargo supera 15.000 filas nuevas. Divide el archivo por cargos.',true);
      }
      plan=proposed;showPlan(plan);
      reviewedSource=source.source;
      save.dataset.valid=plan.cargos.length>0&&!isPreview()&&masters.writesEnabled?'1':'';
      save.disabled=plan.cargos.length===0||isPreview()||!masters.writesEnabled;
      progressTo(100,'Validación terminada');
      notice(plan.cargos.length+' cargos nuevos encontrados · '+plan.newRows.toLocaleString('es-PE')+
        ' filas · '+plan.ignoredRows+' existentes omitidas. '+
        (isPreview()?'Vista de prueba; sin escritura.':
          !masters.writesEnabled?'No se permite confirmar en este entorno.':
          plan.cargos.length?'Puedes revisar y pulsar Confirmar carga.':'No hay cargos nuevos.'));
    }catch(error){
      plan=null;reviewedSource='';save.dataset.valid='';save.disabled=true;
      progressTo(100,previewShown?'Verificación pendiente':'No se pudo leer o validar el Excel');
      if(!previewShown&&sample.textContent.startsWith('Analizando'))sample.textContent='No fue posible leer el archivo.';
      notice((previewShown?'Los cargos visibles son preliminares; no están autorizados para guardar. ':
        'No se pudo generar el resultado. ')+(error?.message||'Error al validar')+
        ' No se modificó ninguno de los dos Excel.',true);
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
    }finally{
      // Refrescar el Resumen solo después de guardar e indexar realmente.
      // Un fallo visual no debe tratarse como fallo de la carga ya persistida.
      if(completed>0){
        try{await onCompleted({cargos:completed,filas:saved});}
        catch{
          notice('Se confirmaron '+completed+' cargos, pero no se pudo actualizar el Resumen. '+
            'Recarga la página para ver el nuevo total. No repitas la carga sin validar.',true);
        }
      }
      busy=false;validate.disabled=false;file.disabled=false;paste.disabled=false;
    }
  });
  clear();notice('');
}
