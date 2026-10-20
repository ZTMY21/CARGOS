import { computeDocEstado, limaDate } from './rules.js';
import { cargoYear } from './cargo-details.js';

// Un envío se cuenta por su fecha efectiva de salida a Iron Mountain, no por
// la fecha de registro del documento ni por el año de origen del cargo.
function dateOnly(value){
  const input=String(value??'').trim();
  const raw=/^\d{4}-\d{2}-\d{2}(?:$|[T\s])/.test(input)?input.slice(0,10):'';
  if(!raw)return null;
  const parsed=new Date(raw+'T00:00:00Z');
  return Number.isFinite(parsed.getTime())&&parsed.toISOString().slice(0,10)===raw?raw:null;
}
function cargoCode(value){
  return String(value??'').trim().replace(/\.0+$/,'')
    .replace(/^0+(?=\d)/,'').toUpperCase();
}
export function summarizeShippedCargos(docs, now=new Date()){
  const today=limaDate(now);
  const currentYear=Number(today.slice(0,4)),currentMonth=Number(today.slice(5,7));
  const unique=new Map();
  let undated=0;
  for(const d of docs||[]){
    if(computeDocEstado(d,now).estado!=='Enviado a Iron Mountain')continue;
    const sent=dateOnly(d.imConfirmado ? d.imFechaEnvio||d.fEnvio : d.fEnvio||d.imFechaEnvio);
    if(!sent){undated+=(d.cargos||[]).length;continue;}
    if(sent>today)continue;
    const yearOfCargo=cargoYear(d);
    for(const raw of d.cargos||[]){
      const code=cargoCode(raw);
      if(!code)continue;
      const key=yearOfCargo+':'+code;
      // Un mismo cargo puede aparecer en varias facturas: fecha efectiva de
      // su primer envío acreditado, sin duplicar el conteo.
      if(!unique.has(key)||sent<unique.get(key))unique.set(key,sent);
    }
  }
  const annual=[];
  for(let year=2020;year<=currentYear;year++){
    const months=Array.from({length:12},(_,i)=>
      year===currentYear && i>=currentMonth ? null : 0);
    annual.push({year,count:0,months,latest:null});
  }
  const byYear=new Map(annual.map(row=>[row.year,row]));
  let total=0,latest=null;
  for(const sent of unique.values()){
    const year=Number(sent.slice(0,4)),month=Number(sent.slice(5,7));
    const row=byYear.get(year);
    if(!row||!Number.isFinite(row.months[month-1]))continue;
    row.count++;
    row.months[month-1]++;
    row.latest= !row.latest || row.latest<sent ? sent:row.latest;
    latest=!latest||latest<sent?sent:latest;
    total++;
  }
  return {
    currentYear,currentMonth,
    currentCount:byYear.get(currentYear)?.months[currentMonth-1]||0,
    annual,total,latest,undated
  };
}
