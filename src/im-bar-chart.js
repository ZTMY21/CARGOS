// Barras SVG para el detalle IM: comparar envíos de cajas e históricos sin mezclar sus unidades.
export function renderImBarChart(container,labels,values,{
  accent='#208550',emptyLabel='Sin envíos registrados',historicalValues=[]
}={}){
  container.replaceChildren();
  const W=640,H=318,L=55,R=621,T=39,B=270;
  const items=labels.map((label,i)=>({
    label,i,
    boxes:Number.isFinite(values[i])?Math.max(0,values[i]):null,
    historical:Number.isFinite(historicalValues[i])?Math.max(0,historicalValues[i]):0
  }));
  const visible=items.filter(item=>item.boxes!==null);
  const max=Math.max(0,...visible.flatMap(item=>[item.boxes,item.historical]));
  const ns='http://www.w3.org/2000/svg';
  const svg=document.createElementNS(ns,'svg');
  svg.setAttribute('viewBox','0 0 '+W+' '+H);
  svg.setAttribute('role','img');
  svg.setAttribute('aria-label','Barras de envíos con registro e históricos por año');
  const add=(parent,tag,attributes={},content)=>{
    const node=document.createElementNS(ns,tag);
    for(const [key,value] of Object.entries(attributes))node.setAttribute(key,String(value));
    if(content!==undefined)node.textContent=String(content);
    parent.append(node);return node;
  };
  const fmt=value=>Number(value).toLocaleString('es-PE');
  const niceStep=value=>{
    const power=Math.pow(10,Math.floor(Math.log10(value)));
    return ([1,2,2.5,5,10].find(k=>k*power>=value)||10)*power;
  };
  const step=niceStep(Math.max(1,max/4));
  const ceiling=Math.max(step,Math.ceil(max/step)*step);
  const y=value=>B-(B-T)*value/ceiling;
  for(let i=0;i<=4;i++){
    const value=ceiling*i/4,yy=y(value);
    add(svg,'line',{x1:L,y1:yy,x2:R,y2:yy,stroke:'#e6ebf0','stroke-width':1});
    add(svg,'text',{x:L-9,y:yy+4,'text-anchor':'end','font-size':11,fill:'#8493a3'},fmt(Math.round(value)));
  }
  const span=(R-L)/Math.max(1,labels.length);
  const tip=document.createElement('div');
  tip.className='im-shipped-tooltip';tip.hidden=true;
  const showTip=(item,cx,cy)=>{
    tip.textContent=item.historical
      ? item.label+': '+fmt(item.boxes)+' cajas con registro\nHistóricos: '+fmt(item.historical)+' cargos'
      : item.label+': '+fmt(item.boxes)+' cajas con registro';
    tip.style.left=100*cx/W+'%';
    tip.style.top=100*cy/H+'%';
    tip.hidden=false;
  };
  visible.forEach(item=>{
    const center=L+span*(item.i+.5);
    const paired=item.boxes>0&&item.historical>0;
    const barWidth=Math.min(paired?25:46,span*(paired?.29:.61));
    const gap=paired?5:0;
    const bars=[
      {value:item.boxes,kind:'verified',fill:accent,offset:paired?-(barWidth+gap)/2:0},
      {value:item.historical,kind:'historical',fill:'#9561d8',offset:paired?(barWidth+gap)/2:0}
    ];
    const group=add(svg,'g',{tabindex:0,'aria-label':
      item.label+': '+fmt(item.boxes)+' cajas enviadas'+
      (item.historical?'; históricos '+fmt(item.historical)+' cargos':'')});
    for(const bar of bars){
      if(bar.value<=0)continue;
      const x=center+bar.offset-barWidth/2,top=y(bar.value);
      add(group,'rect',{x,y:top,width:barWidth,height:B-top,rx:Math.min(5,barWidth/5),
        fill:bar.fill,'data-im-kind':bar.kind});
      add(group,'text',{x:center+bar.offset,y:Math.max(T-9,top-9),
        'text-anchor':'middle','font-size':11,'font-weight':800,
        fill:bar.kind==='historical'?'#8453bf':'#176b47'},fmt(bar.value));
    }
    add(group,'rect',{x:center-span*.44,y:T,width:span*.88,height:B-T,fill:'transparent'});
    add(group,'title',{},item.historical
      ? item.label+': '+fmt(item.boxes)+' cajas con registro; Históricos: '+fmt(item.historical)+' cargos'
      : item.label+': '+fmt(item.boxes)+' cajas con registro');
    const on=()=>showTip(item,center,Math.max(T+32,y(Math.max(item.boxes,item.historical))));
    group.addEventListener('mouseenter',on);
    group.addEventListener('focus',on);
    group.addEventListener('click',on);
    group.addEventListener('mouseleave',()=>{tip.hidden=true;});
    group.addEventListener('blur',()=>{tip.hidden=true;});
  });
  labels.forEach((label,i)=>{
    const center=L+span*(i+.5);
    add(svg,'text',{x:center,y:B+23,'text-anchor':'middle',
      'font-size':labels.length>10?10:11,fill:'#64778a'},label);
  });
  if(max===0){
    add(svg,'text',{x:(L+R)/2,y:(T+B)/2,'text-anchor':'middle',
      'font-size':13,'font-weight':700,fill:'#64748b'},emptyLabel);
  }
  container.append(svg,tip);
}
