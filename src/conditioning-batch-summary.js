import {physicalBoxKey} from './search.js';

// Un lote = la solicitud vigente de cajas nuevas; no confundir recepción y preparación.
// Solo lectura: se consulta el registro de Control de cajas y el módulo Acondicionamiento.
export function summarizeBoxPreparationBatch(request, tracking=null, reception=null, preparedRows=null) {
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
  let prepared=null;
  if(Array.isArray(preparedRows)){
    const codes=new Set();
    for(const row of preparedRows){
      if(!row || row.origen!=='nueva' || !row.preparada)continue;
      const code=physicalBoxKey(row.codigo??row.clave);
      if(!code)continue;
      const sameRequest=String(row.solicitud||'')===requestId;
      // Los registros históricos del Maestro no tienen UUID de solicitud.
      // Se cuentan solo cuando el código coincide con el lote registrado.
      const legacyMatch=!row.solicitud && registeredCodes.has(code);
      if(sameRequest||legacyMatch)codes.add(code);
    }
    prepared=Math.min(total,codes.size);
  }
  const pct=value=>Math.round((value/total)*100);
  return {requestId,total,registered,registeredPct:pct(registered),
    prepared,preparedPct:prepared===null?null:pct(prepared)};
}
