import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { SutradharController } from './sutradhar.controller';
import { SutradharService } from './sutradhar.service';

@Module({
  imports: [AuthModule],
  controllers: [SutradharController],
  providers: [SutradharService]
})
export class SutradharModule {}
