import { defineConfig } from "drizzle-kit"

export default defineConfig({
  schema: "./src/storage/schema.ts",
  out: "./drizzle",
  dialect: "sqlite",
  dbCredentials: { url: process.env.MIRA_DB ?? "./data/mira.db" },
})
