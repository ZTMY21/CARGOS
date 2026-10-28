import test from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import {gzipSync} from 'node:zlib';
import {buildExistenciasReport,buildYearDetailReport,DETAIL_COLUMNS} from '../src/existencias-report.js';

const now=new Date('2026-10-28T02:00:00Z'); // 27 de octubre en Lima.
const base={kardex:'SA-00001',cargos:['653'],anioOrigen:2026,fechaOrigen:'2026-01-06',
  fechaRegistro:'2026-10-15',tipoDoc:'Facturas-Guia',periodo:'',ubicacion:'Santa Anita',
  folios:8,cantidadFacturas:2,usuario:'Operador',obs:'Observación original',
  datosOrigen:{cantidad_registros:3,registros:[
    {Fecha:'2026-01-06',Cargo:'653',Grupo:'A',Codigo:'F001',Total_Paginas:3},
    {Fecha:'2026-01-06',Cargo:'653',Grupo:'B',Codigo:'F002',Total_Paginas:5}
  ]}};

test('report counts distinct cargos and retains only years 2023–2026 with live links',async()=>{
  const sent={...base,kardex:'SA-00002',imConfirmado:true,imFechaEnvio:'2026-10-20',
    datosOrigen:{cantidad_registros:3,registros:base.datosOrigen.registros}};
  const old={...base,kardex:'SA-00003',anioOrigen:2023,cargos:['10'],fechaOrigen:'2023-02-05',
    datosOrigen:{cantidad_registros:1},cantidadFacturas:1};
  const wb=buildExistenciasReport([base,sent,old],now,'https://kardex.example.test/');
  const reloaded=new ExcelJS.Workbook();await reloaded.xlsx.load(await wb.xlsx.writeBuffer());
  assert.deepEqual(reloaded.worksheets.map(s=>s.name),['Resumen','Cargos','Requerimientos']);
  const summary=reloaded.getWorksheet('Resumen');
  assert.equal(summary.getCell('B7').value.result,'2 (16 folios)');
  assert.deepEqual([19,20,21,22].map(r=>summary.getCell(`B${r}`).value),[2023,2024,2025,2026]);
  assert.match(summary.getCell('B23').value,/detalle de ese año/);
  assert.equal(summary.getCell('B24').value,null);
  assert.equal(summary.getCell('C22').value.hyperlink,'https://kardex.example.test/?detalleCargo=2026');
  const rows=reloaded.getWorksheet('Cargos');
  assert.equal(rows.rowCount,3);
  assert.equal(rows.getCell('K2').value,'');
  assert.equal(rows.getCell('L2').value,'Enviado');
  assert.equal(rows.getCell('E2').value,'Aeromontain');
  assert.equal(rows.getCell('N2').value,'Operador');
  assert.equal(rows.getCell('G2').value,3);
  assert.equal(rows.getCell('H2').value,2);
  assert.equal(rows.getCell('O2').value,'Observación original');
  assert.equal(rows.getColumn(16).hidden,true);
  assert.equal(reloaded.getWorksheet('Requerimientos').rowCount,0);
});

test('annual detail combines historical and current 2026 rows in original column order',async()=>{
  const zipped=gzipSync(JSON.stringify([
    [2,'2026-10-27','653','C','F003','','',4,'','','','']
  ])).toString('base64');
  const newer={...base,kardex:'SA-99999',datosOrigen:{registros:[
    {...base.datosOrigen.registros[0]},
    {Fecha:'2026-10-27',Cargo:'653',Grupo:'C',Codigo:'F003',Total_Paginas:4}
  ]}};
  const compressed={...newer,kardex:'SA-99998',datosOrigen:{
    columnas:['_fila_excel',...DETAIL_COLUMNS],registros_gzip_base64:zipped
  }};
  const wb=await buildYearDetailReport([base,newer,compressed],2026);
  const sheet=wb.getWorksheet('Detalle de Cargo 2026');
  assert.deepEqual(sheet.getRow(1).values.slice(1),DETAIL_COLUMNS);
  assert.equal(sheet.rowCount,4);
  assert.deepEqual([2,3,4].map(r=>sheet.getCell(`D${r}`).value),['F001','F002','F003']);
  await assert.rejects(()=>buildYearDetailReport([],2027),/fuera del período/);
});
