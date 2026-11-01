import {normalizeBoxBarcode,parseCargoCell} from './im-requests.js';

// El equipo USB-HID tipo teclado entrega caracteres, NO necesariamente marca/modelo.
// La validación es conservadora: no se colapsan prefijos desconocidos con cajas reales.
export function parseBoxScan(value){
  const original=String(value??'').trim().toUpperCase().replace(/\s+/g,'');
  if(!/^(?:TD|T|P)?[0-9][0-9-]*$/.test(original))return {ok:false,reason:'Código inválido. Debe comenzar con T, TD, P o números.'};
  const digits=normalizeBoxBarcode(original);
  if(!digits||digits.length<5||digits.length>35)return {ok:false,reason:'El código debe contener entre 5 y 35 dígitos.'};
  return {ok:true,original,normalized:digits};
}
export function findPreparedBox(rows,scannedCode){
  const parsed=parseBoxScan(scannedCode);
  if(!parsed.ok)return {...parsed,found:false,matches:[],cargos:[]};
  const matches=(Array.isArray(rows)?rows:[]).filter(row=>{
    const code=parseBoxScan(row.codigo_caja??'');
    return code.ok&&code.normalized===parsed.normalized;
  });
  const cargos=[...new Set(matches.flatMap(row=>parseCargoCell(row.cargos??row.numeros_cargos??row.codigo_cargo??[])))];
  const clasificaciones=[...new Set(matches.map(row=>String(row.clasificacion_caja??'').trim()).filter(Boolean))];
  const originales=[...new Set(matches.map(row=>String(row.codigo_caja??'').trim()).filter(Boolean))];
  return {...parsed,found:matches.length>0,matches,cargos,clasificaciones,originales};
}
// Detectar velocidad probable de un lector. No usar esto para identificar fabricante o modelo.
export function probableRapidScan(intervals=[],characters=0){
  if(characters<6||intervals.length<5)return false;
  const times=intervals.filter(v=>Number.isFinite(v)&&v>=0);
  if(times.length<5)return false;
  const sorted=[...times].sort((a,b)=>a-b);
  return sorted[Math.floor(sorted.length/2)]<=55 && times.reduce((a,b)=>a+b,0)<=1500;
}
