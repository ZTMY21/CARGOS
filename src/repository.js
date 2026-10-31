import { safeImage } from './rules.js';
import { cargoLocations } from './cargo-details.js';

const nullable = value => value === '' || value === undefined ? null : value;
export function reqFromDb(row) {
  return {
    id: row.id, numero: row.numero, tipo: row.tipo, fechaSolicitud: row.fecha_solicitud,
    cantidadCajas: row.cantidad_cajas ?? '', numerosCargo: row.numeros_cargo || '',
    fechaRecepcion: row.fecha_recepcion || '', fechaDevolucion: row.fecha_devolucion || '',
    usuario: row.usuario, updatedAt: row.updated_at
  };
}
export function docFromDb(row) {
  return {
    id: row.id, kardex: row.kardex, fechaRegistro: row.fecha_registro, tipoDoc: row.tipo_doc,
    periodo: row.periodo, ubicacion: row.ubicacion, folios: row.folios ?? '', cargos: row.cargos || [],
    cajaAsignada: row.caja_asignada || '', fEnvio: row.f_envio || '', sustento: row.sustento || '',
    sustentoImagen: safeImage(row.sustento_imagen), driveImageJob: /^drive-job:[0-9a-f-]{36}$/i.test(row.sustento_imagen||'') ? row.sustento_imagen : '', usuario: row.usuario,
    imConfirmado: !!row.im_confirmado, imCodigoCaja: row.im_codigo_caja || '',
    imFechaEnvio: row.im_fecha_envio || '', imResponsable: row.im_responsable || '',
    imPreparado: !!row.im_preparado, imCajaPreparada: row.im_caja_preparada || '',
    imResponsablePreparacion: row.im_responsable_preparacion || '',
    imLiveCodigoCaja: row.im_live_codigo_caja || '',
    imLiveClasificacion: row.im_live_clasificacion || '',
    imLiveFechaEnvio: row.im_live_fecha_envio || '',
    facturas: row.facturas || '', obs: row.obs || '', updatedAt: row.updated_at,
    facturasEncontradas: row.facturas_encontradas || [], cantidadFacturas: row.cantidad_facturas,
    ubicacionesCodigo: row.ubicaciones_codigo, errorUbicacion: row.error_ubicacion,
    tieneSustentoImagen: row.tiene_sustento_imagen || !!row.sustento_imagen,
    claveOrigen: row.clave_origen || '', hojaOrigen: row.hoja_origen || '',
    fechaOrigen: row.fecha_origen || '', anioOrigen: row.anio_origen,
    estadoOrigen: row.estado_origen || '', datosOrigen: row.datos_origen || {},
    importacionId: row.importacion_id, completo: 'facturas' in row
  };
}
export function reqToDb(row, importing = false) {
  const data = {
    tipo: row.tipo, fecha_solicitud: row.fechaSolicitud, cantidad_cajas: nullable(row.cantidadCajas),
    numeros_cargo: row.numerosCargo || '', fecha_recepcion: nullable(row.fechaRecepcion),
    fecha_devolucion: nullable(row.fechaDevolucion), usuario: row.usuario
  };
  if (importing) Object.assign(data, { id: row.id, numero: row.numero });
  else if (row.id) data.id = row.id;
  return data;
}
export function docToDb(row, importing = false) {
  const data = {
    tipo_doc: row.tipoDoc, periodo: nullable(row.periodo),
    ubicacion: nullable(row.ubicacion),
    folios: nullable(row.folios), cargos: row.cargos || [], caja_asignada: nullable(row.cajaAsignada),
    f_envio: nullable(row.fEnvio), sustento: row.sustento || '', sustento_imagen: row.sustentoImagen || '',
    usuario: row.usuario, facturas: row.facturas || '', obs: row.obs || ''
  };
  if (importing) Object.assign(data, {
    id: row.id, kardex: nullable(row.kardex), fecha_registro: row.fechaRegistro,
    clave_origen: nullable(row.claveOrigen), hoja_origen: row.hojaOrigen || '', fecha_origen: nullable(row.fechaOrigen),
    anio_origen: nullable(row.anioOrigen), estado_origen: row.estadoOrigen || '', datos_origen: row.datosOrigen || {}
  });
  else if (row.id) data.id = row.id;
  return data;
}
function checked(result) {
  if (result.error) throw result.error;
  return result.data;
}
export class KardexRepository {
  constructor(client) { this.client = client; }
  async snapshot() { return checked(await this.client.rpc('kardex_snapshot')); }
  async access() { return checked(await this.client.rpc('kardex_access')); }
  async preparedImDetails() { return checked(await this.client.rpc('kardex_prepared_im_detail')); }
  async requestedIMDetails() { return checked(await this.client.rpc('kardex_requested_im_detail')); }
  async shippedIMBoxesMonthly() { return checked(await this.client.rpc('kardex_im_boxes_sent_monthly')); }
  async cargoSafetyStatus() { return checked(await this.client.rpc('kardex_resguardo_estado')); }
  async previousCargos(ids) { return checked(await this.client.rpc('kardex_previous_cargos',{p_documento_ids:ids})); }
  async requestAdminAccess() { return checked(await this.client.rpc('kardex_admin_apply')); }
  async pendingAdminRequests() { return checked(await this.client.rpc('kardex_admin_pending')); }
  async reviewAdminRequest(id,approved) { return checked(await this.client.rpc('kardex_admin_review',{p_id:id,p_approve:approved})); }
  async fetchDoc(id) { return docFromDb(checked(await this.client.from('documentos').select().eq('id',id).single())); }
  async fetchImage(id) {
    const value=checked(await this.client.from('documentos').select('sustento_imagen').eq('id',id).single()).sustento_imagen||'';
    if(!/^drive-job:[0-9a-f-]{36}$/i.test(value))return safeImage(value);
    const session=checked(await this.client.auth.getSession())?.session;
    if(!session)throw new Error('Inicia sesión en Kardex para ver el sustento.');
    const response=await fetch('/api/drive-archive?action=download&id='+encodeURIComponent(value.slice('drive-job:'.length)),{
      headers:{Authorization:'Bearer '+session.access_token}
    });
    if(!response.ok)throw new Error('No se pudo recuperar el sustento desde Google Drive.');
    const payload=await response.arrayBuffer();
    if(payload.byteLength>10*1024**2)throw new Error('Imagen demasiado grande para mostrar.');
    const blob=new Blob([payload],{type:'image/jpeg'});
    return new Promise((resolve,reject)=>{
      const reader=new FileReader();reader.onload=()=>resolve(safeImage(reader.result));reader.onerror=()=>reject(new Error('No se pudo abrir la imagen.'));reader.readAsDataURL(blob);
    });
  }
  async reportDocs(snapshotDocs,year=null) {
    const selected=snapshotDocs.filter(d=>year===null || String(d.anioOrigen||d.periodo?.slice(0,4)||d.fechaOrigen?.slice(0,4))===String(year));
    const rows=checked(await this.client.rpc('kardex_existencias_export_meta'));
    const byId=new Map(rows.map(row=>[row.id,row]));
    return selected.map(doc=>{
      const extra=byId.get(doc.id);
      if(!extra)throw new Error('No se pudo consultar el resumen de todos los cargos.');
      return {...doc,cantidadRegistros:extra.cantidad_registros,
        imLiveResponsableEntrega:extra.responsable_entrega||''};
    });
  }
  async *reportOriginalRows(year,sourceDocs) {
    const relevant=sourceDocs
      .filter(d=>String(d.anioOrigen||d.periodo?.slice(0,4)||d.fechaOrigen?.slice(0,4))===String(year))
      .sort((a,b)=>String(a.cargos?.[0]||'').localeCompare(String(b.cargos?.[0]||''),'es',{numeric:true})
        ||String(a.kardex).localeCompare(String(b.kardex),'es',{numeric:true}));
    // Cada bloque solo consulta el origen de los documentos del año: no
    // transfiere imágenes de sustento ni el catálogo completo al navegador.
    for(let i=0;i<relevant.length;i+=40) {
      const group=relevant.slice(i,i+40);
      const rows=checked(await this.client.from('documentos')
        .select('id,datos_origen').in('id',group.map(d=>d.id)));
      const byId=new Map(rows.map(r=>[r.id,r.datos_origen]));
      for(const doc of group) {
        if(!byId.has(doc.id))throw new Error('No se pudo leer el detalle original del Kardex '+doc.kardex);
        let origin=byId.get(doc.id)||{};
        // Si el nuevo cargo se archivó después de instalar V8, su detalle
        // A:N quedó resguardado en Supabase y se recupera para el Excel anual.
        if(!origin.registros_gzip_base64 && !(origin.registros||[]).length &&
            origin.google_sheet_file && (doc.cargos||[]).length){
          const result=await this.client.rpc('kardex_detalle_original_exportar',{
            p_anio:Number(year),p_cargo:String(doc.cargos[0])
          });
          if(result.error)throw result.error;
          if(Array.isArray(result.data)&&result.data.length){
            const cols=['Fecha','Cargo','Grupo','Codigo','Archivo_Principal',
              'PDF','Total_Paginas','Tipo','Fuente','Observaciones','ESTADO_REGULARIZADO',
              'Estado','Detalle','Actualizado'];
            origin={...origin,registros:result.data.map(values=>
              Object.fromEntries(cols.map((column,index)=>[column,values[index]??''])))};
          }
        }
        yield {doc,origin};
      }
    }
  }
  async search(filters, offset=0, limit=100, signal) {
    let query=this.client.rpc('kardex_search',{
      query_text:filters.query||'',estado_filter:filters.state||'',tipo_filter:filters.type||'',
      ubicacion_filter:filters.location||'',year_filter:filters.year||'',invoice_exact:!!filters.invoiceExact,
      page_offset:offset,page_limit:limit
    });
    if(signal) query=query.abortSignal(signal);
    const result = checked(await query);
    // Load original rows only for this search page, without images or the full catalog.
    if (filters.query?.trim() && result.rows.length) {
      try {
        for (let offset=0; offset<result.rows.length; offset+=20) {
          const page=result.rows.slice(offset,offset+20);
          let request=this.client.from('documentos').select('id,datos_origen').in('id',page.map(d=>d.id));
          if(signal)request=request.abortSignal(signal);
          const sources=checked(await request);
          for(const row of page) {
            const source=sources.find(d=>d.id===row.id);
            if (!source) throw new Error('No se pudo leer el grupo');
            row.ubicaciones_codigo=await cargoLocations(source.datos_origen);
          }
        }
      } catch(error) {
        if(signal?.aborted)throw error;
        for(const row of result.rows)if(!row.ubicaciones_codigo)row.error_ubicacion='No se pudo consultar el grupo. Actualiza los datos.';
      }
    }
    return result;
  }
  async exportRows(filters) {
    const ids=[];
    for(let offset=0;;offset+=1000) {
      const result=await this.search(filters,offset,1000);
      ids.push(...result.rows.map(r=>r.id));
      if(ids.length>=result.total)break;
    }
    const docs=[];
    for(let offset=0;offset<ids.length;offset+=25) {
      const rows=checked(await this.client.from('documentos').select().in('id',ids.slice(offset,offset+25)));
      docs.push(...rows.map(docFromDb));
    }
    return docs.sort((a,b)=>b.kardex.localeCompare(a.kardex));
  }
  async saveReq(row, existing) { return this.save('requerimientos', reqToDb(row), existing, reqFromDb); }
  async saveDoc(row, existing) {
    const value=row.sustentoImagen||'';
    if(/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(value)){
      const id=existing?.id||row.id;
      if(!/^[0-9a-f-]{36}$/i.test(id||''))throw new Error('El documento necesita un identificador para guardar su imagen.');
      const blob=await(await fetch(value)).blob();
      const bytes=await blob.arrayBuffer();
      const sha=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),n=>n.toString(16).padStart(2,'0')).join('');
      const session=checked(await this.client.auth.getSession())?.session;
      if(!session)throw new Error('Inicia sesión para guardar el sustento.');
      const upload=async(action,{job,offset,body}={})=>{
        const query=new URLSearchParams({action});
        if(job)query.set('id',job);
        if(offset!==undefined)query.set('offset',String(offset));
        const response=await fetch('/api/drive-archive?'+query,{
          method:'POST',headers:{Authorization:'Bearer '+session.access_token,'Content-Type':body instanceof Uint8Array?'application/octet-stream':'application/json'},
          body:body instanceof Uint8Array?body:JSON.stringify(body||{})
        });
        const result=await response.json().catch(()=>({}));
        if(!response.ok)throw new Error(result.error||'No se pudo guardar el sustento en Drive.');
        return result;
      };
      let job=await upload('start',{body:{documentId:id,category:'scans',sourceKey:'sustento:'+id,
        sourceVersion:'sha256:'+sha,name:'sustento_'+id+'.jpg',sha256:sha,mime:'image/jpeg',size:bytes.byteLength}});
      while(job.status!=='verified'&&job.offset<bytes.byteLength){
        const offset=job.offset;
        try{job=await upload('chunk',{job:job.id,offset,body:new Uint8Array(bytes.slice(offset,Math.min(offset+1024**2,bytes.byteLength)))});}
        catch(error){
          if(error.message!=='OFFSET_CONFLICT')throw error;
          job=await upload('reconcile',{job:job.id});
        }
      }
      if(job.status!=='verified')job=await upload('finish',{job:job.id});
      if(job.status!=='verified'||job.backendVerified!==true||job.sha256!==sha)
        throw new Error('La imagen no se verificó en Drive. No se guardó el registro.');
      row={...row,sustentoImagen:'drive-job:'+job.id};
    }else if(value&&!/^drive-job:[0-9a-f-]{36}$/i.test(value)){
      throw new Error('Formato de sustento no permitido.');
    }
    return this.save('documentos',docToDb(row),existing,docFromDb);
  }
  async save(table, data, existing, mapper) {
    let query;
    if (existing) {
      query = this.client.from(table).update(data).eq('id', existing.id).eq('updated_at', existing.updatedAt);
    } else query = this.client.from(table).insert(data);
    const result = await query.select();
    if (!existing && result.error?.code === '23505' && data.id) {
      const previous = checked(await this.client.from(table).select().eq('id',data.id).single());
      const matches = previous && Object.keys(data).every(key => {
        const expected = ['folios','cantidad_cajas'].includes(key) && data[key] !== null ? Number(data[key]) : data[key];
        return JSON.stringify(previous[key]) === JSON.stringify(expected);
      });
      if (matches) return mapper(previous);
    }
    const rows = checked(result);
    if (!rows?.length) throw new Error('Otro usuario modificó o eliminó este registro. Recarga los datos y vuelve a editarlo.');
    return mapper(rows[0]);
  }
  async remove(table, existing) {
    const rows = checked(await this.client.from(table).delete().eq('id', existing.id)
      .eq('updated_at', existing.updatedAt).select('id'));
    if (!rows?.length) throw new Error('El registro cambió en otra pantalla. Recarga los datos antes de eliminarlo.');
  }
  async replace(reqs, docs) {
    return checked(await this.client.rpc('kardex_import', {
      requerimientos_data: reqs.map(r => reqToDb(r, true)),
      documentos_data: docs.map(d => docToDb(d, true))
    }));
  }
  async importFile(file, imported, progress=()=>{}) {
    const session=checked(await this.client.auth.getSession())?.session;
    if(!session?.user?.id) throw new Error('Inicia sesión antes de importar.');
    const bytes=await file.arrayBuffer();
    const sha=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),n=>n.toString(16).padStart(2,'0')).join('');
    // Google Drive is the authoritative copy for new Excel imports. Metadata and
    // individual Kardex rows remain in Postgres for transactional search/reporting.
    // Do not open an import transaction until the Drive backend has read back the
    // binary and verified its SHA-256. Never fall back to Supabase Storage.
    if(bytes.byteLength<1||bytes.byteLength>100*1024**2)throw new Error('El Excel debe medir entre 1 byte y 100 MiB.');
    const mime=/\.xlsm$/i.test(file.name)?'application/vnd.ms-excel.sheet.macroenabled.12'
      :'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    const authorization='Bearer '+session.access_token;
    const archive=async(action,{id,offset,json,binary}={})=>{
      const query=new URLSearchParams({action});
      if(id)query.set('id',id);
      if(offset!==undefined)query.set('offset',String(offset));
      const response=await fetch('/api/drive-archive?'+query,{
        method:'POST',headers:{Authorization:authorization,'Content-Type':binary?'application/octet-stream':'application/json'},
        body:binary||JSON.stringify(json||{})
      });
      const result=await response.json().catch(()=>({}));
      if(!response.ok)throw new Error(result.error||'Falló la operación de Google Drive.');
      return result;
    };
    progress('Guardando el Excel original en Google Drive…');
    const sourceKey='excel-import:'+session.user.id+':'+sha;
    const payload={documentId:null,sourceKey,sourceVersion:'sha256:'+sha,
      name:file.name,sha256:sha,size:bytes.byteLength,mime,category:'originals',
      modifiedAt:new Date(file.lastModified).toISOString()};
    let job=await archive('start',{json:payload});
    while(job.status!=='verified'&&job.offset<bytes.byteLength){
      const offset=job.offset;
      progress('Google Drive: '+Math.round(offset/bytes.byteLength*100)+' % transferido…');
      try{
        job=await archive('chunk',{id:job.id,offset,
          binary:new Uint8Array(bytes.slice(offset,Math.min(offset+1024**2,bytes.byteLength)))});
      }catch(error){
        if(error.message!=='OFFSET_CONFLICT')throw error;
        job=await archive('reconcile',{id:job.id});
      }
    }
    if(job.status!=='verified'){
      progress('Verificando descarga e integridad SHA-256 desde Drive…');
      job=await archive('finish',{id:job.id});
    }
    if(job.status!=='verified'||job.backendVerified!==true||job.sha256!==sha||!job.driveFileId)
      throw new Error('Google Drive no confirmó la recuperación del original. No se importaron registros.');
    const importId=checked(await this.client.rpc('kardex_begin_drive_import',{
      archivo_nombre:file.name,archivo_file_id:job.driveFileId,
      archivo_sha256:sha,archivo_formato:imported.format||'kardex'
    }));
    const reqNumbers=new Map(imported.reqs.map(r=>[r.id,r.numero]));
    const records=[...imported.reqs.map(r=>({kind:'req',data:reqToDb(r,true)})),
      ...imported.docs.map(d=>({kind:'doc',data:{...docToDb(d,true),req_numero:reqNumbers.get(d.cajaAsignada)||''}}))];
    const chunks=makeImportBatches(records);
    let processed=0;
    for(let index=0;index<chunks.length;index++) {
      const chunk=chunks[index];
      checked(await this.client.rpc('kardex_stage_import',{
        import_id:importId,batch_number:index,req_data:chunk.reqs,doc_data:chunk.docs
      }));
      processed+=chunk.reqs.length+chunk.docs.length;
      progress(`Preparados ${processed.toLocaleString('es-PE')} de ${records.length.toLocaleString('es-PE')} registros…`);
    }
    progress('Confirmando la importación completa…');
    const result=checked(await this.client.rpc('kardex_commit_import',{import_id:importId,expected_batches:chunks.length}));
    return {...result,importacion_id:importId};
  }
  async reset() { return checked(await this.client.rpc('kardex_reset')); }
}

export function makeImportBatches(records,maxBytes=450000,maxRecords=200) {
  const encoder=new TextEncoder(),chunks=[];
  let chunk={reqs:[],docs:[]},size=0,count=0;
  for(const record of records) {
    const bytes=encoder.encode(JSON.stringify(record.data)).length;
    if(count&&(size+bytes>maxBytes||count>=maxRecords)) {chunks.push(chunk);chunk={reqs:[],docs:[]};size=count=0;}
    chunk[record.kind==='req'?'reqs':'docs'].push(record.data);size+=bytes;count++;
  }
  if(count)chunks.push(chunk);
  return chunks;
}
