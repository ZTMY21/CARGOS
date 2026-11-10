// Browser-based decoding keeps video frames on the device.
export async function scanConditioningBox(video,signal,onCode){
  if(!navigator.mediaDevices?.getUserMedia)throw Error('Cámara no disponible');
  const stream=await navigator.mediaDevices.getUserMedia({
    audio:false,video:{facingMode:{ideal:'environment'},width:{ideal:1280},height:{ideal:720}}
  });
  let controls;
  const stop=()=>{
    controls?.stop();
    for(const track of stream.getTracks())track.stop();
    if(video.srcObject===stream)video.srcObject=null;
  };
  signal.addEventListener('abort',stop,{once:true});
  try{
    signal.throwIfAborted();
    const {BrowserMultiFormatReader}=await import('@zxing/browser');
    signal.throwIfAborted();
    video.muted=true;
    controls=await new BrowserMultiFormatReader(undefined,{delayBetweenScanAttempts:180})
      .decodeFromStream(stream,video,result=>{
        if(result&&!signal.aborted)onCode(result.getText());
      });
    signal.throwIfAborted();
  }catch(error){
    stop();
    signal.removeEventListener('abort',stop);
    throw error;
  }
}
