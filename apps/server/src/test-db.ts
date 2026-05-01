import { sql } from "drizzle-orm";

import { db } from "./db";

async function main() {
  const res = await db.execute(sql`SELECT 1`);
  console.log(res);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
