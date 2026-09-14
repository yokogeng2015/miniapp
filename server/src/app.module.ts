import { Module } from '@nestjs/common';
import { AppController } from '@/app.controller';
import { AppService } from '@/app.service';
import { DictationModule } from '@/dictation/dictation.module';

@Module({
  imports: [DictationModule],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
