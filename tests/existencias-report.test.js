import test from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import {buildExistenciasReport,buildAnnualCargoReport,serializeExistenciasReport,
  REPORT_YEARS,CARGO_COLUMNS,ORIGINAL_COLUMNS,REQ_COLUMNS} from '../src/existencias-report.js';

const now=new Date('2026-10-28T02:00:00Z');
const base={id:'base',kardex:'SA-00001',cargos:['653'],anioOrigen:2026,fechaOrigen:'2026-01-06',
  fechaRegistro:'2026-10-15',tipoDoc:'Facturas-Guia',periodo:'',ubicacion:'Santa Anita',
  folios:8,cantidadFacturas:2,cantidadRegistros:3,usuario:'Operador',obs:'No mostrar',
  datosOrigen:{cantidad_registros:3}};

test('reporte conserva barra inferior y enlaza cada año a su propia hoja',async()=>{
  assert.deepEqual(REPORT_YEARS,[2020,2021,2022,2023,2024,2025,2026]);
  const historical=REPORT_YEARS.slice(1,-1).map((year,i)=>({...base,id:'h'+i,
    kardex:'SA-'+String(i+2).padStart(5,'0'),anioOrigen:year,cargos:[String(100+i)],
    fechaOrigen:year+'-02-05'}));
  const sent={...base,id:'sent',kardex:'SA-00020',imConfirmado:true,imFechaEnvio:'2026-10-20',
    imResponsable:'Responsable del envío'};
  const data=buildExistenciasReport([...historical,base,sent],now);
  const original={
    columnas:['Fecha','Cargo','Grupo','Codigo','Archivo_Principal','PDF','Total_Paginas',
      'Tipo','Fuente','Observaciones','ESTADO_REGULARIZADO'],
    registros:[{Fecha:'06-01-2026',Cargo:'653',Grupo:'1',Codigo:'01FF0100084457',
      Archivo_Principal:'Imagen.jpg',PDF:'01-0FF01-0084457.pdf',Total_Paginas:'2',
      Tipo:'PATRON_FF',Fuente:'F1_FAST',Observaciones:'OK',ESTADO_REGULARIZADO:''}]
  };
  const originalSource=async function* (year){
    for(const doc of [...historical,base,sent].filter(d=>String(d.anioOrigen)===String(year)))
      yield {doc,origin:year==='2026'?original:{registros:[]}};
  };
  const buffer=await serializeExistenciasReport(data,originalSource);
  const raw=buffer instanceof Blob?await buffer.arrayBuffer():buffer;
  const zip=await JSZip.loadAsync(raw);
  const workbookXml=await zip.file('xl/workbook.xml').async('string');
  const summaryXml=await zip.file('xl/worksheets/sheet1.xml').async('string');
  const summaryRels=await zip.file('xl/worksheets/_rels/sheet1.xml.rels')?.async('string')||'';
  assert.match(workbookXml,/<workbookView[^>]*showSheetTabs="1"/);
  assert.doesNotMatch(workbookXml,/<sheet[^>]*state="hidden"/);
  assert.match(summaryXml,/ref="C19"[^>]*location="&apos;Cargos 2026&apos;!A1"/);
  assert.match(summaryXml,/ref="C25"[^>]*location="&apos;Cargos 2020&apos;!A1"/);
  assert.match(summaryXml,/ref="B4"[^>]*location="&apos;Cargos&apos;!A1"/);
  assert.match(summaryXml,/ref="C4"[^>]*location="&apos;Requerimientos&apos;!A1"/);
  assert.doesNotMatch(summaryRels,/TargetMode="External"/);
  const wb=new ExcelJS.Workbook();await wb.xlsx.load(raw);
  assert.deepEqual(wb.worksheets.map(s=>s.name),
    ['Resumen','Cargos',...REPORT_YEARS.slice().reverse().map(year=>'Cargos '+year),'Requerimientos']);
  const res=wb.getWorksheet('Resumen'),cargos=wb.getWorksheet('Cargos'),
    detail=wb.getWorksheet('Cargos 2026'),req=wb.getWorksheet('Requerimientos');
  assert.equal(res.getCell('B7').value,'6 (48 folios)');
  assert.equal(res.getCell('B8').numFmt,'0%');
  assert.equal(res.getCell('B6').fill.fgColor.argb,'FFC00000');
  assert.equal(res.getCell('B6').font.name,'Arial');
  assert.deepEqual(REPORT_YEARS.map((_,i)=>res.getCell('B'+(19+i)).value),REPORT_YEARS.slice().reverse());
  assert.equal(res.getCell('C19').value,'1');
  assert.equal(res.getCell('C25').value,'0');
  assert.deepEqual(cargos.getRow(1).values.slice(1,17),CARGO_COLUMNS);
  assert.deepEqual(detail.getRow(1).values.slice(1,12),ORIGINAL_COLUMNS);
  assert.deepEqual(req.getRow(1).values.slice(1,11),REQ_COLUMNS);
  assert.equal(req.rowCount,1);
  assert.equal(cargos.getCell('A2').value,'SA-00001');
  assert.equal(cargos.getCell('A8').value,'SA-00020');
  assert.equal(cargos.getCell('E8').value,'Iron Mountain');
  assert.equal(cargos.getCell('M8').value,'Enviado');
  assert.equal(cargos.getCell('O8').value,'Responsable del envío');
  assert.equal(cargos.getCell('G8').value,3);
  assert.equal(detail.rowCount,3);
  assert.equal(detail.getCell('B2').value,'653');
  assert.equal(detail.getCell('D2').value,'01FF0100084457');
  assert.equal(detail.getCell('F2').value,'01-0FF01-0084457.pdf');
  assert.equal(detail.getCell('G2').value,2);
  const detailXml=await zip.file('xl/worksheets/sheet3.xml').async('string');
  assert.match(detailXml,/ref="Q1"[^>]*location="&apos;Resumen&apos;!B2"/);
});

test('2026 une cargos repetidos del resumen, pero Cargos conserva todos los Kardex',()=>{
  const added={...base,id:'added',kardex:'SA-00022',cargos:['654'],fechaOrigen:'2026-10-27'};
  const wb=buildExistenciasReport([base,{...base,id:'duplicate',kardex:'SA-00030'},added],now);
  assert.equal(wb.getWorksheet('Resumen').getCell('C19').value.text,'2');
  assert.equal(wb.getWorksheet('Cargos 2026').getRow(1).values.slice(1,12).join('|'),ORIGINAL_COLUMNS.join('|'));
  assert.equal(wb.getWorksheet('Cargos 2026').rowCount,2);
  assert.equal(wb.getWorksheet('Cargos').rowCount,4);
  assert.equal(buildAnnualCargoReport([base,{...base,id:'duplicate'},added],2026,now)
    .getWorksheet('Detalle de Cargo 2026').rowCount,3);
  const a={...base,id:'a',anioOrigen:2024,cargos:['0028']};
  const b={...base,id:'b',anioOrigen:2024,cargos:['28']};
  assert.equal(buildAnnualCargoReport([a,b],2024,now)
    .getWorksheet('Detalle de Cargo 2024').rowCount,3);
});

test('el listado de cada año ordena los números de cargo de menor a mayor',()=>{
  const a={...base,id:'a',kardex:'SA-00003',anioOrigen:2020,cargos:['10']};
  const b={...base,id:'b',kardex:'SA-00002',anioOrigen:2020,cargos:['2']};
  const wb=buildExistenciasReport([a,b],now);
  const tab=wb.getWorksheet('Cargos 2020'),summary=wb.getWorksheet('Resumen');
  assert.equal(summary.getCell('C25').value.hyperlink,"#'Cargos 2020'!A1");
  assert.equal(tab.getCell('B1').value,'Cargo');
  assert.equal(tab.getCell('D1').value,'Codigo');
  assert.equal(tab.getCell('K1').value,'ESTADO_REGULARIZADO');
});

test('porcentajes vencidos y por vencer coinciden con base 100 por número de cargos',()=>{
  const docs=[
    ...Array.from({length:3},(_,i)=>({...base,id:'up-'+i,
      kardex:'SA-'+String(i+10).padStart(5,'0'),cargos:[String(i+500)],
      fechaOrigen:'2026-09-01',folios:2})),
    ...Array.from({length:13},(_,i)=>({...base,id:'late-'+i,
      kardex:'SA-'+String(i+100).padStart(5,'0'),cargos:[String(i+700)],
      fechaOrigen:'2026-02-01',folios:2}))
  ];
  const wb=buildExistenciasReport(docs,now);
  const res=wb.getWorksheet('Resumen');
  assert.equal(res.getCell('B13').value,'3 (6 folios)');
  assert.equal(res.getCell('C13').value,'13 (26 folios)');
  assert.equal(res.getCell('B14').value,0.19);
  assert.equal(res.getCell('C14').value,0.81);
  assert.equal(res.getCell('B14').value+res.getCell('C14').value,1);
  assert.equal(res.getCell('B14').numFmt,'0%');
});

test('el responsable del envío sigue correcto, sin usuario de importación',()=>{
  const sent={...base,imLiveCodigoCaja:'CAJA',imLiveFechaEnvio:'2026-10-27',
    imLiveResponsableEntrega:'Entrega registrada',usuario:'Importación Excel',obs:'secreto'};
  const row=buildExistenciasReport([sent],now).getWorksheet('Cargos').getRow(2);
  assert.equal(row.getCell(5).value,'Iron Mountain');
  assert.equal(row.getCell(11).value,'27/10/2026');
  assert.equal(row.getCell(15).value,'Entrega registrada');
  assert.equal(row.getCell(16).value,'');
});

test('exportación ordena Cargo ascendente y Grupo 1, 2, 3 sin alterar el orden original del grupo',async()=>{
  const doc2={...base,id:'doc2',kardex:'SA-02002',cargos:['2']};
  const doc10a={...base,id:'doc10a',kardex:'SA-02010',cargos:['10']};
  const doc10b={...base,id:'doc10b',kardex:'SA-02011',cargos:['10']};
  const rows=(cargo,groupCodes)=>groupCodes.map(([group,code])=>({
    Fecha:'27-10-2026',Cargo:cargo,Grupo:group,Codigo:code,
    Archivo_Principal:'origen',PDF:'',Total_Paginas:'1',Tipo:'FACT',
    Fuente:'Original',Observaciones:'',ESTADO_REGULARIZADO:''
  }));
  const original2=rows('2',[['3','2G3'],['1','2G1'],['2','2G2']]);
  const original10a=rows('10',[['3','10G3A'],['1','10G1A'],['2','10G2']]);
  const original10b=rows('10',[['3','10G3B'],['1','10G1B']]);
  const byId=new Map([['doc2',original2],['doc10a',original10a],['doc10b',original10b]]);
  const all=[doc2,doc10a,doc10b];
  const source=async function* (year){
    if(year!=='2026')return;
    for(const doc of all)yield {doc,origin:{registros:byId.get(doc.id)}};
  };
  const workbook=buildExistenciasReport(all,now);
  const blob=await serializeExistenciasReport(workbook,source);
  const loaded=new ExcelJS.Workbook();await loaded.xlsx.load(await blob.arrayBuffer());
  const detail=loaded.getWorksheet('Cargos 2026');
  const actual=Array.from({length:8},(_,i)=>[detail.getCell('B'+(i+2)).value,
    detail.getCell('C'+(i+2)).value,detail.getCell('D'+(i+2)).value]);
  assert.deepEqual(actual,[['2','1','2G1'],['2','2','2G2'],['2','3','2G3'],
    ['10','1','10G1A'],['10','1','10G1B'],['10','2','10G2'],
    ['10','3','10G3A'],['10','3','10G3B']]);
});
