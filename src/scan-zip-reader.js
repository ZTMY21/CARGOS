// Lectura selectiva ZIP/OOXML: no crea objetos para las filas históricas del Excel.
// Para archivos grandes lee únicamente la hoja con Fecha/Cargo/Grupo/Código.
const decode=new TextDecoder('utf-8');
const u16=(v,o)=>v.getUint16(o,true),u32=(v,o)=>v.getUint32(o,true);
const xmlText=s=>String(s||'').replace(/&#(x[0-9a-f]+|\d+);|&(amp|lt|gt|quot|apos);/gi,(all,number,entity)=>{
  if(number){const n=number[0].toLowerCase()==='x'?parseInt(number.slice(1),16):parseInt(number,10);
    return n>=0&&n<=0x10ffff?String.fromCodePoint(n):'';}
  return {amp:'&',lt:'<',gt:'>',quot:'"',apos:"'"}[entity]||all;
});
function attr(source,name){
  const escaped=name.replace(/[:]/g,'\\:');
  const match=String(source||'').match(new RegExp('(?:^|\\s)'+escaped+'=(["\\\'])([\\s\\S]*?)\\1'));
  return match?xmlText(match[2]):'';
}
function colNumber(letters){
  let n=0;for(const c of letters.toUpperCase())n=n*26+c.charCodeAt(0)-64;return n-1;
}
async function part(file,start,length){return new Uint8Array(await file.slice(start,start+length).arrayBuffer());}
export async function excelZipDirectory(file){
  if(!Number.isSafeInteger(file.size)||file.size<1||file.size>500*1024**2)
    throw Error('Archivo vacío o mayor que 500 MB.');
  const length=Math.min(file.size,65557),tail=await part(file,file.size-length,length);
  const view=new DataView(tail.buffer,tail.byteOffset,tail.byteLength);
  let end=-1;
  for(let i=tail.length-22;i>=0;i--)if(u32(view,i)===0x06054b50){end=i;break;}
  if(end<0)throw Error('El Excel no contiene un ZIP válido.');
  const entries=u16(view,end+10),bytes=u32(view,end+12),offset=u32(view,end+16);
  if(entries===0xffff||bytes===0xffffffff||offset===0xffffffff||offset+bytes>file.size)
    throw Error('Formato ZIP64 o directorio inválido; no se modificó nada.');
  const directory=await part(file,offset,bytes),dir=new DataView(directory.buffer,directory.byteOffset,directory.byteLength);
  const files=new Map();let at=0;
  for(let i=0;i<entries;i++){
    if(at+46>directory.length||u32(dir,at)!==0x02014b50)throw Error('Directorio ZIP dañado.');
    const flags=u16(dir,at+8),method=u16(dir,at+10),compressed=u32(dir,at+20),expanded=u32(dir,at+24);
    const nameLength=u16(dir,at+28),extraLength=u16(dir,at+30),commentLength=u16(dir,at+32),local=u32(dir,at+42);
    const name=decode.decode(directory.subarray(at+46,at+46+nameLength));
    if(flags&1||![0,8].includes(method))throw Error('El Excel está cifrado o usa compresión no admitida.');
    if(name.endsWith('.xml')||name.endsWith('.rels'))
      files.set(name,{local,method,compressed,expanded,name});
    at+=46+nameLength+extraLength+commentLength;
  }
  return files;
}
async function entryStream(file,entry){
  if(!entry)throw Error('Falta una parte esencial del Excel.');
  if(entry.expanded>900*1024**2)throw Error('La hoja supera el tamaño seguro de lectura.');
  const head=await part(file,entry.local,30),view=new DataView(head.buffer,head.byteOffset,head.byteLength);
  if(u32(view,0)!==0x04034b50)throw Error('Cabecera ZIP dañada.');
  const offset=entry.local+30+u16(view,26)+u16(view,28);
  if(offset+entry.compressed>file.size)throw Error('Sección ZIP incompleta.');
  let stream=file.slice(offset,offset+entry.compressed).stream();
  if(entry.method===8){
    if(typeof DecompressionStream!=='function')
      throw Error('Este navegador no admite lectura selectiva de Excel comprimidos. Prueba con Chrome actualizado.');
    stream=stream.pipeThrough(new DecompressionStream('deflate-raw'));
  }
  return stream;
}
async function entryText(file,entry){
  if(entry.expanded>10*1024**2)throw Error('Metadatos de Excel demasiado grandes.');
  return new Response(await entryStream(file,entry)).text();
}
async function* xmlTags(file,entry,tag){
  const reader=(await entryStream(file,entry)).getReader(),decoder=new TextDecoder();
  const start='<'+tag,finish='</'+tag+'>';
  let buf='';
  try{
    while(true){
      const {value,done}=await reader.read();
      if(done)break;
      buf+=decoder.decode(value,{stream:true});
      while(true){
        const a=buf.indexOf(start);
        if(a<0){buf=buf.slice(-start.length);break;}
        if(a>0)buf=buf.slice(a);
        const b=buf.indexOf(finish);
        if(b<0){
          if(buf.length>8*1024**2)throw Error('Fila o cadena XML demasiado extensa.');
          break;
        }
        const end=b+finish.length;
        yield buf.slice(0,end);
        buf=buf.slice(end);
      }
    }
  }finally{await reader.cancel().catch(()=>{});}
}
function cells(xml){
  const values=[];
  for(const match of xml.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)){
    const attrs=match[1],ref=attr(attrs,'r'),col=ref.match(/^[A-Z]+/)?.[0];
    if(!col)continue;
    const type=attr(attrs,'t'),body=match[2]||'';
    let value='';
    if(type==='s'){
      const raw=body.match(/<v>(\d+)<\/v>/);
      value=raw?{shared:Number(raw[1])}:'';
    }else if(type==='inlineStr'){
      value=xmlText([...body.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map(x=>x[1]).join(''));
    }else{
      value=xmlText(body.match(/<v>([\s\S]*?)<\/v>/)?.[1]??'');
    }
    values[colNumber(col)]=value;
  }
  return values;
}
async function sharedStrings(file,entry,needed){
  if(!needed.size)return new Map();
  const found=new Map();
  if(!entry)throw Error('Faltan cadenas compartidas requeridas para interpretar códigos.');
  let index=0;
  for await(const item of xmlTags(file,entry,'si')){
    if(needed.has(index)){
      const text=[...item.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map(m=>xmlText(m[1])).join('');
      found.set(index,text);
      if(found.size===needed.size)break;
    }
    index++;
  }
  if(found.size!==needed.size)throw Error('Referencias de texto inválidas en el Excel.');
  return found;
}
function resolve(values,dict){
  return values.map(x=>x&&typeof x==='object'&&'shared'in x?dict.get(x.shared)??'':String(x??''));
}
function dateValue(text){
  if(/^\d{5}(?:\.\d+)?$/.test(text)){
    const time=Date.UTC(1899,11,30)+Math.floor(Number(text))*86400000;
    const iso=new Date(time).toISOString().slice(0,10);
    return iso.slice(8,10)+'/'+iso.slice(5,7)+'/'+iso.slice(0,4);
  }
  return text;
}
export async function readSelectedExcelRows(file,{minCargo,resolveHeaders,maxNewRows=50000}){
  const zip=await excelZipDirectory(file);
  const workbook=await entryText(file,zip.get('xl/workbook.xml'));
  const rels=await entryText(file,zip.get('xl/_rels/workbook.xml.rels'));
  const relations=new Map();
  for(const x of rels.matchAll(/<Relationship\b[^>]*\/>/g)){
    const id=attr(x[0],'Id'),target=attr(x[0],'Target');
    if(id&&target)relations.set(id,target);
  }
  const sheets=[];
  for(const x of workbook.matchAll(/<sheet\b[^>]*\/>/g)){
    const name=attr(x[0],'name'),rel=attr(x[0],'r:id'),target=relations.get(rel);
    if(!target)continue;
    const path=target.startsWith('/')?target.slice(1):target.startsWith('xl/')?target:'xl/'+target;
    if(zip.has(path))sheets.push({name,path});
  }
  if(!sheets.length)throw Error('No se encontraron hojas de Excel compatibles.');
  sheets.sort((a,b)=>Number(/2026|cargos|factur|digital/i.test(b.name))-Number(/2026|cargos|factur|digital/i.test(a.name)));
  for(const sheet of sheets){
    const entry=zip.get(sheet.path),headers=[];let seen=0;
    for await(const xml of xmlTags(file,entry,'row')){
      headers.push(cells(xml));if(++seen>=25)break;
    }
    const needed=new Set();
    for(const row of headers)for(const value of row)if(value&&typeof value==='object'&&'shared'in value)needed.add(value.shared);
    const dict=await sharedStrings(file,zip.get('xl/sharedStrings.xml'),needed);
    let mapping;
    for(const row of headers){mapping=resolveHeaders(resolve(row,dict));if(mapping)break;}
    if(!mapping)continue;
    const cargoIndex=mapping[1],cargoStringIds=new Set(),selected=[],sharedNeeded=new Set();
    let sharedCargo=false;
    for await(const xml of xmlTags(file,entry,'row')){
      const raw=cells(xml),c=raw[cargoIndex];
      if(c&&typeof c==='object'&&'shared'in c){sharedCargo=true;cargoStringIds.add(c.shared);continue;}
      const cargo=Number(String(c??'').trim());
      if(!Number.isSafeInteger(cargo)||cargo<=minCargo)continue;
      const row=mapping.map(i=>i<0?'':raw[i]??'');
      selected.push(row);
      for(const value of row)if(value&&typeof value==='object'&&'shared'in value)sharedNeeded.add(value.shared);
      if(selected.length>maxNewRows)throw Error('Hay más de '+maxNewRows.toLocaleString('es-PE')+' filas nuevas. Divide el archivo por cargos.');
    }
    if(sharedCargo){
      const cargoDict=await sharedStrings(file,zip.get('xl/sharedStrings.xml'),cargoStringIds);
      selected.length=0;sharedNeeded.clear();
      for await(const xml of xmlTags(file,entry,'row')){
        const raw=cells(xml),v=raw[cargoIndex];
        const cargo=Number(v&&typeof v==='object'&&'shared'in v?cargoDict.get(v.shared):String(v??'').trim());
        if(!Number.isSafeInteger(cargo)||cargo<=minCargo)continue;
        const row=mapping.map(i=>i<0?'':raw[i]??'');
        selected.push(row);
        for(const value of row)if(value&&typeof value==='object'&&'shared'in value)sharedNeeded.add(value.shared);
        if(selected.length>maxNewRows)throw Error('Demasiadas filas nuevas: '+maxNewRows+'.');
      }
    }
    const valuesDict=await sharedStrings(file,zip.get('xl/sharedStrings.xml'),sharedNeeded);
    return {sheetName:sheet.name,fileName:file.name,count:selected.length,
      rows:selected.map(raw=>{const row=resolve(raw,valuesDict);row[0]=dateValue(row[0]);return row;})};
  }
  throw Error('No se encontró una hoja con Fecha, Cargo, Grupo y Código. No se importó nada.');
}
