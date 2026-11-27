import {cargoYear} from './cargo-year.js';
import {normalizeCargoIM} from './im-requests.js';
import {physicalBoxKey} from './search.js';

export function inventoryConditioning(rows) {
  const byCargo=new Map();
  const byDocument=new Map();
  for(const row of rows){
    (row.documentos_ids||[]).forEach(id=>{
      if(!byDocument.has(id))byDocument.set(id,[]);
      byDocument.get(id).push(row);
    });
    for(const cargo of row.cargos||[]){
      const key=normalizeCargoIM(cargo);
      if(!key)continue;
      if(!byCargo.has(key))byCargo.set(key,[]);
      byCargo.get(key).push(row);
    }
  }
  return doc=>{
    const {acondicionamiento:_previous,...base}=doc;
    const key=physicalBoxKey(doc.imLiveCodigoCaja||doc.imCodigoCaja||doc.imCajaPreparada);
    const year=Number(cargoYear(doc));
    const explicit=byDocument.get(doc.id)||[];
    const matches=new Set(explicit.length?explicit:(doc.cargos||[]).flatMap(cargo=>(byCargo.get(normalizeCargoIM(cargo))||[])
      .filter(row=>row.documentos_ids?.length ? false : row.origen==='nueva' ? row.anios.includes(year) : row.clave===key)));
    // La asociación por ID tiene prioridad cuando el mismo número existe en varios años.
    if(matches.size!==1)return base;
    const [row]=matches;
    return {...base,acondicionamiento:row};
  };
}
