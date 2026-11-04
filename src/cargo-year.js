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
  const counts=new Map(),seenCurrent=new Set();
  for(const doc of docs||[]){
    const value=cargoYear(doc);
    const year=/^\d{4}$/.test(value)?value:'Sin año';
    for(const raw of doc.cargos||[]){
      const normalized=code(raw);
      if(!normalized)continue;
      if(/^\d{4}$/.test(year) && Number(year)>=2026){
        const key=year+':'+normalized;
        if(seenCurrent.has(key))continue;
        seenCurrent.add(key);
      }
      counts.set(year,(counts.get(year)||0)+1);
    }
  }
  return counts;
}
