const demoIm=typeof window!=='undefined' && /-ztmy1\.vercel\.app$/i.test(window.location.hostname) &&
  new URLSearchParams(window.location.search).get('demoIm')==='1';
if(demoIm){import('./connection.css');import('./requirements-im-demo.js');}
else if(__PICKUP_PREVIEW__)import('./pickup-preview.js');
else import('./app.js');
