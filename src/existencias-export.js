import {buildExistenciasReport,serializeExistenciasReport} from './excel-api.js';
import {annualExistenciasRows,applyExistenciasFolios,indexExistenciasRows,sourceKey} from './existencias-data.js';
import {docFromDb,reqFromDb} from './repository.js';
import {REQ_TYPES} from './rules.js';
import {cargoYear} from './cargo-details.js';
import {inventoryConditioning} from './conditioning-inventory.js';

const cargoOrder=new Intl.Collator('es',{numeric:true});
const compareDocs=(a,b)=>cargoOrder.compare(a.cargos?.[0]||'',b.cargos?.[0]||'')
  ||cargoOrder.compare(a.kardex||'',b.kardex||'');

async function fetchDriveSources(repository,view=''){
  const {data,error}=await repository.client.auth.getSession();
  if(error||!data?.session?.access_token)throw Error('Inicia sesión para generar el reporte.');
  const response=await fetch('/api/existencias-sources'+view,{
    headers:{Authorization:'Bearer '+data.session.access_token},
    credentials:'same-origin',cache:'no-store',signal:AbortSignal.timeout(75000)
  });
  if(!response.ok){
    const detail=await response.json().catch(()=>null);
    throw Error(detail?.error||'No se pudo verificar la lectura de los Excel de Drive.');
  }
  return response;
}

function driveFolioIndex(folios){
  if(!Array.isArray(folios)||!folios.length||folios.some(row=>!Array.isArray(row)||
    !/^20\d{2}:.+$/.test(row[0])||!Number.isSafeInteger(row[1])||row[1]<0))
    throw Error('Google Drive devolvió un listado de folios incompleto.');
  return new Map(folios);
}

export async function loadExistenciasFolios(repository,docs){
  const [source,result]=await Promise.all([
    repository.reportDocs(docs),fetchDriveSources(repository,'?view=folios').then(response=>response.json())
  ]);
  return applyExistenciasFolios(source,driveFolioIndex(result.folios));
}

async function getDriveSources(repository){
  const response=await fetchDriveSources(repository);
  const dataStream=response.body.pipeThrough(new DecompressionStream('gzip'));
  const result=await new Response(dataStream).json();
  if(!Array.isArray(result.rows)||!result.rows.length||!Array.isArray(result.history)||
    !Array.isArray(result.registeredUsers)||!Array.isArray(result.masterUsers))
    throw Error('La lectura de Drive devolvió un resultado incompleto.');
  return result;
}

export async function prepareExistenciasExport(repository,progress,{now=new Date(),readDrive=getDriveSources,includeConditioning=false}={}){
  const [snapshot,drive,tracking,conditioning]=await Promise.all([
    repository.snapshot(),readDrive(repository),repository.requestTracking(),
    includeConditioning?repository.conditioning('estados'):[]
  ]);
  if(!Array.isArray(conditioning))throw Error('No se pudieron verificar las cajas con cargos asignados.');
  const requests=snapshot.requerimientos.map(reqFromDb);
  const docs=snapshot.documentos.map(docFromDb).map(inventoryConditioning(conditioning));
  const [source,receptions]=await Promise.all([
    repository.reportDocs(docs),
    Promise.all(requests.filter(r=>r.tipo===REQ_TYPES[0]&&r.cantidadCajas>0&&r.cantidadCajas<=100)
      .map(async r=>[r.id,await repository.reception('estado',r.id)]))
  ]);
  const index=indexExistenciasRows(drive.rows);
  const reportDocs=applyExistenciasFolios(source,driveFolioIndex(drive.folios),{detailRequired:true});
  const workbook=await buildExistenciasReport(reportDocs,now,requests,{
    history:drive.history,registeredUsers:drive.registeredUsers,masterUsers:drive.masterUsers,
    tracking:{...tracking,receptions:Object.fromEntries(receptions)}
  });
  const getHistorical=async function* (year){
    const archive=[],verified=[];
    for(const doc of source){
      if(cargoYear(doc)!==String(year))continue;
      const cargos=doc.cargos||[];
      if(cargos.length&&cargos.every(cargo=>index.has(sourceKey(doc,cargo))))verified.push(doc);
      else archive.push(doc);
    }
    verified.sort(compareDocs);
    let cursor=0;
    for await(const row of repository.reportOriginalRows(year,archive)){
      while(cursor<verified.length&&compareDocs(verified[cursor],row.doc)<=0)yield {doc:verified[cursor++]};
      yield row;
    }
    while(cursor<verified.length)yield {doc:verified[cursor++]};
  };
  return {workbook,serialize:()=>serializeExistenciasReport(workbook,
    annualExistenciasRows(getHistorical,index,source),progress)};
}
