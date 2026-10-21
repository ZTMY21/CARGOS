// Agrupación y cruce de cajas "por solicitud" sin modificar registros de origen.
export const normalizeBoxBarcode = value => {
  const text = String(value ?? '').trim().toUpperCase().replace(/^[A-Z\s]+/, '');
  return /^\d/.test(text) ? text.replace(/\D/g,'') : '';
};
export const normalizeCargoIM = value => {
  const match=String(value??'').trim().toUpperCase().replace(/\.0+$/,'')
    .match(/^0*(\d+)\s*(?:\(?([A-Z])\)?)?$/);
  return match ? (match[1]||'0')+(match[2]||'') : '';
};
export function parseCargoCell(value) {
  if(Array.isArray(value))return [...new Set(value.flatMap(parseCargoCell))];
  const raw=String(value??'').trim().toUpperCase();
  if(!raw)return [];
  // Ej. 3382-3383-3384 (A): todos los cargos llevan A.
  const group=raw.match(/^(\d+(?:\s*[-,;/]\s*\d+)+)\s*\(([A-Z])\)$/);
  if(group)return group[1].split(/\s*[-,;/]\s*/).map(n=>normalizeCargoIM(n+group[2])).filter(Boolean);
  return [...new Set(raw.split(/[,;\n/]|(?<=\d)\s*-\s*(?=\d)/)
    .map(normalizeCargoIM).filter(Boolean))];
}
export function requestedIMBoxes(rows=[],documents=[]) {
  const docIndex=new Map();
  for(const d of documents) for(const raw of d.cargos||[]) {
    const cargo=normalizeCargoIM(raw);
    if(!cargo)continue;
    if(!docIndex.has(cargo))docIndex.set(cargo,[]);
    docIndex.get(cargo).push(d);
  }
  const boxes=new Map();
  for(const row of rows) {
    if(!/por\s+solicitud/i.test(String(row.clasificacion_caja??row.clasificacion??'')))continue;
    const code=String(row.codigo_caja??row.caja??'').trim();
    const num=normalizeBoxBarcode(code);
    if(!num)continue;
    const cargos=parseCargoCell(row.cargos??row.codigo_cargo??row.celda??[]);
    if(!boxes.has(num))boxes.set(num,{codigo:code,numero:num,fechaEnvio:'',cargos:new Set(),filas:new Set(),observaciones:new Set()});
    const box=boxes.get(num);
    box.codigo=box.codigo||code;
    box.filas.add(row.sheet_row??row.row??'');
    if(row.fecha_envio || row.envio)box.fechaEnvio=String(row.fecha_envio||row.envio);
    for(const cargo of cargos)box.cargos.add(cargo);
  }
  const result=[];
  for(const box of boxes.values()){
    const cargos=[...box.cargos].sort((a,b)=>a.localeCompare(b,'es',{numeric:true}));
    const matches=cargos.map(cargo=>{
      const candidates=docIndex.get(cargo)||[];
      // Duplicados de años diferentes se muestran como pendientes de verificación.
      const match=candidates.length===1?candidates[0]:null;
      const assigned=match?.imCodigoCaja||match?.imCajaPreparada||'';
      const barcodeConflict=!!(assigned&&normalizeBoxBarcode(assigned)!==box.numero);
      return {cargo,kardex:match?.kardex||'',match:!!match&&!barcodeConflict,
        issue:candidates.length>1?'Cargo repetido entre períodos':barcodeConflict?'Caja distinta en Kardex':candidates.length===0?'No existe en Kardex':''};
    });
    result.push({codigo:box.codigo,numero:box.numero,cargos:matches,
      fechaEnvio:box.fechaEnvio,estado:box.fechaEnvio?'Enviado':'No enviado',
      coincidencias:matches.filter(c=>c.match).length,
      revisar:matches.filter(c=>!c.match).length,
      filas:[...box.filas].filter(x=>x!=='')});
  }
  return result.sort((a,b)=>a.codigo.localeCompare(b.codigo,'es',{numeric:true}));
}
export function countRequestedCargos(boxes=[]) {
  return new Set(boxes.flatMap(b=>b.cargos.map(c=>c.cargo))).size;
}
