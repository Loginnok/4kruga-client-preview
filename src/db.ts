import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
export function createDb(url = process.env.DATABASE_URL) {
  if (!url) throw new Error("DATABASE_URL must be configured");
  const parsed = new URL(url);
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) throw new Error("PostgreSQL URL required");
  return new PrismaClient({adapter:new PrismaPg({connectionString:url,max:6,connectionTimeoutMillis:5000,statement_timeout:10000})});
}
export type Db = ReturnType<typeof createDb>;
