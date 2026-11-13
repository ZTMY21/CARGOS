import {cargoYear,sourceRecords} from './cargo-details.js';

export const ORIGINAL_COLUMNS=['Fecha','Cargo','Grupo','Codigo','Archivo_Principal','PDF',
  'Total_Paginas','Tipo','Fuente','Observaciones','ESTADO_REGULARIZADO'];
export const reportCargoCode=value=>String(value??'').trim().replace(/\.0+$/,'').replace(/^0+(?=\d)/,'').toUpperCase();
export function masterDate(value){
  const raw=String(value??'').trim();
  const date=raw.match(/^(\d{1,2})[-/](\d{1,2})[-/](20\d{2})$/);
  const iso=date?date[3]+'-'+date[2].padStart(2,'0')+'-'+date[1].padStart(2,'0'):raw;
  const parsed=new Date(iso+'T00:00:00Z');
  return /^20\d{2}-\d{2}-\d{2}$/.test(iso)&&Number.isFinite(+parsed)&&parsed.toISOString().slice(0,10)===iso?iso:'';
}
export function reportCargoKey(date,cargo){
  const iso=masterDate(date),code=reportCargoCode(cargo);
  if(!iso||!code)throw Error('Fecha o cargo inválido en el maestro de Drive.');
  return iso.slice(0,4)+':'+code;
}

export function indexExistenciasRows(rows,{includeDetails=true}={}){
  const index=new Map();
  for(const values of rows){
    const key=reportCargoKey(values[0],values[1]);
    if(!index.has(key))index.set(key,{rows:[],pages:0,withPages:0,count:0});
    const entry=index.get(key);
    entry.count++;
    const pages=Number(values[6]);
    if(String(values[6]??'').trim()&&Number.isSafeInteger(pages)&&pages>=0){
      entry.pages+=pages;
      entry.withPages++;
    }
    if(includeDetails)entry.rows.push(Object.fromEntries(ORIGINAL_COLUMNS.map((column,i)=>[column,values[i]])));
  }
  return index;
}

export function sourceKey(doc,cargo){
  const year=cargoYear(doc);
  if(year==='2026'||(year==='2025'&&/2026\s*$/i.test(doc.hojaOrigen||'')))return year+':'+reportCargoCode(cargo);
  return null;
}

export function summarizeExistenciasFolios(rows){
  return [...indexExistenciasRows(rows,{includeDetails:false})].map(([key,{pages,withPages,count}])=>
    [key,withPages?pages:count]);
}

export function applyExistenciasFolios(docs,index,{detailRequired=false}={}){
  const found=new Set();
  const rows=docs.map(doc=>{
    const foliosPorCargo=Object.fromEntries((doc.cargos||[]).map(cargo=>{
      const key=sourceKey(doc,cargo),inDrive=index.has(key);
      if(inDrive)found.add(key);
      if(key&&!inDrive&&/google-live\||google-drive\||excel-drive\||CARGOS NUEVOS|Reporte Consolidado/i.test(
        [doc.claveOrigen,doc.hojaOrigen].join(' ')))throw Error('Falta el detalle del cargo '+cargo+' en los maestros de Drive.');
      const count=inDrive?index.get(key):
        (Number.isFinite(Number(doc.folios))&&Number(doc.folios)>0
          ?Number(doc.folios):Number(doc.cantidadRegistros??doc.cantidadFacturas)||0);
      return [reportCargoCode(cargo),count];
    }));
    return {...doc,foliosPorCargo};
  });
  const unmatched=detailRequired?[...index.keys()].filter(key=>!found.has(key)):[];
  if(unmatched.length)throw Error('Hay cargos de Drive sin correspondencia en Supabase: '+unmatched.slice(0,10).join(', ')+'.');
  return rows;
}

export function annualExistenciasRows(getHistorical,index,docs){
  return async function* (year){
    const emitted=new Set();
    for await(const entry of getHistorical(year)){
      const {doc}=entry;
      const keep=[];
      for(const cargo of doc.cargos||[]){
        const key=sourceKey(doc,cargo);
        const detail=index.get(key);
        if(!detail){keep.push(cargo);continue;}
        if(!emitted.has(key)){
          yield {doc:{...doc,cargos:[cargo]},records:detail.rows,preserveSequence:true};
          emitted.add(key);
        }
      }
      if(keep.length){
        if(keep.length===doc.cargos.length)yield entry;
        else {
          const codes=new Set(keep.map(reportCargoCode));
          const records=(await sourceRecords(entry.origin)).filter(row=>codes.has(reportCargoCode(row.Cargo)));
          yield {...entry,doc:{...doc,cargos:keep},...(records.length?{records}:{origin:{}})};
        }
      }
    }
    // This verifies the generator has emitted every matched master record.
    const expected=new Set(docs.filter(doc=>cargoYear(doc)===String(year))
      .flatMap(doc=>(doc.cargos||[]).map(cargo=>sourceKey(doc,cargo))).filter(key=>index.has(key)));
    if(emitted.size!==expected.size)throw Error('El detalle anual de Drive está incompleto para '+year+'.');
  };
}
