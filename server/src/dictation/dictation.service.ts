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
  explanation?: string;
  acceptedAsAlternative?: boolean;
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

// 判断是否为单个英文单词（不含空格、非中文）：用于区分“单词默写”与“短语/句子翻译”
function isSingleWord(s: string): boolean {
  const t = (s || '').trim();
  return t.length > 0 && !/[\s\u4e00-\u9fa5]/.test(t) && /^[a-zA-Z]+(?:['-][a-zA-Z]+)*$/.test(t);
}

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

  async saveWordlist(body: { deviceId: string; name: string; words: { en: string; zh: string }[] }) {
    if (!body?.deviceId) {
      throw new BadRequestException('缺少设备标识 deviceId');
    }
    if (!body?.name?.trim()) {
      throw new BadRequestException('请为词单命名');
    }
    const words = (body.words ?? []).filter((w) => w && w.en && w.zh);
    if (!words.length) {
      throw new BadRequestException('词单为空，无法保存');
    }
    const name = body.name.trim().slice(0, 50);
    const client = getSupabaseClient();
    const { data, error } = await client
      .from('wordlists')
      .insert({
        device_id: body.deviceId,
        name,
        words: words.slice(0, 200),
        word_count: words.length,
      })
      .select('*')
      .single();
    if (error) {
      console.error('[dictation] save wordlist error', error.message);
      throw new BadRequestException('保存词单失败：' + error.message);
    }
    return this.mapWordlist(data);
  }

  async listWordlists() {
    // 词单为个人学习资料库，跨端互通：不按设备过滤，全部返回
    const client = getSupabaseClient();
    const { data, error } = await client
      .from('wordlists')
      .select('*')
      .order('created_at', { ascending: false });
    if (error) {
      console.error('[dictation] list wordlists error', error.message);
      throw new BadRequestException('获取词单失败');
    }
    return (data ?? []).map((w) => this.mapWordlist(w));
  }

  async deleteWordlist(id: string) {
    if (!id) {
      throw new BadRequestException('缺少参数');
    }
    const client = getSupabaseClient();
    const { error } = await client
      .from('wordlists')
      .delete()
      .eq('id', id);
    if (error) {
      console.error('[dictation] delete wordlist error', error.message);
      throw new BadRequestException('删除词单失败');
    }
    return { deletedId: id };
  }

  private mapWordlist(row: any) {
    return {
      id: row.id,
      name: row.name,
      words: row.words ?? [],
      wordCount: row.word_count ?? 0,
      createdAt: row.created_at,
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
    // 中译英且标准答案是单个英文单词 → “单词默写”，必须与题库词条完全一致
    const isWordDictation = mode === 'zh2en' && isSingleWord(en);

    let correct = false;
    let explanation = '';
    let acceptedAsAlternative = false;

    if (isWordDictation) {
      const normAns = (answer || '').trim().toLowerCase();
      const normEn = (en || '').trim().toLowerCase();
      correct = normAns === normEn;
      explanation = correct
        ? `默写正确 ✅，与题库单词「${en}」一致。`
        : `这是“单词默写”，答案必须与题库中的单词完全一致（大小写不区分）。标准答案是「${en}」，而你写的是「${(answer || '').trim()}」。`;
    } else {
      // 短语/句子中译英，或英译中 → 语义判题，并给出解释
      const prompt =
        mode === 'zh2en'
          ? `题目要求：根据中文释义写出对应的英文表达（可为单词或常考短语）。\n题目：${zh}\n参考表达：${en}\n用户作答：${answer}\n判断用户作答是否可接受：凡是意思、语法正确且表达自然（包括同义短语、近义说法）均算可接受；若不可接受，请用简短中文解释具体原因（为什么这样说不自然/不正确，以及怎样更接近正确表达）。`
          : `题目要求：根据英文写出其中文意思。\n题目：${en}\n参考表达：${zh}\n用户作答：${answer}\n判断用户作答是否可接受：意思是正确的中文表达（允许同义换说法）均算可接受；若不可接受，请用简短中文解释具体原因（哪里意思不符，更合适的中文措辞是什么）。`;
      const judge = await this.llmJudge(prompt, customHeaders);
      correct = judge.correct;
      explanation = judge.explanation || '';
      acceptedAsAlternative = judge.acceptedAsAlternative;
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
      explanation,
      acceptedAsAlternative,
      pointsAwarded: correct ? POINTS_PER_CORRECT : 0,
      totalPoints,
    };
  }

  private async llmJudge(
    prompt: string,
    customHeaders: Record<string, string>,
  ): Promise<{ correct: boolean; explanation: string; acceptedAsAlternative: boolean }> {
    const client = this.createClient(customHeaders);
    const messages: LLMMessage[] = [
      {
        role: 'user',
        content: `${prompt}\n只输出一个 JSON 对象，格式：{"correct": true 或 false, "explanation": "简短中文解释"}，不要输出其他内容。`,
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

    let explanation = '';
    try {
      const em = text.match(/"explanation"\s*:\s*"((?:[^"\\]|\\.)*)"/m);
      if (em) explanation = em[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\').trim();
    } catch {
      explanation = '';
    }

    return { correct, explanation, acceptedAsAlternative: correct && explanation.length > 0 };
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