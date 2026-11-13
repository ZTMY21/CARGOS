import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import JSZip from 'jszip';
import ExcelJS from 'exceljs';
import {createExistenciasSourcesHandler} from '../api/existencias-sources.js';
import {MASTERS} from '../server/cargo-excel-book.js';
import {IM_HISTORY_FILE_ID,IM_HISTORY_FILE_NAME,IM_HISTORY_PARENT_ID} from '../server/im-history-workbook.js';
import {IM_MASTER_FILE_ID,IM_MASTER_PARENT_ID} from '../server/im-master-workbook.js';
import {readExistenciasMaster,reconcileExistenciasMasters} from '../server/existencias-masters.js';
import {applyExistenciasFolios,summarizeExistenciasFolios,ORIGINAL_COLUMNS} from '../src/existencias-data.js';

const rows=[
  ['10-11-2026',933,2,'A','documento','A.pdf','2','FACT','F1','',''],
  ['10-11-2026',933,1,'','documento sin código','B.pdf','3','FACT','F1','',''],
  ['11-11-2026',934,1,'B','','','','','','',''],
  ['31-12-2025',931,1,'C','','','4','','','','']
];
const workbook=async(name,values)=>{
  const wb=new ExcelJS.Workbook(),sheet=wb.addWorksheet(name);
  values.forEach(row=>sheet.addRow(row));
  return Buffer.from(await wb.xlsx.writeBuffer());
};

test('la lectura conserva orden, duplicados y documentos sin código, y bloquea diferencias documentales',async()=>{
  const bytes=await workbook('CARGOS NUEVOS 2026',[ORIGINAL_COLUMNS,...rows,rows[0]]);
  const original=await readExistenciasMaster(bytes);
  assert.deepEqual(original,[...rows,rows[0]]);
  assert.deepEqual(reconcileExistenciasMasters(original,[rows[0],...rows.slice(2),rows[0]]),original);
  assert.throws(()=>reconcileExistenciasMasters(original,rows.slice(1)),/2026:933/);
  const altered=rows.map((row,i)=>i===0?row.map((value,col)=>col===6?'9':value):row);
  assert.throws(()=>reconcileExistenciasMasters(rows,altered),/2026:933/);
  const docs=[
    {anioOrigen:2026,cargos:['0933','934'],folios:'',hojaOrigen:'CARGOS NUEVOS 2026'},
    {anioOrigen:2025,cargos:['931'],folios:99,hojaOrigen:'CARGOS NUEVOS 2026'},
    {anioOrigen:2025,cargos:['100'],folios:'',cantidadRegistros:12,hojaOrigen:'Cargos enviados 2025'}
  ];
  assert.deepEqual(applyExistenciasFolios(docs,new Map(summarizeExistenciasFolios(original))).map(d=>d.foliosPorCargo),
    [{933:7,934:1},{931:4},{100:12}]);
});

test('la ruta exige administrador, comprueba integridad y vuelve a leer al cambiar la revisión',async()=>{
  const smallMaster=await workbook('CARGOS NUEVOS 2026',[ORIGINAL_COLUMNS,...rows]);
  const paddedMaster=await JSZip.loadAsync(smallMaster);
  paddedMaster.file('xl/test-padding.bin',Buffer.alloc(5*1024**2));
  const master=await paddedMaster.generateAsync({type:'nodebuffer',compression:'STORE'});
  const hist=await workbook('REGISTRO',[['N°','','','CODIGO DE BARRAS','CARGOS','FECHA DE ENVIO'],
    [1,'','Persona registrada','T2044202100','001','2026-11-01']]);
  const im=await workbook('CARGOS ENVIADOS',[['N°','','','CODIGO DE BARRAS','CARGOS','CLASIFICACION','FECHA DE ENVIO'],
    ...Array.from({length:50},(_,i)=>[i+1,'','','T'+(2044202100+i)])]);
  const files=new Map([
    ...Object.values(MASTERS).map(f=>[f.id,{...f,bytes:master}]),
    [IM_HISTORY_FILE_ID,{name:IM_HISTORY_FILE_NAME,parent:IM_HISTORY_PARENT_ID,bytes:hist}],
    [IM_MASTER_FILE_ID,{name:'CARGOS_ENVIADOS_IRON_MOUNTAIN_MAESTRO.xlsm',parent:IM_MASTER_PARENT_ID,mime:MASTERS.original.mime,bytes:im}]
  ]);
  const driveReads=new Map();
  const rangeReads=new Map();
  let revision=1,changed=false,allow=false;
  const handler=createExistenciasSourcesHandler({env:{SUPABASE_URL:'https://test.invalid',SUPABASE_ANON_KEY:'public'},fetcher:async (raw,options)=>{
    const url=new URL(raw);
    if(url.pathname.endsWith('/auth/v1/user'))return Response.json({id:'fixture'});
    if(url.pathname.endsWith('/kardex_access'))return Response.json({allowed:true,is_admin:allow});
    if(url.pathname==='/token')return Response.json({access_token:'fixture-token'});
    const id=url.pathname.split('/').at(-1),f=files.get(id);
    if(!f)throw Error('Unexpected URL');
    if(url.searchParams.get('alt')==='media'){
      const range=options?.headers?.Range?.match(/^bytes=(\d+)-(\d+)$/);
      if(range){
        rangeReads.set(id,(rangeReads.get(id)||0)+1);
        const start=Number(range[1]),end=Number(range[2]);
        if(start===0)driveReads.set(id,(driveReads.get(id)||0)+1);
        return new Response(f.bytes.subarray(start,end+1),{status:206,
          headers:{'Content-Range':'bytes '+start+'-'+end+'/'+f.bytes.length}});
      }
      driveReads.set(id,(driveReads.get(id)||0)+1);
      if(changed&&id===IM_MASTER_FILE_ID)revision++;
      return new Response(f.bytes);
    }
    return Response.json({id,name:f.name,mimeType:f.mime||MASTERS.depurado.mime,parents:[f.parent],size:String(f.bytes.length),
      capabilities:{canDownload:true},version:String(revision),headRevisionId:'r'+revision,
      md5Checksum:createHash('md5').update(f.bytes).digest('hex')});
  }});
  const server=createServer(handler);
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const get=(view='')=>fetch('http://127.0.0.1:'+server.address().port+view,{headers:{Authorization:'Bearer test'}});
  const original=MASTERS.original.id;
  try{
    assert.equal((await get()).status,403);
    assert.equal(driveReads.size,0);
    allow=true;
    let response=await get('/?view=folios');
    assert.equal(response.status,200);
    const summary=await response.json();
    assert.deepEqual(summary,{folios:[['2026:933',5],['2026:934',1],['2025:931',4]]});
    assert.equal(driveReads.has(IM_HISTORY_FILE_ID),false);
    assert.equal(rangeReads.get(original),2);
    response=await get();
    assert.equal(response.status,200);
    const result=JSON.parse(gunzipSync(Buffer.from(await response.arrayBuffer())));
    assert.deepEqual(result.rows,rows);
    assert.deepEqual(result.folios,summary.folios);
    assert.equal(result.history.length,1);
    assert.deepEqual(result.registeredUsers,[{box:'T2044202100',date:'2026-11-01',cargos:['1'],name:'Persona registrada'}]);
    await (await get()).arrayBuffer();
    assert.equal(driveReads.get(original),1);
    revision++;
    await (await get()).arrayBuffer();
    assert.equal(driveReads.get(original),2);
    changed=true;
    response=await get();
    assert.equal(response.status,409);
    assert.match((await response.json()).error,/cambió/);
  }finally{server.close();}
});
