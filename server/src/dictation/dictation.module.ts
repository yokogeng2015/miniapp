import { Module } from '@nestjs/common';
import { StorageService } from '@/storage/storage.service';
import { DictationController } from './dictation.controller';
import { DictationService } from './dictation.service';

@Module({
  controllers: [DictationController],
  providers: [DictationService, StorageService],
})
export class DictationModule {}