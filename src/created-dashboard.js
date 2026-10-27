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
  const comparison = document.getElementById('createdDashboardCompareFilters');
  const comparisonYears = document.getElementById('createdDashboardCompareYears');
  const comparisonNote = document.getElementById('createdDashboardCompareNote');
  const recentButton = document.getElementById('createdDashboardCompareRecent');
  const surface = document.getElementById('createdDashboardChart');
  const legend = document.getElementById('createdDashboardLegend');
  const status = document.getElementById('createdDashboardStatus');
  const title = document.getElementById('createdDashboardChartTitle');
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
    const chartHeight=Math.round(Math.min(560,Math.max(430,chartWidth*0.51)));
    renderCargoLineChart(surface,legend,categories,lines,{
      showLabels,width:chartWidth,height:chartHeight,fontSize:14,highlightIndex
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
    title.textContent='Evolución mensual de cargos realizados · '+selectedYear;
    explain.textContent=selectedMonth
      ? nameOf(selectedMonth)[0].toUpperCase()+nameOf(selectedMonth).slice(1)+
        ' seleccionado: '+fmt(currentCount)+' cargos · evolución anual completa.'
      : 'Todos los meses disponibles de '+selectedYear+' · sin mes destacado.';
    footnote.textContent=fmt(missingDate)+' cargos de '+selectedYear+
      ' sin fecha original válida del mismo año se conservan en el histórico anual, no se asignan a ningún mes.';

    // El mes seleccionado cambia los KPI y se resalta en el gráfico.
    // La serie siempre muestra todos los meses disponibles del año.
    drawGraph(MONTHS.slice(0,upper),[
      {label:String(selectedYear),color:'#c6253e',values:series.slice(0,upper),width:3.4}
    ],true,selectedMonth?selectedMonth-1:null);
  }

  function renderComparison(years) {
    const selected=[...years].filter(year=>comparisonSelection.has(year)).sort((a,b)=>a-b);
    comparisonNote.textContent=selected.length
      ? 'Comparando '+selected.join(', ')+' · meses enero a diciembre. Los meses futuros del año actual no se cuentan.'
      : 'Selecciona al menos un año para mostrar su evolución.';
    title.textContent='Comparación de cargos realizados · '+(selected.length?selected.join(' vs. '):'sin años seleccionados');
    explain.textContent=selected.length===1?'Evolución mensual de '+selected[0]:
      selected.length+' años seleccionados';
    footnote.textContent='Se comparan cargos únicos con fecha original válida. Los cargos sin fecha válida permanecen en el histórico y no se inventan fechas.';
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
      values:datedValues(year),width:3.1
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
    filters.hidden=!individual;
    comparison.hidden=individual;
    if(individual)renderIndividual();
    else renderComparison(years);
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
