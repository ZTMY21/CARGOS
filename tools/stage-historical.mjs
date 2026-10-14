import {createInterface} from 'node:readline';
import {writeFile} from 'node:fs/promises';
import {HistoricalAccumulator} from '../src/historical.js';
const accumulator=new HistoricalAccumulator();
for await(const line of createInterface({input:process.stdin,crlfDelay:Infinity})) {
 const value=JSON.parse(line);
 if(value.sheet){accumulator.beginSheet(value.sheet);process.stderr.write(`Procesando ${value.sheet}\n`);}
 else accumulator.addRow(value.row,value.cells);
}
const result=await accumulator.finish();
if(!process.argv[2])throw new Error('Indica una ruta de salida fuera del repositorio.');
await writeFile(process.argv[2],JSON.stringify(result));
const byYear={};for(const d of result.docs){const y=d.anioOrigen||'Sin año';byYear[y]??={cargos:0,codigos:0};byYear[y].cargos++;byYear[y].codigos+=d.datosOrigen.celdas_documentos;}
console.log(JSON.stringify({stats:result.stats,byYear},null,2));
