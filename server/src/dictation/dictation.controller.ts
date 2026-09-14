import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Query,
  Req,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { HeaderUtils } from 'coze-coding-dev-sdk';
import { Request } from 'express';
import { DictationService } from './dictation.service';

interface CheckBody {
  deviceId: string;
  mode: 'zh2en' | 'en2zh';
  en: string;
  zh: string;
  answer: string;
}

@Controller('dictation')
export class DictationController {
  constructor(private readonly dictationService: DictationService) {}

  @Post('recognize')
  @HttpCode(200)
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: { fileSize: 5 * 1024 * 1024 },
    }),
  )
  async recognize(@UploadedFile() file: Express.Multer.File, @Req() req: Request) {
    if (!file || !file.buffer) {
      throw new BadRequestException('请上传图片文件');
    }
    const customHeaders = HeaderUtils.extractForwardHeaders(
      req.headers as unknown as Record<string, string>,
    );
    const result = await this.dictationService.recognizeImage(file, customHeaders);
    return { status: 'success', data: result };
  }

  @Get('points')
  @HttpCode(200)
  async points(@Query('deviceId') deviceId: string) {
    const data = await this.dictationService.getPoints(deviceId);
    return { status: 'success', data };
  }

  @Post('check')
  @HttpCode(200)
  async check(@Body() body: CheckBody, @Req() req: Request) {
    const customHeaders = HeaderUtils.extractForwardHeaders(
      req.headers as unknown as Record<string, string>,
    );
    const data = await this.dictationService.checkAnswer(body, customHeaders);
    return { status: 'success', data };
  }
}