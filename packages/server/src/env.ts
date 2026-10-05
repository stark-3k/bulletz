export const env = {
  port: Number(process.env.PORT ?? 4000),
  databaseUrl:
    process.env.DATABASE_URL ?? "postgres://bulletz:bulletz@localhost:5433/bulletz",
  logLevel: process.env.LOG_LEVEL ?? "info",
};
