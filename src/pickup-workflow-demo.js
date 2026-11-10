import {PDFDocument} from 'pdf-lib';
import {pickupBoxKey,pickupDate,pickupGroups} from '../server/pickup-workbook.js';

export const demoPickupBoxes = [
  ...Array.from({length:35},(_,i)=>({type:'NUEVAS',code:'TD99000000'+String(i+1).padStart(2,'0'),cargos:[String(910+i)]})),
  ...Array.from({length:30},(_,i)=>({type:'DEVOLUCION',code:'T98000000'+String(i+1).padStart(2,'0'),cargos:[String(710+i)]}))
].map(box=>({...box,key:pickupBoxKey(box.code),prepared_at:'2026-11-07'}));

export async function validatePickupPdf(bytes){
  if(!bytes?.length||bytes.length>5*1024*1024||
    new TextDecoder().decode(bytes.subarray(0,5))!=='%PDF-')throw Error('Selecciona un PDF válido de máximo 5 MB.');
  let pages;
  try{pages=(await PDFDocument.load(bytes,{throwOnInvalidObject:true,updateMetadata:false})).getPageCount();}
  catch{throw Error('El PDF no se pudo leer. Revisa si está dañado o protegido.');}
  if(pages<1||pages>2)throw Error('El sustento debe tener 1 o 2 páginas.');
  return pages;
}

export function createDemoPickupWorkflow({renderMail,writeWorkbooks,clock=()=>new Date(),id=()=>crypto.randomUUID()}){
  const batches=[];
  const available=()=>demoPickupBoxes.filter(box=>!batches.some(batch=>
    batch.status!=='CANCELADO'&&batch.boxes.some(item=>item.key===box.key)));
  const lookup=value=>{
    const batch=batches.find(item=>item.id===value);
    if(!batch)throw Error('Aviso no encontrado.');
    return batch;
  };
  const files=new Map();
  let result;
  let queue=Promise.resolve();
  const sync=visit=>{
    const job=queue.then(async()=>{
      try{
        result=await writeWorkbooks(batches.flatMap(batch=>batch.visits.map(({id,date,codes})=>({id,date,codes}))));
        for(const batch of batches)for(const item of batch.visits)if(result.verified.includes(item.id)){item.synced=true;delete item.error;}
        return result;
      }catch(error){visit.error=error.message;throw error;}
    });
    queue=job.catch(()=>{});
    return job;
  };
  return {
    async state(){return {available:available(),batches,simulation:true};},
    async prepare({keys,config}){
      const chosen=available().filter(box=>keys.includes(box.key));
      if(!chosen.length||chosen.length!==keys.length||pickupGroups.some(type=>chosen.filter(box=>box.type===type).length>30))
        throw Error('Revisa los códigos elegidos y el máximo de 30 por tipo.');
      const batch={id:id(),created_at:clock().toISOString(),status:'PENDIENTE',boxes:chosen,
        subject:'SIMULACIÓN · Recojo | {{nuevas}} nuevas y {{devoluciones}} devolución | {{fecha}}',
        sender:'kardex@example.invalid',to:['iron-mountain@example.invalid'],cc:['archivo@example.invalid'],
        signature:{...config,name:config?.name||'Operador de prueba',company:config?.company||'Kárdex Digital',
          logo_png_base64:config?.logo},schedule:{},events:[],visits:[]};
      batches.unshift(batch);
      return batch;
    },
    async mail(action,batchId){
      const batch=lookup(batchId);
      const output=await renderMail(batch);
      if(action==='download'&&batch.status==='PENDIENTE')batch.status='PREPARADO';
      return output;
    },
    async mark(batchId,action){
      const batch=lookup(batchId);
      if(action==='CANCELADO'&&['PENDIENTE','PREPARADO'].includes(batch.status))batch.status=action;
      else if(action==='CONFIRMADO'&&batch.status==='PREPARADO')batch.status=action;
      else throw Error('Acción incompatible con el estado del correo.');
    },
    async schedule(batchId,dates){
      const batch=lookup(batchId);
      const types=pickupGroups.filter(type=>batch.boxes.some(box=>box.type===type));
      const withdrawn=new Set(batch.visits.flatMap(visit=>visit.codes));
      const completed=type=>batch.boxes.filter(box=>box.type===type).every(box=>withdrawn.has(box.code));
      if(batch.status!=='CONFIRMADO'||!Object.values(dates).some(Boolean)||
          Object.entries(dates).some(([type,date])=>!types.includes(type)||
            (date&&!validDate(date))||
            (completed(type)&&date!==batch.schedule[type])))
        throw Error('Revisa las fechas de programación.');
      batch.events.push({date:clock().toISOString(),actor:'Operador de prueba',previous:batch.schedule,next:dates});
      batch.schedule={...dates};
    },
    async confirm(batchId,{visitId,codes,date,file}){
      const batch=lookup(batchId);
      const prior=batch.visits.find(visit=>visit.id===visitId);
      if(prior)return sync(prior);
      const keys=codes.map(pickupBoxKey);
      const boxes=batch.boxes.filter(box=>keys.includes(box.key));
      const withdrawn=new Set(batch.visits.flatMap(visit=>visit.codes.map(pickupBoxKey)));
      if(batch.status!=='CONFIRMADO'||!validDate(date)||date>pickupDate(clock())||!keys.length||boxes.length!==keys.length||
        boxes.some(box=>!batch.schedule[box.type]||date<box.prepared_at||withdrawn.has(box.key)))
        throw Error('Revisa la fecha y selecciona únicamente cajas programadas que se retiraron.');
      if(!file)throw Error('Adjunta el PDF firmado antes de confirmar.');
      const bytes=new Uint8Array(await file.arrayBuffer());
      const pages=await validatePickupPdf(bytes);
      // Recheck after PDF parsing in case a second request finished concurrently.
      const sameVisit=batch.visits.find(visit=>visit.id===visitId);
      if(sameVisit)return sync(sameVisit);
      if(batch.visits.some(visit=>visit.codes.some(code=>keys.includes(pickupBoxKey(code)))))
        throw Error('Ya se confirmó una de las cajas elegidas.');
      const visit={id:visitId,date,codes:boxes.map(box=>box.code),pages,name:file.name,size:bytes.length,
        actor:'Operador de prueba',synced:false};
      files.set(visitId,new Blob([bytes],{type:'application/pdf'}));
      batch.visits.push(visit);
      return sync(visit);
    },
    retry(batchId,visitId){
      const visit=lookup(batchId).visits.find(item=>item.id===visitId);
      if(!visit)throw Error('Visita no encontrada.');
      return sync(visit);
    },
    pdf(_batchId,visitId){return files.get(visitId);},
    excel(){return result?.files||[];}
  };
}

export function validDate(date){
  const ms=Date.parse(date+'T00:00:00Z');
  return /^\d{4}-\d{2}-\d{2}$/.test(date)&&Number.isFinite(ms)&&new Date(ms).toISOString().slice(0,10)===date;
}
