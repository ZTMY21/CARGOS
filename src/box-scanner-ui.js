import {parseBoxScan,findPreparedBox,probableRapidScan} from './box-scanner.js';

export function attachBoxScanner({repository,isAdmin,appReady}){
  const el=id=>document.getElementById(id);
  const input=el('boxScanInput'),readout=el('boxScanFeedback'),details=el('boxScanResult'),
    history=el('boxScanHistory'),counter=el('boxScanCount'),device=el('boxScannerModel'),
    source=el('boxScannerSource');
  let rows=[],loaded=false,loading=false,enabled=false,seen=new Map(),intervals=[],lastKey=0,autoTimer=null,epoch=0;
  const notice=(text,issue=false)=>{readout.textContent=text;readout.style.color=issue?'var(--red)':'var(--muted)';};
  const append=(parent,tag,text,className)=>{
    const node=document.createElement(tag);
    node.textContent=String(text??'');
    if(className)node.className=className;
    parent.append(node);return node;
  };
  const renderHistory=()=>{
    history.replaceChildren();
    for(const record of [...seen.values()].reverse().slice(0,30)){
      const line=append(history,'li',record.original+' · '+record.label+(record.count>1?' · '+record.count+' lecturas':''));
      line.title=record.original;
    }
    counter.textContent=String(seen.size);
  };
  const renderMatch=(data)=>{
    details.replaceChildren();
    append(details,'h3','Caja escaneada: '+data.original);
    if(!loaded){
      append(details,'p','Sin consulta confirmada de Iron Mountain: no se puede determinar si la caja existe.');
      return;
    }
    if(!data.found){
      append(details,'p','No aparece entre las cajas PENDIENTES de la última sincronización disponible.');
      append(details,'p','Esto no significa que sea una caja nueva: podría estar enviada, en otra hoja o pendiente de sincronización.');
      return;
    }
    append(details,'p','Coincide con '+data.matches.length+' registro(s) de caja pendiente en el Kárdex.');
    append(details,'p','Códigos registrados: '+data.originales.join(', '));
    append(details,'p','Clasificación: '+(data.clasificaciones.join(', ')||'Sin clasificación'));
    append(details,'p','Cargos vinculados: '+(data.cargos.length?data.cargos.join(', '):'Sin cargos registrados'));
    append(details,'p','Estado observado: sin fecha de envío en el último registro sincronizado. Verificar antes de mover físicamente.');
  };
  const clearTimer=()=>{if(autoTimer!==null){clearTimeout(autoTimer);autoTimer=null;}};
  const canScan=()=>enabled&&appReady()&&isAdmin();
  const process=()=>{
    clearTimer();
    if(!canScan())return notice('Inicia sesión como administrador para escanear.',true);
    const scan=parseBoxScan(input.value);
    if(!scan.ok)return notice(scan.reason,true);
    input.value='';intervals=[];lastKey=0;
    const found=findPreparedBox(rows,scan.original);
    const prior=seen.get(scan.normalized);
    if(prior){
      prior.count++;
      notice('Lectura repetida: '+scan.original+'. Esta caja ya se contó en la sesión.');
    }else{
      const label=!loaded?'Sin consulta':found.found?'Coincide con caja pendiente':'Pendiente de revisión';
      seen.set(scan.normalized,{original:scan.original,count:1,label});
      notice(found.found?'Código leído y encontrado en cajas pendientes.':
        loaded?'Código leído; no está entre las cajas pendientes de la fuente sincronizada.':'Código leído; la consulta de cajas no está disponible.');
    }
    renderMatch(found);renderHistory();input.focus();
  };
  const refresh=async()=>{
    if(!canScan()||loading)return;
    loading=true;loaded=false;const call=++epoch;
    notice('Consultando cajas pendientes de Iron Mountain…');
    try{
      const data=await repository.preparedImDetails();
      if(call!==epoch||!canScan())return;
      if(!Array.isArray(data))throw Error('Respuesta inesperada');
      rows=data;loaded=true;
      source.textContent='Consulta correcta: '+new Date().toLocaleString('es-PE')+
        '. Datos según última sincronización de Google Sheets; pueden estar desactualizados.';
      notice('Consulta lista. Escanea el código de una caja. Esta vista no guarda ni cambia estados.');
      input.focus();
    }catch(_error){
      if(call!==epoch)return;
      rows=[];loaded=false;
      source.textContent='No fue posible consultar las cajas pendientes. La lectura sigue disponible, pero no confirma existencias.';
      notice('No se pudo consultar Iron Mountain. Reintenta «Actualizar cajas».',true);
    }finally{loading=false;}
  };
  const displayHID=deviceInfo=>{
    if(!deviceInfo?.productName)return;
    const vid=Number.isInteger(deviceInfo.vendorId)?'VID '+deviceInfo.vendorId.toString(16).padStart(4,'0'):'';
    const pid=Number.isInteger(deviceInfo.productId)?'PID '+deviceInfo.productId.toString(16).padStart(4,'0'):'';
    device.textContent='Dispositivo autorizado: '+deviceInfo.productName+
      (vid&&pid?' ('+vid+' · '+pid+')':'')+
      '. Identificación declarada por USB; confirma que sea el lector.';
  };
  const detectAllowed=async()=>{
    if(!('hid' in navigator)){device.textContent='Modelo no accesible desde este navegador. La lectura USB tipo teclado puede funcionar igualmente.';return;}
    try{
      const known=await navigator.hid.getDevices();
      if(known.length===1)displayHID(known[0]);
      else if(known.length>1)device.textContent='Hay '+known.length+' dispositivos autorizados. Selecciona el lector para identificarlo.';
      else device.textContent='Modo teclado USB: no es posible conocer automáticamente la marca/modelo. Usa «Identificar lector» si está disponible.';
    }catch{
      device.textContent='El navegador no permitió consultar modelos. El escaneo por teclado permanece disponible.';
    }
  };
  el('boxScannerDetect').addEventListener('click',async()=>{
    if(!canScan())return;
    if(!('hid' in navigator))return detectAllowed();
    try{
      // Un usuario debe elegir el dispositivo: jamás afirmar que cualquier HID es el lector.
      const selected=await navigator.hid.requestDevice({filters:[]});
      if(selected.length===1)displayHID(selected[0]);
      else if(selected.length>1)device.textContent='Seleccionaste varios dispositivos: vuelve a identificar uno.';
      else device.textContent='No se seleccionó dispositivo. Si el lector funciona como teclado, puede no aparecer aquí.';
    }catch{
      device.textContent='Permiso de identificación denegado o dispositivo no disponible. Sigue usando el modo teclado.';
    }
    input.focus();
  });
  el('boxScanEnable').addEventListener('click',()=>{
    if(!canScan())return;
    input.focus();
    notice('Campo de lectura listo. Escanea una caja o introduce el código y pulsa Enter.');
  });
  el('boxScanSubmit').addEventListener('click',process);
  el('boxScanRefresh').addEventListener('click',()=>{void refresh();});
  el('boxScanClear').addEventListener('click',()=>{
    if(!canScan())return;
    seen.clear();input.value='';details.replaceChildren();renderHistory();notice('Sesión de lectura vaciada. No se eliminó ningún registro del Kárdex.');input.focus();
  });
  input.addEventListener('keydown',event=>{
    if(!canScan())return;
    if(event.key==='Enter'){event.preventDefault();process();return;}
    if(event.key==='Tab'&&probableRapidScan(intervals,input.value.length)){
      event.preventDefault();process();return;
    }
    if(event.key.length===1&&!event.ctrlKey&&!event.altKey&&!event.metaKey){
      const now=performance.now();
      if(lastKey>0)intervals.push(Math.max(0,now-lastKey));
      if(intervals.length>50)intervals.shift();
      lastKey=now;
    }
  });
  input.addEventListener('input',()=>{
    if(!canScan())return;
    clearTimer();
    if(probableRapidScan(intervals,input.value.length)){
      autoTimer=setTimeout(()=>{autoTimer=null;if(canScan()&&probableRapidScan(intervals,input.value.length))process();},400);
    }
  });
  // WebHID solo informa de dispositivos que el navegador haya autorizado.
  // Los lectores en modo teclado protegido pueden no aparecer y seguir funcionando.
  if('hid' in navigator&&typeof navigator.hid.addEventListener==='function'){
    navigator.hid.addEventListener('connect',event=>{if(enabled)displayHID(event.device);});
    navigator.hid.addEventListener('disconnect',event=>{
      if(enabled){
        device.textContent='Dispositivo HID desconectado: '+String(event.device?.productName||'modelo no disponible')+
          '. El modo teclado puede seguir disponible para otros lectores.';
      }
    });
  }
  return {
    activate(){
      if(!appReady()||!isAdmin())return;
      enabled=true;
      if(!loaded&&!loading)void refresh();
      void detectAllowed();
      input.focus();
    },
    deactivate(){enabled=false;clearTimer();},
    reset(){
      enabled=false;epoch++;clearTimer();rows=[];loaded=false;seen.clear();
      input.value='';intervals=[];lastKey=0;details.replaceChildren();history.replaceChildren();
      counter.textContent='0';source.textContent='Consulta pendiente.';device.textContent='Modelo no identificado.';
    }
  };
}
