
export const normalizeBoxCode = value => {
  const raw = String(value ?? '').trim().toUpperCase().replace(/^[A-Z\s]+/, '');
  return /^\d/.test(raw) ? raw.replace(/\D/g, '') : '';
};
export const normalizeCargoCode = value => {
  const m = String(value ?? '').trim().toUpperCase().replace(/\.0+$/, '').match(/^0*(\d+)\s*(?:\(?([A-Z])\)?)?$/);
  return m ? (m[1] || '0') + (m[2] || '') : '';
};
export function cargoCodes(value) {
  if (Array.isArray(value)) return [...new Set(value.flatMap(cargoCodes))];
  const raw = String(value ?? '').trim().toUpperCase();
  if (!raw) return [];
  // One shared "(A)" suffix applies to all cargos in a grouped cell.
  const g = raw.match(/^(\d+(?:\s*[-,;/]\s*\d+)+)\s*\(([A-Z])\)$/);
  if (g) return g[1].split(/\s*[-,;/]\s*/).map(n => normalizeCargoCode(n + g[2])).filter(Boolean);
  return [...new Set(raw.split(/[,;\n/]|(?<=\d)\s*-\s*(?=\d)/).map(normalizeCargoCode).filter(Boolean))];
}
const date = v => /^\d{4}-\d{2}-\d{2}/.test(String(v || '')) ? String(v).slice(0, 10) : '';
const isRequested = v => /(?:por\s+solicitud|caja\s+solicitad|pr[eé]stamo)/i.test(String(v ?? ''));
function asEntry(row, i) {
  const code = String(row.codigoCaja ?? row.codigo_caja ?? row.imCodigoCaja ??
    row.imCajaPreparada ?? row.codigoBarrasCaja ?? '').trim();
  const numeric = normalizeBoxCode(code);
  if (!numeric) return null;
  const year = String(row.anioOrigen ?? row.anio ?? row.year ?? '').trim();
  const cargos = cargoCodes(row.cargos ?? row.codigoCargo ?? row.codigo_cargo ?? row.numeros_cargos ?? row.numerosCargo);
  return { code, numeric, cargos, year,
    fechaEnvio:date(row.imFechaEnvio ?? row.fechaEnvio ?? row.fecha_envio ?? row.fEnvio),
    fechaPreparacion:date(row.fechaPreparacion ?? row.fecha_preparacion),
    preparado:!!(row.imPreparado || row.preparada || row.fechaPreparacion || row.fecha_preparacion),
    responsable:String(row.responsablePreparacion ?? row.responsable_preparacion ?? ''),
    clasificacion:String(row.clasificacionCaja ?? row.clasificacion_caja ?? row.clasificacion ?? row.tipoCaja ?? ''),
    antiguo:String(row.codigoCajaAntiguo ?? row.codigo_caja_antiguo ?? row.codigoAntiguo ?? ''),
    expected:Number(row.cantidadCargosEsperada ?? row.cantidad_cargos_esperada ?? row.cantidadCargos ?? 0) || 0,
    ubicacion:String(row.ubicacion || ''), docId:row.id ?? row.documentoId,
    order:Number(row.sheet_row ?? row.fuente_fila ?? row.orden ?? i)
  };
}
export function buildBoxIndex(rows = [], requestedRows = []) {
  const map = new Map();
  for (const [i, raw] of rows.entries()) {
    const e = asEntry(raw, i);
    if (!e) continue;
    if (!map.has(e.numeric)) map.set(e.numeric, {code:e.code,numeric:e.numeric,cargos:new Set(),keys:new Set(),
      docIds:new Set(),fechaEnvio:'',fechaPreparacion:'',preparado:false,porSolicitud:false,
      antiguo:'',expected:0,responsable:'',ubicacion:'',order:-1});
    const b = map.get(e.numeric);
    e.cargos.forEach(c => {b.cargos.add(c);b.keys.add((e.year ? e.year + ':' : '') + c);});
    if (e.docId) b.docIds.add(e.docId);
    if (e.order >= b.order) {b.code = e.code;b.order = e.order;}
    b.fechaEnvio = e.fechaEnvio || b.fechaEnvio;
    b.fechaPreparacion = e.fechaPreparacion || b.fechaPreparacion;
    b.preparado ||= e.preparado;
    b.porSolicitud ||= isRequested(e.clasificacion);
    b.antiguo ||= e.antiguo;
    b.expected = Math.max(b.expected,e.expected);
    b.responsable ||= e.responsable;
    b.ubicacion ||= e.ubicacion;
  }
  // Match against the box-request register using numeric barcodes AND cargo count/set.
  for (const [i, raw] of requestedRows.entries()) {
    const e = asEntry(raw,i);
    const b = e && map.get(e.numeric);
    if (!b) continue;
    if ((e.expected && b.cargos.size !== e.expected) ||
       (e.cargos.length && (e.cargos.length !== b.cargos.size || e.cargos.some(c=>!b.cargos.has(c))))) {
      b.conflict = 'La cantidad o lista de cargos no coincide con la solicitud';
    } else b.porSolicitud = true;
  }
  const signatures = new Map();
  for (const b of map.values()) {
    b.cargos = [...b.cargos].sort();
    b.keys = [...b.keys].sort();
    b.faltantes = [];
    if (!b.cargos.length) b.faltantes.push('Cargos asociados');
    if (b.expected && b.cargos.length < b.expected) b.faltantes.push(String(b.expected - b.cargos.length) + ' cargos faltantes');
    if (!b.fechaPreparacion && !b.fechaEnvio) b.faltantes.push('Fecha de preparación');
    if (!b.responsable && !b.fechaEnvio) b.faltantes.push('Responsable de preparación');
    if (!b.fechaEnvio) b.faltantes.push('Fecha de envío a Iron Mountain');
    const signature = b.keys.length === b.cargos.length ? b.keys.join('|') : '';
    if (signature) signatures.set(signature,[...(signatures.get(signature)||[]),b]);
  }
  for (const group of signatures.values()) {
    if (group.length !== 2) {
      if (group.length>2) group.forEach(b=>b.conflict ||= 'Varios códigos con idénticos cargos; revisar');
      continue;
    }
    const [a,b]=group;
    // Different alphabetic prefixes alone are not evidence of replacement.
    if (a.numeric === b.numeric) continue;
    const explicit = [a,b].find(x=>normalizeBoxCode(x.antiguo)===(x===a?b.numeric:a.numeric));
    // If there is no explicit link, require a reliable ordering among still-pending boxes.
    const newer = explicit || (!a.fechaEnvio && !b.fechaEnvio && a.order!==b.order
      ? (a.order>b.order?a:b) : null);
    if (!newer) {
      a.conflict ||= 'Posible caja cambiada: validar código antiguo';
      b.conflict ||= 'Posible caja cambiada: validar código antiguo';
      continue;
    }
    const older = newer===a?b:a;
    newer.antiguo = older.code;
    older.reemplazadaPor = newer.code;
  }
  for (const b of map.values()) {
    b.estadoEnvio = b.fechaEnvio ? 'Enviado' : b.preparado ? 'Pendiente de envío' : 'No enviado';
    b.clasificacion = b.antiguo ? 'Caja Cambiada' :
      b.porSolicitud ? 'Caja por Solicitud' :
      b.preparado && !b.fechaEnvio && b.cargos.length && (!b.expected || b.expected===b.cargos.length)
      ? 'Caja Preparada para Envío' : !b.fechaEnvio ? 'Cajas Nuevas' : 'Sin clasificación';
  }
  const boxes=[...map.values()].filter(b=>!b.reemplazadaPor);
  return { boxes, byCode:map, solicitadas:boxes.filter(b=>b.porSolicitud),
    pendientes:boxes.filter(b=>!b.fechaEnvio), revisiones:boxes.filter(b=>b.conflict) };
}
export function boxesFromDocuments(docs=[]) {
  return docs.filter(d=>d.imCodigoCaja || d.imCajaPreparada).map(d=>({
    id:d.id,codigoCaja:d.imCodigoCaja || d.imCajaPreparada,cargos:d.cargos,
    anioOrigen:d.anioOrigen || d.fechaOrigen?.slice(0,4),
    imFechaEnvio:d.imFechaEnvio,fEnvio:d.fEnvio,imPreparado:d.imPreparado,
    responsablePreparacion:d.imResponsablePreparacion,ubicacion:d.ubicacion
  }));
}
