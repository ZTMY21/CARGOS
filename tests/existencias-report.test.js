import test from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import {buildExistenciasReport,REPORT_YEARS} from '../src/existencias-report.js';

const now=new Date('2026-10-28T02:00:00Z'); // 27 de octubre en Lima.
const base={kardex:'SA-00001',cargos:['653'],anioOrigen:2026,fechaOrigen:'2026-01-06',
  fechaRegistro:'2026-10-15',tipoDoc:'Facturas-Guia',periodo:'',ubicacion:'Santa Anita',
  folios:8,cantidadFacturas:2,usuario:'Operador',obs:'Observación original',
  datosOrigen:{cantidad_registros:3}};

test('each year quantity opens an internal sheet with exactly one row per cargo',async()=>{
  const historical=REPORT_YEARS.slice(0,-1).map((year,i)=>({...base,
    kardex:`SA-${String(i+2).padStart(5,'0')}`,anioOrigen:year,cargos:[String(100+i)],
    fechaOrigen:`${year}-02-05`,datosOrigen:{cantidad_registros:1},cantidadFacturas:1}));
  const sent={...base,kardex:'SA-00020',imConfirmado:true,imFechaEnvio:'2026-10-20'};
  const other={...base,kardex:'SA-00021',anioOrigen:2020,cargos:['50'],fechaOrigen:'2020-02-05'};
  const wb=buildExistenciasReport([...historical,base,sent,other],now);
  const saved=new ExcelJS.Workbook();await saved.xlsx.load(await wb.xlsx.writeBuffer());
  assert.deepEqual(saved.worksheets.map(s=>s.name),['Resumen','Cargos',
    ...REPORT_YEARS.map(year=>`Detalle de Cargo ${year}`),'Requerimientos']);
  const summary=saved.getWorksheet('Resumen');
  assert.equal(summary.getCell('B7').value.result,'7 (56 folios)');
  assert.deepEqual(REPORT_YEARS.map((_,i)=>summary.getCell(`B${19+i}`).value),REPORT_YEARS);
  for(const [i,year] of REPORT_YEARS.entries()){
    const link=summary.getCell(`C${19+i}`).value;
    assert.equal(link.text,'1');
    assert.equal(link.hyperlink,`#'Detalle de Cargo ${year}'!A1`);
    const detail=saved.getWorksheet(`Detalle de Cargo ${year}`);
    assert.equal(detail.rowCount,2);
    assert.equal(detail.getCell('I2').value,year===2026?'653':String(100+i));
    assert.deepEqual(detail.getRow(1).values.slice(1),saved.getWorksheet('Cargos').getRow(1).values.slice(1));
  }
  assert.match(summary.getCell('B27').value,/1 cargos de otros años/);
  assert.equal(summary.getCell('B28').value,null);
  const rows=saved.getWorksheet('Cargos');
  assert.equal(rows.rowCount,8);
  assert.equal(saved.getWorksheet('Detalle de Cargo 2026').getCell('L2').value,'Enviado');
  assert.equal(saved.getWorksheet('Detalle de Cargo 2026').getCell('E2').value,'Aeromontain');
  assert.equal(rows.getColumn(16).hidden,true);
  assert.equal(saved.getWorksheet('Requerimientos').rowCount,0);
});

test('new 2026 cargo appears on the next download and duplicate invoice rows do not inflate the year',()=>{
  const initial=buildExistenciasReport([base],now);
  assert.equal(initial.getWorksheet('Resumen').getCell('C24').value.text,'1');
  const newCargo={...base,kardex:'SA-00022',cargos:['654'],fechaOrigen:'2026-10-27',
    datosOrigen:{cantidad_registros:4}};
  const withNew=buildExistenciasReport([base,{...base,kardex:'SA-00030'},newCargo],now);
  assert.equal(withNew.getWorksheet('Resumen').getCell('C24').value.text,'2');
  assert.deepEqual([2,3].map(row=>withNew.getWorksheet('Detalle de Cargo 2026').getCell(`I${row}`).value),['654','653']);
  assert.equal(withNew.getWorksheet('Detalle de Cargo 2026').rowCount,3);
});

test('historical cargos with distinct Kardex remain distinct even with the same normalized number',()=>{
  const a={...base,kardex:'SA-02866',anioOrigen:2024,cargos:['0028']};
  const b={...base,kardex:'SA-03122',anioOrigen:2024,cargos:['28']};
  const wb=buildExistenciasReport([a,b],now);
  assert.equal(wb.getWorksheet('Resumen').getCell('C22').value.text,'2');
  assert.deepEqual([2,3].map(row=>wb.getWorksheet('Detalle de Cargo 2024').getCell(`A${row}`).value).sort(),
    ['SA-02866','SA-03122']);
});
