import {attachPickupMail} from './pickup-mail-ui.js';
import {createDemoPickupWorkflow} from './pickup-workflow-demo.js';
import {composePickupMail} from './pickup-mail-template.js';
import {pickupAttachments} from '../server/pickup-workbook.js';
import newTemplate from '../server/templates/pickup-nuevas.xlsx?url';
import returnTemplate from '../server/templates/pickup-devolucion.xlsx?url';

const original=document.getElementById('grp-correos');
const icons=[...document.querySelectorAll('svg')].find(el=>el.querySelector('#iv-mail'));
const stage=document.createElement('main');
stage.className='wrap';
const banner=document.createElement('p');
banner.className='notice';
banner.textContent='Vista previa · datos ficticios. Los correos y archivos de este ensayo se generan con datos de prueba.';
stage.append(banner,original);
document.body.replaceChildren(...(icons?[icons]:[]),stage);
document.body.className='';
original.hidden=false;
original.open=true;
const workflow=createDemoPickupWorkflow({
  async renderMail(batch){
    const attachments=await pickupAttachments(batch,async type=>{
      const r=await fetch(type==='NUEVAS'?newTemplate:returnTemplate);
      if(!r.ok)throw Error('No se pudo abrir la plantilla de prueba.');
      return r.arrayBuffer();
    });
    const mail=composePickupMail(batch,attachments,{noticeAt:new Date(),simulation:true});
    return {...mail,boxes:batch.boxes.length,
      attachments:attachments.map(file=>file.filename),attachmentFiles:attachments,blob:new Blob([mail.eml],{type:'message/rfc822'})};
  },
  async writeWorkbooks(visits){
    const r=await fetch('/api/pickup-mail',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({action:'demoExcel',visits})});
    const result=await r.json();
    if(!r.ok)throw Error(result.error);
    return result;
  }
});
const mail=attachPickupMail({workflow,isAdmin:()=>true,appReady:()=>true,isPreview:()=>true});
mail.activate();
const simulation=document.getElementById('ivMailSimShortcut');
simulation.textContent='Simular correo para enviar';
simulation.onclick=()=>mail.simulate();
