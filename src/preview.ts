import {timingSafeEqual} from "node:crypto";
import {hashToken} from "./security.js";
export type PreviewAccess={publicOrigin?:string;user?:string;passwordHash?:string;localOpen?:boolean};
export function previewAccess(settings:PreviewAccess){
 const remote=settings.publicOrigin?new URL(settings.publicOrigin):null;
 if(remote&&(remote.protocol!=='https:'||remote.username||remote.password||remote.pathname!=='/'))throw Error('Preview public origin must be a plain HTTPS origin');
 const localOpen=settings.localOpen===true&&!remote;
 if(!localOpen&&(!settings.user||!settings.passwordHash||!/^[a-f0-9]{64}$/.test(settings.passwordHash)))throw Error('Preview authentication is required');
 return {host:remote?.host,allowed(header:string|undefined){
  if(localOpen)return true;
  if(!header?.startsWith('Basic ')||header.length>1024)return false;
  const raw=Buffer.from(header.slice(6),'base64').toString('utf8');const at=raw.indexOf(':');
  if(at<1||raw.slice(0,at)!==settings.user)return false;
  return timingSafeEqual(Buffer.from(hashToken(raw.slice(at+1)),'hex'),Buffer.from(settings.passwordHash!,'hex'));
 }};
}
