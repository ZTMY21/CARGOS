import test from 'node:test';
import assert from 'node:assert/strict';
import {
 BOX_HEADERS,verifyBoxSourceHeader,matchBoxRow,buildBoxControlValues,validateSourceBox,boxSourceRow
} from '../src/box-sheet-sync.js';
const header=['N°','FECHA DE PREPARACION\nDE CAJAS','RESPONSABLE','CODIGO DE BARRAS\nDE CAJAS',
 'NUMERO DE\nCARGOS','CLASIFICACIÓN DE\nCAJA','FECHA DE ENVIO A\nIRON MOUNTAIN',
 'RESPONSABLE\nEN ENTREGAR','RESPONSABLE\nEN RECIBIR','PLACA'];
const condition={code:'00990011',original_code:'TD00990011',cargos:['933','934'],
 classification:'Cajas Nuevas',status:'LISTA',started_at:'2026-11-01T14:00:00-05:00',
 finished_at:'2026-11-01T14:20:00-05:00',observation:''};
test('reconoce exclusivamente cabecera original CARGOS ENVIADOS A:J',()=>{
 assert.equal(verifyBoxSourceHeader([header]),true);
 assert.equal(verifyBoxSourceHeader([['Caja','Estado','Cargos']]),false);
});
test('conserva prefijos T/TD/P y ceros sin duplicar la misma caja',()=>{
 const data=[BOX_HEADERS,['T00990011','00990011','ESCANEADA'],['P00990012','00990012','ESCANEADA']];
 const result=matchBoxRow(data,'TD00990011',1);
 assert.equal(result.matches.length,1);
 assert.equal(result.matches[0].row,2);
 assert.equal(matchBoxRow(data,'00990012',1).matches.length,1);
 assert.equal(matchBoxRow(data,'T00990013',1).matches.length,0);
});
test('la tabla de control preserva última lectura y cargo original mientras cambia el estado',()=>{
 const old=['T00990011','00990011','ESCANEADA','','','','','admin@company.com','','01/11/2026 09:00',''];
 const newRow=buildBoxControlValues(condition,old,'01/11/2026 14:20','other@company.com');
 assert.equal(newRow[0],'T00990011');
 assert.equal(newRow[1],'00990011');
 assert.equal(newRow[2],'LISTA');
 assert.equal(newRow[3],'933-934');
 assert.equal(newRow[7],'admin@company.com');
 assert.equal(newRow[9],'01/11/2026 09:00');
 assert.equal(newRow.length,11);
});
test('solo agrega A:F a la hoja oficial cuando la caja está lista',()=>{
 const inserted=boxSourceRow(condition,50,'admin@company.com','01/11/2026');
 assert.deepEqual(inserted,['50','01/11/2026','admin@company.com','TD00990011','933-934','Cajas Nuevas']);
 assert.equal(inserted.length,6); // G:J son campos de envío no modificables por acondicionamiento.
 assert.throws(()=>boxSourceRow({...condition,status:'OBSERVADA'},50,'admin','01/11/2026'),/NOT_READY/);
});
test('bloquea conflicto con caja enviada, cargo incorrecto o clasificación distinta',()=>{
 const source=[header,['49','20/10/2026','user','T00990011','933-934','Cajas Nuevas','','','','']];
 const match=matchBoxRow(source,'TD00990011',3).matches[0];
 assert.equal(validateSourceBox(condition,match).status,'existing');
 assert.equal(validateSourceBox({...condition,cargos:['933']},match).status,'conflict');
 assert.equal(validateSourceBox({...condition,classification:'POR SOLICITUD'},match).status,'conflict');
 assert.equal(validateSourceBox(condition,{values:[...match.values.slice(0,6),'21/10/2026']}).status,'conflict');
});
