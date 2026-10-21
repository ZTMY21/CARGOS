import { computeReqEstado, computeDocEstado, escapeHtml } from './rules.js';

export function normalizeSearch(value = '') {
  return String(value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g,'')
    .toLowerCase().replace(/[^a-z0-9]/g,'');
}
export function searchTerms(value = '') {
  return String(value).trim().split(/\s+/).map(normalizeSearch).filter(Boolean);
}
export function highlightMatch(value, query) {
  const source=String(value ?? ''), map=[], normalized=[];
  for(let index=0;index<source.length;index++) {
    const fragment=normalizeSearch(source[index]);
    for(const char of fragment) {normalized.push(char);map.push(index);}
  }
  const text=normalized.join(''), ranges=[];
  for(const term of searchTerms(query)) {
    let start=0, match;
    while((match=text.indexOf(term,start))!==-1) {
      ranges.push([map[match],map[match+term.length-1]+1]);start=match+term.length;
    }
  }
  const merged=[];
  for(const range of ranges.sort((a,b)=>a[0]-b[0])) {
    const last=merged.at(-1);
    if(last && range[0]<=last[1]) last[1]=Math.max(last[1],range[1]);
    else merged.push([...range]);
  }
  let cursor=0,result='';
  for(const [start,end] of merged) {
    result+=escapeHtml(source.slice(cursor,start))+`<mark>${escapeHtml(source.slice(start,end))}</mark>`;
    cursor=end;
  }
  return result+escapeHtml(source.slice(cursor));
}
// The Facturas cell adapts to the entered value, independently of the user's role.
export function invoiceSearchPresentation(doc, query = '') {
  const allCodes = String(doc.facturas || '').split(/[,;\n]/).map(code => code.trim()).filter(Boolean);
  // The RPC returns a short list of matched codes, but also the authoritative total.
  const foundCodes = Array.isArray(doc.facturasEncontradas) && doc.facturasEncontradas.length
    ? doc.facturasEncontradas : allCodes;
  const dbCount = Number(doc.cantidadFacturas);
  const total = doc.cantidadFacturas !== null && doc.cantidadFacturas !== undefined
    && Number.isSafeInteger(dbCount) && dbCount >= 0 ? dbCount : allCodes.length;
  if (!String(query ?? '').trim()) return {kind:'browse',codes:foundCodes.slice(0,3),total};
  const compactQuery = normalizeSearch(query);
  if (compactQuery && (doc.cargos || []).some(cargo => normalizeSearch(cargo).includes(compactQuery))) {
    return {kind:'cargo',codes:[],total};
  }
  const terms = searchTerms(query);
  const codes = foundCodes.filter(code => terms.some(term => normalizeSearch(code).includes(term)));
  return {kind:codes.length?'invoice':'other',codes,total};
}

// Busca exclusivamente la caja visible en Existencias, sin confundir su UUID interno
// con el codigo fisico registrado en Iron Mountain o el numero de requerimiento.
export function assignedBoxCode(doc, requirements = new Map()) {
  const requestNumber = requirements instanceof Map
    ? requirements.get(doc.cajaAsignada)
    : requirements.find(r => r.id === doc.cajaAsignada)?.numero;
  return String((doc.imConfirmado && doc.imCodigoCaja)
    || (doc.imPreparado && doc.imCajaPreparada)
    || requestNumber || '').trim();
}

// Sin prefijo numerico, 203258116 localiza T203258116, TD203258116
// y 203258116. Al escribir T o TD se respeta el prefijo indicado.
export function matchesAssignedBoxCode(code, query, exact = false) {
  const candidate = normalizeSearch(code), needle = normalizeSearch(query);
  if (!candidate || !needle) return false;
  const comparable = /^\d+$/.test(needle)
    ? candidate.replace(/^[a-z]+(?=\d)/,'') : candidate;
  return exact ? comparable === needle : comparable.includes(needle);
}

export function filterDocuments(documents, requirements, filters, now=new Date()) {
  const reqs=new Map(requirements.map(r=>[r.id,r.numero]));
  const terms=searchTerms(filters.query);
  const cargoOnly=filters.type==='solo-cargos';
  const boxOnly=filters.type==='solo-cajas';
  const cargoQuery=normalizeSearch(filters.query);
  const exactBox=boxOnly && cargoQuery && documents.some(d =>
    matchesAssignedBoxCode(assignedBoxCode(d,reqs),filters.query,true));
  // Si el código exacto existe, no incluir números parecidos como 1490
  // cuando se busca 490. Si no, permitir búsquedas parciales de cargos.
  const hasExactCargo=cargoOnly && cargoQuery && documents.some(d=>
    (d.cargos||[]).some(c=>normalizeSearch(c)===cargoQuery));
  return documents.map(d=>({...d,...computeDocEstado(d,now)})).filter(d=>{
    const fields=[d.kardex,...(d.cargos||[]),d.facturas,reqs.get(d.cajaAsignada),d.sustento,d.obs,d.usuario,d.tipoDoc,d.hojaOrigen].map(normalizeSearch);
    const periodYear=d.periodo?.slice(0,4);
    const year=filters.year||'';
    const matchesYear=!year || (year==='sin-periodo' && !d.periodo)
      || (year.startsWith('origen:') && String(d.anioOrigen)===year.slice(7))
      || (!year.includes(':') && periodYear===year);
    const matchesInvoice=cargoOnly || boxOnly || !filters.invoiceExact || !cargoQuery
      || (d.facturas||'').split(/[,;\n]/).some(number=>normalizeSearch(number)===cargoQuery);
    const matchesCargo=boxOnly
      ? (cargoQuery ? matchesAssignedBoxCode(assignedBoxCode(d,reqs),filters.query,exactBox)
        : !!assignedBoxCode(d,reqs))
      : cargoOnly
        ? (d.cargos||[]).some(c=>!cargoQuery || (hasExactCargo
          ? normalizeSearch(c)===cargoQuery : normalizeSearch(c).includes(cargoQuery)))
        : terms.every(t=>fields.some(field=>field.includes(t)));
    return matchesInvoice && matchesCargo
      && (!filters.state||d.estado===filters.state)
      && (cargoOnly || boxOnly || !filters.type || d.tipoDoc===filters.type)
      && (!filters.location||d.ubicacion===filters.location||(filters.location==='sin-dato'&&!d.ubicacion))
      && matchesYear;
  });
}
export function filterRequirements(requirements, documents, query) {
  const terms=searchTerms(query);
  return requirements.filter(r=>{
    const fields=[r.numero,r.tipo,r.numerosCargo,r.usuario,computeReqEstado(r,documents),r.fechaSolicitud,r.fechaRecepcion,r.fechaDevolucion].map(normalizeSearch);
    return terms.every(term=>fields.some(field=>field.includes(term)));
  });
}
