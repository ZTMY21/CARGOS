import { limaDate } from './rules.js';
import { normalizeSearch } from './search.js';

function sourceDate(value) {
  if(value instanceof Date && Number.isFinite(value.getTime())) return value.toISOString().slice(0,10);
  const text=String(value??'').trim();
  if(/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  const match=text.match(/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{4})$/);
  if(match) {
    const date=`${match[3]}-${match[2].padStart(2,'0')}-${match[1].padStart(2,'0')}`;
    const parsed=new Date(`${date}T00:00:00Z`);
    if(Number.isFinite(parsed.getTime())&&parsed.toISOString().slice(0,10)===date) return date;
  }
  return '';
}
async function stableId(key) {
  const hash=new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(`kardex-historico-v1|${key}`)));
  const bytes=hash.slice(0,16);bytes[6]=(bytes[6]&15)|128;bytes[8]=(bytes[8]&63)|128;
  const h=Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('');
  return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
}
function isCode(value) {
  const text=String(value??'').trim();
  return text.length>2 && /\d/.test(text) && !sourceDate(value) && !/^CARGO\s*/i.test(text);
}
function inferType(codes) {
  let invoice=false,guide=false,sale=false,unknown=false;
  for(const code of codes) {
    const text=String(code).toUpperCase();
    if(/^(?:\d{2})?GR/.test(text)) guide=true;
    else if(/^(?:\d{2})?(?:BB|BV)/.test(text)) sale=true;
    else if(/^(?:\d{2})?(?:FF|F\d)/.test(text)) invoice=true;
    else unknown=true;
  }
  if(unknown||[invoice,guide,sale].filter(Boolean).length!==1) return 'Fact / GR / BV';
  return guide?'Guías de Remisión':sale?'Boletas de Venta':'Facturas-Guia';
}
export class HistoricalAccumulator {
  constructor() {this.groups=new Map();this.stats={celdas_documentos:0,filas_2026:0,anotaciones:0,sin_cargo:0};}
  beginSheet(name) {
    this.sheet=name;this.year=Number(name.match(/\b(20\d{2})\b/)?.[1])||null;
    this.flat=/^CARGOS NUEVOS/i.test(name);this.source='';this.columns=[];this.headers=null;
  }
  group(cargo='',source='',unknownKey='') {
    const key=[this.sheet,source,cargo||`sin-cargo:${unknownKey}`].join('|');
    if(!this.groups.has(key)) this.groups.set(key,{
      key,cargo,source,sheet:this.sheet,year:this.year,codes:[],positions:[],rows:[],annotations:[],
      dates:new Set(),pages:0,hasPages:false,firstRow:null,lastRow:null,unknown:!cargo
    });
    return this.groups.get(key);
  }
  add(group,code,row,col,raw=null) {
    group.codes.push(String(code).trim());group.positions.push([row,col]);
    if(raw) group.rows.push(raw);
    group.firstRow=group.firstRow===null?row:Math.min(group.firstRow,row);group.lastRow=Math.max(group.lastRow||row,row);
    this.stats.celdas_documentos++;
    if(group.unknown) this.stats.sin_cargo++;
  }
  addRow(row,cells) {
    // Detect the unified table by its columns in every year; keep legacy matrices supported.
    if(row===1 && ['Fecha','Cargo','Codigo'].every(header=>cells.some(c=>String(c.value).trim()===header))) this.flat=true;
    if(this.flat) {
      if(row===1) {this.headers=Object.fromEntries(cells.map(c=>[c.col,String(c.value)]));return;}
      if(!cells.length) return;
      const data=Object.fromEntries(cells.map(c=>[this.headers?.[c.col]||`Columna ${c.col}`,
        c.value instanceof Date ? sourceDate(c.value) : String(c.value??'')]));
      data._fila_excel=row;
      const rawCode=String(data.Codigo??'').trim();
      const sourceLabel=/\.(?:xlsx|xlsm|xls)\s*·/i.test(rawCode);
      const code=sourceLabel?'':rawCode.replace(/^[,;\s]+|[,;\s]+$/g,'');
      const cargo=String(data.Cargo??'').trim();
      const group=this.group(cargo,'',cargo?'':String(row));
      if(sourceLabel)group.annotations.push([row,4,`Encabezado de archivo en Codigo: ${rawCode}`]);
      else if(rawCode!==code)group.annotations.push([row,4,'Se retiró un separador inicial/final del código; el valor original se conserva en los datos de origen.']);
      const date=sourceDate(data.Fecha);if(date)group.dates.add(date);
      for(const field of ['Observaciones','ESTADO_REGULARIZADO']) {
        const note=String(data[field]||'').trim();
        if(note&&note!=='OK')group.annotations.push([row,field,`${code?code+': ':''}${note}`]);
      }
      const pages=Number(data.Total_Paginas);
      if(data.Total_Paginas!==''&&data.Total_Paginas!==null&&data.Total_Paginas!==undefined&&Number.isInteger(pages)&&pages>=0) {group.pages+=pages;group.hasPages=true;}
      this.stats.filas_2026++;
      if(code)this.add(group,code,row,4,data);
      else {group.rows.push(data);group.annotations.push([row,4,'El registro de origen no tiene código de documento']);}
      return;
    }
    if(row<=3) return;
    const source=cells.find(c=>String(c.value??'').includes(' · '));
    if(source) {this.source=String(source.value);this.columns=[];return;}
    const cargoCells=cells.filter(c=>/^\s*CARGO\s*/i.test(String(c.value??'')));
    const excluded=new Set();
    if(cargoCells.length) {
      const contexts=[];
      for(const c of cargoCells) {
        excluded.add(c.col);
        const adjacent=cells.filter(d=>Math.abs(d.col-c.col)<=1&&d.col!==c.col&&sourceDate(d.value))
          .sort((a,b)=>Math.abs(a.col-c.col)-Math.abs(b.col-c.col))[0];
        if(adjacent)excluded.add(adjacent.col);
        const match=String(c.value).match(/^\s*CARGO\s*(\d+)/i);
        const cargo=match?.[1]||'';
        const date=sourceDate(adjacent?.value);
        const group=this.group(cargo,this.source,cargo?'':`${sourceDate(adjacent?.value)||'sin-fecha'}:${c.col}:${normalizeSearch(c.value)}`);
        if(date)group.dates.add(date);
        contexts.push({start:Math.min(c.col,adjacent?.col??c.col),group});
      }
      contexts.sort((a,b)=>a.start-b.start);
      for(let i=0;i<contexts.length;i++) {
        const end=contexts[i+1]?.start??10000;
        for(let col=contexts[i].start;col<end&&col<=100;col++)this.columns[col]=contexts[i].group;
      }
    }
    for(const cell of cells) {
      if(excluded.has(cell.col)||sourceDate(cell.value))continue;
      const value=String(cell.value??'').trim();if(!value)continue;
      let group=this.columns[cell.col];
      if(isCode(value)) {
        group ||= this.group('',this.source,'sin-contexto');
        this.add(group,value,row,cell.col);
      } else if(group) {
        group.annotations.push([row,cell.col,value]);this.stats.anotaciones++;
      }
    }
  }
  async finish() {
    const docs=[];
    for(const g of this.groups.values()) {
      if(!g.codes.length&&!g.rows.length)continue;
      const dates=[...g.dates].sort();
      docs.push({
        id:await stableId(g.key),kardex:'',fechaRegistro:limaDate(),tipoDoc:inferType(g.codes),
        periodo:'',ubicacion:'',folios:g.hasPages?g.pages:'',cargos:g.cargo?[g.cargo]:[],
        cajaAsignada:'',fEnvio:'',sustento:'',sustentoImagen:'',usuario:'Importación Excel',
        facturas:g.codes.join(', '),obs:[g.unknown?'El origen no indica número de cargo.':'',
          ...new Set(g.annotations.map(a=>a[2]).filter(v=>!/^\s*[x|\-]\s*$/i.test(v)))].filter(Boolean).join('\n'),
        claveOrigen:`historico|${g.key}`,hojaOrigen:g.sheet,anioOrigen:g.year,
        fechaOrigen:dates.length===1?dates[0]:'',estadoOrigen:/Cargos enviados/i.test(g.sheet)?'La hoja de origen declara cargos enviados':'',
        datosOrigen:{fuente:g.source,fechas:dates,posiciones:g.positions,registros:g.rows,anotaciones:g.annotations,
          fila_inicial:g.firstRow,fila_final:g.lastRow,celdas_documentos:g.codes.length}
      });
    }
    return {reqs:[],docs,format:'historico',stats:{...this.stats,requerimientos:0,documentos:docs.length}};
  }
}
export async function parseHistoricalWorkbook(workbook,XLSX) {
  const sheets=workbook.SheetNames.filter(name=>/^(?:CARGOS NUEVOS|Cargos enviados)\s*/i.test(name));
  if(!sheets.length) throw new Error('El archivo no contiene hojas de Kardex ni un histórico de cargos reconocido.');
  const accumulator=new HistoricalAccumulator();
  for(const name of sheets) {
    accumulator.beginSheet(name);
    const sheet=workbook.Sheets[name],range=XLSX.utils.decode_range(sheet['!ref']||'A1');
    for(let row=range.s.r;row<=range.e.r;row++) {
      const cells=[];
      for(let col=range.s.c;col<=range.e.c;col++) {
        const cell=sheet['!data']?.[row]?.[col]??sheet[XLSX.utils.encode_cell({r:row,c:col})];
        let value=cell?.v;
        if(cell?.t==='n'&&cell.z&&XLSX.SSF.is_date(cell.z)) {
          const date=XLSX.SSF.parse_date_code(value);
          if(date)value=`${date.y}-${String(date.m).padStart(2,'0')}-${String(date.d).padStart(2,'0')}`;
        }
        if(value!==undefined&&value!==null&&value!=='')cells.push({col:col+1,value});
      }
      accumulator.addRow(row+1,cells);
    }
  }
  return accumulator.finish();
}
