import 'reflect-metadata';
import { MikroORM } from '@mikro-orm/postgresql';
import config from '../mikro-orm.config.ts';

const orm = await MikroORM.init(config);
try {
  await orm.getMigrator().down();
} finally {
  await orm.close(true);
}
