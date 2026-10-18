import { Options } from '@mikro-orm/core';
import { PostgreSqlDriver } from '@mikro-orm/postgresql';
import { WalletEntity } from './src/infrastructure/persistence/wallet.entity.ts';
import { Migration20261017000000 } from './migrations/Migration20261017000000.ts';

const config: Options<PostgreSqlDriver> = {
  driver: PostgreSqlDriver,
  entities: [WalletEntity],
  dbName: process.env.DB_NAME ?? 'wager_wallet',
  user: process.env.DB_USER ?? 'postgres',
  password: process.env.DB_PASSWORD ?? 'postgres',
  host: process.env.DB_HOST ?? 'localhost',
  port: Number(process.env.DB_PORT ?? 5432),
  migrations: {
    migrationsList: [{ name: 'Migration20261017000000', class: Migration20261017000000 }],
    transactional: true,
    allOrNothing: true,
  },
  debug: process.env.NODE_ENV === 'development',
};

export default config;
