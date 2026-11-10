import {setupRequirements} from './requirements-ui.js';
import {REQ_TYPES,limaDate} from './rules.js';

// Demostración exclusiva de Vercel Preview. Monta el MISMO formulario de
// Requerimientos en el HTML original del Kárdex, sin entrar a Supabase.
const sample=[
  {clave:'demo45',codigo:'T00045',cargos:['300'],ubicacion:'Iron Mountain',solicitable:true,prestamo:null,estado:'En IM'},
  {clave:'demo46',codigo:'TD00046',cargos:['301'],ubicacion:'Iron Mountain',solicitable:true,prestamo:null,estado:'En IM'},
  {clave:'demo78',codigo:'P00078',cargos:['302'],ubicacion:'Iron Mountain',solicitable:true,prestamo:null,estado:'En IM'}
];
export function mountImMailDemo(doc=document){
  const view=id=>doc.getElementById(id);
  if(!view('appShell')||!view('req4Workspace'))throw Error('No está disponible el formulario original de Requerimientos.');
  view('sessionLoading').hidden=true;
  view('authOverlay').hidden=true;
  view('registerOverlay').hidden=true;
  view('appShell').hidden=false;
  view('appShell').inert=false;
  view('googleSyncPanel').hidden=false;
  view('googleSyncContent').hidden=true;
  view('sessionProfile').hidden=false;
  view('sessionUser').textContent='Preview · Sin sesión real';
  view('connectionStatus').textContent='Vista previa de diseño · Sin conexión a registros reales';
  view('grp-requerimientos').hidden=false;
  view('grp-requerimientos').open=true;
  for(const section of ['grp-resumen','grp-existencias','grp-escaneos','grp-cajas','grp-acondicionamiento','grp-correos','grp-solicitudes','grp-documentos']){
    const node=view(section);
    if(node)node.hidden=true;
  }
  for(const tab of doc.querySelectorAll('#workspaceTabs [data-workspace]')){
    const chosen=tab.dataset.workspace==='requerimientos';
    tab.setAttribute('aria-selected',String(chosen));
    tab.tabIndex=chosen?0:-1;
    tab.disabled=!chosen;
  }
  const banner=doc.createElement('p');
  banner.id='imMailDemoBanner';
  banner.className='req4-note';
  banner.textContent='Preview de Solicitudes a IM: puedes probar el buscador, seleccionar y simular el guardado. No se envían correos ni se modifican registros reales.';
  view('req4Workspace').before(banner);

  let rows=[],tracking={cajas:[],suministro:{solicitudes:[]}},counter=0,ui=null;
  const context=()=>({
    allowed:true,mailAccess:true,mailPreviewMode:true,
    id:'demo-im-local',name:'Demostración · CD Santa Anita'
  });
  const repository={
    pickupMailConfig:async()=>({}),
    requestBoxes:async search=>{
      const q=String(search||'').toUpperCase().trim();
      return sample.filter(box=>box.codigo.toUpperCase().includes(q));
    },
    requestAction:async(id,action,data)=>{
      if(action!=='crear'||data.tipo!=='prestamo'||!Array.isArray(data.cajas)||!data.cajas.length)
        throw Error('Selecciona las cajas de ejemplo antes de simular la solicitud.');
      const row={
        id,numero:'DEMO-IM-'+String(++counter).padStart(3,'0'),tipo:REQ_TYPES[1],
        cantidadCajas:data.cajas.length,fechaSolicitud:limaDate(),usuario:'Vista previa',
        estadoV4:'Solicitado'
      };
      rows.push(row);
      tracking.cajas.push(...data.cajas.map(codigo=>({
        requerimiento:id,codigo,cargos:[],clave:'demo-'+codigo,prestamo:row.numero
      })));
      return row;
    }
  };
  const refresh=async()=>ui?.update(rows,tracking);
  ui=setupRequirements(view('req4Workspace'),{repository,context,refresh,isPreview:true});
  ui.update(rows,tracking);
  return {ui,repository,context};
}
if(typeof document!=='undefined'&&document.getElementById('appShell')){
  mountImMailDemo(document);
}
