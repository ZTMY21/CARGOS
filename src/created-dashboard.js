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
    const countIn=(arr,start,end)=>arr.slice(start,end).reduce((sum,n)=>sum+(Number.isFinite(n)?n:0),0);
    const validYearCount=countIn(series,0,upper);
    const currentCount=selectedMonth
      ? (Number.isFinite(series[selectedMonth-1])?series[selectedMonth-1]:0)
      : validYearCount;
    let previousCount=null, previousLabel='', comparisonKind='';
    if(selectedMonth){
      const previousYear=selectedMonth===1?selectedYear-1:selectedYear;
      const previousMonth=selectedMonth===1?12:selectedMonth-1;
      const previousSeries=data.comparison.find(v=>v.year===previousYear)?.values;
      const previousValue=previousSeries?.[previousMonth-1];
      previousCount=Number.isFinite(previousValue)?previousValue:null;
      previousLabel=FULL_MONTHS[previousMonth-1]+' de '+previousYear;
      comparisonKind='mensual';
    }else{
      const priorYear=selectedYear-1;
      const previousSeries=data.comparison.find(v=>v.year===priorYear)?.values;
      previousCount=previousSeries?countIn(previousSeries,0,upper):null;
      previousLabel='enero–'+FULL_MONTHS[upper-1]+' de '+priorYear;
      comparisonKind='interanual';
    }
    const difference=previousCount===null?null:currentCount-previousCount;
    const variance=previousCount>0?(difference/previousCount*100):null;
    const varianceText=variance===null?'—':
      (variance>0?'+':'')+variance.toLocaleString('es-PE',{minimumFractionDigits:1,maximumFractionDigits:1})+'%';
    const accumulated=countIn(series,0,selectedMonth||upper);
    const latestYearCount=data.annual.find(v=>v.year===selectedYear)?.count||0;
    const missingDate=Math.max(0,latestYearCount-validYearCount);
    const text=(id,value)=>{document.getElementById(id).textContent=value;};
    text('createdDashboardSelected',fmt(currentCount));
    text('createdDashboardAnnual',previousCount===null?'—':fmt(previousCount));
    text('createdDashboardDated',varianceText);
    text('createdDashboardUndated',fmt(selectedMonth?accumulated:latestYearCount));
    text('createdDashboardSelectedLabel',selectedMonth?'CARGOS DEL MES SELECCIONADO':'CARGOS CON FECHA DEL PERÍODO');
    text('createdDashboardSelectedNote',selectedMonth?
      FULL_MONTHS[selectedMonth-1]+' de '+selectedYear:'Enero–'+FULL_MONTHS[upper-1]+' de '+selectedYear);
    text('createdDashboardPreviousLabel',selectedMonth?'CARGOS DEL MES ANTERIOR':'CARGOS DEL AÑO ANTERIOR');
    text('createdDashboardPreviousNote',previousCount===null?
      'Sin datos históricos para comparar':previousLabel);
    text('createdDashboardVariationLabel','VARIACIÓN '+comparisonKind.toUpperCase());
    text('createdDashboardVariationNote',variance===null?
      (previousCount===0?'Sin variación porcentual: base 0':'Sin período comparable'):
      (difference>=0?'+':'')+fmt(difference)+' cargos respecto a '+(selectedMonth?'mes anterior':'período equivalente'));
    text('createdDashboardAccumulatedLabel',selectedMonth?'ACUMULADO DEL AÑO':'TOTAL DE CARGOS DEL AÑO');
    text('createdDashboardAccumulatedNote',selectedMonth?
      'Enero–'+FULL_MONTHS[selectedMonth-1]+' · con fecha válida':
      fmt(missingDate)+' sin fecha válida incluidos en el total');
    const variationCard=document.getElementById('createdDashboardDated').closest('.created-stat');
    variationCard.dataset.trend=variance===null?'unavailable':variance>0?'up':variance<0?'down':'flat';
    const period=selectedMonth?FULL_MONTHS[selectedMonth-1]+' de '+selectedYear
      : 'enero–'+FULL_MONTHS[upper-1]+' de '+selectedYear;
    document.getElementById('createdDashboardSelectionLabel').textContent=selectedMonth
      ? 'Cargos realizados en '+period : 'Cargos realizados entre '+period;
    document.getElementById('createdDashboardChartTitle').textContent='Evolución mensual de cargos realizados · '+selectedYear;
    document.getElementById('createdDashboardExplain').textContent=selectedMonth
      ? 'Se muestra la evolución desde enero hasta '+FULL_MONTHS[range-1]+'.'
      : 'Se muestra la evolución mensual del año seleccionado.';
    document.getElementById('createdDashboardFootnote').textContent=
      fmt(missingDate)+' cargos de '+selectedYear+' sin fecha original válida del mismo año se contabilizan en el histórico anual, no se asignan a ningún mes.';
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
