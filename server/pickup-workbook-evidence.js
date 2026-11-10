import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import {loadHistoryWorkbook} from './im-history-workbook.js';
import {escapeXml} from './workbook-cells.js';

const sheetPath='xl/worksheets/sheet1.xml';
const relPath='xl/worksheets/_rels/sheet1.xml.rels';
const ns='http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const relRoot='<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>';
const text=value=>String(value?.text??value??'');

export async function linkPickupEvidence(bytes,items,{historical=false,url,visit}){
  const load=value=>historical?loadHistoryWorkbook(value):new ExcelJS.Workbook().xlsx.load(value);
  const book=await load(bytes);
  const sheet=book.worksheets[0];
  const zip=await JSZip.loadAsync(bytes);
  let xml=await zip.file(sheetPath).async('string');
  let rels=await zip.file(relPath)?.async('string')||relRoot;
  const newLinks=[],expected=[];
  for(const item of items){
    const requested=item.origen==='solicitada'&&(historical||!item.master_prepared);
    const lookup=requested?(historical?'L':'K'):'D';
    const column=requested?'M':'D';
    const value=requested?item.id:item.codigo;
    const matches=sheet.getColumn(lookup).values.flatMap((entry,index)=>text(entry)===value?[index]:[]);
    if(matches.length!==1)throw Error('IM_PICKUP_EVIDENCE_ROW_NOT_UNIQUE');
    const reference=column+matches[0];
    const cell=sheet.getCell(reference);
    if(text(cell.value)!==item.codigo)throw Error('IM_PICKUP_EVIDENCE_BOX_MISMATCH');
    expected.push(reference);
    if(cell.hyperlink===url)continue;
    if(cell.hyperlink||new RegExp('<hyperlink\\b[^>]*\\bref="'+reference+'"').test(xml))
      throw Error('IM_PICKUP_EVIDENCE_LINK_CONFLICT');
    const hash=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(visit+'|'+reference));
    const id='rIdPickup'+Array.from(new Uint8Array(hash).subarray(0,12),byte=>byte.toString(16).padStart(2,'0')).join('');
    if(rels.includes('Id="'+id+'"'))throw Error('IM_PICKUP_EVIDENCE_RELATIONSHIP_CONFLICT');
    newLinks.push('<hyperlink xmlns:r="'+ns+'" ref="'+reference+'" r:id="'+id+
      '" tooltip="Sustento de recojo '+escapeXml(visit)+'"/>');
    rels=rels.replace('</Relationships>','<Relationship Id="'+id+'" Type="'+ns+
      '/hyperlink" Target="'+escapeXml(url)+'" TargetMode="External"/></Relationships>');
  }
  if(!newLinks.length)return bytes;
  const links=newLinks.join('');
  if(xml.includes('</hyperlinks>'))xml=xml.replace('</hyperlinks>',links+'</hyperlinks>');
  else{
    const tail=/<(?:printOptions|pageMargins|pageSetup|headerFooter|rowBreaks|colBreaks|customProperties|cellWatches|ignoredErrors|smartTags|drawing|legacyDrawing|picture|oleObjects|controls|webPublishItems|tableParts|extLst)\b|<\/worksheet>/;
    if(!tail.test(xml))throw Error('IM_PICKUP_EVIDENCE_STRUCTURE_CHANGED');
    xml=xml.replace(tail,match=>'<hyperlinks>'+links+'</hyperlinks>'+match);
  }
  zip.file(sheetPath,xml);zip.file(relPath,rels);
  const result=await zip.generateAsync({type:'nodebuffer',compression:'DEFLATE'});
  const proof=await load(result);
  for(const reference of expected){
    const verified=proof.worksheets[0].getCell(reference);
    if(verified.hyperlink!==url||text(verified.value)!==text(sheet.getCell(reference).value))
      throw Error('IM_PICKUP_EVIDENCE_NOT_VERIFIED');
  }
  return result;
}
