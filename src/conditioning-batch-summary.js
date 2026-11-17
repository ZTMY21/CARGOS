import {physicalBoxKey} from './search.js';
import {REQ_TYPES} from './rules.js';

export const boxSupplyRequests = rows => rows.filter(row=>row.tipo===REQ_TYPES[0] && Number(row.cantidadCajas)>0);

export function renderSupplySelector(container,requests,currentId,busy=false) {
  const signature=JSON.stringify(requests.map(({id,numero})=>[id,numero]));
  if(container.dataset.requests!==signature){
    container.replaceChildren(...requests.map(({id,numero})=>{
      const button=container.ownerDocument.createElement('button');
      button.type='button';
      button.className='secondary';
      button.dataset.supplyId=id;
      button.textContent=numero;
      return button;
    }));
    container.dataset.requests=signature;
  }
  container.hidden=requests.length===0;
  for(const button of container.children){
    button.setAttribute('aria-pressed',String(button.dataset.supplyId===currentId));
    button.disabled=busy;
  }
}

export async function loadBoxPreparationBatches(repository,requests,preparedRows,tracking) {
  const batches=await Promise.all(requests.map(async request=>{
    const [reception,shipped]=await Promise.all([
      repository.reception('estado',request.id).catch(()=>null),
      repository.conditioningBatchShipments(request.id).catch(()=>null)
    ]);
    return [request.id,summarizeBoxPreparationBatch(request,tracking,reception,reception?preparedRows:null,shipped)];
  }));
  return new Map(batches);
}

export function combineBoxPreparationBatches(batches) {
  const total=batches.reduce((sum,batch)=>sum+batch.total,0);
  const registered=batches.reduce((sum,batch)=>sum+batch.registered,0);
  const prepared=batches.every(batch=>batch.boxes!==null)
    ? new Set(batches.flatMap(batch=>batch.boxes.map(row=>physicalBoxKey(row.codigo||row.clave)))).size : null;
  return {total,registered,prepared,
    preparedPct:total&&prepared!==null?Math.round(prepared/total*100):null};
}


export function boxPreparationRows(requestId,reception,preparedRows,shippedRows=[]) {
  const saved=new Set((reception?.lecturas||[]).filter(row=>row.guardado)
    .map(row=>physicalBoxKey(row.codigo)).filter(Boolean));
  const boxes=new Map();
  for(const row of [...preparedRows,...shippedRows]){
    if(row?.origen!=='nueva'||!(row.preparada||row.enviada))continue;
    const code=physicalBoxKey(row.codigo||row.clave);
    if(!code)continue;
    const linked=row.solicitud ? String(row.solicitud)===requestId : saved.has(code);
    if(!linked || (reception && !saved.has(code)))continue;
    const prior=boxes.get(code);
    if(!prior || (row.enviada && !prior.enviada) ||
      (Boolean(row.enviada)===Boolean(prior.enviada) && String(row.preparada||'')>String(prior.preparada||''))){
      boxes.set(code,row);
    }
  }
  return [...boxes.values()];
}

// La recepción y la preparación se consultan por requerimiento.
// Solo lectura: se consulta el registro de Control de cajas y el módulo Acondicionamiento.
export function summarizeBoxPreparationBatch(request, tracking=null, reception=null, preparedRows=null,shippedRows=[]) {
  if (!request || request.tipo!==REQ_TYPES[0]) return null;
  const total=Math.max(0,Number(request.cantidadCajas)||0);
  if(!total)return null;
  const requestId=String(request.id??'');
  const status=tracking?.suministro?.solicitudes?.find(row=>String(row.id)===requestId);
  const activeReception=reception && String(reception.id)===requestId ? reception : null;
  const readings=activeReception?.lecturas;
  const countCodes=rows=>new Set(rows.map(row=>physicalBoxKey(row.codigo)).filter(Boolean)).size;
  const bound=value=>Math.min(total,Math.max(0,Number(value)||0));
  const registered=bound(readings?countCodes(readings.filter(row=>row.guardado)):status?.guardadas??request.recibidoV4);
  const scanned=bound(readings?countCodes(readings):status?.leidas??registered);
  const boxes=Array.isArray(preparedRows)&&Array.isArray(shippedRows)
    ? boxPreparationRows(requestId,activeReception,preparedRows,shippedRows) : null;
  const prepared=boxes===null?null:Math.min(total,boxes.length);
  const confirmed=activeReception?.confirmada||status?.confirmada||request.fechaRecepcion||null;
  const pct=value=>Math.round((value/total)*100);
  return {requestId,total,registered,scanned,confirmed,boxes,registeredPct:pct(registered),
    prepared,preparedPct:prepared===null?null:pct(prepared)};
}
