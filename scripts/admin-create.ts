import "dotenv/config";
import { mkdir,writeFile } from "node:fs/promises";
import { createDb } from "../src/db.js";
import { hashPassword,token } from "../src/security.js";
import { z } from "zod";
const db=createDb();
try {
 const email=z.email().parse(process.env.ADMIN_EMAIL||"admin@localhost.test").toLowerCase();
 if(await db.admin.findUnique({where:{email}})){console.log("Существующий администратор сохранён без смены пароля.");}
 else {
  const password=process.env.ADMIN_PASSWORD||token();if(password.length<16)throw new Error("Use at least 16 password characters");
  await db.admin.create({data:{email,passwordHash:await hashPassword(password)}});
  if(!process.env.ADMIN_PASSWORD){await mkdir('.state',{recursive:true});await writeFile('.state/admin-password.txt',password+'\n',{mode:0o600,flag:'wx'});}
  console.log("Администратор создан. Локальный начальный пароль: .state/admin-password.txt (не публиковать).");
 }
}finally {await db.$disconnect();}
