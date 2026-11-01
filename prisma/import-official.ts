import catalog from "./official-catalog.json" with {type:"json"};
import {createDb,type Db} from "../src/db.js";
export async function importOfficial(db:Db){
 const modelId=(brand:string,model:string)=>'source-'+brand.toLowerCase()+'-'+Buffer.from(model).toString('hex');
 await db.$transaction(async tx=>{
  for(const [index,c] of catalog.categories.entries())await tx.category.upsert({where:{id:c[0]!},create:{id:c[0]!,name:c[1]!,sortOrder:index},update:{}});
  for(const p of catalog.products){
   const brandId=p.brand.toLowerCase();
   await tx.brand.upsert({where:{id:brandId},create:{id:brandId,name:p.brand},update:{}});
   for(const model of p.models)await tx.scooterModel.upsert({where:{brandId_name:{brandId,name:model}},create:{id:modelId(p.brand,model),brandId,name:model},update:{}});
   const fields={slug:p.slug,sku:p.sku,name:p.name,categoryId:p.category,brandId,priceCents:p.priceCents,stock:0,description:p.description,specs:p.specs,images:p.images,testData:false,sourceUrl:p.sourceUrl,sourceSku:p.sourceSku||null,sourceAvailability:p.sourceAvailability,sourceRetrievedAt:new Date(p.retrievedAt)};
   await tx.product.upsert({where:{id:p.id},create:{id:p.id,...fields},update:fields});
   await tx.compatibility.deleteMany({where:{productId:p.id}});
   for(const model of p.models){const value=await tx.scooterModel.findUniqueOrThrow({where:{brandId_name:{brandId,name:model}}});await tx.compatibility.create({data:{productId:p.id,modelId:value.id}});}
  }
 },{timeout:30000});
 return {products:catalog.products.length,images:catalog.images.length};
}
if(process.argv[1]?.endsWith('import-official.ts')){const db=createDb();importOfficial(db).then(result=>console.log(JSON.stringify(result))).finally(()=>db.$disconnect());}
