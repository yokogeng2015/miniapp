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

const OCR_SYSTEM_PROMPT = `你是专注的单词识别助手。图片可能是中英文混排或纯英文内容，通常为英文单词及其中文释义。请从中提取【英文单词或短语】及其最常用的【中文释义】。
要求：
1. 只提取适合默写的英文词汇（名词、动词、形容词、短语等，具有明确含义）。
2. 忽略页码、标题、题号、装饰文字和无关注释。
3. 每项 en 为该英文单词（小写），zh 为一句简洁准确的中文释义。
4. 去除重复项。
5. 最多返回 20 项。
只输出一个 JSON 数组，格式：[{"en":"单词","zh":"释义"}]。若没有可用单词，输出 []。禁止输出 JSON 之外的任何字符或解释。`;

function normalizeWords(p: unknown): WordItem[] {
  const arr = Array.isArray(p)
    ? p
    : p && typeof p === 'object' && Array.isArray((p as { words?: unknown }).words)
    ? (p as { words: unknown[] }).words
    : null;
  if (!arr) return [];
  return arr
    .map((w) => {
      const o = (w ?? {}) as Record<string, unknown>;
      return {
        en: String(o.en ?? o.word ?? '').trim(),
        zh: String(o.zh ?? o.meaning ?? '').trim(),
      };
    })
    .filter((w) => w.en && w.zh);
}

function extractJsonArray(text: unknown): WordItem[] {
  const s = (typeof text === 'string' ? text : JSON.stringify(text)).trim();
  const cleaned = s.replace(/```json/gi, '').replace(/```/g, '').trim();
  try {
    return normalizeWords(JSON.parse(cleaned));
  } catch {
    /* fall through */
  }
  const start = cleaned.indexOf('[');
  const end = cleaned.lastIndexOf(']');
  if (start >= 0 && end > start) {
    try {
      return normalizeWords(JSON.parse(cleaned.slice(start, end + 1)));
    } catch {
      /* fall through */
    }
  }
  return [];
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

    let words: WordItem[] = [];
    const rawLogs: string[] = [];
    // 最多尝试 2 次，应对 LLM 偶发输出非标准格式的情况
    for (let attempt = 0; attempt < 2 && words.length === 0; attempt++) {
      const hint =
        attempt === 1 ? '\n注意：请务必只输出 JSON 数组，禁止输出任何其他文字或解释。' : '';
      const messages: LLMMessage[] = [
        { role: 'system', content: OCR_SYSTEM_PROMPT + hint },
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
      rawLogs.push(typeof raw === 'string' ? raw : JSON.stringify(raw));
      words = extractJsonArray(raw);
    }

    if (words.length === 0) {
      console.error('[dictation] OCR 原始输出:', rawLogs.join('\n'));
      throw new BadRequestException('未能从图片中识别出有效单词，请更换更清晰的图片或重试');
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