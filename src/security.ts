import { randomBytes, createHash, scrypt as rawScrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
const scrypt = promisify(rawScrypt);
export const token = () => randomBytes(32).toString("hex");
export const hashToken = (value:string) => createHash("sha256").update(value).digest("hex");
export async function hashPassword(value:string) {
  const salt=randomBytes(16).toString("hex");
  const derived=await scrypt(value,salt,64) as Buffer;
  return `scrypt$${salt}$${derived.toString("hex")}`;
}
export async function verifyPassword(value:string,stored:string) {
  const [algorithm,salt,expected]=stored.split("$");
  if(algorithm!=="scrypt" || !salt || !expected || !/^[0-9a-f]{128}$/.test(expected))return false;
  const actual=await scrypt(value,salt,64) as Buffer;
  return timingSafeEqual(actual,Buffer.from(expected,"hex"));
}
export class Limiter {
  private entries=new Map<string,{count:number;expires:number}>();
  take(key:string,max:number,windowMs:number) {
    const now=Date.now();
    for(const [k,v] of this.entries)if(v.expires<=now)this.entries.delete(k);
    let entry=this.entries.get(key);
    if(!entry){if(this.entries.size>=10000)return false;entry={count:0,expires:now+windowMs};this.entries.set(key,entry);}
    return ++entry.count<=max;
  }
}
