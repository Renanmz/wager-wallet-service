import { Type } from 'class-transformer';
import {
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Matches,
  ValidateNested,
} from 'class-validator';
import { WagerTransactionKind } from '../domain/wager-transaction.ts';

export class MoneyDto {
  @IsString()
  @Matches(/^\d+(?:\.\d{1,2})?$/)
  amount!: string;

  @IsString()
  @Matches(/^[A-Z]{3}$/)
  currency!: string;
}

export class CreateWalletDto {
  @IsUUID()
  playerId!: string;

  @ValidateNested()
  @Type(() => MoneyDto)
  initialBalance!: MoneyDto;
}

export class SubmitWagerTransactionDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  providerId!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  externalTransactionId!: string;

  @IsUUID()
  playerId!: string;

  @IsUUID()
  walletId!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  roundId!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  gameId!: string;

  @IsEnum({
    BET: WagerTransactionKind.Bet,
    WIN: WagerTransactionKind.Win,
    LOSS: WagerTransactionKind.Loss,
    REFUND: WagerTransactionKind.Refund,
    ROLLBACK: WagerTransactionKind.Rollback,
  })
  kind!: Exclude<WagerTransactionKind, WagerTransactionKind.Opening>;

  @ValidateNested()
  @Type(() => MoneyDto)
  money!: MoneyDto;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  referenceExternalTransactionId?: string;
}
