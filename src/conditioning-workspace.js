import {escapeHtml,fmtDate,limaDate} from './rules.js';
import {physicalBoxKey} from './search.js';
import {drawBoxBarcode} from './box-code128.js';
import {scanConditioningBox} from './conditioning-camera.js';

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

export function attachConditioningWorkspace({repository,live=false,onChanged=()=>{},scanCamera=scanConditioningBox}){
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
  const workspace=scan.closest('.acond-workspace');
  const laptop=el('acondLaptop'),mobile=el('acondMobile'),scanForm=el('acondScanForm');
  let selected=null,year=2026,active=false,busy=false,lookupVersion=0,listVersion=0,timer;
  let mobileMode=false,step='start',camera,validatingFinal=false;
  const cargoVersions=fields.map(()=>0);
  let validations=Array(3).fill(null);
  const message=text=>{el('acondMessage').textContent=text;};
  const controlMessage=text=>{el('acondControlMessage').textContent=text;};
  const call=(action,data)=>repository.conditioning(action,data);
  const lookup=code=>call('buscar',{p_codigo:code});
  const eligible=()=>selected?.status==='disponible'&&['nueva','solicitada'].includes(selected.origen);

  function showStep(next=step){
    step=next;
    workspace.dataset.mode=mobileMode?'mobile':'laptop';
    laptop.setAttribute('aria-pressed',String(!mobileMode));
    mobile.setAttribute('aria-pressed',String(mobileMode));
    const read=mobileMode&&step==='read';
    const detail=mobileMode&&step==='detail';
    const confirm=mobileMode&&step==='confirm';
    el('acondLookup').hidden=mobileMode&&!(step==='start'||read);
    el('acondLookupIntro').hidden=read;
    el('acondReadCode').hidden=!read;
    scanForm.hidden=read;
    el('acondLaptopHint').hidden=mobileMode;
    el('acondOpenCamera').hidden=!mobileMode||step!=='start';
    el('acondContinue').hidden=!read||!eligible();
    el('acondNewScan').hidden=!read;
    el('acondCamera').hidden=!mobileMode||step!=='camera';
    el('acondPreparation').hidden=mobileMode&&!(detail||confirm);
    el('acondNext').hidden=!detail;
    el('acondConfirm').hidden=!confirm;
    el('acondEdit').hidden=!confirm;
    save.hidden=mobileMode&&!confirm;
    el('acondDone').hidden=!mobileMode||step!=='done';
    el('acondKpis').hidden=mobileMode&&step!=='start';
  }
  function stopCamera(){
    camera?.abort();
    camera=null;
  }
  function restart(){
    stopCamera();
    lookupVersion++;
    select(null);
    scan.value='';
    message('');
    showStep('start');
  }

  function mark(index,status=''){
    fields[index].feedback.dataset.status=status;
    const mobileLabel={disponible:'✓ Sí existe',inexistente:'✕ No existe',duplicado:'Cargo duplicado'};
    fields[index].feedback.textContent=(mobileMode&&mobileLabel[status])||cargoLabels[status]||'';
  }
  function updateButtons(){
    const editing=selected?.status==='disponible'&&selected.origen==='nueva'&&!busy;
    const checking=selected?.status==='disponible'&&selected.origen==='solicitada';
    el('acondVerifiedLabel').hidden=!checking;
    const cargoHint=el('acondCargoHint');
    if(editing){
      cargoHint.textContent=mobileMode?'Ingresa los cargos de la caja.':'Elige el año, ingresa hasta 3 cargos y presiona Enter o la flecha para validar cada uno.';
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
    const locked=busy||(mobileMode&&(step==='confirm'||validatingFinal));
    for(const {input,button} of fields){input.readOnly=!editing||locked;button.disabled=!editing||locked;}
    for(const button of yearButtons)button.disabled=locked||(mobileMode&&selected?.origen==='solicitada');
    verified.disabled=locked;
    laptop.disabled=mobile.disabled=busy||validatingFinal;
    scan.readOnly=busy;
    el('acondNext').disabled=validatingFinal||busy;
    el('acondEdit').disabled=busy;
    el('acondAnother').disabled=busy;
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
    if(mobileMode&&record?.origen==='nueva')origin.firstElementChild.textContent='Caja nueva solicitada';
    if(mobileMode&&record?.origen==='solicitada')origin.firstElementChild.textContent='Caja solicitada en préstamo';
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
      const [data,reception]=await Promise.all([call('listar'),repository.reception()]);
      if(!active||version!==listVersion)return;
      const supply=Number(reception?.cantidad)||0;
      const receptionCount=el('acondReceptionCount');
      let prepared=data.preparadas;
      if(supply){
        const readings=reception.lecturas||[];
        const saved=new Set(readings.filter(row=>row.guardado).map(row=>physicalBoxKey(row.codigo)).filter(Boolean));
        const inRequest=new Set(data.listado.filter(row=>row.origen==='nueva'&&
          (!row.solicitud||row.solicitud===reception.id))
          .map(row=>physicalBoxKey(row.codigo)).filter(key=>saved.has(key)));
        prepared=inRequest.size;
        receptionCount.textContent=readings.length+' de '+supply+' registradas · '+
          Math.max(0,supply-readings.length)+' por registrar';
      }
      const percent=supply?Math.round(prepared/supply*100):0;
      receptionCount.hidden=!supply;
      el('acondNewLabel').textContent=supply?'Cajas nuevas solicitadas':'Cajas nuevas registradas';
      el('acondNew').textContent=String(supply||data.nuevas);
      el('acondRequested').textContent=String(data.solicitadas);
      el('acondPrepared').textContent=supply?prepared+' de '+supply:String(prepared);
      el('acondProgressTrack').hidden=!supply;
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
  async function validate(index,final=false){
    const field=fields[index],value=field.input.value.trim(),box=selected,currentYear=year;
    if(!value||!box||(!final&&field.input.readOnly))return;
    const version=++cargoVersions[index];
    validations[index]=null;
    field.feedback.textContent='Validando…';
    updateButtons();
    const current=()=>version===cargoVersions[index]&&box===selected&&year===currentYear&&field.input.value.trim()===value;
    try{
      const result=await call('cargo',{p_codigo:box.codigo,p_anio:currentYear,p_cargos:[value]});
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
      fields.forEach((_,i)=>cargoVersions[i]++);
      fields.forEach((_,i)=>mark(i));
      updateButtons();
    }
  });
  fields.forEach(({input,button},i)=>{
    input.addEventListener('input',()=>{cargoVersions[i]++;validations[i]=null;mark(i);updateButtons();});
    input.addEventListener('blur',()=>{if(mobileMode&&step==='detail'&&!validations[i])void validate(i);});
    input.addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();void validate(i);}});
    button.addEventListener('click',()=>void validate(i));
  });
  scan.addEventListener('input',()=>{lookupVersion++;select(null);});
  async function consult(code){
    if(busy)return;
    const version=++lookupVersion;
    select(null);message('');
    if(mobileMode){
      const panel=el('acondReadCode');
      panel.querySelector('strong').textContent=code;
      panel.querySelector('p').textContent='';
      showStep('read');
    }
    if(!physicalBoxKey(code))return select({status:'inexistente'});
    el('acondBoxState').textContent='Consultando caja…';
    try{
      const record=await lookup(code);
      if(!active||version!==lookupVersion)return;
      select(record);
      if(mobileMode){
        if(record.codigo&&record.codigo!==code)
          el('acondReadCode').querySelector('p').textContent='Código en el registro: '+record.codigo+'. Verifica la etiqueta antes de continuar.';
        if(record.status==='ambiguo')
          el('acondBoxState').textContent='Varias cajas comparten ese número. Confirma el código completo con el responsable antes de continuar.';
        showStep();
      }else if(record.codigo){scan.focus();scan.select();}
    }catch{if(version===lookupVersion)el('acondBoxState').textContent='No se pudo consultar la caja. Reintenta.';}
  }
  scanForm.addEventListener('submit',event=>{
    event.preventDefault();
    void consult(scan.value.trim());
  });
  for(const [button,mode] of [[laptop,false],[mobile,true]]){
    button.addEventListener('click',()=>{
      if(mode===mobileMode)return;
      mobileMode=mode;
      restart();
      if(!mobileMode)scan.focus();
    });
  }
  el('acondOpenCamera').addEventListener('click',async()=>{
    if(camera||!active)return;
    const controller=camera=new AbortController();
    message('');
    const status=el('acondCameraStatus');
    status.textContent='Buscando código de caja…';
    showStep('camera');
    const timeout=setTimeout(()=>{
      if(!controller.signal.aborted)
        status.textContent='Todavía no se pudo leer la etiqueta. Acércala al recuadro o vuelve para ingresar el código.';
    },12000);
    controller.signal.addEventListener('abort',()=>clearTimeout(timeout),{once:true});
    try{
      await scanCamera(el('acondCameraVideo'),controller.signal,code=>{
        if(controller.signal.aborted||!active)return;
        if(!physicalBoxKey(code)){
          status.textContent='Código de caja no reconocido. Prueba con otra etiqueta.';
          return;
        }
        stopCamera();
        void consult(code);
      });
    }catch(error){
      if(controller.signal.aborted)return;
      stopCamera();
      showStep('start');
      message(error.name==='NotAllowedError'
        ? 'Permiso de cámara denegado. Habilítalo en el navegador o ingresa el código manualmente.'
        : 'No se pudo abrir la cámara. Puedes ingresar el código manualmente.');
    }
  });
  for(const id of ['acondCloseCamera','acondNewScan','acondAnother'])
    el(id).addEventListener('click',restart);
  document.addEventListener('visibilitychange',()=>{
    if(document.hidden&&camera)restart();
  });
  el('acondContinue').addEventListener('click',()=>{
    if(!eligible())return;
    showStep('detail');
    updateButtons();
  });
  el('acondNext').addEventListener('click',async()=>{
    if(!eligible()||validatingFinal)return;
    const box=selected;
    message('');
    if(box.origen==='nueva'){
      const filled=fields.flatMap(({input},i)=>input.value.trim()?[i]:[]);
      if(!filled.length){message('Ingresa al menos un cargo para continuar.');return;}
      validatingFinal=true;
      updateButtons();
      await Promise.all(filled.map(i=>validate(i,true)));
      validatingFinal=false;
      if(!active||step!=='detail'||selected!==box){updateButtons();return;}
      const seen=new Set();
      const invalid=filled.filter(i=>{
        const result=validations[i];
        if(result?.status!=='disponible')return true;
        const code=String(result.codigo||result.value).trim().toLowerCase().replace(/^cargo[\s-]+|\.0+$/g,'')
          .replace(/[^a-z0-9]/g,'').replace(/^0+(?=\d)/,'');
        if(seen.has(code)){mark(i,'duplicado');return true;}
        seen.add(code);
        return false;
      });
      if(invalid.length){
        message('Revisa '+(invalid.length===1?'la fila ':'las filas ')+invalid.map(i=>i+1).join(', ')+' antes de continuar.');
        updateButtons();
        return;
      }
    }else if(!verified.checked){
      message('Confirma que los cargos físicos coinciden con el Histórico IM.');
      return;
    }
    showStep('confirm');
    updateButtons();
  });
  el('acondEdit').addEventListener('click',()=>{
    showStep('detail');
    message('');
    updateButtons();
  });
  verified.addEventListener('change',()=>{
    message(verified.checked?'':'Si hay diferencias, verifica los cargos antes de continuar.');
    updateButtons();
  });
  save.addEventListener('click',async()=>{
    if(save.disabled||(mobileMode&&step!=='confirm'))return;
    busy=true;updateButtons();message('Registrando preparación…');
    const box=selected;
    try{
      const record=await call('preparar',{p_codigo:box.codigo,p_anio:year,
        p_cargos:fields.map(f=>f.input.value.trim()).filter(Boolean),p_datos:{verificada:verified.checked}});
      if(selected!==box)return;
      select({...record,status:'preparada'});
      if(mobileMode){
        el('acondDoneText').textContent='La caja '+record.codigo+' ha sido registrada correctamente.';
        el('acondDoneCode').textContent=record.codigo;
        el('acondDoneYears').textContent=record.anios?.join(', ')||'—';
        el('acondDoneCount').textContent=String(record.cargos.length);
        showStep('done');
      }
      const registered=selected;
      const synced=await sync();
      if(selected!==registered)return;
      message(synced?'Caja acondicionada y verificada en el '+excelLabel+'.':'Caja acondicionada. Sincronización pendiente.');
      await Promise.allSettled([refresh(),onChanged()]);
    }catch(error){
      if(selected!==box)return;
      if(mobileMode&&step==='confirm')showStep('detail');
      message(error.message||'No se pudo registrar la preparación.');
    }
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
  chooseYear(year);select(null);showStep();
  return {
    activate(){active=true;void refresh();clearInterval(timer);timer=setInterval(refresh,5000);if(!mobileMode)scan.focus();},
    deactivate(){active=false;lookupVersion++;clearInterval(timer);if(camera||(mobileMode&&step==='read'&&!selected))restart();},
    reset(){active=false;listVersion++;clearInterval(timer);restart();}
  };
}
