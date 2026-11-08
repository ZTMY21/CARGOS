export const escapeXml=value=>String(value??'').replace(/&/g,'&amp;').replace(/</g,'&lt;')
  .replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&apos;');

export function writeWorksheetCells(xml,row,values,styles={}){
  const pattern=new RegExp('<row\\b[^>]*\\br="'+row+'"[^>]*(?:\\/>|>[\\s\\S]*?<\\/row>)');
  const original=xml.match(pattern)?.[0];
  const cells=new Map([...(original||'').matchAll(/<c\b[^>]*\br="([A-Z]+)\d+"[^>]*(?:\/>|>[\s\S]*?<\/c>)/g)]
    .map(match=>[match[1],match[0]]));
  for(const [column,value] of Object.entries(values)){
    const old=cells.get(column);
    if(/<f\b/.test(old||''))throw Error('EXCEL_FORMULA_OCCUPIED');
    const style=Object.hasOwn(styles,column)?'s="'+styles[column]+'"':(old||'').match(/\bs="\d+"/)?.[0];
    const opening='<c r="'+column+row+'"'+(style?' '+style:'');
    cells.set(column,typeof value==='number'?opening+'><v>'+value+'</v></c>':
      opening+' t="inlineStr"><is><t xml:space="preserve">'+escapeXml(value)+'</t></is></c>');
  }
  const head=original?.match(/^<row\b[^>]*>/)?.[0].replace(/\s*\/>$/,'>')||'<row r="'+row+'">';
  const sorted=[...cells].sort(([a],[b])=>a.length-b.length||a.localeCompare(b));
  const replacement=head+sorted.map(([,cell])=>cell).join('')+'</row>';
  const width=sorted.at(-1)?.[0]||'A';
  xml=xml.replace(/(<dimension\b[^>]*\bref=")([A-Z]+\d+)(?::([A-Z]+)(\d+))?"/,(_,prefix,start,end,last)=>{
    const prior=end||start.replace(/\d/g,'');
    const max=prior.length>width.length||(prior.length===width.length&&prior>width)?prior:width;
    return prefix+start+':'+max+Math.max(row,Number(last||start.replace(/\D/g,'')))+'"';
  });
  if(original)return xml.replace(pattern,()=>replacement);
  const after=[...xml.matchAll(/<row\b[^>]*\br="(\d+)"[^>]*>/g)].find(m=>Number(m[1])>row)?.[0]||'</sheetData>';
  if(!xml.includes(after))throw Error('EXCEL_SHEETDATA_MISSING');
  return xml.replace(after,()=>replacement+after);
}

export function checkHeaders(sheet,headers){
  for(const [column,header] of Object.entries(headers)){
    const actual=sheet.getCell(column+'1').value;
    if(actual!==header && (actual!=null&&actual!==''||
       sheet.getColumn(column).values.some((v,i)=>i>1&&v!=null&&v!=='')))throw Error('EXCEL_COLUMNS_OCCUPIED');
  }
}

export const displayExcelDate=iso=>iso?iso.split('-').reverse().join('/'):'';
