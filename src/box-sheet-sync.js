import {parseBoxScan} from './box-scanner.js';
import {parseCargoCell} from './im-requests.js';

export const BOX_SHEET_ID='1aWqIoj5UXAeyKhNN1paoYnTa4jdfN8LhDEcdH_lQ4mk';
export const BOX_CONTROL_TAB='CONTROL DE CAJAS';
export const BOX_SOURCE_TAB='CARGOS ENVIADOS';
export const BOX_HEADERS=[
  'Código de caja','Código normalizado','Estado','Cargos','Clasificación',
  'Inicio de preparación','Fin de preparación','Responsable','Observación',
  'Última lectura','Última actualización'
];
const clean=x=>String(x??'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toUpperCase().replace(/\s+/g,' ').trim();
export function verifyBoxSourceHeader(values){
 const headers=(values?.[0]||[]).map(clean);
 return headers.length>=10 &&
   headers[1].includes('FECHA DE PREPARACION')&&
   headers[2].includes('RESPONSABLE')&&
   headers[3].includes('CODIGO DE BARRAS')&&
   headers[4].includes('NUMERO DE')&&headers[4].includes('CARGOS')&&
   headers[5].includes('CLASIFICACION DE')&&
   headers[6].includes('FECHA DE ENVIO');
}
export function matchBoxRow(rows,code,keyColumn=3){
 const parsed=parseBoxScan(code);
 if(!parsed.ok)return {valid:false,matches:[]};
 const matches=[];
 for(let index=1;index<(rows||[]).length;index++){
   const candidate=keyColumn===1?String(rows[index]?.[1]??''):String(rows[index]?.[3]??'');
   if(!candidate)continue;
   const found=parseBoxScan(candidate);
   if(found.ok&&found.normalized===parsed.normalized)matches.push({row:index+1,values:rows[index]});
 }
 return {valid:true,code:parsed.normalized,matches};
}
export function buildBoxControlValues(record,previous,stamp,responsible){
 const scanned=parseBoxScan(record.original_code||record.code);
 if(!scanned.ok||record.code!==scanned.normalized)throw Error('BOX_INVALID');
 const statuses=['EN_PREPARACION','OBSERVADA','LISTA'];
 if(!statuses.includes(record.status))throw Error('BOX_STATE_INVALID');
 return [
   String(previous?.[0]||scanned.original),
   scanned.normalized,
   record.status,
   parseCargoCell(record.cargos||[]).join('-'),
   record.classification,
   record.started_at||'',
   record.finished_at||'',
   String(previous?.[7]||responsible||''),
   record.observation||'',
   String(previous?.[9]||''),
   stamp
 ];
}
export function validateSourceBox(record,match){
 if(!match)return {status:'new'};
 const src=match.values||[];
 const srcCargos=parseCargoCell(src[4]);
 const newCargos=parseCargoCell(record.cargos);
 const same=srcCargos.length===newCargos.length&&srcCargos.every(c=>newCargos.includes(c));
 if(!same)return {status:'conflict',reason:'Cargos diferentes en la hoja oficial'};
 if(clean(src[5])!==clean(record.classification))return {status:'conflict',reason:'Clasificación diferente en la hoja oficial'};
 if(String(src[6]||'').trim())return {status:'conflict',reason:'La caja ya tiene fecha de envío a Iron Mountain'};
 return {status:'existing'};
}
export function boxSourceRow(record,number,responsible,date){
 const scanned=parseBoxScan(record.original_code||record.code);
 if(!scanned.ok||scanned.normalized!==record.code||record.status!=='LISTA')throw Error('BOX_NOT_READY');
 const cargos=parseCargoCell(record.cargos||[]);
 if(!cargos.length||cargos.length>50)throw Error('CARGOS_INVALID');
 return [String(number),date,responsible,scanned.original,cargos.join('-'),record.classification];
}
