import test from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import {inspectMaster,replaceLastMasterCargo} from '../server/cargo-excel-book.js';

function row(n,cargo,code){
  return '<row r="'+n+'" spans="1:11"><c r="B'+n+'" s="3"><v>'+cargo+
    '</v></c><c r="D'+n+'" t="inlineStr"><is><t>'+code+
    '</t></is></c></row>';
}
async function fixture(cargos,{original=false}={}){
  const zip=new JSZip(),last=cargos.length+1,ref='A1:K'+last;
  const body=cargos.map(([cargo,code],i)=>row(i+2,cargo,code)).join('');
  zip.file('xl/worksheets/sheet1.xml',
    '<worksheet><dimension ref="'+ref+'"/><sheetData><row r="1"></row>'+
      body+'</sheetData><autoFilter ref="'+ref+'"/></worksheet>');
  zip.file('xl/tables/table1.xml',
    '<table name="TablaConsolidada" ref="'+ref+'"><autoFilter ref="'+ref+'"/></table>');
  zip.file('xl/workbook.xml','<workbook><sheets>CARGOS NUEVOS 2026</sheets></workbook>');
  if(original)zip.file('xl/vbaProject.bin',Buffer.from('macros-unmodified'));
  return zip.generateAsync({type:'nodebuffer'});
}
const replacement=[
  ['2026-11-02','944','1','CORREGIDO-1','Document1.jpg','Doc1.pdf','1','PATRON_FF','F1_FAST','OK',''],
  ['2026-11-02','944','2','CORREGIDO-2','Document2.jpg','Doc2.pdf','1','PATRON_FF','F1_FAST','OK',''],
  ['2026-11-02','944','3','CORREGIDO-3','Document3.jpg','Doc3.pdf','1','PATRON_FF','F1_FAST','OK','']
];

test('orphan latest cargo is replaced, not appended, while previous cargos and table stay intact',async()=>{
  const input=await fixture([[942,'ANTERIOR-942'],[943,'ANTERIOR-943'],
    [944,'EQUIVOCADO-1'],[944,'EQUIVOCADO-2']]);
  const output=await replaceLastMasterCargo(input,'depurado',944,replacement);
  const check=await inspectMaster(output.bytes,'depurado');
  assert.equal(output.replaced,true);
  assert.equal(output.previousRows,2);
  assert.equal(check.counts[944],3);
  assert.equal(check.counts[943],1);
  assert.equal(check.counts[942],1);
  assert.equal(check.rows,6);
  const xml=check.xml;
  assert.ok(xml.includes('ANTERIOR-942'));
  assert.ok(xml.includes('ANTERIOR-943'));
  assert.ok(xml.includes('CORREGIDO-1'));
  assert.ok(xml.includes('CORREGIDO-3'));
  assert.ok(!xml.includes('EQUIVOCADO-1'));
  assert.ok(!xml.includes('EQUIVOCADO-2'));
  assert.ok(check.table.includes('ref="A1:K6"'));
});

test('the reconciliation refuses replacing earlier cargos or a mixed tail',async()=>{
  const input=await fixture([[942,'EXISTENTE'],[943,'EXISTENTE'],
    [944,'MALO'],[944,'MALO']]);
  await assert.rejects(replaceLastMasterCargo(input,'depurado',943,replacement),
    /CORRECCION_SOLO_ULTIMO_CARGO/);
  const mixed=await fixture([[942,'ANTIGUO'],[944,'MALO'],[943,'OTRO']]);
  await assert.rejects(replaceLastMasterCargo(mixed,'depurado',944,replacement),
    /OTROS_CARGOS_MEZCLADOS_EN_TRAMO/);
});

test('reconciliation of macro-enabled original retains VBA bytes',async()=>{
  const input=await fixture([[942,'A'],[943,'B'],[944,'MAL']],{original:true});
  const before=await JSZip.loadAsync(input);
  const output=await replaceLastMasterCargo(input,'original',944,replacement);
  const after=await JSZip.loadAsync(output.bytes);
  assert.deepEqual(await after.file('xl/vbaProject.bin').async('nodebuffer'),
    await before.file('xl/vbaProject.bin').async('nodebuffer'));
  assert.equal((await inspectMaster(output.bytes,'original')).counts[944],3);
});
