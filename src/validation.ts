import { z } from "zod";
z.config(z.locales.ru());
export const keySchema=z.string().regex(/^[a-zA-Z0-9-]{16,100}$/);
const text=(max:number)=>z.string().trim().max(max);
const optionalEmail=z.union([z.email().max(180),z.literal("")]).default("");
const contact={name:text(100).min(2,"Введите имя"),phone:text(40).refine(v=>{const n=v.replace(/\D/g,"").length;return n>=10&&n<=15},"Введите номер из 10–15 цифр"),email:optionalEmail,consent:z.literal(true,{error:"Необходимо согласие на обработку данных"}),idempotency_key:keySchema};
export const checkoutSchema=z.object({...contact,delivery:z.enum(["pickup","delivery"]),address:text(500).default(""),comment:text(1000).default("")}).superRefine((v,c)=>{if(v.delivery==="delivery"&&v.address.length<10)c.addIssue({code:"custom",path:["address"],message:"Укажите полный адрес доставки"});});
export const repairSchema=z.object({...contact,brand:text(60).min(1,"Укажите бренд"),model:text(100).min(1,"Укажите модель"),description:text(2000).min(10,"Опишите неисправность (не менее 10 символов)")});
export const quantitySchema=z.number().int().min(1).max(99);
export const cartAddSchema=z.object({product_id:text(100).min(1),quantity:quantitySchema.default(1)});
export const loginSchema=z.object({email:z.email().max(180).transform(v=>v.toLowerCase()),password:z.string().min(1).max(256)}).strict();
export const productSchema=z.object({slug:z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(100),sku:text(80).min(1),name:text(200).min(3),categoryId:text(100).min(1),brandId:text(100).min(1),modelIds:z.array(text(100)).min(1).max(30),price:z.string().regex(/^\d{1,6}(?:[.,]\d{1,2})?$/,"Укажите цену с точностью до копеек"),stock:z.number().int().min(0).max(100000),description:text(10000).min(10),specs:z.record(text(100),text(500)).default({}),images:z.array(z.string().regex(/^\/[a-z0-9/_-]+\.(?:png|jpg|jpeg|webp|svg)$/i)).min(1).max(8).default(["/placeholder.svg","/placeholder-detail.svg"])}).strict();
export function cents(value:string){const [whole,part=""]=value.replace(",",".").split(".");return Number(whole)*100+Number(part.padEnd(2,"0"));}
export const orderStatusSchema=z.object({status:z.enum(["NEW","PROCESSING","READY","COMPLETED","CANCELLED"])}).strict();
