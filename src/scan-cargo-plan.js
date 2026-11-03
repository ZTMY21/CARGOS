import {normalizeInvoice} from './scan-rows.js';

const numberCargo = value => {
  const text=String(value??'').trim();
  return /^\d{1,7}$/.test(text)?Number(text):NaN;
};

export function planCargoImport(ready,masters) {
  if(!masters || !Array.isArray(masters.original?.cargos) || !Array.isArray(masters.depurado?.cargos))
    throw Error('No se pudo verificar los dos Excel maestros.');
  const indexed=new Set((masters.indexedCargos||[]).map(numberCargo));
  const present={
    original:new Set(masters.original.cargos.map(numberCargo)),
    depurado:new Set(masters.depurado.cargos.map(numberCargo))
  };
  const lastOriginal=Math.max(0,...present.original),lastDepurado=Math.max(0,...present.depurado);
  const baseline=Math.min(lastOriginal,lastDepurado,Number.isSafeInteger(masters.indexedLastCargo)?masters.indexedLastCargo:Math.min(lastOriginal,lastDepurado));
  if(baseline<941)throw Error('Los Excel maestros no están conciliados hasta el cargo 941.');
  const groups=new Map(),rejected=[],invalid=[];
  for(const item of ready){
    const cargo=numberCargo(item.cargo),year=Number(item.iso.slice(0,4));
    if(year!==2026 || !Number.isSafeInteger(cargo)){
      invalid.push({line:item.line,cargo:item.cargo,reason:'Solo se admiten cargos nuevos correlativos de 2026 (desde 942).'});
      continue;
    }
    if(cargo<=baseline && present.original.has(cargo) && present.depurado.has(cargo)){
      rejected.push(item);
      continue;
    }
    if(cargo<942){invalid.push({line:item.line,cargo:item.cargo,reason:'Cargo histórico no identificado en ambos Excel; requiere conciliación manual.'});continue;}
    // Si una carga anterior quedó parcial, se permite recuperar el Excel que falta.
    const missing={
      original:!present.original.has(cargo),
      depurado:!present.depurado.has(cargo)
    };
    if(indexed.has(cargo)&&(missing.original||missing.depurado)){
      throw Error('El cargo '+cargo+' ya figura en el Kárdex, pero falta en alguno de los Excel. Requiere conciliación antes de importar.');
    }
    if(!missing.original&&!missing.depurado && (cargo<=941||indexed.has(cargo))){rejected.push(item);continue;}
    const current=groups.get(cargo)||{cargo,rows:[],missing,codes:new Set(),dates:new Set(),duplicateRows:0};
    current.rows.push(item.values);
    current.codes.add(normalizeInvoice(item.codigo));
    current.dates.add(item.iso);
    groups.set(cargo,current);
  }
  const cargos=[...groups.values()].sort((a,b)=>a.cargo-b.cargo).map(c=>({
    cargo:c.cargo,rows:c.rows,codes:c.codes.size,missing:c.missing,
    dates:[...c.dates],count:c.rows.length
  }));
  // No saltar un cargo previo: si aparece 944 sin 942 y 943, detener la carga.
  let expected=baseline+1;
  for(const cargo of cargos){
    if(cargo.cargo!==expected){
      if(cargo.cargo<expected)continue;
      throw Error('Falta el cargo '+expected+' en el archivo. No se puede continuar con el '+cargo.cargo+' sin validar la continuidad.');
    }
    if(cargo.dates.length!==1)throw Error('El cargo '+cargo.cargo+' contiene fechas diferentes. Corrige el Excel antes de confirmar.');
    expected++;
  }
  return {baseline,cargos,ignoredRows:rejected.length,invalid,
    newRows:cargos.reduce((n,c)=>n+c.count,0)};
}
