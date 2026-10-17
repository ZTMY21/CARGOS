import test from 'node:test';
import assert from 'node:assert/strict';
import {gzipSync} from 'node:zlib';
import ExcelJS from 'exceljs';
import {cargoLocations,groupsForCodes,cargoYear} from '../src/cargo-details.js';
import {buildCargoWorkbook} from '../src/cargo-export.js';
import {KardexRepository} from '../src/repository.js';

const origin={columnas:['Codigo','Grupo'],registros_gzip_base64:gzipSync(JSON.stringify([
 ['F-001','2'],['F-001','17'],['GR001','14'],['BV001',''],['F-002','1']
])).toString('base64')};
test('groups use exact document codes, retain multiple groups and groups above 14, with no invented missing values',async()=>{
 const locations=await cargoLocations(origin);
 assert.deepEqual(groupsForCodes(locations,['f001']),['2','17']);
 assert.deepEqual(groupsForCodes(locations,['GR-001']),['14']);
 assert.deepEqual(groupsForCodes(locations,['BV001']),[]);
 assert.deepEqual(groupsForCodes(locations,['F-00']),[]);
 assert.equal(cargoYear({anioOrigen:2024,fechaOrigen:'2023-01-01'}),'2024');
 assert.equal(cargoYear({periodo:'2026-10-01'}),'2026');
 const updated=await cargoLocations({...origin,grupos_por_codigo:{f001:['19']}});
 assert.deepEqual(updated.f001,['19']);
});
test('guest Excel contains one cargo, all its documents and groups, no sustento or hidden source data',async()=>{
 const doc={kardex:'SA-1',cargos:['005'],anioOrigen:2023,facturas:'F-001, GR001, BV001, F-002',datosOrigen:origin,sustento:'PRIVATE',sustentoImagen:'PRIVATE-IMAGE'};
 const wb=await buildCargoWorkbook(doc);
 const loaded=new ExcelJS.Workbook();await loaded.xlsx.load(await wb.xlsx.writeBuffer());
 assert.deepEqual(loaded.worksheets.map(s=>s.name),['Cargo']);
 const sheet=loaded.worksheets[0];assert.equal(sheet.rowCount,5);
 assert.deepEqual(sheet.getRow(2).values.slice(1),['SA-1','2023','005','F-001','Grupo 2, Grupo 17']);
 assert.equal(sheet.getCell('E4').value,'Sin grupo registrado');
 assert.doesNotMatch(JSON.stringify(sheet.model),/PRIVATE|Sustento|registros_gzip/);
});
test('search enriches only matched IDs and source failures leave results available with an explicit error',async()=>{
 let requested;const rows=[{id:'selected'}];
 const client={rpc(){return Promise.resolve({data:{rows:structuredClone(rows)},error:null});},from(table){assert.equal(table,'documentos');return {select(columns){assert.equal(columns,'id,datos_origen');return this;},in(column,ids){requested=ids;return Promise.resolve({data:[{id:'selected',datos_origen:origin}],error:null});}};}};
 const repo=new KardexRepository(client);const result=await repo.search({query:'F-001'});
 assert.deepEqual(requested,['selected']);assert.deepEqual(result.rows[0].ubicaciones_codigo.f001,['2','17']);
 client.from=()=>({select(){return this;},in(){return Promise.resolve({error:new Error('offline')});}});
 const failed=await repo.search({query:'F-001'});assert.equal(failed.rows[0].id,'selected');assert.match(failed.rows[0].error_ubicacion,/No se pudo/);
});
