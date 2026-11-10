// KPI de cajas acondicionadas. Solo lectura: utiliza el listado del módulo Acondicionamiento.
export function limaDay(value=new Date()) {
  if(typeof value==='string' && /^\d{4}-\d{2}-\d{2}/.test(value))return value.slice(0,10);
  const date=value instanceof Date?value:new Date(value);
  if(Number.isNaN(date.valueOf()))return '';
  const parts=new Intl.DateTimeFormat('en-US',{timeZone:'America/Lima',
    year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(date);
  const part=key=>parts.find(item=>item.type===key)?.value||'';
  return part('year')+'-'+part('month')+'-'+part('day');
}
function boxKey(value) {
  const raw=String(value??'').toUpperCase().replace(/^[A-Z\s]+/,'').replace(/\D/g,'');
  return raw.replace(/^0+(?=\d)/,'');
}
const number=value=>Number(value)||0;
export function summarizeConditionedBoxes(rows=[],today=new Date()) {
  const currentDay=limaDay(today),currentMonth=currentDay.slice(0,7),currentYear=currentDay.slice(0,4);
  const unique=new Map();
  for(const row of Array.isArray(rows)?rows:[]) {
    if(!row || !['nueva','solicitada'].includes(String(row.origen||'').toLowerCase()))continue;
    const codigo=boxKey(row.codigo||row.clave);
    const preparada=limaDay(row.preparada||row.fecha_preparacion);
    if(!codigo || !preparada)continue;
    // Una caja se contabiliza una sola vez por preparación y solicitud.
    const clave=codigo+':'+String(row.solicitud||'');
    const entry={codigo,preparada,origen:String(row.origen).toLowerCase(),
      enviada:!!String(row.enviada||row.fecha_envio||'').trim()};
    const old=unique.get(clave);
    if(!old || (entry.enviada && !old.enviada) || entry.preparada>old.preparada)
      unique.set(clave,entry);
  }
  const registros=[...unique.values()].sort((a,b)=>a.preparada.localeCompare(b.preparada));
  const mes=registros.filter(r=>r.preparada.slice(0,7)===currentMonth);
  const pendientes=mes.filter(r=>!r.enviada);
  return {registros,mesPreparadas:mes.length,mesPendientes:pendientes.length,
    pendientesNuevas:pendientes.filter(r=>r.origen==='nueva').length,
    pendientesSolicitadas:pendientes.filter(r=>r.origen==='solicitada').length,
    currentDay,currentMonth,currentYear};
}
const months=['ene','feb','mar','abr','may','jun','jul','ago','sep','oct','nov','dic'];
function weekKey(date) {
  const utc=new Date(date+'T12:00:00Z');
  const weekday=(utc.getUTCDay()+6)%7;
  utc.setUTCDate(utc.getUTCDate()-weekday);
  return utc.toISOString().slice(0,10);
}
function timeline(summary,period) {
  const {registros,currentDay,currentMonth,currentYear}=summary;
  const data=[];
  if(period==='dia'){
    const max=number(currentDay.slice(8));
    for(let i=1;i<=max;i++){
      const key=currentMonth+'-'+String(i).padStart(2,'0');
      data.push({key,label:String(i).padStart(2,'0')+'/'+currentMonth.slice(5),match:r=>r.preparada===key});
    }
  }else if(period==='semana'){
    const weeks=new Map();
    const max=number(currentDay.slice(8));
    for(let i=1;i<=max;i++){
      const date=currentMonth+'-'+String(i).padStart(2,'0'),key=weekKey(date);
      if(!weeks.has(key))weeks.set(key,{key,label:'Semana '+(weeks.size+1),match:r=>r.preparada.startsWith(currentMonth)&&weekKey(r.preparada)===key});
    }
    data.push(...weeks.values());
  }else if(period==='mes'){
    for(let i=1;i<=number(currentMonth.slice(5));i++){
      const key=currentYear+'-'+String(i).padStart(2,'0');
      data.push({key,label:months[i-1],match:r=>r.preparada.slice(0,7)===key});
    }
  }else{
    const years=[...new Set(registros.map(r=>r.preparada.slice(0,4)))].filter(y=>y<=currentYear);
    const start=Math.min(2020,...years.map(number),number(currentYear));
    for(let y=start;y<=number(currentYear);y++){
      const key=String(y);
      data.push({key,label:key,match:r=>r.preparada.startsWith(key)});
    }
  }
  return data.map(bucket=>{
    const subset=registros.filter(bucket.match);
    return {label:bucket.label,nuevas:subset.filter(r=>r.origen==='nueva').length,
      solicitadas:subset.filter(r=>r.origen==='solicitada').length,total:subset.length};
  });
}
export function attachPreparedMonthlyKpi({repository,isAdmin,appReady}) {
  const el=id=>document.getElementById(id);
  const modal=el('conditionedMonthlySheet'),metric=el('monthlyBoxesConditioned'),
    note=el('conditionedMonthlyNote');
  let view='dia',summary=null,request=0;
  const format=n=>new Intl.NumberFormat('es-PE').format(n);
  function render(){
    if(!modal.open)return;
    [...modal.querySelectorAll('[data-prepared-period]')].forEach(button=>{
      const active=button.dataset.preparedPeriod===view;
      button.setAttribute('aria-selected',String(active));
    });
    const chart=el('conditionedMonthlyChart'),status=el('conditionedMonthlyStatus');
    if(!summary){
      chart.textContent='Aún no hay datos disponibles.';
      return;
    }
    el('conditionedMonthlyPrepared').textContent=format(summary.mesPreparadas);
    el('conditionedMonthlyPending').textContent=format(summary.mesPendientes);
    const buckets=timeline(summary,view);
    const max=Math.max(1,...buckets.map(b=>b.total));
    chart.innerHTML=buckets.map(bucket=>{
      const first=bucket.nuevas/max*100,second=bucket.solicitadas/max*100;
      return '<div class="conditioned-chart-row" role="listitem">'+
        '<span class="conditioned-chart-label">'+bucket.label+'</span>'+
        '<div class="conditioned-chart-track" aria-label="'+bucket.total+' cajas">'+
        '<span class="conditioned-segment-new" style="width:'+first+'%"></span>'+
        '<span class="conditioned-segment-requested" style="width:'+second+'%"></span></div>'+
        '<strong class="conditioned-chart-value">'+format(bucket.total)+'</strong></div>';
    }).join('');
    status.textContent='Productividad histórica: incluye cajas preparadas que después fueron enviadas. La tarjeta superior solo cuenta las pendientes del mes.';
  }
  async function refresh(){
    if(!isAdmin()||!appReady())return;
    const current=++request;
    try{
      const data=await repository.conditioning('listar');
      if(current!==request || !isAdmin() || !appReady())return;
      if(!data || !Array.isArray(data.listado))throw new Error('Respuesta no disponible');
      summary=summarizeConditionedBoxes(data.listado);
      metric.textContent=format(summary.mesPendientes);
      note.textContent='Preparadas este mes · Pendientes de envío a IM';
      render();
    }catch{
      if(current!==request)return;
      summary=null;metric.textContent='—';
      note.textContent='No se pudo consultar Acondicionamiento';
      if(modal.open)el('conditionedMonthlyChart').textContent='No se pudieron consultar las cajas acondicionadas.';
    }
  }
  modal.querySelectorAll('[data-prepared-period]').forEach(button=>
    button.addEventListener('click',()=>{view=button.dataset.preparedPeriod;render();}));
  el('btnCloseConditionedMonthly').addEventListener('click',()=>modal.close());
  return {
    refresh,
    open(){
      if(!isAdmin()||!appReady())return;
      view='dia';
      if(!modal.open)modal.showModal();
      render();void refresh();
    }
  };
}
