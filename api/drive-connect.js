import {randomBytes,randomUUID,timingSafeEqual,createHash} from 'node:crypto';
import {ArchiveError,seal,unseal,sha256} from '../server/archive/security.js';
import {runtime} from '../server/archive/runtime.js';
import {DriveClient} from '../server/archive/drive-client.js';
export const config={maxDuration:60};
const cookieName='kardex_drive_connect';
const output=(res,status,data)=>{res.statusCode=status;res.setHeader('Content-Type','application/json; charset=utf-8');res.end(JSON.stringify(data));};
function redirectUri(env){
 const u=new URL(env.GOOGLE_DRIVE_REDIRECT_URI||'https://unconfigured.invalid');
 const host=u.hostname==='kardex-digital-santa-anita.vercel.app'||(u.hostname.startsWith('kardex-digital-santa-anita-')&&u.hostname.endsWith('-ztmy1.vercel.app'));
 if(!host||u.protocol!=='https:'||u.pathname!=='/api/drive-connect'||u.search||u.hash||u.username||u.password)throw new ArchiveError('OAUTH_REDIRECT_NOT_CONFIGURED',503);return u;
}
function connectEnabled(env){return env.KARDEX_DRIVE_CONNECT_ENABLED==='true'&&(env.VERCEL_ENV!=='production'||env.KARDEX_DRIVE_RELEASE_APPROVED==='true');}
export function createConnectHandler({env=process.env,fetcher=fetch}={}){return async(req,res)=>{
 res.setHeader('Cache-Control','private, no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');
 const clearCookie=()=>res.setHeader('Set-Cookie',`${cookieName}=; Path=/api/drive-connect; HttpOnly; Secure; SameSite=Lax; Max-Age=0`);
 try{
  if(req.method!=='GET')throw new ArchiveError('METHOD_NOT_ALLOWED',405);
  const action=req.query?.code||req.query?.error?'callback':req.query?.action||'status';
  const configured=Boolean(env.GOOGLE_DRIVE_CLIENT_ID&&env.GOOGLE_DRIVE_CLIENT_SECRET&&env.KARDEX_DRIVE_METADATA_KEY&&env.KARDEX_DRIVE_SESSION_KEY&&env.GOOGLE_DRIVE_REDIRECT_URI);
  if(action==='status'){
   let connected=false,gatewayReady=false;
   if(env.KARDEX_DRIVE_METADATA_KEY){const state=await runtime(env,'get-oauth',null,null,fetcher);gatewayReady=true;connected=Boolean(state?.cipher);}
   return output(res,200,{configured,connectEnabled:connectEnabled(env),gatewayReady,connected,clientSecretConfigured:Boolean(env.GOOGLE_DRIVE_CLIENT_SECRET),redirectConfigured:Boolean(env.GOOGLE_DRIVE_REDIRECT_URI),connectUrl:configured?redirectUri(env).href+'?action=start':null});
  }
  if(!connectEnabled(env))throw new ArchiveError('OAUTH_CONNECTION_NOT_ENABLED',503);
  if(!configured)throw new ArchiveError('OAUTH_CLIENT_CONFIGURATION_PENDING',503);
  const uri=redirectUri(env);
  if(req.headers.host!==uri.host){if(action!=='start')throw new ArchiveError('OAUTH_ORIGIN_MISMATCH',400);res.statusCode=303;res.setHeader('Location',uri.href+'?action=start');return res.end();}
  if(action==='start'){
   const id=randomUUID(),cookie=randomBytes(32).toString('base64url'),verifier=randomBytes(32).toString('base64url');
   await runtime(env,'create-session',{cookieHash:sha256(cookie),verifierCipher:seal(verifier,env.KARDEX_DRIVE_SESSION_KEY)},id,fetcher);
   res.setHeader('Set-Cookie',`${cookieName}=${cookie}; Path=/api/drive-connect; HttpOnly; Secure; SameSite=Lax; Max-Age=600`);
   const url=new URL('https://accounts.google.com/o/oauth2/v2/auth');
   url.search=new URLSearchParams({client_id:env.GOOGLE_DRIVE_CLIENT_ID,redirect_uri:uri.href,response_type:'code',scope:'https://www.googleapis.com/auth/drive',access_type:'offline',prompt:'consent select_account',login_hint:env.GOOGLE_DRIVE_OWNER_EMAIL,state:id,code_challenge:createHash('sha256').update(verifier).digest('base64url'),code_challenge_method:'S256'}).toString();
   res.statusCode=303;res.setHeader('Location',url.href);return res.end();
  }
  if(action!=='callback')throw new ArchiveError('INVALID_ACTION');
  const id=req.query?.state;if(typeof id!=='string'||!/^[-a-f0-9]{36}$/i.test(id))throw new ArchiveError('OAUTH_STATE_INVALID',400);
  const state=await runtime(env,'consume-session',null,id,fetcher),cookie=(req.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith(cookieName+'='))?.slice(cookieName.length+1)||'';
  clearCookie();if(!state||!cookie||!/^[-a-f0-9]{64}$/.test(state.cookieHash||'')||!timingSafeEqual(Buffer.from(sha256(cookie),'hex'),Buffer.from(state.cookieHash,'hex')))throw new ArchiveError('OAUTH_STATE_EXPIRED_OR_INVALID',400);
  if(req.query.error)throw new ArchiveError('GOOGLE_AUTHORIZATION_DECLINED',400);
  const code=req.query.code;if(typeof code!=='string'||code.length>4096)throw new ArchiveError('OAUTH_CODE_INVALID',400);
  const r=await fetcher('https://oauth2.googleapis.com/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:env.GOOGLE_DRIVE_CLIENT_ID,client_secret:env.GOOGLE_DRIVE_CLIENT_SECRET,code,redirect_uri:uri.href,grant_type:'authorization_code',code_verifier:unseal(state.verifierCipher,env.KARDEX_DRIVE_SESSION_KEY)}),signal:AbortSignal.timeout(20000),redirect:'error'});
  if(!r.ok)throw new ArchiveError('GOOGLE_CODE_EXCHANGE_FAILED',503);const tokens=await r.json();if(!tokens.access_token||!tokens.refresh_token)throw new ArchiveError('GOOGLE_OFFLINE_CONSENT_REQUIRED',409);
  const drive=new DriveClient(env,{fetcher});drive.cached={token:tokens.access_token,until:Date.now()+300000};
  const account=await(await drive.request('https://www.googleapis.com/drive/v3/about?fields=user(emailAddress)')).json();
  if(account.user?.emailAddress?.toLowerCase()!==env.GOOGLE_DRIVE_OWNER_EMAIL?.toLowerCase())throw new ArchiveError('GOOGLE_ACCOUNT_NOT_APPROVED',403);
  await drive.checkRoot();for(const category of ['scans','originals','backups','history','manifests'])await drive.folder(category);
  // Credentials are encrypted before persistence; no token is returned to a browser.
  await runtime(env,'set-oauth',{cipher:seal(JSON.stringify({refreshToken:tokens.refresh_token,clientId:env.GOOGLE_DRIVE_CLIENT_ID,ownerEmail:account.user.emailAddress,connectedAt:new Date().toISOString()}),env.KARDEX_DRIVE_SESSION_KEY)},null,fetcher);
  res.statusCode=303;res.setHeader('Location','/drive-archive.html?drive_connected=1');return res.end();
 }catch(error){clearCookie();return output(res,error instanceof ArchiveError?error.status:503,{error:error instanceof ArchiveError?error.code:'OAUTH_CONNECTION_FAILED'});}
};}
export default createConnectHandler();
