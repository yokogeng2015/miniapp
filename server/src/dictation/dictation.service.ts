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
// 积分全局共享：所有设备共用同一条累计记录，实现跨端同步
const GLOBAL_POINTS_ID = 'global_points_shared';
// 积分清零确认密码
const RESET_PASSWORD = '8214';
const OCR_MODEL = 'doubao-seed-2-0-pro-260215';
const JUDGE_MODEL = 'doubao-seed-2-0-lite-260215';

const OCR_SYSTEM_PROMPT = `你是专注的英语学习资料识别助手。图片通常是英文词条、短语或短句的列表（可能中英混排，也可能是纯英文没有中文）。
请把图片中的每一行英文学习条目提取出来，要求：
1. 保持原始短语或短句的完整形态，【绝对不要把一个短语/短句拆分成单个单词】。例如
   - "take out everything" 应作为一整条，而不是拆成 take / out / everything；
   - "an English-Chinese dictionary" 应作为一整条；
   - "your secret to English learning" 应作为一整条。
2. 每项都必须给出准确的中文翻译 zh：如果图片中该行已带有中文释义，就采用图中的中文；如果图片中没有中文，你自己补上简洁准确的中文翻译，保证每项 zh 都有值。
3. 忽略页码、标题、题号、序号（如 1. 2. 3.）、装饰文字和无关注释。
4. 去除重复项，并保持原有顺序。
5. 最多返回 20 项。
只输出一个 JSON 数组，格式：[{"en":"短语","zh":"中文翻译"}]。若没有可用的学习条目，输出 []。禁止输出 JSON 之外的任何字符或解释。`;

// 判断是否为单个英文单词（不含空格、非中文）：用于区分“单词默写”与“短语/句子翻译”
function isSingleWord(s: string): boolean {
  const t = (s || '').trim();
  return t.length > 0 && !/[\s\u4e00-\u9fa5]/.test(t) && /^[a-zA-Z]+(?:['-][a-zA-Z]+)*$/.test(t);
}

// 判题用规范化：忽略大小写、全/半角标点、撇号、连字符与空白，仅保留字母数字内容后比较
// 例如 apple == Apple == apple. == " apple! "；don't == dont
function normalizeForCompare(s: string): string {
  return (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function normalizeWords(p: unknown): WordItem[] {
  const arr = Array.isArray(p)
    ? p
    : p && typeof p === 'object' && Array.isArray((p as { words?: unknown }).words)
    ? (p as { words: unknown[] }).words
    : null;
  if (!arr) return [];
  // 荧光笔/重复扫描会产生相同词条，按英文（忽略大小写与空白）自动去重，保留首次出现
  const seen = new Set<string>();
  const result: WordItem[] = [];
  for (const raw of arr) {
    const o = (raw ?? {}) as Record<string, unknown>;
    const en = String(o.en ?? o.word ?? '').trim();
    const zh = String(o.zh ?? o.meaning ?? '').trim();
    if (!en || !zh) continue;
    const key = en.replace(/\s+/g, ' ').toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ en, zh });
  }
  return result;
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
            { type: 'text', text: '请识别这张图片中的英文学习条目（可能含单词、短语或短句）并返回 JSON 数组。' },
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

  async getPoints(): Promise<{ totalPoints: number; correctCount: number; totalCount: number }> {
    const client = getSupabaseClient();
    const { data } = await client
      .from('study_users')
      .select('total_points, correct_count, total_count')
      .eq('device_id', GLOBAL_POINTS_ID)
      .maybeSingle();

    return {
      totalPoints: data?.total_points ?? 0,
      correctCount: data?.correct_count ?? 0,
      totalCount: data?.total_count ?? 0,
    };
  }

  // 积分清零（需密码确认）
  async resetPoints(password: string): Promise<{ totalPoints: number }> {
    if (!password || password !== RESET_PASSWORD) {
      throw new BadRequestException('密码错误，无法清零');
    }
    const client = getSupabaseClient();
    const { data, error } = await client
      .from('study_users')
      .update({
        total_points: 0,
        correct_count: 0,
        total_count: 0,
        updated_at: new Date().toISOString(),
      })
      .eq('device_id', GLOBAL_POINTS_ID)
      .select('total_points')
      .single();
    if (error) {
      console.error('[dictation] reset points error', error.message);
      throw new BadRequestException('积分清零失败');
    }
    return { totalPoints: data?.total_points ?? 0 };
  }

  // 手动修改积分（需密码确认）
  async setPoints(body: {
    password?: string;
    totalPoints?: number;
    correctCount?: number;
    totalCount?: number;
  }): Promise<{ totalPoints: number; correctCount: number; totalCount: number }> {
    if (!body || body.password !== RESET_PASSWORD) {
      throw new BadRequestException('密码错误，无法修改积分');
    }
    const normalize = (v: unknown, fallback: number) =>
      typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.round(v)) : fallback;
    const client = getSupabaseClient();
    const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (body.totalPoints !== undefined) patch.total_points = normalize(body.totalPoints, 0);
    if (body.correctCount !== undefined) patch.correct_count = normalize(body.correctCount, 0);
    if (body.totalCount !== undefined) patch.total_count = normalize(body.totalCount, 0);
    const { data, error } = await client
      .from('study_users')
      .update(patch)
      .eq('device_id', GLOBAL_POINTS_ID)
      .select('total_points, correct_count, total_count')
      .single();
    if (error) {
      console.error('[dictation] set points error', error.message);
      throw new BadRequestException('修改积分失败');
    }
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
      // 忽略大小写、标点、连字符和多余空白进行比较，只要内容正确即可判定正确
      const normAns = normalizeForCompare(answer);
      const normEn = normalizeForCompare(en);
      correct = normAns !== '' && normAns === normEn;
      explanation = correct
        ? `默写正确 ✅，与题库单词「${en}」一致（忽略标点与大小写差异）。`
        : `这是“单词默写”，答案必须与题库中的单词内容一致（忽略大小写与标点）。标准答案是「${en}」，而你写的是「${(answer || '').trim()}」。`;
    } else {
      // 短语/句子中译英，或英译中 → 语义判题，并给出解释（提示忽略标点差异）
      const prompt =
        mode === 'zh2en'
          ? `题目要求：根据中文释义写出对应的英文表达（可为单词或常考短语）。\n题目：${zh}\n参考表达：${en}\n用户作答：${answer}\n判断用户作答是否可接受：凡是意思、语法正确且表达自然（包括同义短语、近义说法）均算可接受；多余的标点、缺失标点、大小写或空格差异均不影响判对。若不可接受，请用简短中文解释具体原因（为什么这样说不自然/不正确，以及怎样更接近正确表达）。`
          : `题目要求：根据英文写出其中文意思。\n题目：${en}\n参考表达：${zh}\n用户作答：${answer}\n判断用户作答是否可接受：意思是正确的中文表达（允许同义换说法）均算可接受；多余的标点、缺失标点或空格差异均不影响判对。若不可接受，请用简短中文解释具体原因（哪里意思不符，更合适的中文措辞是什么）。`;
      const judge = await this.llmJudge(prompt, customHeaders);
      correct = judge.correct;
      explanation = judge.explanation || '';
      acceptedAsAlternative = judge.acceptedAsAlternative;
    }

    let totalPoints = 0;
    try {
      totalPoints = await this.awardResult(correct);
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

  async checkPhoto(
    file: Express.Multer.File,
    body: { deviceId: string; mode: 'zh2en' | 'en2zh'; en: string; zh: string },
    customHeaders: Record<string, string>,
  ): Promise<CheckResult & { recognized: string }> {
    const { url } = await this.storageService.uploadImage(file.buffer, file.originalname, file.mimetype);
    const client = this.createClient(customHeaders);

    // 识别手写/印刷答案文本（可能是英文单词/短语，或英译中时是中文）
    const prompt =
      body.mode === 'en2zh'
        ? '图片中是手写的、针对一个英文单词的中文答案。请准确识别图片中的中文内容（可能是一个或多个汉字词/短语）。只返回识别到的原文，去掉多余空白，不要任何解释。'
        : '图片中是手写的、针对一个中文释义的英文答案（可能是一个英文单词或短语）。请准确识别图片中的英文内容，注意手写字母（a/e/o、l/i、b/d、g/q 等易混淆）。只返回识别到的英文原文，去掉标点和多于空白，不要任何解释。';
    const messages: LLMMessage[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url, detail: 'high' } },
        ],
      },
    ];
    let recognized = '';
    for (let attempt = 0; attempt < 2 && !recognized; attempt++) {
      const resp = await client.invoke(messages, { model: OCR_MODEL, temperature: 0.1 });
      recognized = String(resp.content || '').trim();
    }
    if (!recognized) {
      throw new BadRequestException('未能识别出手写答案，请拍摄更清晰的字迹后重试');
    }

    const result = await this.checkAnswer(
      { deviceId: body.deviceId, mode: body.mode, en: body.en, zh: body.zh, answer: recognized },
      customHeaders,
    );
    return { ...result, recognized };
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

  private async awardResult(correct: boolean): Promise<number> {
    const client = getSupabaseClient();
    const now = new Date().toISOString();

    const { data: existing } = await client
      .from('study_users')
      .select('id, total_points, total_count, correct_count')
      .eq('device_id', GLOBAL_POINTS_ID)
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
      const { data, error } = await client
        .from('study_users')
        .update(patches)
        .eq('device_id', GLOBAL_POINTS_ID)
        .select('total_points')
        .single();
      if (error) throw new Error(error.message);
      return data?.total_points ?? 0;
    }

    const insertCount = correct ? POINTS_PER_CORRECT : 0;
    const { data, error } = await client
      .from('study_users')
      .insert({
        device_id: GLOBAL_POINTS_ID,
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