from zipfile import ZipFile
from lxml import etree as E
import json,datetime,sys
path=sys.argv[1]
ns='{http://schemas.openxmlformats.org/spreadsheetml/2006/main}'
def col(ref):
 n=0
 for c in ref:
  if c.isdigit():break
  n=n*26+ord(c)-64
 return n
with ZipFile(path) as z:
 styles=E.fromstring(z.read('xl/styles.xml'),E.XMLParser(resolve_entities=False,load_dtd=False,no_network=True))
 fmts={int(f.attrib['numFmtId']):f.attrib['formatCode'] for f in styles.findall('.//{*}numFmt')}
 date_styles=set()
 for i,f in enumerate(styles.find(ns+'cellXfs')):
  n=int(f.attrib.get('numFmtId','0'));code=fmts.get(n,'').lower()
  if n in (14,15,16,17,22) or ('y' in code and 'd' in code):date_styles.add(i)
 sst=[]
 for _,e in E.iterparse(z.open('xl/sharedStrings.xml'),events=('end',),tag=ns+'si',resolve_entities=False,load_dtd=False,no_network=True):
  sst.append(''.join(n.text or '' for n in e.iter(ns+'t')));e.clear()
  while e.getprevious() is not None:del e.getparent()[0]
 names=[s.attrib['name'] for s in E.fromstring(z.read('xl/workbook.xml'),E.XMLParser(resolve_entities=False,load_dtd=False,no_network=True)).findall('.//{*}sheet')]
 for si,name in enumerate(names,1):
  print(json.dumps({'sheet':name}),flush=True)
  for _,e in E.iterparse(z.open(f'xl/worksheets/sheet{si}.xml'),events=('end',),tag=ns+'row',resolve_entities=False,load_dtd=False,no_network=True):
   cells=[]
   for c in e.findall(ns+'c'):
    v=c.find(ns+'v');val=v.text if v is not None else '';t=c.attrib.get('t')
    if t=='s':val=sst[int(val)] if val else ''
    elif t=='inlineStr':val=''.join(n.text or '' for n in c.iter(ns+'t'))
    elif val!='' and int(c.attrib.get('s','0')) in date_styles:
     try:val=(datetime.datetime(1899,12,30)+datetime.timedelta(days=float(val))).date().isoformat()
     except ValueError:pass
    if val!='':cells.append({'col':col(c.attrib['r']),'value':val})
   if cells:print(json.dumps({'row':int(e.attrib['r']),'cells':cells},ensure_ascii=False))
   e.clear()
   while e.getprevious() is not None:del e.getparent()[0]
