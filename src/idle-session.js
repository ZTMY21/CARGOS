export const IDLE_LIMIT = 60 * 60 * 1000;

// Share activity between tabs and retain the deadline across reloads/browser suspension.
export function createIdleSession({window, onExpire, now=()=>Date.now(), limit=IDLE_LIMIT}) {
  let key=null, last=0, timer=null, lastWrite=0;
  const read=()=>{try{return Number(window.localStorage.getItem(key))||0;}catch{return 0;}};
  const write=()=>{try{window.localStorage.setItem(key,String(last));}catch{/* Private browsing fallback. */}};
  function stop(){window.clearTimeout(timer);timer=null;key=null;}
  function check(){
    if(!key)return false;
    last=Math.max(last,read());
    const remaining=limit-(now()-last);
    if(remaining<=0){stop();void onExpire();return false;}
    window.clearTimeout(timer);timer=window.setTimeout(check,remaining);return true;
  }
  function activity(){
    if(!check())return;
    last=now();
    if(last-lastWrite>=1000){write();lastWrite=last;}
    check();
  }
  function start(session){
    let sessionId='';
    try{
      const payload=session.access_token.split('.')[1].replace(/-/g,'+').replace(/_/g,'/');
      sessionId=JSON.parse(window.atob(payload)).session_id||'';
    }catch{/* Legacy sessions still use the user-specific inactivity deadline. */}
    const nextKey=`kardex-idle:${session.user.id}:${sessionId}`;
    if(key!==nextKey){stop();key=nextKey;last=read()||now();write();lastWrite=last;}
    return check();
  }
  const events=['pointerdown','pointermove','keydown','wheel','touchstart'];
  for(const event of events)window.addEventListener(event,activity,{passive:true});
  const visible=()=>{if(!window.document.hidden)check();};
  const storage=event=>{if(event.key===key)check();};
  window.document.addEventListener('visibilitychange',visible);
  window.addEventListener('focus',check);
  window.addEventListener('storage',storage);
  return {start,stop,check,destroy(){
    stop();for(const event of events)window.removeEventListener(event,activity);
    window.document.removeEventListener('visibilitychange',visible);
    window.removeEventListener('focus',check);window.removeEventListener('storage',storage);
  }};
}
