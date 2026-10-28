import test from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import {buildExistenciasReport,buildAnnualCargoReport,REPORT_YEARS,CARGO_COLUMNS,REQ_COLUMNS,DETAIL_COLUMNS} from '../src/existencias-report.js';

const now=new Date('2026-10-28T02:00:00Z');
const base={id:'base',kardex:'SA-00001',cargos:['653'],anioOrigen:2026,fechaOrigen:'2026-01-06',
  fechaRegistro:'2026-10-15',tipoDoc:'Facturas-Guia',periodo:'',ubicacion:'Santa Anita',
  folios:8,cantidadFacturas:2,cantidadRegistros:3,usuario:'Operador',obs:'No mostrar',
  datosOrigen:{cantidad_registros:3}};
const save=async wb=>{const result=new ExcelJS.Workbook();await result.xlsx.load(await wb.xlsx.writeBuffer());return result;};

test('the base workbook layout survives serialization and yearly details appear only on demand',async()=>{
  const historical=REPORT_YEARS.slice(0,-1).map((year,i)=>({...base,id:'h'+i,
    kardex:'SA-'+String(i+2).padStart(5,'0'),anioOrigen:year,cargos:[String(100+i)],fechaOrigen:year+'-02-05'}));
  const sent={...base,id:'sent',kardex:'SA-00020',imConfirmado:true,imFechaEnvio:'2026-10-20',
    imResponsable:'Responsable del envío'};
  const wb=await save(buildExistenciasReport([...historical,base,sent],now,'https://example.com/'));
  assert.deepEqual(wb.worksheets.map(s=>s.name),['Resumen','Cargos','Requerimientos']);
  const res=wb.getWorksheet('Resumen'),cargos=wb.getWorksheet('Cargos'),req=wb.getWorksheet('Requerimientos');
  assert.equal(res.getCell('C6').value,'Enviado a Iron Mountain');
  assert.equal(res.getCell('E6').value,'Pendientes de Envío IM');
  assert.equal(res.getCell('B7').value,'6 (48 folios)');
  assert.equal(res.getCell('B8').numFmt,'0%');
  assert.equal(res.getCell('B8').alignment.horizontal,'center');
  assert.equal(res.getCell('B6').fill.fgColor.argb,'FFC00000');
  assert.equal(res.getCell('B6').font.name,'Arial');
  assert.deepEqual(REPORT_YEARS.map((_,i)=>res.getCell('B'+(19+i)).value),REPORT_YEARS);
  assert.equal(res.getCell('C24').value.hyperlink,'https://example.com/?detalleCargo=2026');
  assert.equal(res.getCell('B25').value,null);
  assert.deepEqual(cargos.getRow(1).values.slice(1),CARGO_COLUMNS);
  assert.deepEqual(req.getRow(1).values.slice(1),REQ_COLUMNS);
  assert.equal(req.rowCount,1);
  assert.equal(req.getCell('A1').fill.fgColor.argb,'FF1F4E78');
  assert.equal(cargos.getCell('E2').value,'Iron Mountain');
  assert.equal(cargos.getCell('M2').value,'Enviado');
  assert.equal(cargos.getCell('O2').value,'Responsable del envío');
  assert.equal(cargos.getCell('P2').value,'');
  assert.equal(cargos.getCell('L2').value,'');
  assert.equal(cargos.getCell('G2').value,3);
  const annual=await save(buildAnnualCargoReport([...historical,base,sent],2026,now));
  const detail=annual.getWorksheet('Detalle de Cargo 2026');
  assert.deepEqual(annual.worksheets.map(s=>s.name),['Detalle de Cargo 2026']);
  assert.deepEqual(detail.getRow(1).values.slice(1),DETAIL_COLUMNS);
  assert.equal(detail.rowCount,2);
  assert.equal(detail.getCell('G2').value,'653');
});

test('2026 updates and merges repeated cargo; older Kardex rows remain separate',()=>{
  const added={...base,id:'added',kardex:'SA-00022',cargos:['654'],fechaOrigen:'2026-10-27'};
  const wb=buildExistenciasReport([base,{...base,id:'duplicate',kardex:'SA-00030'},added],now,'https://example.com/');
  assert.equal(wb.getWorksheet('Resumen').getCell('C24').value.text,'2');
  assert.equal(buildAnnualCargoReport([base,{...base,id:'duplicate'},added],2026,now)
    .getWorksheet('Detalle de Cargo 2026').rowCount,3);
  const a={...base,id:'a',anioOrigen:2024,cargos:['0028']};
  const b={...base,id:'b',anioOrigen:2024,cargos:['28']};
  assert.equal(buildAnnualCargoReport([a,b],2024,now).getWorksheet('Detalle de Cargo 2024').rowCount,3);
});

test('live sent cargo uses the delivery responsible, with no import user or observations',()=>{
  const sent={...base,imLiveCodigoCaja:'CAJA',imLiveFechaEnvio:'2026-10-27',
    imLiveResponsableEntrega:'Entrega registrada',usuario:'Importación Excel',obs:'secreto'};
  const row=buildExistenciasReport([sent],now).getWorksheet('Cargos').getRow(2);
  assert.equal(row.getCell(5).value,'Iron Mountain');
  assert.equal(row.getCell(11).value,'27/10/2026');
  assert.equal(row.getCell(15).value,'Entrega registrada');
  assert.equal(row.getCell(16).value,'');
});
