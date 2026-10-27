import { renderCargoLineChart } from './cargo-line-chart.js';

const MONTHS=['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'];
const FULL_MONTHS=['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'];
const fmt=n=>Number(n).toLocaleString('es-PE');

// Sólo dibuja datos que ya calcula el Kardex. No escribe datos ni recalcula estados IM.
export function createCreatedDashboard() {
  const root=document.getElementById('createdDashboard');
  const yearEl=document.getElementById('createdDashboardYear');
  const monthEl=document.getElementById('createdDashboardMonth');
  const surface=document.getElementById('createdDashboardChart');
  const legend=document.getElementById('createdDashboardLegend');
  const status=document.getElementById('createdDashboardStatus');
  let selectedYear=null;
  let selectedMonth=null;
  let data=null;
  let lastChartWidth=0;
  function render(){
    if(!data)return;
    const years=data.annual.map(v=>v.year);
    if(!years.includes(selectedYear))selectedYear=data.currentYear;
    const key=years.join(',');
    if(yearEl.dataset.years!==key){
      yearEl.replaceChildren();
      for(const year of years.slice().reverse())yearEl.add(new Option(String(year),String(year)));
      yearEl.dataset.years=key;
    }
    yearEl.value=String(selectedYear);
    if(selectedMonth===null)selectedMonth=selectedYear===data.currentYear?data.currentMonth:0;
    const upper=selectedYear===data.currentYear?data.currentMonth:12;
    monthEl.replaceChildren();
    monthEl.add(new Option('Todos los meses', 'all'));
    for(let i=1;i<=upper;i++)monthEl.add(new Option(FULL_MONTHS[i-1][0].toUpperCase()+FULL_MONTHS[i-1].slice(1),String(i)));
    if(selectedMonth>upper)selectedMonth=upper;
    monthEl.value=selectedMonth===0?'all':String(selectedMonth);
    const series=data.comparison.find(v=>v.year===selectedYear)?.values||Array(12).fill(0);
    const range=selectedMonth||upper;
    const annual=data.annual.find(v=>v.year===selectedYear)?.count||0;
    const dated=series.reduce((sum,v)=>sum+(Number.isFinite(v)?v:0),0);
    const selected=selectedMonth?series[selectedMonth-1]||0:dated;
    const undated=Math.max(0,annual-dated);
    document.getElementById('createdDashboardSelected').textContent=fmt(selected);
    document.getElementById('createdDashboardAnnual').textContent=fmt(annual);
    document.getElementById('createdDashboardDated').textContent=fmt(dated);
    document.getElementById('createdDashboardUndated').textContent=fmt(undated);
    const period=selectedMonth?FULL_MONTHS[selectedMonth-1]+' de '+selectedYear
      : 'enero–'+FULL_MONTHS[upper-1]+' de '+selectedYear;
    document.getElementById('createdDashboardSelectionLabel').textContent=selectedMonth
      ? 'Cargos realizados en '+period : 'Cargos realizados entre '+period;
    document.getElementById('createdDashboardChartTitle').textContent='Evolución mensual de cargos realizados · '+selectedYear;
    document.getElementById('createdDashboardExplain').textContent=selectedMonth
      ? 'Se muestra la evolución desde enero hasta '+FULL_MONTHS[range-1]+'.'
      : 'Se muestra la evolución mensual del año seleccionado.';
    document.getElementById('createdDashboardFootnote').textContent=
      fmt(undated)+' cargos de '+selectedYear+' sin fecha original válida del mismo año se contabilizan en el total anual, no en los meses.';
    const values=series.slice(0,range);
    status.hidden=true;
    surface.hidden=false;
    legend.hidden=false;
    // Adaptar el lienzo al ancho REAL disponible, también al contraer el menú
    // o cambiar el zoom del navegador. La altura no queda limitada a 340px.
    const measuredWidth=Math.round(surface.getBoundingClientRect().width);
    const chartWidth=Math.max(700,measuredWidth||960);
    const chartHeight=Math.round(Math.min(560,Math.max(430,chartWidth*0.51)));
    renderCargoLineChart(surface,legend,MONTHS.slice(0,range),[
      {label:String(selectedYear),color:'#c6253e',values,width:3.4}
    ],{showLabels:true,width:chartWidth,height:chartHeight,fontSize:14});
    lastChartWidth=measuredWidth;
  }
  yearEl.addEventListener('change',()=>{
    selectedYear=Number(yearEl.value);
    selectedMonth=selectedYear===data?.currentYear?data.currentMonth:0;
    render();
  });
  monthEl.addEventListener('change',()=>{
    selectedMonth=monthEl.value==='all'?0:Number(monthEl.value);
    render();
  });
  // Sólo vuelve a dibujar si cambia el ancho, no si cambia la altura del SVG.
  // Esto evita bucles de ResizeObserver en Chrome y mantiene filtros intactos.
  if(typeof ResizeObserver!=='undefined'){
    const resizeObserver=new ResizeObserver(entries=>{
      const width=Math.round(entries[0]?.contentRect?.width||0);
      if(data && width>0 && Math.abs(width-lastChartWidth)>2)render();
    });
    resizeObserver.observe(surface);
  }else{
    window.addEventListener('resize',()=>{if(data)render();});
  }
  return summary=>{
    data=summary;
    if(!data){
      status.textContent='Consultando cargos realizados…';
      status.hidden=false;surface.hidden=true;legend.hidden=true;
      return;
    }
    render();
  };
}
