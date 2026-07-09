const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');

const migrationsDir = process.env.MIGRATIONS_DIR ?? '/app/db/migrations';
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.POSTGRES_SSL === 'true' ? { rejectUnauthorized: false } : undefined
});

async function main() {
  await pool.query(`
    create table if not exists schema_migrations (
      filename text primary key,
      applied_at timestamptz not null default now()
    )
  `);

  const appliedResult = await pool.query('select filename from schema_migrations');
  const applied = new Set(appliedResult.rows.map((row) => row.filename));
  const files = fs
    .readdirSync(migrationsDir)
    .filter((filename) => filename.endsWith('.sql'))
    .sort();

  for (const filename of files) {
    if (applied.has(filename)) {
      console.log(`Skipping ${filename}`);
      continue;
    }

    const sql = fs.readFileSync(path.join(migrationsDir, filename), 'utf8');
    const client = await pool.connect();

    try {
      console.log(`Applying ${filename}`);
      await client.query('begin');
      await client.query(sql);
      await client.query('insert into schema_migrations (filename) values ($1)', [filename]);
      await client.query('commit');
    } catch (error) {
      await client.query('rollback').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  console.log('Migrations complete');
}

main()
  .catch((error) => {
    console.error(error.stack ?? error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end().catch(() => undefined);
  });
