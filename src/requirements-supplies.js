// Metadato opcional del requerimiento, sin modificar la cantidad de cajas.
export const PRECINTOS_MAX=250;

export function validarPrecintos(value){
  if(value===null||value===undefined||value==='')return 0;
  const number=Number(value);
  if(!Number.isInteger(number)||number<0||number>PRECINTOS_MAX)
    throw new RangeError('Ingresa entre 0 y 250 precintos enteros.');
  return number;
}

// La operación "crear" ya conserva p_datos en el historial de movimientos.
// Los registros anteriores no tienen precintos: null significa dato ausente.
export function precintosRegistrados(row,tracking){
  if(!row?.id)return null;
  const op=tracking?.movimientos?.findLast(item=>
    item.requerimiento===row.id&&item.tipo==='crear'&&
    Object.prototype.hasOwnProperty.call(item.datos||{},'precintos'));
  if(!op)return null;
  try{return validarPrecintos(op.datos.precintos);}
  catch{return null;}
}
