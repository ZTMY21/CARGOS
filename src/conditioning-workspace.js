import {escapeHtml,fmtDate,limaDate} from './rules.js';
import {physicalBoxKey} from './search.js';
import {drawBoxBarcode} from './box-code128.js';

const names={nueva:'Caja nueva',solicitada:'Caja solicitada',reparacion:'Reparación'};
const boxLabels={
  inexistente:'No se encontró una caja registrada con este código',
  ambiguo:'Se encontraron varias cajas con este número. Verifica el código',
  no_recibida:'La caja aún no tiene recepción física confirmada.',
  revisar_historico:'Revisa el envío original y los cargos en Histórico IM antes de continuar.',
  disponible:'Pendiente de preparación',observada:'La preparación anterior requiere revisión.',
  preparada:'Caja acondicionada'
};
const cargoLabels={
  disponible:'✓ Existe el cargo',inexistente:'✕ No existe el cargo',
  no_disponible:'El cargo existe, pero no está disponible.',ambiguo:'Hay más de un registro para este cargo.'
};
const date=value=>value?fmtDate(value):'—';
const badge=origin=>'<span class="acond-tag" data-origin="'+escapeHtml(origin)+'">'+escapeHtml(names[origin]||'—')+'</span>';

export function attachConditioningWorkspace({repository,live=false,onChanged=()=>{}}){
  const el=id=>document.getElementById(id);
  el('grp-acondicionamiento').querySelector('.group-body')
    .replaceWith(el('conditioningWorkspaceTemplate').content.cloneNode(true));
  const controls=el('grp-cajas').querySelector('.group-body');
  controls.append(el('conditioningControlTemplate').content.cloneNode(true));
  const excelLabel=live?'Excel Maestro':'Excel de prueba';
  if(live){
    controls.querySelector('[data-acond-download="maestro"]').textContent='Descargar Excel Maestro';
    controls.querySelector('[data-acond-download="historico"]').textContent='Descargar Histórico IM';
  }
  const scan=el('acondScan'),save=el('acondSave'),verified=el('acondVerified'),yearButtons=[...el('acondYears').children];
  const fields=[...el('acondCargoFields').children].map(row=>({
    input:row.querySelector('input'),button:row.querySelector('button'),feedback:row.querySelector('span')
  }));
  let selected=null,year=2026,active=false,busy=false,lookupVersion=0,listVersion=0,timer;
  let validations=Array(3).fill(null);
  const message=text=>{el('acondMessage').textContent=text;};
  const controlMessage=text=>{el('acondControlMessage').textContent=text;};
  const call=(action,data)=>repository.conditioning(action,data);
  const lookup=code=>call('buscar',{p_codigo:code});

  function mark(index,status=''){
    fields[index].feedback.dataset.status=status;
    fields[index].feedback.textContent=cargoLabels[status]||'';
  }
  function updateButtons(){
    const editing=selected?.status==='disponible'&&selected.origen==='nueva'&&!busy;
    const checking=selected?.status==='disponible'&&selected.origen==='solicitada';
    el('acondVerifiedLabel').hidden=!checking;
    verified.disabled=busy;
    const cargoHint=el('acondCargoHint');
    if(editing){
      cargoHint.textContent='Elige el año, ingresa hasta 3 cargos y presiona Enter o la flecha para validar cada uno.';
    }else if(selected?.origen==='solicitada'){
      cargoHint.textContent=selected.status==='no_recibida'
        ? 'Confirma la recepción en Control de cajas para verificar los cargos del Histórico IM.'
        : 'Los cargos del Histórico IM se muestran para consulta y verificación física.';
    }else if(selected?.codigo){
      cargoHint.textContent='Los campos se habilitan para cajas nuevas recibidas y pendientes de preparación.';
    }else{
      cargoHint.textContent='Primero consulta el código de una caja nueva recibida.';
    }
    const filled=fields.map(({input},i)=>[input.value.trim(),validations[i]]).filter(([value])=>value);
    for(const {input,button} of fields){input.readOnly=!editing;button.disabled=!editing;}
    save.disabled=busy||!(checking?verified.checked:editing&&filled.length>0&&
      filled.every(([value,result])=>result?.value===value&&result.status==='disponible'));
  }
  function chooseYear(next){
    year=next;
    for(const button of yearButtons)button.setAttribute('aria-pressed',String(Number(button.value)===year));
  }
  function select(record){
    selected=record;
    validations=Array(3).fill(null);
    verified.checked=false;
    if(record?.anios?.length===1)chooseYear(record.anios[0]);
    fields.forEach(({input},i)=>{
      input.value=record?.cargos?.[i]||'';
      mark(i,input.value?'disponible':'');
    });
    const extra=el('acondExtraCargos');
    extra.hidden=!(record?.cargos?.length>3);
    extra.textContent=extra.hidden?'':'Cargos adicionales: '+record.cargos.slice(3).join('-');
    const origin=el('acondBoxOrigin');
    origin.hidden=!record?.origen;
    origin.innerHTML=record?.origen?badge(record.origen):'';
    const details=[boxLabels[record?.status]];
    if(record?.origen==='solicitada'){
      if(record.anios?.length)details.push('Año: '+record.anios.join(', '));
      if(record.envio_original)details.push('Envío original: '+date(record.envio_original));
      if(record.solicitada)details.push('Solicitud: '+date(record.solicitada));
      if(record.recibida)details.push('Recepción: '+date(record.recibida));
    }
    el('acondBoxState').textContent=details.filter(Boolean).join(' · ');
    el('acondBarcodeCode').textContent=record?.codigo||'Escanea una caja';
    drawBoxBarcode(el('acondBarcode'),record?.codigo||'');
    if(record?.codigo)scan.value=record.codigo;
    updateButtons();
  }
  async function refresh(){
    const version=++listVersion;
    try{
      const data=await call('listar');
      if(!active||version!==listVersion)return;
      const total=data.nuevas+data.solicitadas,percent=total?Math.round(data.preparadas/total*100):0;
      el('acondNew').textContent=String(data.nuevas);
      el('acondRequested').textContent=String(data.solicitadas);
      el('acondPrepared').textContent=data.preparadas+' de '+total;
      el('acondProgress').value=percent;
      el('acondPercent').textContent=percent+'%';
      el('acondList').innerHTML=data.listado.map(row=>'<tr><td><strong>'+escapeHtml(row.codigo)+'</strong></td><td>'+
        badge(row.origen)+'</td><td>'+escapeHtml((row.cargos||[]).join('-'))+'</td><td>'+
        date(row.preparada)+'</td><td>'+escapeHtml(row.responsable||'—')+'</td></tr>').join('')
        ||'<tr><td colspan="5">Todavía no hay cajas preparadas.</td></tr>';
      el('acondRetry').hidden=!data.listado.some(row=>row.revision>row.sincronizada);
    }catch{if(active&&version===listVersion)message('No se pudieron consultar los indicadores. Revisa tu conexión.');}
  }
  async function sync(){
    try{
      for(let i=0;i<3;i++){
        const result=await repository.conditioningExcel('sincronizar');
        if(!result.verified)throw Error('No verificado');
        if(result.count<30){el('acondRetry').hidden=true;return true;}
      }
    }catch{}
    el('acondRetry').hidden=false;
    return false;
  }
  async function validate(index){
    const field=fields[index],value=field.input.value.trim(),box=selected,currentYear=year;
    if(!value||!box||field.input.readOnly)return;
    validations[index]=null;
    field.feedback.textContent='Validando…';
    updateButtons();
    const current=()=>box===selected&&year===currentYear&&field.input.value.trim()===value;
    try{
      const result=await call('cargo',{p_codigo:box.codigo,p_anio:year,p_cargos:[value]});
      if(!current())return;
      validations[index]={value,...result};
      mark(index,result.status);
      updateButtons();
    }catch{if(current())field.feedback.textContent='No se pudo validar. Reintenta.';}
  }
  for(const button of yearButtons)button.addEventListener('click',()=>{
    chooseYear(Number(button.value));
    if(selected?.origen==='nueva'&&selected.status==='disponible'){
      validations.fill(null);
      fields.forEach((_,i)=>mark(i));
      updateButtons();
    }
  });
  fields.forEach(({input,button},i)=>{
    input.addEventListener('input',()=>{validations[i]=null;mark(i);updateButtons();});
    input.addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();void validate(i);}});
    button.addEventListener('click',()=>void validate(i));
  });
  scan.addEventListener('input',()=>{lookupVersion++;select(null);});
  el('acondScanForm').addEventListener('submit',async event=>{
    event.preventDefault();
    if(busy)return;
    const code=scan.value,version=++lookupVersion;
    select(null);message('');
    if(!physicalBoxKey(code))return select({status:'inexistente'});
    el('acondBoxState').textContent='Consultando caja…';
    try{
      const record=await lookup(code);
      if(!active||version!==lookupVersion)return;
      select(record);
      if(record.codigo){scan.focus();scan.select();}
    }catch{if(version===lookupVersion)el('acondBoxState').textContent='No se pudo consultar la caja. Reintenta.';}
  });
  verified.addEventListener('change',()=>{
    message(verified.checked?'':'Si hay diferencias, verifica los cargos antes de continuar.');
    updateButtons();
  });
  save.addEventListener('click',async()=>{
    if(save.disabled)return;
    busy=true;updateButtons();message('Registrando preparación…');
    try{
      const record=await call('preparar',{p_codigo:selected.codigo,p_anio:year,
        p_cargos:fields.map(f=>f.input.value.trim()).filter(Boolean),p_datos:{verificada:verified.checked}});
      select({...record,status:'preparada'});
      const synced=await sync();
      message(synced?'Caja acondicionada y verificada en el '+excelLabel+'.':'Caja acondicionada. Sincronización pendiente.');
      await Promise.all([refresh(),onChanged()]);
    }catch(error){message(error.message||'No se pudo registrar la preparación.');}
    finally{busy=false;updateButtons();}
  });
  el('acondRetry').addEventListener('click',async()=>{
    message(await sync()?excelLabel+' verificado.':'La sincronización sigue pendiente.');
    await refresh();
  });
  const dispatch=el('acondDispatch');
  dispatch.elements.fecha.value=limaDate();
  for(const [form,action] of [[el('acondReceive'),'recibir'],[dispatch,'enviar']]){
    form.addEventListener('submit',async event=>{
      event.preventDefault();
      const button=form.querySelector('button');
      if(button.disabled)return;
      button.disabled=true;
      const data=Object.fromEntries(new FormData(form));
      try{
        if(!physicalBoxKey(data.codigo))throw Error(boxLabels.inexistente);
        const record=await lookup(data.codigo);
        if(action==='enviar'){
          if(!record.id)throw Error(boxLabels[record.status]||'Primero prepara la caja.');
          if(record.enviada)throw Error('El despacho ya está registrado.');
          await call(action,{p_datos:{...data,id:record.id}});
          controlMessage(await sync()?'Despacho verificado en el '+excelLabel+' y en el Histórico IM.':'Despacho registrado. Sincronización pendiente.');
        }else{
          if(record.status!=='no_recibida'||record.origen!=='solicitada')
            throw Error(record.recibida?'La caja ya está recepcionada.':boxLabels[record.status]);
          const received=await call(action,{p_codigo:record.codigo});
          if(!received.recibida)throw Error('No se pudo verificar la recepción.');
          controlMessage('Recepción física confirmada.');
        }
        form.elements.codigo.value='';
        await onChanged();
      }catch(error){controlMessage(error.message||'No se pudo completar el movimiento.');}
      finally{button.disabled=false;}
    });
  }
  el('acondControlRetry').addEventListener('click',async()=>{
    controlMessage(await sync()?excelLabel+' verificado.':'La sincronización sigue pendiente.');
  });
  for(const button of controls.querySelectorAll('[data-acond-download]')){
    button.addEventListener('click',async()=>{
      try{
        const type=button.dataset.acondDownload,file=await repository.conditioningExcel(type);
        const link=document.createElement('a');
        link.href=URL.createObjectURL(file);
        link.download=live?(type==='maestro'?'CARGOS_ENVIADOS_IRON_MOUNTAIN_MAESTRO'+
          (file.type.includes('macroenabled')?'.xlsm':'.xlsx'):'REGISTRO_DE_FACTURAS_ENVIADOS_A_IRON_MOUNTAIN.xlsx'):
          type+'_acondicionamiento_preview.xlsx';
        link.click();
        setTimeout(()=>URL.revokeObjectURL(link.href),30000);
      }catch{controlMessage('No se pudo descargar el archivo de Excel.');}
    });
  }
  chooseYear(year);select(null);
  return {
    activate(){active=true;void refresh();clearInterval(timer);timer=setInterval(refresh,15000);scan.focus();},
    deactivate(){active=false;lookupVersion++;clearInterval(timer);},
    reset(){active=false;lookupVersion++;listVersion++;clearInterval(timer);select(null);scan.value='';message('');}
  };
}
