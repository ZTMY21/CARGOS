import argparse, collections, datetime, hashlib, json, pathlib, re, zipfile
import xml.etree.ElementTree as E

def parse_date(value):
    for fmt in ('%d-%m-%Y','%d/%m/%Y','%Y-%m-%d','%Y-%m-%d %H:%M:%S'):
        try: return datetime.datetime.strptime(value,fmt).date().isoformat()
        except ValueError: pass
    try:
        serial=float(value)
        if 36526 <= serial <= 73415: return (datetime.date(1899,12,30)+datetime.timedelta(days=int(serial))).isoformat()
    except ValueError: pass
    return None

def prepare(source, output):
    z=zipfile.ZipFile(source);ns='{http://schemas.openxmlformats.org/spreadsheetml/2006/main}';ss=[]
    if 'xl/sharedStrings.xml' in z.namelist():
        for _,e in E.iterparse(z.open('xl/sharedStrings.xml'),events=['end']):
            if e.tag==ns+'si': ss.append(''.join(e.itertext()));e.clear()
    groups={};stats=collections.Counter();pending=[]
    for _,e in E.iterparse(z.open('xl/worksheets/sheet1.xml'),events=['end']):
        if e.tag!=ns+'row':continue
        row=int(e.get('r'));cells={re.sub(r'\d','',c.get('r')): ss[int(c.findtext(ns+'v'))] if c.get('t')=='s' else ''.join(c.itertext()) if c.get('t')=='inlineStr' else c.findtext(ns+'v') or '' for c in e};e.clear()
        if row==1:
            if [cells.get(c) for c in 'ABCD']!=['Fecha','Cargo','Grupo','Codigo']:raise ValueError('Encabezados cambiaron: revisar antes de sincronizar')
            continue
        if not any(v.strip() for v in cells.values()):stats['blank_rows']+=1;continue
        stats['source_rows']+=1
        cargo=re.sub(r'\.0+$','',cells.get('B','').strip());code=cells.get('D','').strip().lstrip(',; ')
        date=parse_date(cells.get('A','').strip())
        if not date or not cargo or not code or len(code)>200 or re.search(r'\.(xlsx?|xlsm)\b',code,re.I):
            stats['pending_rows']+=1
            if len(pending)<20:pending.append({'row':row,'reason':'Falta fecha, cargo o código válido'})
            continue
        year=int(date[:4]);key=f'{year}|{cargo}'
        g=groups.setdefault(key,{'year':year,'cargo':cargo,'date':date,'codes':set()});g['codes'].add(code);stats['valid_rows']+=1
    output=pathlib.Path(output);output.mkdir(parents=True,exist_ok=True)
    batch=[];size=0;number=0
    def flush():
        nonlocal batch,size,number
        if not batch:return
        payload=json.dumps(batch,ensure_ascii=False,separators=(',',':'))
        (output/f'{number:04d}.sql').write_text("select public.kardex_google_append('"+payload.replace("'","''")+"'::jsonb) as result;",encoding='utf8')
        number+=1;batch=[];size=0
    for key in sorted(groups):
        g=groups[key];g['codes']=sorted(g['codes']);encoded=json.dumps(g,ensure_ascii=False)
        if batch and (size+len(encoded.encode())>180000 or len(batch)>=50):flush()
        batch.append(g);size+=len(encoded.encode())
    flush()
    report={**stats,'groups':len(groups),'batches':number,'pending_examples':pending,'sha256':hashlib.file_digest(open(source,'rb'),'sha256').hexdigest()}
    (output/'summary.json').write_text(json.dumps(report,ensure_ascii=False),encoding='utf8')
    return report
if __name__=='__main__':
    ap=argparse.ArgumentParser();ap.add_argument('source');ap.add_argument('output');args=ap.parse_args()
    print(json.dumps(prepare(args.source,args.output),ensure_ascii=False))
