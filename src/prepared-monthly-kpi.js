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
// Gráfica vertical de dos series, con ejes y cuadrícula como la vista aprobada.
export function groupedChartSvg(buckets) {
  const count=buckets.length;
  const width=Math.max(700, count*53+78);
  const height=300,left=39,right=16,top=20,bottom=43;
  const innerW=width-left-right,innerH=height-top-bottom;
  const maxValue=Math.max(4,...buckets.flatMap(x=>[x.nuevas,x.solicitadas]));
  const step=Math.max(1,Math.ceil(maxValue/4)),max=step*4;
  const toY=value=>top+innerH-innerH*value/max;
  const rows=Array.from({length:5},(_,i)=>{
    const value=i*step,y=toY(value);
    return '<line class="conditioned-gridline" x1="'+left+'" x2="'+(width-right)+'" y1="'+y+'" y2="'+y+'"/>'+
      '<text class="conditioned-axis-text" x="'+(left-12)+'" y="'+(y+4)+'" text-anchor="end">'+value+'</text>';
  }).join('');
  const groupWidth=innerW/Math.max(1,count);
  const barWidth=Math.min(23,Math.max(8,groupWidth*.29));
  const gap=Math.min(5,groupWidth*.08);
  const bars=buckets.map((item,i)=>{
    const center=left+groupWidth*(i+.5);
    const groups=[['nuevas','conditioned-bar-new','Cajas nuevas',-barWidth-gap/2],
      ['solicitadas','conditioned-bar-requested','Cajas solicitadas',gap/2]];
    const rects=groups.map(([key,cls,label,dx])=>{
      const n=item[key],y=toY(n),h=toY(0)-y;
      if(!n)return '';
      return '<rect class="'+cls+'" x="'+(center+dx)+'" y="'+y+'" width="'+barWidth+
        '" height="'+h+'" rx="4" ry="4"><title>'+item.label+': '+n+' '+label+'</title></rect>';
    }).join('');
    return rects+'<text class="conditioned-axis-text" x="'+center+'" y="'+(height-19)+'" text-anchor="middle">'+item.label+'</text>';
  }).join('');
  return '<svg class="conditioned-svg" xmlns="http://www.w3.org/2000/svg" width="'+width+
    '" height="'+height+'" viewBox="0 0 '+width+' '+height+'" role="img" aria-label="Gráfico de cajas nuevas y solicitadas acondicionadas por periodo">'+
    rows+'<line class="conditioned-axis" x1="'+left+'" x2="'+(width-right)+'" y1="'+toY(0)+'" y2="'+toY(0)+'"/>'+
    '<line class="conditioned-axis" x1="'+left+'" x2="'+left+'" y1="'+top+'" y2="'+toY(0)+'"/>'+bars+'</svg>';
}
export function demoConditionedRows() {
  // Únicamente para la vista demostrativa del despliegue preview, nunca persiste.
  const nue=[1,1,2,3,2,4,2,1,2],sol=[0,1,1,1,0,1,1,0,1],rows=[];
  for(let i=0;i<9;i++){
    const preparada='2026-11-'+String(i+1).padStart(2,'0');
    for(let j=0;j<nue[i];j++)rows.push({codigo:'T'+String(10001+i*10+j),origen:'nueva',preparada});
    for(let j=0;j<sol[i];j++)rows.push({codigo:'P'+String(40001+i*10+j),origen:'solicitada',preparada});
  }
  return rows;
}
export function attachPreparedMonthlyKpi({repository,isAdmin,appReady}) {
  const el=id=>document.getElementById(id);
  const modal=el('conditionedMonthlySheet'),metric=el('monthlyBoxesConditioned'),
    note=el('conditionedMonthlyNote');
  const params=new URLSearchParams(window.location.search);
  const demo=params.get('demo-kpi')==='1' && /-ztmy1\.vercel\.app$/i.test(window.location.hostname)
    && !['kardex-digital-santa-anita-ztmy1.vercel.app','kardex-digital-santa-anita-git-main-ztmy1.vercel.app'].includes(window.location.hostname);
  let view='dia',summary=null,request=0;
  const format=n=>new Intl.NumberFormat('es-PE').format(n);
  const formatMonth=value=>{
    const [year,month]=value.split('-').map(Number);
    return new Intl.DateTimeFormat('es-PE',{month:'long',year:'numeric',timeZone:'America/Lima'}).format(new Date(Date.UTC(year,month-1,1)));
  };
  function render(){
    if(!modal.open)return;
    for(const button of modal.querySelectorAll('[data-prepared-period]')) {
      const active=button.dataset.preparedPeriod===view;
      button.setAttribute('aria-selected',String(active));
      button.tabIndex=active?0:-1;
    }
    const chart=el('conditionedMonthlyChart'),status=el('conditionedMonthlyStatus');
    if(!summary){
      chart.innerHTML='<p class="conditioned-empty">Consultando registros de acondicionamiento…</p>';
      return;
    }
    el('conditionedDataSource').textContent=demo?'Datos de ejemplo':'Datos de acondicionamiento';
    el('conditionedMonthlyPending').textContent=format(summary.mesPendientes);
    el('conditionedMonthlyNew').textContent=format(summary.pendientesNuevas)+' cajas nuevas';
    el('conditionedMonthlyRequested').textContent=format(summary.pendientesSolicitadas)+' cajas solicitadas acondicionadas';
    el('conditionedPeriodLabel').textContent=
      formatMonth(summary.currentMonth)+' · Pendientes de envío a IM';
    const buckets=timeline(summary,view);
    chart.innerHTML=groupedChartSvg(buckets);
    status.textContent=demo
      ? 'Datos ilustrativos, no extraídos del aplicativo. Prueba los filtros Día, Semana, Mes y Año.'
      : 'La gráfica mide cajas preparadas en cada periodo y conserva el historial incluso después del envío. El número principal solo incluye las preparadas este mes que siguen pendientes de envío.';
  }
  async function refresh(){
    if(!demo && (!isAdmin()||!appReady()))return;
    const current=++request;
    try {
      const data=demo
        ? {listado:demoConditionedRows()}
        : await repository.conditioning('listar');
      if(current!==request || (!demo && (!isAdmin()||!appReady())))return;
      if(!data || !Array.isArray(data.listado))throw new Error('Respuesta no disponible');
      summary=summarizeConditionedBoxes(data.listado,demo?new Date('2026-11-09T20:00:00-05:00'):new Date());
      metric.textContent=format(summary.mesPendientes);
      note.textContent='Preparadas este mes · Pendientes de envío a IM';
      render();
    } catch {
      if(current!==request)return;
      summary=null;metric.textContent='—';
      note.textContent='No se pudo consultar Acondicionamiento';
      if(modal.open)el('conditionedMonthlyChart').innerHTML=
        '<p class="conditioned-empty">No se pudieron consultar las cajas acondicionadas.</p>';
    }
  }
  modal.querySelectorAll('[data-prepared-period]').forEach(button=>
    button.addEventListener('click',()=>{view=button.dataset.preparedPeriod;render();}));
  el('btnCloseConditionedMonthly').addEventListener('click',()=>modal.close());
  const controller={
    refresh,
    open(){
      if(!demo && (!isAdmin()||!appReady()))return;
      view='dia';
      if(!modal.open)modal.showModal();
      render();void refresh();
    }
  };
  if(demo)window.requestAnimationFrame(()=>controller.open());
  return controller;
}
