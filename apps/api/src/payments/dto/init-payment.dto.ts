import { IsUUID } from 'class-validator';

export class InitPaymentDto {
  @IsUUID()
  bookingId!: string;
}
