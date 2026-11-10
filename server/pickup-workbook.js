import JSZip from 'jszip';
import {writeWorksheetCells} from './workbook-cells.js';

export const pickupGroups = ['NUEVAS', 'DEVOLUCION'];
export const pickupType = box => box.type || 'NUEVAS';
export const pickupBoxKey = code => String(code ?? '').replace(/[^0-9]/g, '');
export const pickupDate = value => new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'America/Lima', year: 'numeric', month: '2-digit', day: '2-digit'
}).format(new Date(value));

export function groupPickupBoxes(boxes) {
  if (!Array.isArray(boxes) || !boxes.length) throw Error('Selecciona al menos una caja.');
  const groups = {NUEVAS: [], DEVOLUCION: []};
  const keys = new Set();
  for (const box of boxes) {
    const type = pickupType(box);
    const key = pickupBoxKey(box.code);
    if (!pickupGroups.includes(type) || !/^[A-Z]*[0-9][0-9. _/-]*$/i.test(box.code) ||
        key.length < 5 || key.length > 35 || keys.has(key) || !Array.isArray(box.cargos) || !box.cargos.length)
      throw Error('Hay una caja inválida o repetida.');
    keys.add(key);
    groups[type].push(box);
    if (groups[type].length > 30) throw Error('Máximo 30 cajas de cada tipo.');
  }
  return groups;
}

const dateSerial = box => {
  const date = box.box_created_at || box.prepared_at || pickupDate(box.finished_at);
  const time = Date.parse(date + 'T00:00:00Z');
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0,10) !== date)
    throw Error('La fecha de creación de la caja es inválida.');
  return (time - Date.UTC(1899, 11, 30)) / 86400000;
};

export async function pickupAttachments(detail, readTemplate) {
  const groups = groupPickupBoxes(detail.boxes);
  const [,month,day] = pickupDate(detail.created_at).split('-').map(Number);
  return Promise.all(pickupGroups.filter(type => groups[type].length).map(async type => {
    const zip = await JSZip.loadAsync(await readTemplate(type));
    const path = 'xl/worksheets/sheet1.xml';
    let xml = await zip.file(path).async('string');
    for (const [index, box] of groups[type].entries()) {
      const date = dateSerial(box);
      const description = box.cargos.join('-');
      const values = type === 'NUEVAS'
        ? {A:box.code,B:'PY809',C:box.code,D:'-',E:'-',F:'LGT',G:'FACTURA/GUIA',H:date,I:date,J:description,K:'-'}
        : {A:box.code,B:'PY809',C:box.code,D:box.code,E:'PY809',F:box.code,G:'-',H:'-',I:'LGT',J:'FACTURA/GUIA',K:date,L:date,M:description,N:'-'};
      xml = writeWorksheetCells(xml, index + 2, values, type === 'NUEVAS' ? {H:8,I:8} : {K:9,L:9});
    }
    zip.file(path, xml);
    return {filename: 'Formato IM-DYT ('+type+') - '+day+'-'+month+'.xlsx',
      bytes: await zip.generateAsync({type:'uint8array',compression:'DEFLATE'})};
  }));
}
