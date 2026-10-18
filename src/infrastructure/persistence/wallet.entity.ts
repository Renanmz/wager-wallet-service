import { Entity, PrimaryKey, Property } from '@mikro-orm/core';

@Entity({ tableName: 'wallets' })
export class WalletEntity {
  @PrimaryKey({ type: 'uuid' })
  id!: string;

  @Property({ fieldName: 'player_id', type: 'uuid' })
  playerId!: string;

  @Property({ type: 'char', length: 3 })
  currency!: string;

  @Property({ type: 'numeric', precision: 20, scale: 2 })
  balance!: string;

  @Property({ type: 'integer' })
  version!: number;

  @Property({ fieldName: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @Property({ fieldName: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
