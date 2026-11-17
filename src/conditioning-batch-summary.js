import {physicalBoxKey} from './search.js';

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

// Un lote = la solicitud vigente de cajas nuevas; no confundir recepción y preparación.
// Solo lectura: se consulta el registro de Control de cajas y el módulo Acondicionamiento.
export function summarizeBoxPreparationBatch(request, tracking=null, reception=null, preparedRows=null,shippedRows=[]) {
  if (!request || request.tipo!=='Cajas nuevas para acondicionar') return null;
  const total=Math.max(0,Number(request.cantidadCajas)||0);
  if(!total)return null;
  const requestId=String(request.id??'');
  const status=tracking?.suministro?.solicitudes?.find(row=>String(row.id)===requestId);
  const activeReception=reception && String(reception.id)===requestId ? reception : null;
  const registeredCodes=new Set((activeReception?.lecturas||[])
    .map(row=>physicalBoxKey(row.codigo)).filter(Boolean));
  const fallback=Number(status?.leidas??status?.guardadas??request.recibidoV4??0);
  const registered=Math.min(total,Math.max(0,activeReception?registeredCodes.size:Number.isFinite(fallback)?fallback:0));
  const prepared=Array.isArray(preparedRows)&&Array.isArray(shippedRows)
    ? Math.min(total,boxPreparationRows(requestId,activeReception,preparedRows,shippedRows).length)
    : null;
  const pct=value=>Math.round((value/total)*100);
  return {requestId,total,registered,registeredPct:pct(registered),
    prepared,preparedPct:prepared===null?null:pct(prepared)};
}
