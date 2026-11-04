// Año contable de los indicadores: una fecha original válida prevalece sobre
// la pestaña o el año de carga. Nunca alteramos la procedencia del documento.
export function cargoYear(doc) {
  const raw=String(doc?.fechaOrigen??'').trim();
  const match=raw.match(/^(\d{4}-\d{2}-\d{2})(?:$|T|\s)/);
  if(match){
    const date=new Date(match[1]+'T00:00:00Z');
    if(Number.isFinite(date.getTime()) && date.toISOString().slice(0,10)===match[1])
      return match[1].slice(0,4);
  }
  return String(doc?.anioOrigen||doc?.periodo?.slice(0,4)||doc?.fechaOrigen?.slice(0,4)||'Sin dato');
}
const code=value=>String(value??'').trim().replace(/\.0+$/,'')
  .replace(/^0+(?=\d)/,'').toUpperCase();

// Total general y por años comparten el mismo criterio:
// históricos hasta 2025: cada registro original cuenta, incluso 0028 y 28;
// desde 2026: una factura adicional de un cargo no se cuenta dos veces.
export function cargoTotalsByYear(docs) {
  const counts=new Map();
  for(const doc of uniqueCargoDocuments(docs || [])){
    const value=cargoYear(doc);
    const year=/^\d{4}$/.test(value)?value:'Sin año';
    counts.set(year,(counts.get(year)||0)+doc.cargos.length);
  }
  return counts;
}

// Place the authoritative entry first before calling this function. Preserve
// distinct historical rows and only deduplicate repeated cargos from 2026 onward.
export function uniqueCargoDocuments(docs) {
  const seen = new Set();
  return docs.flatMap(doc => {
    const year = cargoYear(doc);
    const cargos = (doc.cargos || []).filter(raw => {
      const normalized = code(raw);
      if (!normalized) return false;
      if (!/^\d{4}$/.test(year) || Number(year) < 2026) return true;
      const key = year + ':' + normalized;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    return cargos.length ? [{ ...doc, cargos }] : [];
  });
}
