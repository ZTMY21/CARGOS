import test from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import {inspectMaster,appendMasterCargo,replaceLastMasterCargo} from '../server/cargo-excel-book.js';

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

test('same number of rows: replaces 944 data without changing table dimension',async()=>{
  const input=await fixture([[942,'ANTERIOR-942'],[943,'ANTERIOR-943'],
    [944,'EQUIVOCADO-1'],[944,'EQUIVOCADO-2'],[944,'EQUIVOCADO-3']]);
  const before=await inspectMaster(input,'depurado');
  const output=await replaceLastMasterCargo(input,'depurado',944,replacement);
  const after=await inspectMaster(output.bytes,'depurado');
  assert.equal(output.replaced,true);
  assert.equal(output.previousRows,3);
  assert.equal(after.counts[944],3);
  assert.equal(after.rows,before.rows);
  assert.equal(after.lastCargo,944);
  assert.equal(after.table,before.table);
  assert.ok(after.xml.includes('CORREGIDO-1'));
  assert.ok(after.xml.includes('CORREGIDO-3'));
  assert.ok(!after.xml.includes('EQUIVOCADO-1'));
  assert.ok(after.xml.includes('ANTERIOR-943'));
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


test('.xlsm original sin dimension, con cargos decimales y filas de formato sigue aceptando el siguiente cargo',async()=>{
  const zip=new JSZip();
  zip.file('xl/worksheets/sheet1.xml',
    '<worksheet><sheetData><row r="1"></row>'+
    '<row r="2"><c r="B2"><v>943.0</v></c></row>'+
    '<row r="3"><c r="B3"><v>944.0</v></c></row>'+
    '<row r="4"><c r="B4" s="20"/></row>'+
    '<row r="5"><c r="B5" s="20"/></row>'+
    '</sheetData><autoFilter ref="A1:K5"/></worksheet>');
  zip.file('xl/tables/table1.xml',
    '<table name="TablaConsolidada" ref="A1:K5"><autoFilter ref="A1:K5"/></table>');
  zip.file('xl/workbook.xml','<workbook><sheets>CARGOS NUEVOS 2026</sheets></workbook>');
  zip.file('xl/vbaProject.bin',Buffer.from('macro-original-intacta'));
  const input=await zip.generateAsync({type:'nodebuffer'});
  const before=await inspectMaster(input,'original');
  assert.equal(before.rows,5);
  assert.equal(before.lastCargo,944);
  assert.equal(before.counts[944],1);
  const next=[['2026-11-10','945','1','FACT-945','','','1','FACTURA','ESCANER','','']];
  const result=await appendMasterCargo(input,'original',945,next);
  const after=await inspectMaster(result.bytes,'original');
  assert.equal(result.rowsAdded,1);
  assert.equal(after.rows,6);
  assert.equal(after.lastCargo,945);
  assert.equal(after.counts[945],1);
  assert.equal(after.counts[944],1);
  assert.equal(after.counts[943],1);
  assert.ok(!after.xml.includes('<dimension'));
  assert.ok(after.xml.includes('<row r="5"><c r="B5" s="20"/></row>'));
  assert.ok(after.table.includes('ref="A1:K6"'));
  const postZip=await JSZip.loadAsync(result.bytes);
  assert.equal((await postZip.file('xl/vbaProject.bin').async('nodebuffer')).toString(),
    'macro-original-intacta');
});

test('no se omite una fila de maestro que tenga datos y no tenga cargo',async()=>{
  const zip=new JSZip();
  zip.file('xl/worksheets/sheet1.xml','<worksheet><sheetData><row r="1"></row>'+
    '<row r="2"><c r="D2"><v>987</v></c></row></sheetData></worksheet>');
  zip.file('xl/tables/table1.xml','<table name="TablaConsolidada" ref="A1:K2"/>');
  zip.file('xl/workbook.xml','<workbook>CARGOS NUEVOS 2026</workbook>');
  zip.file('xl/vbaProject.bin',Buffer.from('macro'));
  await assert.rejects(inspectMaster(await zip.generateAsync({type:'nodebuffer'}),'original'),
    /CARGO_INVALIDO_EN_MAESTRO/);
});


test('la carga posterior hereda Calibri 11 sin negrita del original y conserva altura y macros',async()=>{
  const zip=new JSZip();
  zip.file('xl/worksheets/sheet1.xml',
    '<worksheet><sheetData><row r="1"></row>'+
    '<row r="2" ht="15.75" customHeight="1"><c r="A2" s="16" t="inlineStr"><is><t>10-11-2026</t></is></c>'+
    '<c r="B2" s="17"><v>946</v></c><c r="C2" s="17"><v>1</v></c>'+
    '<c r="D2" s="16" t="inlineStr"><is><t>OLD</t></is></c>'+
    '<c r="G2" s="17"><v>1</v></c><c r="K2" s="16"/></row>'+
    '<row r="3" ht="15.75" customHeight="1"><c r="B3" s="20"/></row>'+
    '</sheetData><autoFilter ref="A1:K3"/></worksheet>');
  zip.file('xl/tables/table1.xml','<table name="TablaConsolidada" ref="A1:K3"><autoFilter ref="A1:K3"/></table>');
  zip.file('xl/workbook.xml','<workbook>CARGOS NUEVOS 2026</workbook>');
  zip.file('xl/vbaProject.bin',Buffer.from('existing macros'));
  const input=await zip.generateAsync({type:'nodebuffer'});
  const next=[['2026-11-10','947','2','FF-947','d.jpg','d.pdf','1','FACTURA','LECTURA','','']];
  const out=await appendMasterCargo(input,'original',947,next);
  const check=await inspectMaster(out.bytes,'original');
  const newRow=check.xml.match(/<row r="4"[^>]*>[\s\S]*?<\/row>/)?.[0];
  assert.ok(newRow);
  assert.match(newRow,/<row r="4" ht="15.75" customHeight="1">/);
  assert.match(newRow,/<c r="A4" s="16"/);
  assert.match(newRow,/<c r="D4" s="16"/);
  assert.match(newRow,/<c r="K4" s="16"/);
  assert.match(newRow,/<c r="B4" s="17"/);
  assert.match(newRow,/<c r="C4" s="17"/);
  assert.match(newRow,/<c r="G4" s="17"/);
  assert.doesNotMatch(newRow,/ s="2"/);
  assert.equal(check.counts[946],1);
  assert.equal(check.counts[947],1);
  const a=await JSZip.loadAsync(input),b=await JSZip.loadAsync(out.bytes);
  assert.deepEqual(await a.file('xl/vbaProject.bin').async('nodebuffer'),
    await b.file('xl/vbaProject.bin').async('nodebuffer'));
});

test('el libro depurado sigue heredando sus estilos 2 y 3',async()=>{
  const input=await fixture([[946,'VIGENTE']]);
  const next=[['2026-11-10','947','1','SIGUIENTE','','','1','FACTURA','','','']];
  const out=await appendMasterCargo(input,'depurado',947,next);
  const xml=(await inspectMaster(out.bytes,'depurado')).xml;
  const row=xml.match(/<row r="3"[^>]*>[\s\S]*?<\/row>/)?.[0];
  assert.ok(row);
  assert.match(row,/<c r="B3" s="3"/);
});
