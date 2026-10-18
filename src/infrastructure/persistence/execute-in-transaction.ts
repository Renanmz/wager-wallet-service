import {
  AnyEntity,
  EntityData,
  EntityManager,
  QueryResult,
} from '@mikro-orm/core';

type SqlExecutionResult =
  | QueryResult
  | EntityData<AnyEntity>
  | EntityData<AnyEntity>[];

export function executeInTransaction<
  T extends SqlExecutionResult = EntityData<AnyEntity>[],
>(
  entityManager: EntityManager,
  query: string,
  params: unknown[] = [],
): Promise<T> {
  const transactionContext = entityManager.getTransactionContext();
  if (!transactionContext) {
    throw new Error('executeInTransaction requires an active MikroORM transaction.');
  }

  return entityManager.getConnection().execute<T>(
    query,
    params,
    'all',
    transactionContext,
  );
}
