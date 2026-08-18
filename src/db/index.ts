import postgres from 'postgres'
import { config } from '../config/index.js'
import { log } from '../logger/index.js'
import { migrations } from './migrations.js'

const logger = log('db')

export const sql = postgres({
  host: config.PGHOST,
  port: config.PGPORT,
  user: config.PGUSER,
  password: config.PGPASSWORD,
  database: config.PGDATABASE,
  max: 10,
  onnotice: () => {},
})

export type Sql = typeof sql

export async function migrate(): Promise<void> {
  await sql`
    create table if not exists schema_migrations (
      name       text primary key,
      applied_at timestamptz not null default now()
    )
  `
  const applied = await sql<{ name: string }[]>`select name from schema_migrations`
  const done = new Set(applied.map((r) => r.name))

  for (const m of migrations) {
    if (done.has(m.name)) continue
    logger.info({ migration: m.name }, 'применяю миграцию')
    await sql.begin(async (tx) => {
      await tx.unsafe(m.sql)
      await tx`insert into schema_migrations ${tx({ name: m.name })}`
    })
  }
  logger.info({ count: migrations.length }, 'миграции в актуальном состоянии')
}

export async function closeDb(): Promise<void> {
  await sql.end({ timeout: 5 })
}
