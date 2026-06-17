import { Allow, IsInt, IsUUID, Min } from 'class-validator';

export class CreateBookingDto {
  @IsUUID()
  slotId!: string;

  @IsInt()
  @Min(1)
  headcount!: number;

  @Allow()
  amount?: unknown;

  @Allow()
  amountInr?: unknown;

  @Allow()
  amount_inr?: unknown;
}
