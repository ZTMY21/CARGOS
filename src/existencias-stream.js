import JSZip from 'jszip';
import {sourceRecords} from './cargo-details.js';

// OOXML en flujo: evita construir millones de objetos de celda en ExcelJS.
// Las hojas de Resumen, Cargos y Requerimientos son las creadas por ExcelJS.
const encoder=new TextEncoder();
const FIELDS=['Fecha','Cargo','Grupo','Codigo','Archivo_Principal','PDF',
  'Total_Paginas','Tipo','Fuente','Observaciones','ESTADO_REGULARIZADO'];
const LETTERS='ABCDEFGHIJK';
const CRC_TABLE=Uint32Array.from({length:256},(_,i)=>{
  let c=i;
  for(let j=0;j<8;j++) c=(c&1)?(0xEDB88320^(c>>>1)):(c>>>1);
  return c>>>0;
});
function crcUpdate(crc,bytes){
  for(const byte of bytes) crc=CRC_TABLE[(crc^byte)&255]^(crc>>>8);
  return crc>>>0;
}
function xmlEscape(v){
  return String(v).replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&apos;')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g,'');
}
function rowXml(row,index,styleId){
  let html='<row r="'+index+'">';
  for(let c=0;c<FIELDS.length;c++){
    const value=row[FIELDS[c]];
    if(value===undefined||value===null||value==='')continue;
    const cell=LETTERS[c]+index;
    if(c===6 && Number.isFinite(Number(value)) && String(value).trim()!==''){
      html+='<c r="'+cell+'" s="'+styleId+'"><v>'+Number(value)+'</v></c>';
    }else{
      html+='<c r="'+cell+'" s="'+styleId+'" t="inlineStr"><is><t xml:space="preserve">'
        +xmlEscape(value)+'</t></is></c>';
    }
  }
  return html+'</row>';
}
function fallbackRows(doc,origin={}){
  const date=String(doc.fechaOrigen||doc.fechaRegistro||'');
  const fecha=/^\d{4}-\d{2}-\d{2}$/.test(date)
    ?date.slice(8,10)+'-'+date.slice(5,7)+'-'+date.slice(0,4):date;
  const cargo=(doc.cargos||[])[0]||'';
  // Los nuevos cargos de Google Sheets conservan cada código y su Grupo,
  // aunque todavía no tengan Archivo_Principal, PDF, Tipo o Fuente.
  const codes=Object.entries(origin.grupos_por_codigo||{});
  if(codes.length) return codes.flatMap(([codigo,grupos])=>{
    const groups=Array.isArray(grupos)&&grupos.length?grupos:[''];
    return groups.map(grupo=>({Fecha:fecha,Cargo:cargo,Grupo:grupo,
      Codigo:codigo.toUpperCase(),Archivo_Principal:'',PDF:'',Total_Paginas:'',
      Tipo:'',Fuente:'',Observaciones:'',ESTADO_REGULARIZADO:''}));
  });
  return (doc.cargos||[]).map(c=>({
    Fecha:fecha,Cargo:c,Grupo:'',Codigo:'',Archivo_Principal:'',PDF:'',
    Total_Paginas:'',Tipo:'',Fuente:'',
    Observaciones:'Sin detalle original en la base',ESTADO_REGULARIZADO:''
  }));
}
function annualTemplate(xml){
  const open='<sheetData>',close='</sheetData>';
  const p=xml.indexOf(open),e=xml.indexOf(close,p);
  if(p<0||e<0)throw new Error('La plantilla de una hoja anual está incompleta.');
  const row=xml.slice(p+open.length,e).match(/<row\b[^>]*\br="1"[^>]*>[\s\S]*?<\/row>/);
  if(!row)throw new Error('No se encontraron los encabezados del listado original.');
  const before=xml.slice(0,p).replace(/<dimension\b[^>]*\/>/,'');
  const after=xml.slice(e+close.length);
  const row2=xml.slice(p+open.length,e).match(/<row\b[^>]*\br="2"[^>]*>[\s\S]*?<\/row>/)?.[0]||'';
  const styleId=Number(row2.match(/<c\b[^>]*\bs="(\d+)"/)?.[1]||0);
  return {before:before+open+row[0],after:close+after,styleId};
}
const detailSorter=new Intl.Collator('es',{numeric:true,sensitivity:'base'});
const normalizedCargo=value=>String(value??'').trim()
  .replace(/\.0+$/,'').replace(/^0+(?=\d)/,'');
function compareDetails(a,b){
  const compare= (x,y)=>detailSorter.compare(String(x??'').trim(),String(y??'').trim());
  const byCargo=compare(normalizedCargo(a.Cargo),normalizedCargo(b.Cargo));
  if(byCargo)return byCargo;
  const ga=String(a.Grupo??'').trim(),gb=String(b.Grupo??'').trim();
  if(!ga&&!gb)return 0;
  if(!ga)return 1;
  if(!gb)return -1;
  return compare(ga,gb);
}
async function* annualXml(xml,year,docSource,progress){
  const template=annualTemplate(xml);
  yield encoder.encode(template.before);
  let rowIndex=2,buffer='',currentCargo=null,cargoRows=[];
  // Agrupa registros de un mismo cargo, incluso si provienen de varios
  // Kardex. Ordena primero Cargo y luego Grupo; conserva el orden de origen
  // dentro de cada grupo para no alterar la secuencia real de documentos.
  async function* flushCargo(){
    cargoRows.sort(compareDetails);
    for(const row of cargoRows){
      if(rowIndex>1048576)throw new Error('El detalle de '+year+' supera el máximo de filas de Excel.');
      buffer+=rowXml(row,rowIndex++,template.styleId);
      if(buffer.length>131072){
        yield encoder.encode(buffer);
        buffer='';
        if(rowIndex%10000<500){
          progress?.(year,rowIndex-2);
          await new Promise(resolve=>setTimeout(resolve,0));
        }
      }
    }
    cargoRows=[];
  }
  for await(const {doc,origin} of docSource(year)){
    const cargo=normalizedCargo((doc.cargos||[])[0]);
    if(currentCargo!==null&&cargo!==currentCargo){
      for await(const chunk of flushCargo())yield chunk;
    }
    currentCargo=cargo;
    const original=await sourceRecords(origin||doc.datosOrigen||{});
    const rows=original.length?original:fallbackRows(doc,origin);
    for(const row of rows){
      cargoRows.push({ ...row, Cargo:String(row.Cargo??'').trim()||cargo });
    }
  }
  for await(const chunk of flushCargo())yield chunk;
  if(buffer)yield encoder.encode(buffer);
  progress?.(year,rowIndex-2);
  // El detalle real puede tener más filas que el conteo inicial, sobre todo
  // en cargos nuevos de 2026. Mantener el autofiltro sobre todos los datos.
  const lastRow=Math.max(2,rowIndex-1);
  const footer=template.after.replace(/<autoFilter\b[^>]*\bref="[^"]*"[^>]*\/>/,
    tag=>tag.replace(/\bref="[^"]*"/,'ref="A1:K'+lastRow+'"'));
  yield encoder.encode(footer);
}
function word(view,offset,value){view.setUint16(offset,value,true);}
function dword(view,offset,value){view.setUint32(offset,value>>>0,true);}
function binarySource(bytes){return (async function*(){yield bytes;})();}
class ZipStreamWriter {
  constructor(){this.parts=[];this.offset=0;this.entries=[];}
  push(bytes){this.parts.push(bytes);this.offset+=bytes.byteLength;}
  async add(name,source){
    const nameBytes=encoder.encode(name),offset=this.offset;
    const local=new Uint8Array(30+nameBytes.length),h=new DataView(local.buffer);
    dword(h,0,0x04034b50);word(h,4,20);word(h,6,0x808);word(h,8,8);
    word(h,26,nameBytes.length);
    local.set(nameBytes,30);this.push(local);
    let compressed=0,uncompressed=0,crc=0xFFFFFFFF;
    const compressor=new CompressionStream('deflate-raw');
    const reader=compressor.readable.getReader(),writer=compressor.writable.getWriter();
    const consuming=(async()=>{
      while(true){
        const {value,done}=await reader.read();
        if(done)break;
        if(value?.byteLength){compressed+=value.byteLength;this.push(value);}
      }
    })();
    for await(const bytes of source){
      if(!bytes?.length)continue;
      uncompressed+=bytes.byteLength;
      crc=crcUpdate(crc,bytes);
      await writer.write(bytes);
    }
    await writer.close();
    await consuming;
    crc=(crc^0xFFFFFFFF)>>>0;
    const descriptor=new Uint8Array(16),dv=new DataView(descriptor.buffer);
    dword(dv,0,0x08074b50);dword(dv,4,crc);dword(dv,8,compressed);dword(dv,12,uncompressed);
    this.push(descriptor);
    this.entries.push({nameBytes,offset,crc,compressed,uncompressed});
  }
  finish(){
    const centralOffset=this.offset;
    for(const entry of this.entries){
      const c=new Uint8Array(46+entry.nameBytes.length),v=new DataView(c.buffer);
      dword(v,0,0x02014b50);word(v,4,20);word(v,6,20);word(v,8,0x808);
      word(v,10,8);dword(v,16,entry.crc);dword(v,20,entry.compressed);
      dword(v,24,entry.uncompressed);word(v,28,entry.nameBytes.length);
      dword(v,42,entry.offset);c.set(entry.nameBytes,46);this.push(c);
    }
    const end=new Uint8Array(22),v=new DataView(end.buffer);
    dword(v,0,0x06054b50);word(v,8,this.entries.length);
    word(v,10,this.entries.length);
    dword(v,12,this.offset-centralOffset);dword(v,16,centralOffset);
    this.push(end);
    return new Blob(this.parts,{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'});
  }
}
function defaultSource(docs){
  return async function* (year){
    const rows=docs.filter(d=>String(d.anioOrigen||d.fechaOrigen?.slice(0,4))===String(year))
      .sort((a,b)=>String(a.cargos?.[0]||'').localeCompare(String(b.cargos?.[0]||''),'es',{numeric:true}));
    for(const doc of rows)yield {doc,origin:doc.datosOrigen||{}};
  };
}
export async function serializeOriginalAnnualReport(workbook,getSource,progress){
  const template=await JSZip.loadAsync(await workbook.xlsx.writeBuffer());
  const years=workbook._existenciasYears||[];
  const docs=workbook._existenciasDocs||[];
  const annualFiles=new Map(years.map((year,i)=>['xl/worksheets/sheet'+(i+3)+'.xml',year]));
  const source=getSource||defaultSource(docs);
  const output=new ZipStreamWriter();
  for(const [name,file] of Object.entries(template.files)){
    if(file.dir)continue;
    const data=await file.async('uint8array');
    // Enlaces internos de Excel: sin relación externa; vuelven a funcionar
    // desde Resumen y desde los detalles originales de cualquier año.
    const isWorkbook=name==='xl/workbook.xml';
    const isSheet=/^xl\/worksheets\/sheet\d+\.xml$/.test(name);
    const isSheetRel=/^xl\/worksheets\/_rels\/sheet\d+\.xml\.rels$/.test(name);
    let sourceXml=(isSheet||isSheetRel||isWorkbook)?new TextDecoder().decode(data):'';
    if(isWorkbook)sourceXml=sourceXml.replace(/<workbookView\b([^>]*)\/>/,(_,attrs)=>
      '<workbookView'+attrs.replace(/\s+showSheetTabs="[^"]*"/,'')+' showSheetTabs="1"/>');
    if(isSheet)sourceXml=sourceXml.replace(/<hyperlink\b[^>]*\blocation="#[^"]*"[^>]*\/>/g,tag=>
      tag.replace(/\s+r:id="[^"]*"/,'').replace(/\blocation="#/,'location="'));
    if(isSheetRel)sourceXml=sourceXml.replace(/<Relationship\b(?=[^>]*\bTarget="#)[^>]*\/>/g,'');
    if(annualFiles.has(name)){
      const year=annualFiles.get(name);
      await output.add(name,annualXml(sourceXml,year,source,progress));
    }else{
      await output.add(name,binarySource(isSheet||isSheetRel||isWorkbook?encoder.encode(sourceXml):data));
    }
  }
  return output.finish();
}
