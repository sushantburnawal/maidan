import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { PAYMENT_GATEWAY, PAYMENTS_REPOSITORY } from './payments.constants';
import {
  FakePaymentGateway,
  PhonePeGateway,
  shouldUsePhonePeGateway
} from './payment-gateway';
import { PaymentsController } from './payments.controller';
import { PostgresPaymentsRepository } from './payments.repository';
import { PaymentsService } from './payments.service';

@Module({
  imports: [AuthModule],
  controllers: [PaymentsController],
  providers: [
    PaymentsService,
    {
      provide: PAYMENTS_REPOSITORY,
      useClass: PostgresPaymentsRepository
    },
    {
      provide: PAYMENT_GATEWAY,
      useFactory: () => (shouldUsePhonePeGateway() ? new PhonePeGateway() : new FakePaymentGateway())
    }
  ],
  exports: [PaymentsService]
})
export class PaymentsModule {}
