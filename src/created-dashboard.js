import { renderCargoLineChart } from './cargo-line-chart.js';

const MONTHS = ['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'];
const FULL_MONTHS = ['enero','febrero','marzo','abril','mayo','junio','julio',
  'agosto','septiembre','octubre','noviembre','diciembre'];
const COMPARE_COLORS = {
  2020:'#7e8999',2021:'#9464c9',2022:'#cb8832',2023:'#d96673',
  2024:'#a3a04c',2025:'#149b76',2026:'#2b7bdc'
};
const fmt = n => Number(n).toLocaleString('es-PE');
const sumValid = (values, start, end) =>
  values.slice(start,end).reduce((sum,n)=>sum+(Number.isFinite(n)?n:0),0);
const nameOf = month => FULL_MONTHS[month-1];

/**
 * Dashboard de cargos realizados, solo lectura. Ambas vistas comparten
 * un único contenedor de SVG; no se crea una segunda gráfica.
 */
export function createCreatedDashboard() {
  const root = document.getElementById('createdDashboard');
  const yearEl = document.getElementById('createdDashboardYear');
  const monthEl = document.getElementById('createdDashboardMonth');
  const individualButton = document.getElementById('createdDashboardModeIndividual');
  const compareButton = document.getElementById('createdDashboardModeCompare');
  const filters = document.getElementById('createdDashboardFilters');
  const stats = root.querySelector('.created-dashboard-stats');
  const comparisonStats = document.getElementById('createdDashboardComparisonStats');
  const comparisonCards = document.getElementById('createdDashboardComparisonCards');
  const comparisonHighlight = document.getElementById('createdDashboardComparisonHighlight');
  const comparison = document.getElementById('createdDashboardCompareFilters');
  const comparisonYears = document.getElementById('createdDashboardCompareYears');
  const comparisonNote = document.getElementById('createdDashboardCompareNote');
  const recentButton = document.getElementById('createdDashboardCompareRecent');
  const surface = document.getElementById('createdDashboardChart');
  const legend = document.getElementById('createdDashboardLegend');
  const periodMeta = document.getElementById('createdDashboardMeta');
  const status = document.getElementById('createdDashboardStatus');
  const title = document.getElementById('createdDashboardChartTitle');
  const chartBadge = document.getElementById('createdDashboardChartBadge');
  const explain = document.getElementById('createdDashboardExplain');
  const footnote = document.getElementById('createdDashboardFootnote');
  const periodLabel = document.getElementById('createdDashboardSelectionLabel');
  let data = null;
  let mode = 'individual';
  let selectedYear = null;
  let selectedMonth = null;
  let comparisonSelection = null;
  let lastChartWidth = 0;

  const text = (id, value) => { document.getElementById(id).textContent = value; };
  const datedValues = year => data.comparison.find(row=>row.year===year)?.values ?? Array(12).fill(0);
  const annualTotal = year => data.annual.find(row=>row.year===year)?.count ?? 0;

  function syncYears() {
    const years = data.annual.map(row=>row.year);
    if(!years.includes(selectedYear))selectedYear=data.currentYear;
    const key = years.join(',');
    if(yearEl.dataset.years !== key) {
      yearEl.replaceChildren();
      for(const year of [...years].reverse())yearEl.add(new Option(String(year),String(year)));
      yearEl.dataset.years = key;
    }
    yearEl.value=String(selectedYear);

    if(comparisonSelection === null) {
      comparisonSelection = new Set(years.slice(-2));
    } else {
      comparisonSelection = new Set([...comparisonSelection].filter(year=>years.includes(year)));
    }
    if(comparisonYears.dataset.years!==key) {
      comparisonYears.replaceChildren();
      for(const year of [...years].reverse()) {
        const color=COMPARE_COLORS[year] || '#64748b';
        const label=document.createElement('label');
        label.className='created-dashboard-year-option';
        label.style.setProperty('--series-color',color);
        const checkbox=document.createElement('input');
        checkbox.type='checkbox';
        checkbox.value=String(year);
        checkbox.name='comparison-year';
        const swatch=document.createElement('span');
        swatch.className='series-swatch';
        const yearText=document.createElement('span');
        yearText.textContent=String(year);
        label.append(checkbox,swatch,yearText);
        comparisonYears.append(label);
      }
      comparisonYears.dataset.years=key;
    }
    for(const input of comparisonYears.querySelectorAll('input[name="comparison-year"]')) {
      input.checked=comparisonSelection.has(Number(input.value));
    }
    return years;
  }

  function drawGraph(categories, lines, showLabels, highlightIndex=null) {
    status.hidden=true;
    surface.hidden=false;
    legend.hidden=false;
    const measuredWidth=Math.round(surface.getBoundingClientRect().width);
    const chartWidth=Math.max(700,measuredWidth||960);
    // Mantiene una zona de datos amplia sin desperdiciar altura bajo los meses.
    const chartHeight=Math.round(Math.min(590,Math.max(445,chartWidth*0.46)));
    renderCargoLineChart(surface,legend,categories,lines,{
      showLabels,width:chartWidth,height:chartHeight,fontSize:14,highlightIndex,compactLayout:true
    });
    lastChartWidth=measuredWidth;
  }

  function renderIndividual() {
    if(selectedMonth===null)selectedMonth=selectedYear===data.currentYear?data.currentMonth:0;
    const upper=selectedYear===data.currentYear?data.currentMonth:12;
    monthEl.replaceChildren();
    monthEl.add(new Option('Todos los meses','all'));
    for(let i=1;i<=upper;i++){
      const month=nameOf(i);
      monthEl.add(new Option(month[0].toUpperCase()+month.slice(1),String(i)));
    }
    if(selectedMonth>upper)selectedMonth=upper;
    monthEl.value=selectedMonth===0?'all':String(selectedMonth);

    const series=datedValues(selectedYear);
    const range=selectedMonth||upper;
    const validYearCount=sumValid(series,0,upper);
    const currentCount=selectedMonth
      ? (Number.isFinite(series[selectedMonth-1])?series[selectedMonth-1]:0)
      : validYearCount;

    let previousCount=null, previousLabel='', comparisonKind='';
    if(selectedMonth){
      const priorYear=selectedMonth===1?selectedYear-1:selectedYear;
      const priorMonth=selectedMonth===1?12:selectedMonth-1;
      const priorSeries=data.comparison.find(v=>v.year===priorYear)?.values;
      const value=priorSeries?.[priorMonth-1];
      previousCount=Number.isFinite(value)?value:null;
      previousLabel=nameOf(priorMonth)+' de '+priorYear;
      comparisonKind='mensual';
    }else{
      const priorYear=selectedYear-1;
      const priorSeries=data.comparison.find(v=>v.year===priorYear)?.values;
      previousCount=priorSeries?sumValid(priorSeries,0,upper):null;
      previousLabel='enero–'+nameOf(upper)+' de '+priorYear;
      comparisonKind='interanual';
    }

    const difference=previousCount===null?null:currentCount-previousCount;
    const variance=previousCount>0?(difference/previousCount*100):null;
    const varianceText=variance===null?'—':
      (variance>0?'+':'')+variance.toLocaleString('es-PE',
        {minimumFractionDigits:1,maximumFractionDigits:1})+'%';
    const accumulated=sumValid(series,0,range);
    const missingDate=Math.max(0,annualTotal(selectedYear)-validYearCount);

    text('createdDashboardSelected',fmt(currentCount));
    text('createdDashboardAnnual',previousCount===null?'—':fmt(previousCount));
    text('createdDashboardDated',varianceText);
    text('createdDashboardUndated',fmt(selectedMonth?accumulated:annualTotal(selectedYear)));
    text('createdDashboardSelectedLabel',selectedMonth?'CARGOS DEL MES SELECCIONADO':'CARGOS CON FECHA DEL PERÍODO');
    text('createdDashboardSelectedNote',selectedMonth?
      nameOf(selectedMonth)+' de '+selectedYear:'Enero–'+nameOf(upper)+' de '+selectedYear);
    text('createdDashboardPreviousLabel',selectedMonth?'CARGOS DEL MES ANTERIOR':'CARGOS DEL AÑO ANTERIOR');
    text('createdDashboardPreviousNote',previousCount===null?'Sin datos históricos para comparar':previousLabel);
    text('createdDashboardVariationLabel','VARIACIÓN '+comparisonKind.toUpperCase());
    text('createdDashboardVariationNote',variance===null?
      (previousCount===0?'Sin variación porcentual: base 0':'Sin período comparable'):
      (difference>=0?'+':'')+fmt(difference)+' cargos respecto a '+
      (selectedMonth?'mes anterior':'período equivalente'));
    text('createdDashboardAccumulatedLabel',selectedMonth?'ACUMULADO DEL AÑO':'TOTAL DE CARGOS DEL AÑO');
    text('createdDashboardAccumulatedNote',selectedMonth?
      'Enero–'+nameOf(selectedMonth)+' · con fecha válida':
      fmt(missingDate)+' sin fecha válida incluidos en el total');
    const variationCard=document.getElementById('createdDashboardDated').closest('.created-stat');
    variationCard.dataset.trend=variance===null?'unavailable':variance>0?'up':variance<0?'down':'flat';

    const period=selectedMonth?nameOf(selectedMonth)+' de '+selectedYear:
      'enero–'+nameOf(upper)+' de '+selectedYear;
    periodLabel.textContent=selectedMonth?'Cargos realizados en '+period:'Cargos realizados entre '+period;
    title.textContent='Evolución de cargos realizados';
    chartBadge.textContent=String(selectedYear);
    explain.textContent=selectedMonth
      ? nameOf(selectedMonth)[0].toUpperCase()+nameOf(selectedMonth).slice(1)+
        ': '+fmt(currentCount)+' cargos · enero a diciembre.'
      : 'Enero a diciembre · sin mes destacado.';
    const futureMonths=selectedYear===data.currentYear && upper<12;
    footnote.textContent=fmt(missingDate)+' cargos de '+selectedYear+
      ' sin fecha original válida se conservan en el histórico anual, no se asignan a ningún mes.'+
      (futureMonths?' Los meses posteriores a '+nameOf(upper)+' quedan sin puntos hasta que existan registros.':'');

    // Mantener los doce meses en el eje horizontal, pero nunca mostrar futuros como cero.
    const annualSeries=MONTHS.map((_,index)=>
      selectedYear===data.currentYear && index>=upper ? null : series[index] ?? 0
    );
    drawGraph(MONTHS,[
      {label:String(selectedYear),color:'#c6253e',values:annualSeries,width:3.4}
    ],true,selectedMonth?selectedMonth-1:null);
  }

  function renderComparisonCards(selected, upper) {
    // Conteo por fecha original válida. El mismo corte mensual se aplica a
    // todos los años comparados (no se suman registros sin fecha verificable).
    comparisonCards.replaceChildren();
    const period=upper===12?'enero a diciembre':'enero a '+nameOf(upper);
    const rows=selected.map(year=>({
      year,count:sumValid(datedValues(year),0,upper),
      color:COMPARE_COLORS[year] || '#64748b'
    }));
    for(const item of rows) {
      const card=document.createElement('article');
      card.className='created-comparison-card';
      card.style.setProperty('--comparison-color',item.color);
      const heading=document.createElement('div');
      heading.className='created-comparison-year';
      const dot=document.createElement('span');
      dot.className='created-comparison-swatch';
      dot.setAttribute('aria-hidden','true');
      const yearLabel=document.createElement('span');
      yearLabel.textContent=String(item.year);
      heading.append(dot,yearLabel);
      const count=document.createElement('strong');
      count.className='created-comparison-number';
      count.textContent=fmt(item.count);
      const description=document.createElement('span');
      description.className='created-comparison-label';
      description.textContent='Cargos · '+period+' (fecha válida)';
      card.append(heading,count,description);
      comparisonCards.append(card);
    }
    if(!rows.length) {
      const empty=document.createElement('p');
      empty.className='created-comparison-empty';
      empty.textContent='Selecciona uno o más años para ver sus indicadores.';
      comparisonCards.append(empty);
      comparisonHighlight.hidden=true;
      return;
    }
    const sorted=[...rows].sort((a,b)=>b.count-a.count || b.year-a.year);
    if(sorted.length===1) {
      comparisonHighlight.textContent='Selecciona otro año para comparar resultados del mismo período.';
    } else {
      const most=sorted[0],second=sorted[1],difference=most.count-second.count;
      comparisonHighlight.textContent=difference===0
        ? 'Mayor actividad compartida: '+sorted.filter(row=>row.count===most.count)
            .map(row=>row.year).join(', ')+' · '+fmt(most.count)+' cargos cada uno ('+period+').'
        : 'Mayor actividad: '+most.year+' con '+fmt(most.count)+
          ' cargos; '+fmt(difference)+' más que '+second.year+
          ' (segundo mayor), en el período '+period+'.';
    }
    comparisonHighlight.hidden=false;
  }

  function renderComparison(years) {
    const selected=[...years].filter(year=>comparisonSelection.has(year)).sort((a,b)=>a-b);
    // Si está incluido el año en curso, la comparación se realiza hasta
    // el mes actual para TODOS los años; si no, son doce meses completos.
    const upper=selected.includes(data.currentYear)?data.currentMonth:12;
    const period=upper===12?'enero a diciembre':'enero a '+nameOf(upper);
    comparisonNote.textContent=selected.length
      ? 'Comparando '+selected.join(', ')+' · '+period+
        '. Todos los años usan el mismo período; sin fechas válidas no se asignan cargos a un mes.'
      : 'Selecciona al menos un año para mostrar su evolución.';
    periodLabel.textContent=selected.length
      ? 'Comparando: '+selected.join(', ')
      : 'Elige uno o más años para comparar';
    title.textContent='Comparación de cargos realizados';
    chartBadge.textContent=selected.length===1?String(selected[0]):selected.length+' años';
    explain.textContent=selected.length===1?'Evolución mensual de '+selected[0]:
      selected.length+' años en una sola gráfica';
    footnote.textContent='Las tarjetas y la gráfica comparan cargos únicos con fecha original válida, de '+
      period+'. Se excluyen cargos sin fecha válida del desglose mensual.';
    renderComparisonCards(selected,upper);
    if(!selected.length){
      surface.replaceChildren();
      legend.replaceChildren();
      surface.hidden=true;
      legend.hidden=true;
      status.textContent='Selecciona uno o más años para comparar.';
      status.hidden=false;
      return;
    }
    const lines=selected.map(year=>({
      label:String(year),color:COMPARE_COLORS[year]||'#64748b',
      values:datedValues(year).map((value,index)=>index>=upper?null:value),width:3.1
    }));
    drawGraph(MONTHS,lines,selected.length<=2);
  }

  function render(){
    if(!data)return;
    const years=syncYears();
    const individual=mode==='individual';
    individualButton.setAttribute('aria-pressed',String(individual));
    compareButton.setAttribute('aria-pressed',String(!individual));
    stats.hidden=!individual;
    comparisonStats.hidden=individual;
    filters.hidden=!individual;
    comparison.hidden=individual;
    if(individual)renderIndividual();
    else renderComparison(years);
    // Una sola leyenda inferior: vista individual muestra año y resumen,
    // comparación muestra las series de colores existentes sin duplicar datos.
    periodMeta.hidden=!individual;
    legend.hidden=individual || !comparisonSelection || comparisonSelection.size===0;
  }

  individualButton.addEventListener('click',()=>{mode='individual';render();});
  compareButton.addEventListener('click',()=>{mode='compare';render();});
  yearEl.addEventListener('change',()=>{
    selectedYear=Number(yearEl.value);
    selectedMonth=selectedYear===data?.currentYear?data.currentMonth:0;
    render();
  });
  monthEl.addEventListener('change',()=>{
    selectedMonth=monthEl.value==='all'?0:Number(monthEl.value);
    render();
  });
  comparisonYears.addEventListener('change',event=>{
    const input=event.target.closest('input[name="comparison-year"]');
    if(!input)return;
    const year=Number(input.value);
    if(input.checked)comparisonSelection.add(year);
    else comparisonSelection.delete(year);
    render();
  });
  recentButton.addEventListener('click',()=>{
    if(!data)return;
    comparisonSelection=new Set(data.annual.map(row=>row.year).slice(-2));
    render();
  });
  if(typeof ResizeObserver!=='undefined'){
    const observer=new ResizeObserver(entries=>{
      const width=Math.round(entries[0]?.contentRect?.width||0);
      if(data && width>0 && Math.abs(width-lastChartWidth)>2)render();
    });
    observer.observe(surface);
  }else{
    window.addEventListener('resize',()=>{if(data)render();});
  }
  return summary=>{
    data=summary;
    if(!data){
      status.textContent='Consultando cargos realizados…';
      status.hidden=false;
      surface.hidden=true;
      legend.hidden=true;
      return;
    }
    render();
  };
}
