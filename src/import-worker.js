import { parseImport } from './import-parser.js';
self.onmessage=async event=>{
  try {self.postMessage({result:await parseImport(event.data)});}
  catch(error) {self.postMessage({error:error?.message||'No se pudo leer el archivo Excel.'});}
};
