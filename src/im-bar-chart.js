// Barras SVG del detalle IM. ? representa información histórica sin cantidad de cajas.
export function renderImBarChart(container,labels,values,{
  accent='#208550',emptyLabel='Sin envíos registrados',
  historicalValues=[],historicalUnknown=[]
}={}){
  container.replaceChildren();
  const W=640,H=318,L=55,R=621,T=39,B=270;
  const items=labels.map((label,i)=>({
    label,i,
    verified:typeof values[i]==='number'&&Number.isFinite(values[i])?Math.max(0,values[i]):null,
    historical:Number.isFinite(historicalValues[i])?Math.max(0,historicalValues[i]):0,
    unknown:Number.isFinite(historicalUnknown[i])?Math.max(0,historicalUnknown[i]):0
  }));
  const visible=items.filter(item=>item.verified!==null);
  const max=Math.max(0,...visible.map(item=>item.verified+item.historical));
  const ns='http://www.w3.org/2000/svg';
  const svg=document.createElementNS(ns,'svg');
  svg.setAttribute('viewBox','0 0 '+W+' '+H);
  svg.setAttribute('role','img');
  svg.setAttribute('aria-label','Barras de cajas enviadas a Iron Mountain; históricos diferenciados');
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
  const span=(R-L)/Math.max(1,labels.length),width=Math.min(46,span*.61);
  const tip=document.createElement('div');
  tip.className='im-shipped-tooltip';tip.hidden=true;
  const showTip=(item,cx,cy)=>{
    let label=item.label+': '+fmt(item.verified+item.historical)+' cajas identificadas';
    if(item.historical)label+=' ('+fmt(item.verified)+' registradas, '+fmt(item.historical)+' históricas)';
    if(item.unknown)label+='\n'+fmt(item.unknown)+' cargos históricos sin caja identificada. No se suman como cajas.';
    tip.textContent=label;
    tip.style.left=100*cx/W+'%';
    tip.style.top=100*cy/H+'%';
    tip.hidden=false;
  };
  visible.forEach(item=>{
    const {i,verified,historical,unknown}=item;
    const center=L+span*(i+.5),total=verified+historical;
    const top=y(total),verifiedTop=y(verified);
    const group=add(svg,'g',{tabindex:0,'aria-label':
      item.label+': '+fmt(total)+' cajas contabilizadas'+
      (unknown?'; '+fmt(unknown)+' cargos históricos con cajas sin identificar':'')});
    if(verified>0)add(group,'rect',{x:center-width/2,y:verifiedTop,width,
      height:B-verifiedTop,rx:historical>0?0:Math.min(5,width/5),
      fill:accent,'data-im-kind':'verified'});
    if(historical>0)add(group,'rect',{x:center-width/2,y:top,width,
      height:verifiedTop-top,rx:Math.min(5,width/5),
      fill:'#9561d8','data-im-kind':'historical'});
    // El signo ? no posee altura proporcional; nunca se incorpora a la suma de cajas.
    if(unknown>0){
      const markX=total>0?center+width/2+3:center-10;
      const markY=total>0?Math.min(B-22,Math.max(T+4,top+4)):B-22;
      add(group,'rect',{x:markX,y:markY,width:20,height:20,rx:5,
        fill:'#9561d8','data-im-kind':'unknown'});
      add(group,'text',{x:markX+10,y:markY+14,'text-anchor':'middle',
        'font-size':14,'font-weight':800,fill:'#fff'},'?');
    }
    add(group,'rect',{x:center-span*.44,y:T,width:span*.88,height:B-T,fill:'transparent'});
    add(group,'title',{},item.label+': '+fmt(total)+' cajas'+
      (unknown?'; '+fmt(unknown)+' cargos históricos, cajas sin cuantificar':''));
    if(total>0)add(group,'text',{x:center,y:Math.max(T-9,top-9),
      'text-anchor':'middle','font-size':11,'font-weight':800,fill:'#176b47'},fmt(total));
    const on=()=>showTip(item,center,Math.max(T+32,top));
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
