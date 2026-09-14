import { BadRequestException, Injectable } from '@nestjs/common';
import { Config, LLMClient } from 'coze-coding-dev-sdk';
import { getSupabaseClient } from '@/storage/database/supabase-client';
import { StorageService } from '@/storage/storage.service';

export interface WordItem {
  en: string;
  zh: string;
}

export interface CheckResult {
  correct: boolean;
  reference: string;
  pointsAwarded: number;
  totalPoints: number;
}

type VisionTextPart = { type: 'text'; text: string };
type VisionImagePart = { type: 'image_url'; image_url: { url: string; detail?: 'high' | 'low' } };
type LLMContent = string | Array<VisionTextPart | VisionImagePart>;
interface LLMMessage {
  role: 'system' | 'user' | 'assistant';
  content: LLMContent;
}

const POINTS_PER_CORRECT = 10;
const OCR_MODEL = 'doubao-seed-2-0-pro-260215';
const JUDGE_MODEL = 'doubao-seed-2-0-lite-260215';

const OCR_SYSTEM_PROMPT = `你是严谨的单词识别助手。请识别图片中的英文单词或短语及其常用中文释义。
要求：
1. 只提取适合做默写的英文单词/短语（名词、动词、形容词等具有明确含义的词汇）。
2. 忽略无关文字、装饰文字、题目标题等。
3. 中文释义要简洁准确，最常用义优先。
4. 去除重复项。
5. 最多返回 20 个。
只输出一个 JSON 数组，格式：[{"en":"英文","zh":"中文释义"}]。若没有可用单词，输出 []。不要输出任何其他内容。`;

function extractJsonArray(text: string): WordItem[] {
  const cleaned = text.replace(/```json/gi, '').replace(/```/g, '').trim();
  try {
    const parsed = JSON.parse(cleaned);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    const start = cleaned.indexOf('[');
    const end = cleaned.lastIndexOf(']');
    if (start >= 0 && end > start) {
      const sub = cleaned.slice(start, end + 1);
      try {
        return JSON.parse(sub);
      } catch {
        return [];
      }
    }
    return [];
  }
}

@Injectable()
export class DictationService {
  constructor(private readonly storageService: StorageService) {}

  private createClient(customHeaders: Record<string, string>) {
    return new LLMClient(new Config(), customHeaders);
  }

  async recognizeImage(file: Express.Multer.File, customHeaders: Record<string, string>): Promise<{
    imageUrl: string;
    words: WordItem[];
  }> {
    const { url } = await this.storageService.uploadImage(file.buffer, file.originalname, file.mimetype);

    const client = this.createClient(customHeaders);
    const messages: LLMMessage[] = [
      { role: 'system', content: OCR_SYSTEM_PROMPT },
      {
        role: 'user',
        content: [
          { type: 'text', text: '请识别这张图片中的英文学习单词并返回 JSON 数组。' },
          { type: 'image_url', image_url: { url, detail: 'high' } },
        ],
      },
    ];

    const resp = await client.invoke(messages, { model: OCR_MODEL, temperature: 0.2 });
    const raw = resp.content || '[]';
    const words = extractJsonArray(raw)
      .map((w) => ({
        en: String(w?.en ?? '').trim(),
        zh: String(w?.zh ?? '').trim(),
      }))
      .filter((w) => w.en && w.zh);

    if (words.length === 0) {
      throw new BadRequestException('未能从图片中识别出有效单词，请更换更清晰的图片');
    }

    console.log('[dictation] recognized words:', words.length);
    return { imageUrl: url, words };
  }

  async getPoints(deviceId: string): Promise<{ totalPoints: number; correctCount: number; totalCount: number }> {
    if (!deviceId) {
      throw new BadRequestException('缺少设备标识 deviceId');
    }
    const client = getSupabaseClient();
    const { data } = await client
      .from('study_users')
      .select('total_points, correct_count, total_count')
      .eq('device_id', deviceId)
      .maybeSingle();

    return {
      totalPoints: data?.total_points ?? 0,
      correctCount: data?.correct_count ?? 0,
      totalCount: data?.total_count ?? 0,
    };
  }

  async checkAnswer(
    body: { deviceId: string; mode: 'zh2en' | 'en2zh'; en: string; zh: string; answer: string },
    customHeaders: Record<string, string>,
  ): Promise<CheckResult> {
    const { deviceId, mode, en, zh } = body;
    const answer = String(body.answer ?? '').trim();

    if (!deviceId) throw new BadRequestException('缺少设备标识 deviceId');
    if (!['zh2en', 'en2zh'].includes(mode)) throw new BadRequestException('mode 仅支持 zh2en 或 en2zh');
    if (!en || !zh) throw new BadRequestException('单词数据缺失');
    if (!answer) throw new BadRequestException('请填写答案');

    const reference = mode === 'zh2en' ? en : zh;
    const prompt =
      mode === 'zh2en'
        ? `题目要求：根据中文释义写出生对应的英文单词。\n题目：${zh}\n标准答案：${en}\n用户作答：${answer}\n判断用户作答是否可接受：可以是标准答案本身，也可以是意思正确、拼写合理的同义英文单词/短语。错误拼写或意思不符则不可接受。`
        : `题目要求：根据英文单词写出其中文意思。\n题目：${en}\n标准答案：${zh}\n用户作答：${answer}\n判断用户作答是否可接受：可以是标准答案本身，也可以是意思正确、表述合理的同义中文表达。意思不符则不可接受。`;

    const client = this.createClient(customHeaders);
    const messages: LLMMessage[] = [
      {
        role: 'user',
        content: `${prompt}\n只输出一个 JSON 对象：{"correct": true 或 false}，不要输出其他内容。`,
      },
    ];
    const resp = await client.invoke(messages, { model: JUDGE_MODEL, temperature: 0.1 });
    const text = (resp.content || '').replace(/```json/gi, '').replace(/```/g, '').trim();
    let correct = false;
    try {
      const matched = text.match(/"correct"\s*:\s*(true|false)/i);
      correct = matched ? matched[1].toLowerCase() === 'true' : text.includes('"correct": true');
    } catch {
      correct = false;
    }

    let totalPoints = 0;
    try {
      totalPoints = await this.awardResult(deviceId, correct);
    } catch (e) {
      console.error('[dictation] award points failed:', (e as Error).message);
    }

    return {
      correct,
      reference,
      pointsAwarded: correct ? POINTS_PER_CORRECT : 0,
      totalPoints,
    };
  }

  private async awardResult(deviceId: string, correct: boolean): Promise<number> {
    const client = getSupabaseClient();
    const now = new Date().toISOString();

    const { data: existing } = await client
      .from('study_users')
      .select('id, total_points, total_count, correct_count')
      .eq('device_id', deviceId)
      .maybeSingle();

    if (existing) {
      const patches: Record<string, number | string> = {
        total_count: (existing.total_count ?? 0) + 1,
        updated_at: now,
      };
      if (correct) {
        patches.total_points = (existing.total_points ?? 0) + POINTS_PER_CORRECT;
        patches.correct_count = (existing.correct_count ?? 0) + 1;
      }
      // correct_count maintained but not critical for display
      const { data, error } = await client
        .from('study_users')
        .update(patches)
        .eq('device_id', deviceId)
        .select('total_points')
        .single();
      if (error) throw new Error(error.message);
      return data?.total_points ?? 0;
    }

    const insertCount = correct ? POINTS_PER_CORRECT : 0;
    const { data, error } = await client
      .from('study_users')
      .insert({
        device_id: deviceId,
        total_points: insertCount,
        correct_count: correct ? 1 : 0,
        total_count: 1,
      })
      .select('total_points')
      .single();
    if (error) throw new Error(error.message);
    return data?.total_points ?? 0;
  }
}