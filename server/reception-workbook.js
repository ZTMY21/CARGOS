import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import {readMasterRows,IM_MASTER_NAME} from './im-master-workbook.js';

const keyOf = code => code.replace(/[^0-9]/g,'');
const sheetPath = 'xl/worksheets/sheet1.xml';
const tablePath = 'xl/tables/table1.xml';

// Edit only the worksheet and its table. Other OOXML parts, including VBA, retain their bytes.
export async function appendReceivedBoxes(bytes,readings,options) {
  const previous = await readMasterRows(bytes,options);
  const known = new Map(previous.map(row => [keyOf(row.caja),row]));
  const maxNumber = Math.max(0,...previous.map(row => Number(row.numero)||0));
  const zip = await JSZip.loadAsync(bytes);
  const sheet = zip.file(sheetPath), table = zip.file(tablePath);
  if (!sheet || !table) throw Error('IM_MASTER_STRUCTURE_CHANGED');
  let sheetXml = await sheet.async('string');
  const tableXml = await table.async('string');
  const edge = Number(tableXml.match(/<table\b[^>]*\bref="A1:J(\d+)"/)?.[1]);
  if (!edge || previous.at(-1)?.row > edge) throw Error('IM_MASTER_TABLE_CHANGED');

  const styles = {};
  for (const column of ['A','D']) {
    const cell = sheetXml.match(new RegExp('<c\\b[^>]*\\br="'+column+edge+'"[^>]*>'))?.[0];
    styles[column] = cell?.match(/\bs="(\d+)"/)?.[0] ?? '';
  }
  const added = {};
  const appended = [];
  for (const reading of readings) {
    const existing = known.get(reading.clave);
    if (reading.guardado) {
      if (existing?.caja !== reading.codigo || Number(existing?.numero) !== reading.correlativo)
        throw Error('IM_MASTER_RECEIPT_NOT_VERIFIED');
      continue;
    }
    if (!/^(TD|T|P)?\d{10}$/i.test(reading.codigo) || keyOf(reading.codigo)!==reading.clave)
      throw Error('IM_MASTER_INVALID_BOX');
    if (existing || Object.hasOwn(added,reading.clave)) throw Error('IM_MASTER_EXISTING_BOX_CONFLICT');

    const number = maxNumber + appended.length + 1;
    if (!Number.isSafeInteger(number) || number>999999999) throw Error('IM_MASTER_NUMBER_LIMIT');
    const index = edge + appended.length + 1;
    if (index>15000) throw Error('IM_MASTER_ROW_LIMIT');
    const styleA = styles.A ? ' '+styles.A : '';
    const styleD = styles.D ? ' '+styles.D : '';
    const row = '<row r="'+index+'"><c r="A'+index+'"'+styleA+'><v>'+number+'</v></c>'+
      '<c r="D'+index+'"'+styleD+' t="inlineStr"><is><t>'+reading.codigo+'</t></is></c></row>';
    const occupied = new RegExp('<row\\b[^>]*\\br="'+index+'"[^>]*(?:\\/>|>[\\s\\S]*?<\\/row>)');
    const prior = sheetXml.match(occupied)?.[0];
    if (prior) {
      // Preserve row layout and styles already present in empty template cells.
      if (/<(?:v|f|is)\b/.test(prior)) throw Error('IM_MASTER_ROW_OCCUPIED');
      const head = prior.match(/^<row\b[^>]*>/)[0].replace(/\s*\/>$/, '>');
      const cells = prior.match(/<c\b[^>]*\/>/g) || [];
      const replacement = new Map([...row.matchAll(/<c r="([AD])\d+"[\s\S]*?<\/c>/g)].map(m=>[m[1],m[0]]));
      for (const cell of cells) {
        const column = cell.match(/\br="([A-Z]+)\d+"/)?.[1];
        if (!column) throw Error('IM_MASTER_STRUCTURE_CHANGED');
        if (replacement.has(column)) {
          const originalStyle = cell.match(/\bs="\d+"/)?.[0];
          const styled = replacement.get(column);
          if (originalStyle) replacement.set(column,styled.replace(/(<c r="[AD]\d+")(?: s="\d+")?/,'$1 '+originalStyle));
        } else replacement.set(column,cell);
      }
      sheetXml = sheetXml.replace(prior,head+[...replacement.keys()].sort().map(c=>replacement.get(c)).join('')+'</row>');
    } else {
      const next = sheetXml.match(new RegExp('<row\\b[^>]*\\br="(?:'+(index+1)+')"[^>]*>'))?.[0];
      if (next) sheetXml = sheetXml.replace(next,row+next);
      else {
        if (!sheetXml.includes('</sheetData>')) throw Error('IM_MASTER_STRUCTURE_CHANGED');
        // With no immediate successor, insert before any later template row.
        const following = [...sheetXml.matchAll(/<row\b[^>]*\br="(\d+)"[^>]*>/g)].find(m=>Number(m[1])>index);
        const marker = following?.[0] || '</sheetData>';
        sheetXml = sheetXml.replace(marker,row+marker);
      }
    }
    added[reading.clave] = number;
    appended.push({reading,index});
  }
  if (!appended.length) return {bytes,added,rows:previous};
  const end = edge+appended.length;
  sheetXml = sheetXml.replace(/(<dimension\b[^>]*\bref="A1:J)(\d+)"/,
    (_,head,last)=>head+Math.max(Number(last),end)+'"');
  zip.file(sheetPath,sheetXml);
  zip.file(tablePath,tableXml.replaceAll('ref="A1:J'+edge+'"','ref="A1:J'+end+'"'));
  const output = await zip.generateAsync({type:'nodebuffer',compression:'DEFLATE'});
  const verified = await readMasterRows(output,options);
  if (verified.length!==previous.length+appended.length ||
    previous.some((old,i)=>JSON.stringify(old)!==JSON.stringify(verified[i])) ||
    appended.some(({reading,index})=>!verified.some(row=>
      row.row===index && row.receivedOnly===true && row.caja===reading.codigo &&
      Number(row.numero)===added[reading.clave])))
    throw Error('IM_MASTER_WRITE_NOT_VERIFIED');
  return {bytes:output,added,rows:verified};
}

export async function createReceptionFixture() {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet(IM_MASTER_NAME);
  const columns = ['N°','FECHA DE PREPARACIÓN','RESPONSABLE','CÓDIGO DE BARRAS DE CAJAS','NÚMERO DE CARGOS',
    'CLASIFICACIÓN DE CAJA','FECHA DE ENVÍO A IRON MOUNTAIN','ENTREGA','RECIBE','PLACA'].map(name=>({name}));
  const rows = [[700,null,'Operador de prueba','P9900000700','123','Cajas Nuevas','2026-10-01'],
    [900,null,'Operador de prueba','TD9900000900','124','Cajas Nuevas']];
  sheet.addTable({name:'Maestro',ref:'A1',headerRow:true,totalsRow:false,columns,rows});
  sheet.columns.forEach((column,i)=>{column.width=i===3?28:22;});
  return {bytes:Buffer.from(await workbook.xlsx.writeBuffer()),codes:{9900000700:700,9900000900:900}};
}
