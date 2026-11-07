import ExcelJS from 'exceljs';

export const IM_MASTER_FILE_ID = '14tW2-XqukNYozn4P67A7lrhjFfPveAmv';
export const IM_MASTER_PARENT_ID = '1MOZhwThHZmqI9McyBvEIh1OCutIu-8bb';
export const IM_MASTER_NAME = 'CARGOS ENVIADOS';
const MAX_BOXES = 1200;

const text = value => {
  if (value == null) return '';
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'object') {
    if ('result' in value) return text(value.result);
    if ('text' in value) return text(value.text);
    if (Array.isArray(value.richText)) return value.richText.map(x => text(x.text)).join('');
  }
  return String(value).trim();
};
const norm = s => text(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().replace(/\s+/g, ' ').trim();
const boxKey = code => text(code).replace(/[^0-9]/g, '');

function dateString(value) {
  if (value == null || value === '') return '';
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString().slice(0, 10);
  if (typeof value === 'number' && Number.isFinite(value) && value >= 30000 && value <= 80000) {
    return new Date(Date.UTC(1899, 11, 30) + Math.floor(value) * 86400000).toISOString().slice(0, 10);
  }
  const s = text(value);
  if (/^20\d\d-\d\d-\d\d$/.test(s)) return s;
  const d = s.match(/^(\d{1,2})\/(\d{1,2})\/(20\d\d)$/);
  if (d) return d[3] + '-' + d[2].padStart(2, '0') + '-' + d[1].padStart(2, '0');
  throw Error('IM_MASTER_INVALID_DATE');
}
function parseCargos(value) {
  const raw = text(value).toUpperCase().trim();
  if (!raw) throw Error('IM_MASTER_CARGOS_REQUIRED');
  const group = raw.match(/^(\d+(?:\s*[-,;/]\s*\d+)+)\s*\(([A-Z])\)$/);
  const tokens = group ? group[1].split(/\s*[-,;/]\s*/).map(x => x + group[2])
    : raw.split(/\s*[-,;/\n]\s*/);
  const cargos = [];
  for (const token of tokens) {
    const match = token.match(/^0*(\d{1,7})\s*(?:\(?([A-Z])\)?)?$/);
    if (!match || (match[2] && match[2] !== 'A')) throw Error('IM_MASTER_INVALID_CARGO');
    const code = (match[1].replace(/^0+(?=\d)/, '') || '0') + (match[2] || '');
    if (!cargos.includes(code)) cargos.push(code);
  }
  if (!cargos.length || cargos.length > 60) throw Error('IM_MASTER_CARGOS_LIMIT');
  return cargos;
}
export async function readMasterRows(bytes,{minimumBoxes=49}={}) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(bytes);
  if (workbook.worksheets.length !== 1 || workbook.worksheets[0]?.name !== IM_MASTER_NAME)
    throw Error('IM_MASTER_ONLY_ONE_SHEET');
  const sheet = workbook.worksheets[0];
  const headers = Array.from({ length: 10 }, (_, i) => norm(sheet.getRow(1).getCell(i + 1).value));
  if (!headers[3].includes('CODIGO DE BARRAS') || !headers[4].includes('CARGOS') ||
      !headers[5].includes('CLASIFICACION') || !headers[6].includes('FECHA DE ENVIO'))
    throw Error('IM_MASTER_HEADERS_CHANGED');
  const output = [], seen = new Set();
  let withCargos = 0;
  if (sheet.rowCount > 15000) throw Error('IM_MASTER_TOO_LARGE');
  for (let r = 2; r <= sheet.rowCount; r++) {
    const row = sheet.getRow(r);
    const caja = text(row.getCell(4).value);
    if (!caja) {
      if ([2, 3, 5, 6, 7].some(c => text(row.getCell(c).value))) throw Error('IM_MASTER_INCOMPLETE_ROW');
      continue;
    }
    const key = boxKey(caja);
    if (key.length < 6 || seen.has(key)) throw Error('IM_MASTER_DUPLICATE_BOX');
    seen.add(key);
    const receivedOnly = /^[1-9][0-9]*$/.test(text(row.getCell(1).value)) &&
      [2,3,5,6,7,8,9,10].every(c=>row.getCell(c).value == null || row.getCell(c).value === '');
    output.push({
      row: r, numero: text(row.getCell(1).value),
      preparacion: dateString(row.getCell(2).value),
      responsable: text(row.getCell(3).value), caja,
      celda: text(row.getCell(5).value), cargos: receivedOnly ? [] : parseCargos(row.getCell(5).value),
      clasificacion: text(row.getCell(6).value),
      envio: dateString(row.getCell(7).value),
      entrega: text(row.getCell(8).value),
      recibe: text(row.getCell(9).value),
      placa: text(row.getCell(10).value),
      ...(receivedOnly ? {receivedOnly:true} : {}),
    });
    if (!receivedOnly && ++withCargos > MAX_BOXES) throw Error('IM_MASTER_TOO_MANY_BOXES');
  }
  if (output.length < minimumBoxes) throw Error('IM_MASTER_SUSPICIOUSLY_EMPTY');
  return output;
}
