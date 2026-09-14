import { BadRequestException, Injectable } from '@nestjs/common';
import { S3Storage } from 'coze-coding-dev-sdk';

@Injectable()
export class StorageService {
  private readonly storage: S3Storage;

  constructor() {
    this.storage = new S3Storage({
      endpointUrl: process.env.COZE_BUCKET_ENDPOINT_URL,
      accessKey: '',
      secretKey: '',
      bucketName: process.env.COZE_BUCKET_NAME,
      region: 'cn-beijing',
    });
  }

  private sanitizeFilename(name: string): string {
    const ext = (name.split('.').pop() || 'jpg')
      .replace(/[^a-zA-Z0-9]/g, '')
      .slice(0, 5) || 'jpg';
    return `img_${Date.now()}.${ext}`;
  }

  async uploadImage(buffer: Buffer, originalname: string, contentType?: string): Promise<{ key: string; url: string }> {
    if (!buffer || buffer.length === 0) {
      throw new BadRequestException('无法读取图片内容');
    }
    const key = await this.storage.uploadFile({
      fileContent: buffer,
      fileName: `dictation/${this.sanitizeFilename(originalname)}`,
      contentType: contentType || 'image/jpeg',
    });
    const url = await this.storage.generatePresignedUrl({ key, expireTime: 3600 });
    return { key, url };
  }
}