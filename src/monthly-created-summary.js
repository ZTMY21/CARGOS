// Resumen de cargos realizados. La clasificación por mes usa la fecha original
// de cada cargo; los importados antiguos sin fecha no se consideran altas del mes.
function asYear(value){
  const year=Number(value);
  return Number.isInteger(year) && year>=2020 && year<=9999 ? year : null;
}
function validIsoDate(value){
  const raw=String(value??'').trim();
  let iso='';
  if(/^\d{4}-\d{2}-\d{2}(?:$|T|\s)/.test(raw))iso=raw.slice(0,10);
  else {
    const match=raw.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
    if(match)iso=`${match[3]}-${match[2].padStart(2,'0')}-${match[1].padStart(2,'0')}`;
  }
  if(!iso)return null;
  const d=new Date(iso+'T00:00:00Z');
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0,10)===iso ? iso : null;
}
function cargoCode(value){
  return String(value??'').trim().replace(/\.0+$/,'').replace(/^0+(?=\d)/,'').toUpperCase();
}
export function summarizeCreatedCargos(docs,now=new Date()){
  const todayParts=new Intl.DateTimeFormat('en-CA',{
    timeZone:'America/Lima',year:'numeric',month:'2-digit',day:'2-digit'
  }).formatToParts(now);
  const part=key=>Number(todayParts.find(p=>p.type===key)?.value);
  const currentYear=part('year'),currentMonth=part('month');
  const yearSets=new Map();
  const canonical=new Map();
  for(const doc of docs||[]){
    const sourceYear=asYear(doc.anioOrigen)||asYear(String(doc.periodo??'').slice(0,4))
      ||asYear(String(doc.fechaOrigen??'').slice(0,4));
    if(sourceYear===null)continue;
    const sourceDate=validIsoDate(doc.fechaOrigen);
    // Solo para altas nuevas del año actual se permite fecha de registro
    // si falta la original. Importaciones históricas nunca usan esta fecha.
    const date=sourceDate||(sourceYear===currentYear?validIsoDate(doc.fechaRegistro):null);
    if(!yearSets.has(sourceYear))yearSets.set(sourceYear,new Set());
    for(const value of doc.cargos||[]){
      const code=cargoCode(value);
      if(!code)continue;
      const key=sourceYear+':'+code;
      yearSets.get(sourceYear).add(key);
      const previous=canonical.get(key);
      if(!previous || (date&&(!previous.date||date<previous.date)))
        canonical.set(key,{year:sourceYear,date});
    }
  }
  const monthly=Array.from({length:currentMonth},(_,i)=>({
    month:i+1,count:0
  }));
  let yearDated=0;
  for(const item of canonical.values()){
    if(item.year!==currentYear || !item.date || Number(item.date.slice(0,4))!==currentYear)continue;
    const month=Number(item.date.slice(5,7));
    if(month>=1 && month<=currentMonth){monthly[month-1].count++;yearDated++;}
  }
  const annual=Array.from({length:Math.max(0,currentYear-2020+1)},(_,i)=>({
    year:2020+i,count:yearSets.get(2020+i)?.size||0
  }));
  const annualCurrent=yearSets.get(currentYear)?.size||0;
  return {
    currentYear,currentMonth,currentCount:monthly.at(-1)?.count||0,
    monthly,annual,monthlyTotal:yearDated,
    annualTotal:annual.reduce((sum,row)=>sum+row.count,0),
    undatedInCurrentYear:Math.max(0,annualCurrent-yearDated)
  };
}
