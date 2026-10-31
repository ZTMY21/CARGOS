// Run once with approved backend credentials. Creates empty folders only.
import {DriveClient} from '../../server/archive/drive-client.js';
import {categories} from '../../server/archive/security.js';
const env=process.env;
if(!env.KARDEX_DRIVE_AUTHORIZATION_REF)throw new Error('Falta autorización institucional documentada.');
const drive=new DriveClient(env);await drive.checkRoot();
const ids={};
for(const [category,name]of Object.entries(categories)){
 const root=env.GOOGLE_DRIVE_ROOT_FOLDER_ID;if(!/^[\w-]{10,200}$/.test(root))throw new Error('Carpeta inválida.');
 const q=`'${root}' in parents and name = '${name}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
 const data=await (await drive.request('https://www.googleapis.com/drive/v3/files?fields=files(id)&q='+encodeURIComponent(q))).json();
 if(data.files.length>1)throw new Error('Carpeta ambigua; revise antes de continuar.');
 ids[category]=data.files[0]?.id|| (await (await drive.request('https://www.googleapis.com/drive/v3/files?fields=id',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name,mimeType:'application/vnd.google-apps.folder',parents:[root]})})).json()).id;
}
console.log(JSON.stringify(ids,null,2));
