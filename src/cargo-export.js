import ExcelJS from 'exceljs';
import { cargoLocations, cargoYear, groupsForCodes, locationLabel } from './cargo-details.js';

export async function buildCargoWorkbook(doc) {
  const locations = await cargoLocations(doc.datosOrigen);
  const codes = [...new Set((doc.facturas || '').split(/[,;\n]/).map(s=>s.trim()).filter(Boolean))];
  const wb = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet('Cargo');
  sheet.columns = [
    {header:'Kardex',key:'kardex',width:16}, {header:'Año',key:'year',width:10},
    {header:'Cargo',key:'cargo',width:18}, {header:'Factura / Guía / BV',key:'code',width:30},
    {header:'Ubicación',key:'location',width:35}
  ];
  for (const code of codes.length ? codes : ['']) {
    sheet.addRow({kardex:doc.kardex,year:cargoYear(doc),cargo:(doc.cargos||[]).join(', '),
      code,location:locationLabel(groupsForCodes(locations,[code]))});
  }
  sheet.getRow(1).font={bold:true,color:{argb:'FFFFFFFF'}};
  sheet.getRow(1).fill={type:'pattern',pattern:'solid',fgColor:{argb:'FF1F4E78'}};
  sheet.getRow(1).height=28;
  sheet.views=[{state:'frozen',ySplit:1}];
  sheet.autoFilter={from:'A1',to:`E${sheet.rowCount}`};
  sheet.eachRow(row=>{row.alignment={vertical:'top',wrapText:true};});
  return wb;
}
