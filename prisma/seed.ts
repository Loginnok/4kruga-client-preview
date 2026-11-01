import fixtures from "./fixtures.json" with {type:"json"};
import { createDb } from "../src/db.js";
import { z } from "zod";
export async function seed(db=createDb()) {
 if(await db.product.count())return;
 const brandModels:Record<string,string[]>={Kugoo:["M4","M4 Pro","G2 Pro"],Xiaomi:["M365","Pro 2"],Ninebot:["F20","F30","F40","Max G2","Max G30"],Dualtron:["Mini","Thunder"]};
 const modelId=(brand:string,model:string)=>brand.toLowerCase()+"-"+model.toLowerCase().replace(/[^a-z0-9]+/g,"-");
 await db.$transaction(async tx=>{
  for(const [i,c] of fixtures.categories.entries())await tx.category.upsert({where:{id:c[0]!},create:{id:c[0]!,name:c[1]!,sortOrder:i},update:{}});
  for(const [brand,models] of Object.entries(brandModels)){
   await tx.brand.upsert({where:{id:brand.toLowerCase()},create:{id:brand.toLowerCase(),name:brand},update:{}});
   for(const model of models)await tx.scooterModel.upsert({where:{id:modelId(brand,model)},create:{id:modelId(brand,model),name:model,brandId:brand.toLowerCase()},update:{}});
  }
  for(const p of fixtures.products)await tx.product.create({data:{id:p.id,slug:p.id,sku:p.sku,name:p.name,categoryId:p.category,brandId:p.brand.toLowerCase(),priceCents:p.price,stock:p.stock,description:p.description,specs:z.record(z.string(),z.string()).parse(p.specs),images:p.images,testData:true,compatibility:{create:p.models.map(model=>({modelId:modelId(p.brand,model)}))}}});
 },{timeout:20000});
}
if(process.argv[1]?.endsWith('seed.ts')){const db=createDb();seed(db).then(async()=>console.log('Каталог в PostgreSQL:',await db.product.count(),'товаров; существующие данные не перезаписаны.')).finally(()=>db.$disconnect());}
