import {parseBoxScan,findPreparedBox,probableRapidScan} from './box-scanner.js';

// Los lectores USB-HID pueden funcionar como teclado sin exponer su modelo.
// Mostramos "Conectado" solo si WebHID confirma un lector autorizado.
const readerName=name=>/symbol|zebra|motorola|honeywell|datalogic|barcode|scanner|lector|cipherlab|newland|unitech|opticon|socket/i.test(String(name??''));

export function attachBoxScanner({repository,isAdmin,appReady}){
  const el=id=>document.getElementById(id);
  const input=el('boxScanInput'),feedback=el('boxScanFeedback'),details=el('boxScanResult'),
    history=el('boxScanHistory'),counter=el('boxScanCount'),device=el('boxScannerModel'),
    state=el('boxScannerStatus'),source=el('boxScannerSource');
  let rows=[],loaded=false,loading=false,enabled=false,seen=new Map(),intervals=[],
    lastKey=0,autoTimer=null,epoch=0,identified=null;

  const notice=(message,error=false)=>{
    feedback.textContent=message;
    feedback.style.color=error?'var(--red)':'var(--muted)';
  };
  const line=(parent,tag,value)=>{
    const node=document.createElement(tag);
    node.textContent=String(value??'');
    parent.append(node);
    return node;
  };
  const setModel=info=>{
    if(!info||!readerName(info.productName))return;
    identified={vendorId:info.vendorId,productId:info.productId,productName:info.productName};
    state.textContent='Conectado';
    device.textContent='Lector: '+info.productName;
    device.hidden=false;
  };
  const matchesIdentified=info=>identified&&info&&
    identified.vendorId===info.vendorId&&identified.productId===info.productId;
  const observeDevice=async()=>{
    if(!enabled||!('hid' in navigator)||typeof navigator.hid.getDevices!=='function')return;
    try{
      const devices=await navigator.hid.getDevices();
      if(!enabled)return;
      const recognized=devices.filter(x=>readerName(x.productName));
      if(recognized.length===1)setModel(recognized[0]);
    }catch{
      // Sin permisos USB previos: el modo teclado continúa sin identificación.
    }
  };
  const renderHistory=()=>{
    history.replaceChildren();
    for(const item of [...seen.values()].reverse().slice(0,30)){
      const description=item.original+' · '+item.label+(item.count>1?' ('+item.count+' lecturas)':'');
      line(history,'li',description).title=item.original;
    }
    counter.textContent=String(seen.size);
  };
  const renderMatch=data=>{
    details.replaceChildren();
    line(details,'h3','Caja '+data.original);
    if(!loaded){
      line(details,'p','No hay datos de cajas disponibles. Pulsa Actualizar.');
      return;
    }
    if(!data.found){
      line(details,'p','No encontrada entre las cajas pendientes.');
      line(details,'p','Revisa su estado antes de registrarla como nueva.');
      return;
    }
    line(details,'p','Cargos: '+(data.cargos.length?data.cargos.join(', '):'Sin cargos asociados'));
    line(details,'p','Clasificación: '+(data.clasificaciones.join(', ')||'Sin clasificar'));
    line(details,'p','Estado registrado: pendiente de envío.');
  };
  const clearTimer=()=>{
    if(autoTimer!==null){clearTimeout(autoTimer);autoTimer=null;}
  };
  const canScan=()=>enabled&&appReady()&&isAdmin();
  const process=()=>{
    clearTimer();
    if(!canScan())return;
    const scanned=parseBoxScan(input.value);
    if(!scanned.ok)return notice(scanned.reason,true);
    input.value='';intervals=[];lastKey=0;
    if(!identified)state.textContent='Lectura recibida';
    const found=findPreparedBox(rows,scanned.original);
    const prior=seen.get(scanned.normalized);
    if(prior){
      prior.count++;
      notice('Caja repetida. No se contó dos veces.');
    }else{
      const label=!loaded?'Sin verificar':found.found?'Encontrada':'Por revisar';
      seen.set(scanned.normalized,{original:scanned.original,count:1,label});
      notice(!loaded?'Código recibido. Actualiza las cajas para consultar.':
        found.found?'Caja encontrada.':'No aparece entre las cajas pendientes.');
    }
    renderMatch(found);renderHistory();input.focus();
  };
  const refresh=async()=>{
    if(!canScan()||loading)return;
    loading=true;loaded=false;
    const call=++epoch;
    notice('Buscando cajas…');
    source.hidden=true;
    try{
      const data=await repository.preparedImDetails();
      if(call!==epoch||!canScan())return;
      if(!Array.isArray(data))throw Error('Invalid list');
      rows=data;loaded=true;
      notice('');
      input.focus();
    }catch{
      if(call!==epoch)return;
      rows=[];loaded=false;
      notice('No se pudo consultar las cajas.',true);
      source.textContent='Intenta Actualizar. Las lecturas no cambian los datos registrados.';
      source.hidden=false;
    }finally{
      loading=false;
    }
  };
  el('boxScanSubmit').addEventListener('click',process);
  el('boxScanRefresh').addEventListener('click',()=>{void refresh();});
  el('boxScanClear').addEventListener('click',()=>{
    if(!canScan())return;
    seen.clear();input.value='';details.replaceChildren();renderHistory();
    notice('Lecturas limpiadas.');input.focus();
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
      autoTimer=setTimeout(()=>{
        autoTimer=null;
        if(canScan()&&probableRapidScan(intervals,input.value.length))process();
      },400);
    }
  });
  if('hid' in navigator&&typeof navigator.hid.addEventListener==='function'){
    navigator.hid.addEventListener('connect',event=>{
      if(enabled)setModel(event.device);
    });
    navigator.hid.addEventListener('disconnect',event=>{
      if(enabled&&matchesIdentified(event.device)){
        identified=null;
        device.textContent='';
        device.hidden=true;
        state.textContent='Desconectado';
      }
    });
  }
  return {
    activate(){
      if(!appReady()||!isAdmin())return;
      enabled=true;
      state.textContent=identified?'Conectado':'Listo para escanear';
      if(!loaded&&!loading)void refresh();
      void observeDevice();
      input.focus();
    },
    deactivate(){enabled=false;clearTimer();},
    reset(){
      enabled=false;epoch++;clearTimer();rows=[];loaded=false;seen.clear();
      intervals=[];lastKey=0;identified=null;
      input.value='';details.replaceChildren();history.replaceChildren();
      counter.textContent='0';
      device.textContent='';device.hidden=true;
      state.textContent='Listo para escanear';
      source.textContent='';source.hidden=true;
      notice('');
    }
  };
}
