import { useCallback, useEffect, useState } from 'react';
import Taro from '@tarojs/taro';
import { Image, Text, View } from '@tarojs/components';
import { Camera, CircleCheck, CircleX, Coins, House, Info, Library, Pencil, RotateCcw, ScanLine, Trash2, TrendingUp } from 'lucide-react-taro';
import { Network } from '@/network';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';

interface WordItem {
  en: string;
  zh: string;
}

interface ApiEnvelope<T> {
  status: string;
  message?: string;
  data?: T;
}

type Step = 'upload' | 'recognizing' | 'review' | 'quiz' | 'result' | 'bank';

interface SavedList {
  id: string;
  name: string;
  words: WordItem[];
  wordCount: number;
  createdAt: string;
}

const POINTS_STORAGE_KEY = 'dictation_device_id';

function genDeviceId(): string {
  const chars = 'abcdef0123456789';
  let id = '';
  for (let i = 0; i < 32; i++) id += chars[Math.floor(Math.random() * 16)];
  return `dev-${id}`;
}

// 安全解析可能是 JSON 字符串的后端响应（微信/抖音 uploadFile 返回 String）
function tryParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

// 从 uploadFile/request 的响应中递归提取识别单词数组，兼容小程序端多样的返回结构
function resolveRecognizedWords(raw: unknown): WordItem[] {
  if (raw == null) return [];
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) return [];
    const obj = tryParse(trimmed);
    if (obj) return resolveRecognizedWords(obj);
    // 若字符串里内嵌了 JSON 对象（前后可能有其他文字），提取对象子串再解析
    const s = trimmed.indexOf('{');
    const e = trimmed.lastIndexOf('}');
    if (s >= 0 && e > s) {
      const obj2 = tryParse(trimmed.slice(s, e + 1));
      if (obj2) return resolveRecognizedWords(obj2);
    }
    return [];
  }
  if (Array.isArray(raw)) {
    return raw.filter(
      (x): x is WordItem =>
        !!x && typeof x === 'object' && typeof (x as WordItem).en === 'string' && typeof (x as WordItem).zh === 'string',
    );
  }
  if (typeof raw === 'object') {
    const b = raw as Record<string, any>;
    const candidates: unknown[] = [
      b?.data?.words,
      b?.words,
      b?.result?.words,
      b?.data?.result?.words,
      b?.list,
      b?.recognized,
    ];
    for (const c of candidates) {
      const w = resolveRecognizedWords(c);
      if (w.length) return w;
    }
  }
  return [];
}

function getDeviceId(): string {
  try {
    const existing = Taro.getStorageSync(POINTS_STORAGE_KEY);
    if (existing) return existing;
    const id = genDeviceId();
    Taro.setStorageSync(POINTS_STORAGE_KEY, id);
    return id;
  } catch {
    return genDeviceId();
  }
}

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export default function IndexPage() {
  const [step, setStep] = useState<Step>('upload');
  const [imagePath, setImagePath] = useState('');
  const [h5RawFile, setH5RawFile] = useState<File | null>(null);
  const [words, setWords] = useState<WordItem[]>([]);
  const [mode, setMode] = useState<'zh2en' | 'en2zh'>('zh2en');
  const [quizOrder, setQuizOrder] = useState<number[]>([]);
  const [quizIndex, setQuizIndex] = useState(0);
  const [sessionCorrect, setSessionCorrect] = useState(0);
  const [sessionEarned, setSessionEarned] = useState(0);
  const [answer, setAnswer] = useState('');
  const [feedback, setFeedback] = useState<{
    correct: boolean;
    reference: string;
    explanation: string;
    acceptedAlternative?: boolean;
    pointsAwarded: number;
  } | null>(null);
  const [checking, setChecking] = useState(false);

  const [points, setPoints] = useState(0);
  const [totalCount, setTotalCount] = useState(0);
  const [correctCount, setCorrectCount] = useState(0);
  const [deviceId] = useState<string>(() => getDeviceId());

  const [resetPwd, setResetPwd] = useState('');
  const [resetting, setResetting] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [setPointsInput, setSetPointsInput] = useState('');
  const [setCorrectInput, setSetCorrectInput] = useState('');
  const [setTotalInput, setSetTotalInput] = useState('');

  const [editOpen, setEditOpen] = useState(false);
  const [editIdx, setEditIdx] = useState(-1);
  const [editEn, setEditEn] = useState('');
  const [editZh, setEditZh] = useState('');

  const [activeTab, setActiveTab] = useState<'home' | 'words' | 'growth'>('home');
  const [savedLists, setSavedLists] = useState<SavedList[]>([]);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [bankLoading, setBankLoading] = useState(false);
  const [sampleMode, setSampleMode] = useState<'all' | 'sample'>('all');
  const [sampleCount, setSampleCount] = useState('5');
  const [bankName, setBankName] = useState('');
  const [savingList, setSavingList] = useState(false);

  const refreshPoints = useCallback(async () => {
    try {
      const res = await Network.request({ url: `/api/dictation/points?deviceId=${deviceId}` });
      console.log('points body:', res.data);
      const body = res.data as ApiEnvelope<{ totalPoints: number; correctCount?: number; totalCount?: number }>;
      setPoints(body?.data?.totalPoints ?? 0);
      setCorrectCount(body?.data?.correctCount ?? 0);
      setTotalCount(body?.data?.totalCount ?? 0);
    } catch (e) {
      console.error('load points failed', e);
    }
  }, [deviceId]);

  useEffect(() => {
    refreshPoints();
  }, [refreshPoints]);

  const handleSetPoints = async () => {
    if (!resetPwd) {
      Taro.showToast({ title: '请输入密码', icon: 'none' });
      return;
    }
    if (!setPointsInput) {
      Taro.showToast({ title: '请输入新的成长值', icon: 'none' });
      return;
    }
    const toNum = (s: string) => (s === '' || s === undefined ? undefined : Number(s));
    setResetting(true);
    try {
      const res = await Network.request({
        url: '/api/dictation/points/set',
        method: 'POST',
        data: {
          password: resetPwd,
          totalPoints: toNum(setPointsInput),
          correctCount: setCorrectInput === '' ? undefined : toNum(setCorrectInput),
          totalCount: setTotalInput === '' ? undefined : toNum(setTotalInput),
        },
      });
      console.log('set points resp:', res.data);
      const body = res.data as ApiEnvelope<{ totalPoints: number; correctCount: number; totalCount: number }>;
      setPoints(body?.data?.totalPoints ?? 0);
      setCorrectCount(body?.data?.correctCount ?? 0);
      setTotalCount(body?.data?.totalCount ?? 0);
      setResetPwd('');
      setSetPointsInput('');
      setSetCorrectInput('');
      setSetTotalInput('');
      Taro.showToast({ title: '成长值已更新', icon: 'none' });
    } catch (e) {
      console.error('set points failed', e);
      const err = e as { data?: { message?: string } };
      Taro.showToast({ title: err?.data?.message || '修改失败', icon: 'none' });
    } finally {
      setResetting(false);
    }
  };

  const isH5 = Taro.getEnv() === Taro.ENV_TYPE.WEB;

  const pickH5File = (): Promise<File> =>
    new Promise((resolve, reject) => {
      try {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = 'image/*';
        input.style.display = 'none';
        input.onchange = () => {
          const file = input.files && input.files[0];
          if (input.parentNode) input.parentNode.removeChild(input);
          if (file) resolve(file);
          else reject(new Error('未选择图片'));
        };
        document.body.appendChild(input);
        input.click();
      } catch (e) {
        reject(e);
      }
    });

  const handleChooseImage = async () => {
    try {
      if (isH5) {
        const file = await pickH5File();
        setH5RawFile(file);
        setImagePath(URL.createObjectURL(file));
      } else {
        const res = await Taro.chooseImage({ count: 1, sizeType: ['compressed'] });
        setImagePath(res.tempFilePaths[0]);
        setH5RawFile(null);
      }
    } catch (e) {
      console.error('choose image cancelled/error', e);
      Taro.showToast({ title: '选择图片失败', icon: 'none' });
    }
  };

  const runRecognize = async (): Promise<WordItem[]> => {
    // H5 端：Coze SW 会拦截 Taro.uploadFile 的 blob 上传(报 uploadFile:fail)。
    // 改用原生 File 对象手动构造 FormData 上传，绕过限制。
    if (isH5 && h5RawFile) {
      const fd = new FormData();
      fd.append('file', h5RawFile, h5RawFile.name || 'image.jpg');
      const resp = await fetch(`${PROJECT_DOMAIN}/api/dictation/recognize`, {
        method: 'POST',
        body: fd,
      });
      const body = (await resp.json()) as ApiEnvelope<{ words: WordItem[] }>;
      if (!body?.data?.words) throw new Error(body?.message || '识别失败');
      return body.data.words;
    }
    // 小程序端：使用 Network.uploadFile，最多自动重试 2 次，应对偶发抖动
    let lastErr: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await Network.uploadFile({
          url: '/api/dictation/recognize',
          filePath: imagePath,
          name: 'file',
        });
        // 微信/抖音小程序端 Taro.uploadFile 的 res.data 是 JSON 字符串，需兼容解析
        const recognized = resolveRecognizedWords(res.data);
        if (recognized.length) return recognized;
        // 未解析出单词时打印原始响应，便于定位小程序端返回结构
        console.log('[recognize] miniprogram raw upload resp =', res.data);
        throw new Error('未识别到单词，请检查上传后重试');
        return recognized;
      } catch (e) {
        lastErr = e;
        console.error('recognize error (attempt ' + attempt + ')', e);
        if (attempt < 2) await new Promise((r) => setTimeout(r, 600));
      }
    }
    throw lastErr ? new Error((lastErr as { errMsg?: string })?.errMsg) : new Error('识别失败');
  };

  const handleRecognize = async () => {
    if (!imagePath) return;
    setStep('recognizing');
    try {
      const recognized = await runRecognize();
      console.log('recognized words:', recognized);
      setWords(recognized);
      setStep('review');
    } catch (e) {
      console.error('recognize final error', e);
      const errMsg =
        (e as { message?: string })?.message ||
        (e as { errMsg?: string })?.errMsg ||
        '识别失败，请检查网络后重试';
      Taro.showToast({ title: errMsg, icon: 'none' });
      setStep('upload');
    }
  };

  const handleStartEdit = (idx: number) => {
    setEditIdx(idx);
    setEditEn(words[idx]?.en ?? '');
    setEditZh(words[idx]?.zh ?? '');
    setEditOpen(true);
  };

  const handleSaveEdit = () => {
    const en = editEn.trim();
    const zh = editZh.trim();
    if (!en) {
      Taro.showToast({ title: '英文不能为空', icon: 'none' });
      return;
    }
    setWords((prev) => prev.map((w, i) => (i === editIdx ? { en, zh } : w)));
    setEditOpen(false);
  };

  // 删除单个词条（荧光笔扫描可能产生重复），删除前确认
  const deleteWord = (idx: number) => {
    Taro.showModal({
      title: '删除词条',
      content: `确定删除「${words[idx]?.en || ''}」吗？`,
      confirmText: '删除',
      confirmColor: '#e92e6f',
      success: (res) => {
        if (res.confirm) {
          setWords((prev) => prev.filter((_, i) => i !== idx));
          Taro.showToast({ title: '已删除', icon: 'success' });
        }
      },
    });
  };

  const startQuiz = (pool?: WordItem[]) => {
    let source = pool && pool.length ? pool : words;
    if (!source.length) {
      Taro.showToast({ title: '暂无可默写的单词', icon: 'none' });
      return;
    }
    const n = Math.max(1, parseInt(sampleCount, 10) || 5);
    if (sampleMode === 'sample' && source.length > n) {
      source = shuffle(source).slice(0, n);
    }
    setWords(source);
    const order = shuffle(source.map((_, i) => i));
    setQuizOrder(order);
    setQuizIndex(0);
    setSessionCorrect(0);
    setSessionEarned(0);
    setAnswer('');
    setFeedback(null);
    setStep('quiz');
  };

  const loadSavedLists = useCallback(async () => {
    setBankLoading(true);
    try {
      const res = await Network.request({ url: `/api/dictation/wordlists?deviceId=${deviceId}` });
      const body = res.data as ApiEnvelope<SavedList[]>;
      // 后端返回 data 为数组（不是 { list: [] }）
      const list = Array.isArray(body?.data) ? (body.data as SavedList[]) : [];
      setSavedLists(list);
      setSelectedIds((ids) => ids.filter((id) => list.some((l) => l.id === id)));
    } catch (e) {
      console.error('load wordlists failed', e);
    } finally {
      setBankLoading(false);
    }
  }, [deviceId]);

  const openBank = () => {
    setActiveTab('words');
    loadSavedLists();
  };

  const saveCurrentList = async () => {
    const name = bankName.trim();
    if (!name) {
      Taro.showToast({ title: '请先填写词单名称', icon: 'none' });
      return;
    }
    if (!words.length) {
      Taro.showToast({ title: '暂无可保存的单词', icon: 'none' });
      return;
    }
    setSavingList(true);
    try {
      const res = await Network.request({
        url: '/api/dictation/wordlists/save',
        method: 'POST',
        data: { deviceId, name, words },
      });
      const body = res.data as ApiEnvelope<{ id: string; name: string; words: WordItem[]; wordCount: number; createdAt: string }>;
      const saved = body?.data;
      if (!saved?.id) throw new Error(body?.message || '保存失败');
      // 立即把新词单合并进本地列表，保证保存后马上能看到记录
      const newList: SavedList = {
        id: saved.id,
        name: saved.name || name,
        words: saved.words?.length ? saved.words : words,
        wordCount: saved.wordCount ?? words.length,
        createdAt: saved.createdAt || new Date().toISOString(),
      };
      setSavedLists((prev) => [newList, ...prev.filter((l) => l.id !== newList.id)]);
      setSelectedIds((ids) => (ids.includes(newList.id) ? ids : [...ids, newList.id]));
      Taro.showToast({ title: `已保存「${name}」`, icon: 'none' });
      setBankName('');
    } catch (e) {
      console.error('save wordlist failed', e);
      Taro.showToast({ title: '保存词单失败', icon: 'none' });
    } finally {
      setSavingList(false);
    }
  };

  const deleteSavedList = async (id: string) => {
    try {
      await Network.request({
        url: `/api/dictation/wordlists/${id}?deviceId=${deviceId}`,
        method: 'DELETE',
      });
      setSavedLists((l) => l.filter((x) => x.id !== id));
    } catch (e) {
      console.error('delete wordlist failed', e);
    }
  };

  const buildPoolFromSelected = (): WordItem[] => {
    const map = new Map<string, WordItem>();
    for (const id of selectedIds) {
      const list = savedLists.find((l) => l.id === id);
      list?.words?.forEach((w) => {
        if (w && w.en && w.zh && !map.has(w.en)) map.set(w.en, w);
      });
    }
    return Array.from(map.values());
  };

  const toggleList = (id: string) => {
    setSelectedIds((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]));
  };

  const startFromBank = () => {
    const pool = buildPoolFromSelected();
    if (!pool.length) {
      Taro.showToast({ title: '请先选择词单', icon: 'none' });
      return;
    }
    startQuiz(pool);
    setActiveTab('home');
  };

  const currentWord = quizOrder.length ? words[quizOrder[quizIndex]] : null;

  const handleSubmit = async () => {
    if (!currentWord || !answer.trim() || checking) return;
    setChecking(true);
    try {
      const res = await Network.request({
        url: '/api/dictation/check',
        method: 'POST',
        data: {
          deviceId,
          mode,
          en: currentWord.en,
          zh: currentWord.zh,
          answer: answer.trim(),
        },
      });
      console.log('check body:', res.data);
      const d = (
        res.data as ApiEnvelope<{
          correct: boolean;
          reference: string;
          explanation: string;
          acceptedAlternative: boolean;
          pointsAwarded: number;
          totalPoints: number;
        }>
      )?.data;
      setFeedback({
        correct: !!d?.correct,
        reference: d?.reference ?? '',
        explanation: d?.explanation ?? '',
        acceptedAlternative: !!d?.acceptedAlternative,
        pointsAwarded: d?.pointsAwarded ?? 0,
      });
      if (d?.correct) {
        setSessionCorrect((c) => c + 1);
        setSessionEarned((e) => e + (d?.pointsAwarded ?? 0));
      }
      if (typeof d?.totalPoints === 'number') setPoints(d.totalPoints);
      else refreshPoints();
      // 移动端：答题后自动定位到反馈区，避免被软键盘/小屏遮挡看不到提示
      setTimeout(
        () => {
          try {
            if (isH5) {
              (document as unknown as { getElementById: (id: string) => Element | null }).getElementById('answer-feedback')?.scrollIntoView?.({
                behavior: 'smooth',
                block: 'center',
              });
            }
          } catch {}
        },
        120
      );
    } catch (e) {
      console.error('check error', e);
      Taro.showToast({ title: '提交失败，请重试', icon: 'none' });
    } finally {
      setChecking(false);
    }
  };

  const nextQuestion = () => {
    setAnswer('');
    setFeedback(null);
    if (quizIndex + 1 >= quizOrder.length) {
      setStep('result');
    } else {
      setQuizIndex((i) => i + 1);
    }
  };

  const total = quizOrder.length;
  const progressValue = quizOrder.length ? Math.round(((quizIndex + (feedback ? 1 : 0)) / total) * 100) : 0;

  return (
    <View className="min-h-screen bg-background px-4 py-6">
      <View className="mx-auto w-full max-w-2xl pb-24">
      {/* 顶部成长值栏 */}
      <View className="mb-5 flex flex-row items-center justify-between">
        <View className="flex flex-row items-center gap-2">
          <ScanLine size={22} className="text-primary" color="#e92e6f" />
          <Text className="block text-lg font-bold text-primary">随拍默写</Text>
        </View>
        <View className="flex flex-row items-center gap-2">
          <View
            className="rounded-full bg-secondary px-3 py-1"
            onClick={() => {
              setResetPwd('');
              setActiveTab('growth');
            }}
          >
            <View className="flex flex-row items-center gap-1">
              <Coins size={14} color="#f59e0b" />
              <Text className="text-xs font-semibold text-foreground">{points} 成长值</Text>
            </View>
          </View>
          <View
            className="flex h-5 w-5 items-center justify-center rounded-full bg-muted"
            onClick={() => setHelpOpen(true)}
          >
            <Info size={12} color="#6c6c70" />
          </View>
        </View>
      </View>

      {/* 我的词单入口 */}
      {(step === 'upload' || step === 'review') && (
        <View className="mb-4">
          <Button
            variant="default"
            className="w-full border-none bg-[#db5a6b] text-white shadow-none"
            onClick={openBank}
          >
            <Text>从我的词单开始默写</Text>
          </Button>
        </View>
      )}

      {/* 上传 / 识别 / 浏览单词 */}
      {activeTab === 'home' && (step === 'upload' || step === 'recognizing' || step === 'review') && (
        <View>
          <View
            className="mb-5 rounded-lg px-6 py-6 text-white shadow-lg"
            style={{ background: 'linear-gradient(135deg, #e05664 0%, #a878a5 55%, #3287fe 100%)' }}
          >
            <View className="mb-4 flex flex-row items-center justify-between">
              <View>
                <Text className="block text-lg font-bold text-white">单词听写</Text>
                <Text className="block text-xs text-white opacity-80">拍图识词 · 随拍随默</Text>
              </View>
            {/*    <View className="rounded-full px-3 py-1" style={{ backgroundColor: 'rgba(255,255,255,0.22)' }}>
                <Text className="text-xs font-medium text-white">学习进度</Text>
              </View> */}
            </View>  
            <View className="flex flex-row gap-3">
              <View className="flex-1 rounded-2xl bg-white p-4">
                <Text className="block text-xs text-gray-700">总答题数量</Text>
                <Text className="block text-2xl font-bold text-primary">{totalCount}</Text>
              </View>
              <View className="flex-1 rounded-2xl bg-white p-4">
                <Text className="block text-xs text-gray-700">总答对数量</Text>
                <Text className="block text-2xl font-bold text-primary">{correctCount}</Text>
              </View>
            </View>
          </View>

          <Card>
            <CardContent className="p-5">
              {step === 'review' && imagePath ? (
                <View className="mb-4 flex flex-row items-center gap-4">
                  <Image
                    src={imagePath}
                    mode="aspectFill"
                    className="h-20 w-20 rounded-xl bg-gray-100"
                  />
                  <View className="flex-1">
                    <Text className="block text-base font-semibold">已识别单词</Text>
                    <Text className="block text-sm text-muted-foreground">
                      共 {words.length} 个，点击下方开始默写
                    </Text>
                  </View>
                </View>
              ) : (
                <View
                  onClick={handleChooseImage}
                  hoverClass="opacity-80"
                  className="flex flex-col items-center justify-center rounded-xl border-2 border-dashed border-primary bg-muted px-4 py-12"
                >
                  <Camera size={40} className="text-primary" color="#e92e6f" />
                  <Text className="mt-3 block text-sm font-medium">
                    {imagePath ? '已选择图片，点击可更换' : '点击选择单词图片'}
                  </Text>
                  <Text className="mt-1 block text-xs text-muted-foreground">支持 JPG / PNG</Text>
                  {imagePath ? (
                    <Image
                      src={imagePath}
                      mode="aspectFill"
                      className="mt-4 h-40 w-40 rounded-xl bg-gray-200"
                    />
                  ) : null}
                </View>
              )}

              {step === 'recognizing' && (
                <View className="mt-4 flex flex-col items-center py-4">
                  <Text className="block text-sm text-muted-foreground">AI 正在识别图片中的单词…</Text>
                </View>
              )}

              {step === 'review' && (
                <View className="mt-2">
                  <Text className="mb-2 block text-sm font-semibold text-foreground">识别结果</Text>
                  <View className="flex flex-col gap-2">
                    {words.map((w, idx) => (
                      <View
                        key={idx}
                        className="flex flex-row items-center justify-between rounded-lg bg-muted px-3 py-2"
                      >
                        <View className="flex-1 pr-2">
                          <Text className="block text-sm font-semibold">{w.en}</Text>
                          <Text className="block text-sm text-muted-foreground">{w.zh}</Text>
                        </View>
                        <View className="flex shrink-0 flex-row items-center">
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => handleStartEdit(idx)}
                          >
                            <Pencil size={14} color="#e92e6f" />
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => deleteWord(idx)}
                          >
                            <Trash2 size={15} color="#d11a4d" />
                          </Button>
                        </View>
                      </View>
                    ))}
                  </View>
                </View>
              )}

              {step === 'review' && (
                <View className="mt-5">
                  <Text className="mb-2 block text-sm font-semibold">默写模式</Text>
                  <View className="flex flex-row gap-2">
                    <Button
                      className="flex-1"
                      variant={mode === 'zh2en' ? 'default' : 'secondary'}
                      onClick={() => setMode('zh2en')}
                    >
                      中译英
                    </Button>
                    <Button
                      className="flex-1"
                      variant={mode === 'en2zh' ? 'default' : 'secondary'}
                      onClick={() => setMode('en2zh')}
                    >
                      英译中
                    </Button>
                  </View>

                  <View className="mt-4">
                    <Text className="mb-2 block text-sm font-semibold">默写范围</Text>
                    <View className="flex flex-row gap-2">
                      <Button
                        size="sm"
                        className="flex-1"
                        variant={sampleMode === 'all' ? 'default' : 'secondary'}
                        onClick={() => setSampleMode('all')}
                      >
                        全量
                      </Button>
                      <Button
                        size="sm"
                        className="flex-1"
                        variant={sampleMode === 'sample' ? 'default' : 'secondary'}
                        onClick={() => setSampleMode('sample')}
                      >
                        抽查
                      </Button>
                    </View>
                    {sampleMode === 'sample' && (
                      <View style={{ display: "flex", alignItems: "center", width: "100%", marginTop: "8px", borderRadius: "12px", backgroundColor: "#f2f2f7", padding: "0 12px", minHeight: "48px", boxSizing: "border-box" }}>
                        <Input style={{ width: "100%", fontSize: "16px", padding: "0", boxSizing: "border-box" }} type="number" placeholder="抽查条数"
                          value={sampleCount}
                          onInput={(e) => setSampleCount(e.detail.value.replace(/\D/gi, ''))}
                        />
                      </View>
                    )}
                  </View>

                  <Button className="mt-4 w-full" size="lg" onClick={() => startQuiz()}>
                    开始默写
                  </Button>

                  <View className="mt-6 border-t border-muted pt-4">
                    <Text className="mb-2 block text-sm font-semibold">保存为词单</Text>
                    <Text className="mb-2 block text-xs text-muted-foreground">
                      可自定义命名，之后可在「我的词单」多选合集默写
                    </Text>
                    <View
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        width: '100%',
                        borderRadius: '12px',
                        backgroundColor: '#f2f2f7',
                        padding: '0 12px',
                        minHeight: '48px',
                        boxSizing: 'border-box',
                      }}
                    >
                      <Input
                        style={{ width: '100%', fontSize: '16px', padding: '0', boxSizing: 'border-box' }}
                        placeholder="给这组词起个名称"
                        value={bankName}
                        onInput={(e) => setBankName(e.detail.value)}
                      />
                    </View>
                    <Button className="mt-3 w-full" variant="outline" onClick={saveCurrentList} disabled={savingList}>
                      {savingList ? '保存中…' : '保存为词单'}
                    </Button>
                  </View>
                </View>
              )}
            </CardContent>
          </Card>

          <View className="mt-5">
            {step === 'upload' && !imagePath && (
              <Button className="w-full" size="lg" onClick={handleChooseImage}>
                选择图片
              </Button>
            )}
            {step === 'upload' && imagePath && (
              <>
                <Button className="w-full" size="lg" onClick={handleRecognize}>
                  识别单词
                </Button>
                <Button
                  className="mt-3 w-full"
                  variant="outline"
                  onClick={handleChooseImage}
                >
                  重新选择图片
                </Button>
              </>
            )}
            {step === 'recognizing' && (
              <Button className="w-full" size="lg">
                <Text>正在识别…</Text>
              </Button>
            )}
            {step === 'review' && imagePath && (
              <Button className="w-full" variant="outline" onClick={handleRecognize}>
                重新识别
              </Button>
            )}
            {step === 'review' && imagePath && (
              <Button className="mt-3 w-full" variant="ghost" onClick={() => { setStep('upload'); setImagePath(''); setWords([]); }}>
                换一张图片
              </Button>
            )}
          </View>
        </View>
      )}

      {/* 我的词单（多选合集默写） */}
      {activeTab === 'words' && (
        <View>
          <View className="mb-4 flex flex-row items-center justify-between">
            <Text className="block text-lg font-bold">我的词单</Text>
            <Button size="sm" variant="ghost" onClick={() => setActiveTab('home')}>
              返回
            </Button>
          </View>

          {bankLoading ? (
            <Text className="block text-sm text-muted-foreground">加载中…</Text>
          ) : savedLists.length === 0 ? (
            <Card>
              <CardContent className="flex flex-col items-center p-8">
                <Text className="block text-center text-sm text-muted-foreground">
                  还没有保存的词单{'\n'}识别图片后即可保存，可多选合集默写
                </Text>
                <Button className="mt-4" onClick={() => { setActiveTab('home'); setStep('upload'); }}>
                  去上传识别
                </Button>
              </CardContent>
            </Card>
          ) : (
            <>
              <View className="flex flex-col gap-2">
                {savedLists.map((l) => {
                  const sel = selectedIds.includes(l.id);
                  return (
                    <Card key={l.id}>
                      <CardContent className="p-4">
                        <View className="flex flex-row items-center justify-between" onClick={() => toggleList(l.id)}>
                          <View className="flex-1 pr-2">
                            <Text className="block text-base font-semibold">{l.name}</Text>
                            <Text className="block text-xs text-muted-foreground">{l.wordCount} 个单词</Text>
                          </View>
                          <View className="flex flex-row items-center gap-2">
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={(e) => {
                                e.stopPropagation();
                                deleteSavedList(l.id);
                              }}
                            >
                              删除
                            </Button>
                            <CircleCheck size={22} color={sel ? '#e92e6f' : '#cbd5e1'} strokeWidth={1.6} />
                          </View>
                        </View>
                        <View className="mt-2 flex flex-row flex-wrap gap-1">
                          {l.words.slice(0, 5).map((w) => (
                            <Badge key={w.en} variant={sel ? 'default' : 'secondary'}>
                              {w.en}
                            </Badge>
                          ))}
                        </View>
                      </CardContent>
                    </Card>
                  );
                })}
              </View>

              <View className="mt-5">
                <Text className="mb-2 block text-sm font-semibold">默写范围</Text>
                <View className="flex flex-row gap-2">
                  <Button
                    size="sm"
                    className="flex-1"
                    variant={sampleMode === 'all' ? 'default' : 'secondary'}
                    onClick={() => setSampleMode('all')}
                  >
                    全量
                  </Button>
                  <Button
                    size="sm"
                    className="flex-1"
                    variant={sampleMode === 'sample' ? 'default' : 'secondary'}
                    onClick={() => setSampleMode('sample')}
                  >
                    抽查
                  </Button>
                </View>
                {sampleMode === 'sample' && (
                  <View style={{ display: "flex", width: "100%", marginTop: "8px", borderRadius: "12px", backgroundColor: "#f2f2f7", padding: "0 12px" }}>
                    <Input style={{ width: "100%", fontSize: "16px", padding: "0", boxSizing: "border-box" }} type="number" placeholder="抽查条数"
                      value={sampleCount}
                      onInput={(e) => setSampleCount(e.detail.value.replace(/\D/gi, ''))}
                    />
                  </View>
                )}
              </View>

              <Button className="mt-5 w-full" size="lg" disabled={!selectedIds.length} onClick={startFromBank}>
                开始默写（已选 {selectedIds.length} 个词单）
              </Button>
            </>
          )}
        </View>
      )}

      {/* 默写答题 */}
      {activeTab === 'home' && step === 'quiz' && currentWord && (
        <View>
          <Card className="mb-4">
            <CardContent className="p-5">
              <View className="mb-4 flex flex-row items-center justify-between">
                <Text className="block text-sm font-semibold">
                  第 {quizIndex + 1} / {total} 题
                </Text>
                <Badge variant="secondary">
                  <Coins size={12} color="#f59e0b" />
                  <Text className="text-xs font-semibold text-amber-700">+10 / 题</Text>
                </Badge>
              </View>
              <Progress value={progressValue} className="mb-5" />

              <View className="rounded-xl bg-muted p-5 text-center">
                {mode === 'zh2en' ? (
                  <>
                    <Text className="block text-2xl font-bold leading-relaxed">{currentWord.zh}</Text>
                    <Text className="mt-2 block text-sm text-muted-foreground">请输入对应的英文单词</Text>
                  </>
                ) : (
                  <>
                    <Text className="block text-2xl font-bold leading-relaxed">{currentWord.en}</Text>
                    <Text className="mt-2 block text-sm text-muted-foreground">请输入对应的中文意思</Text>
                  </>
                )}
              </View>

              {feedback ? (
                <View
                  id="answer-feedback"
                  className={
                    feedback.correct
                      ? 'mt-4 rounded-xl bg-emerald-50 p-4'
                      : 'mt-4 rounded-xl bg-red-50 p-4'
                  }
                >
                  <View className="mb-1 flex flex-row items-center gap-2">
                    {feedback.correct ? (
                      <CircleCheck size={18} color="#059669" />
                    ) : (
                      <CircleX size={18} color="#dc2626" />
                    )}
                    <Text
                      className={
                        feedback.correct
                          ? 'block text-base font-bold text-emerald-700'
                          : 'block text-base font-bold text-red-600'
                      }
                    >
                      {feedback.correct ? '回答正确' : '回答错误'}
                    </Text>
                  </View>
                  {!feedback.correct && (
                    <Text className="block text-sm text-red-600">参考答案：{feedback.reference}</Text>
                  )}
                  {feedback.correct && feedback.pointsAwarded > 0 && (
                    <Text className="block text-sm text-emerald-700">
                      获得 {feedback.pointsAwarded} 成长值
                    </Text>
                  )}
                  {feedback.acceptedAlternative && (
                    <Text className="mt-1 block text-xs text-emerald-600">
                      你用了同义表达，语义正确，已按正确计分
                    </Text>
                  )}
                  {feedback.explanation ? (
                    <Text
                      className={
                        feedback.correct
                          ? 'mt-2 block text-sm text-emerald-800'
                          : 'mt-2 block text-sm text-red-700'
                      }
                    >
                      {feedback.explanation}
                    </Text>
                  ) : null}
                  <Button className="mt-3 w-full" onClick={nextQuestion}>
                    {quizIndex + 1 >= total ? '查看成绩' : '下一题'}
                  </Button>
                </View>
              ) : (
                <View className="mt-4">
                  <View
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      width: '100%',
                      borderRadius: '12px',
                      backgroundColor: '#f2f2f7',
                      padding: '8px 14px',
                      boxSizing: 'border-box',
                    }}
                  >
                    <Input
                      style={{
                        flex: 1,
                        width: '100%',
                        fontSize: '17px',
                        backgroundColor: 'transparent',
                        padding: '0',
                        boxSizing: 'border-box',
                      }}
                      placeholder={mode === 'zh2en' ? '输入英文单词' : '输入中文意思'}
                      value={answer}
                      onInput={(e) => setAnswer(e.detail.value)}
                    />
                  </View>
                  <Button className="mt-3 w-full" size="lg" onClick={handleSubmit} disabled={!answer.trim() || checking}>
                    <Text>{checking ? '判题中…' : '提交答案'}</Text>
                  </Button>
                </View>
              )}
            </CardContent>
          </Card>
        </View>
      )}

      {/* 结果 */}
      {activeTab === 'home' && step === 'result' && (
        <View>
          <Card className="mb-4 text-center">
            <CardContent className="p-8">
              <Text className="block text-2xl font-bold">本轮完成</Text>
              <View className="mt-6 flex flex-row items-center justify-center gap-2">
                <CircleCheck size={20} color="#059669" />
                <Text className="block text-lg font-semibold">
                  答对 {sessionCorrect} / {total} 题
                </Text>
              </View>
              <View className="mt-4 flex flex-row gap-3">
                <View className="flex flex-1 flex-col items-center rounded-xl bg-sky-100 px-3 py-3">
                  <Text className="block text-xl font-bold text-sky-800">{totalCount}</Text>
                  <Text className="mt-1 block text-xs text-sky-800">总答题数量</Text>
                </View>
                <View className="flex flex-1 flex-col items-center rounded-xl bg-sky-100 px-3 py-3">
                  <Text className="block text-xl font-bold text-sky-800">{correctCount}</Text>
                  <Text className="mt-1 block text-xs text-sky-800">总答对数量</Text>
                </View>
              </View>
              <View className="mt-4 flex flex-row items-center justify-center gap-2">
                <Coins size={20} color="#f59e0b" />
                <Text className="block text-lg font-semibold text-amber-700">
                  获得 {sessionEarned} 成长值
                </Text>
              </View>
              <Text className="mt-2 block text-sm text-muted-foreground">
                当前累计 {points} 成长值
              </Text>
              <Button className="mt-6 w-full" size="lg" onClick={() => startQuiz()}>
                <RotateCcw size={16} color="#e92e6f" />
                <Text>再默写一轮</Text>
              </Button>
              <Button
                className="mt-3 w-full"
                variant="outline"
                onClick={() => {
                  setStep('upload');
                  setImagePath('');
                  setWords([]);
                  setFeedback(null);
                }}
              >
                换一张图片
              </Button>
            </CardContent>
          </Card>
        </View>
      )}

      {/* 我的成长值（独立视图） */}
      {activeTab === 'growth' && (
        <View>
          <View className="mb-4 flex flex-row items-center justify-between">
            <Text className="block text-lg font-bold">我的成长值</Text>
            <Button size="sm" variant="ghost" onClick={() => setActiveTab('home')}>
              返回首页
            </Button>
          </View>
          <View className="mt-2 flex flex-col items-center rounded-2xl bg-card py-6 shadow-sm">
            <Text className="block text-3xl font-bold text-amber-600">{points}</Text>
            <Text className="mt-1 block text-sm text-muted-foreground">当前累计成长值</Text>
          </View>
          <View className="mt-3 rounded-xl bg-sky-50 p-4">
            <Text className="block text-sm font-semibold text-sky-900">成长值里程碑</Text>
            <Text className="mt-1 block text-xs text-sky-700">
              当前 {Math.min(points, 20000)} / 20000 分
            </Text>
            <View className="mt-3 h-2 w-full overflow-hidden rounded-full bg-sky-200">
              <View
                className="h-full rounded-full bg-sky-600"
                style={{ width: `${Math.min((points / 20000) * 100, 100)}%` }}
              />
            </View>
            <View className="mt-3 flex flex-col gap-1.5">
              {[
                { pts: 500, label: '迷你奖' },
                { pts: 2000, label: '小奖' },
                { pts: 5000, label: '普通奖' },
                { pts: 10000, label: '进步奖' },
                { pts: 20000, label: '终极大奖' },
              ].map((m) => (
                <View
                  key={m.pts}
                  className={`flex flex-row items-center justify-between rounded-lg px-3 py-2 ${
                    points >= m.pts ? 'bg-sky-600' : 'bg-white'
                  }`}
                >
                  <Text className={points >= m.pts ? 'block text-sm text-white' : 'block text-sm text-sky-800'}>
                    {points >= m.pts ? '已达成' : '待达成'} · {m.pts} 分
                  </Text>
                  <Text className={points >= m.pts ? 'block text-sm font-semibold text-white' : 'block text-sm font-semibold text-sky-800'}>
                    {m.label}
                  </Text>
                </View>
              ))}
            </View>
          </View>
          <View className="mt-3 rounded-xl border border-border p-4">
            <Text className="mb-1 block text-sm font-semibold">手动修改成长值</Text>
            <Text className="block text-xs text-muted-foreground">
              填写目标成长值（必填）。总答题/总答对数量留空则保持当前值。
            </Text>
            <View className="mt-2 rounded-xl bg-muted px-3 py-2">
              <Input
                className="w-full bg-transparent"
                type="number"
                placeholder="成长值（必填）"
                value={setPointsInput}
                onInput={(e) => setSetPointsInput(e.detail.value)}
              />
            </View>
            <View className="mt-2 rounded-xl bg-muted px-3 py-2">
              <Input
                className="w-full bg-transparent"
                type="number"
                placeholder="总答对数量（留空不变）"
                value={setCorrectInput}
                onInput={(e) => setSetCorrectInput(e.detail.value)}
              />
            </View>
            <View className="mt-2 rounded-xl bg-muted px-3 py-2">
              <Input
                className="w-full bg-transparent"
                type="number"
                placeholder="总答题数量（留空不变）"
                value={setTotalInput}
                onInput={(e) => setSetTotalInput(e.detail.value)}
              />
            </View>
            <View className="mt-2 rounded-xl bg-muted px-3 py-2">
              <Input
                className="w-full bg-transparent"
                password
                placeholder="请输入密码"
                value={resetPwd}
                onInput={(e) => setResetPwd(e.detail.value)}
              />
            </View>
            <Button className="mt-3 w-full" variant="destructive" disabled={resetting} onClick={handleSetPoints}>
              {resetting ? '保存中…' : '确认修改'}
            </Button>
          </View>
        </View>
      )}

      <Dialog open={editOpen} onOpenChange={(v) => setEditOpen(!!v)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>编辑词条</DialogTitle>
          </DialogHeader>
          <View className="flex flex-col gap-3">
            <View style={{ display: "flex", alignItems: "center", width: "100%", borderRadius: "12px", backgroundColor: "#f2f2f7", padding: "0 12px", minHeight: "48px", boxSizing: "border-box" }}>
              <Input
                style={{ width: '100%', fontSize: '16px', padding: '0', boxSizing: 'border-box' }}
                value={editEn}
                onInput={(e) => setEditEn(e.detail.value)}
                placeholder="英文（单词或短语）"
              />
            </View>
            <View style={{ display: "flex", alignItems: "center", width: "100%", borderRadius: "12px", backgroundColor: "#f2f2f7", padding: "0 12px", minHeight: "48px", boxSizing: "border-box" }}>
              <Input
                style={{ width: '100%', fontSize: '16px', padding: '0', boxSizing: 'border-box' }}
                value={editZh}
                onInput={(e) => setEditZh(e.detail.value)}
                placeholder="中文释义"
              />
            </View>
          </View>
          <View
            className="mt-4 flex flex-row items-center justify-center gap-1"
            style={{ alignSelf: 'flex-start' }}
          >
            <Trash2 size={15} color="#d11a4d" />
            <Text
              className="block text-sm"
              style={{ color: '#d11a4d' }}
              onClick={() => {
                if (editIdx >= 0) {
                  const i = editIdx;
                  setEditOpen(false);
                  deleteWord(i);
                }
              }}
            >
              删除此词条
            </Text>
          </View>
          <DialogFooter className="mt-3">
            <Button variant="outline" className="w-full" onClick={() => setEditOpen(false)}>
              取消
            </Button>
            <Button className="mt-2 w-full" onClick={handleSaveEdit}>
              保存
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={helpOpen} onOpenChange={setHelpOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>成长值是什么？</DialogTitle>
          </DialogHeader>
          <View className="flex flex-col gap-2.5">
              <Text className="block text-sm leading-relaxed text-foreground">
                成长值代表你的学习成长，通过每次默写不断累积：
              </Text>
              <View className="flex flex-row items-start gap-2">
                <CircleCheck size={15} color="#188649" />
                <Text className="block flex-1 text-sm text-foreground">每答对一题，成长值 +10</Text>
              </View>
              <View className="flex flex-row items-start gap-2">
                <CircleX size={15} color="#d11a4d" />
                <Text className="block flex-1 text-sm text-foreground">答错不会扣成长值</Text>
              </View>
              <Text className="block pt-1 text-sm text-muted-foreground">
                达到对应档位可解锁成就：500 迷你奖 · 2000 小奖 · 5000 普通奖 · 10000 进步奖 · 20000 终极大奖
              </Text>
            </View>
          <DialogFooter className="mt-4">
            <Button className="w-full" onClick={() => setHelpOpen(false)}>
              知道了
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 底部快速导航 */}
      <View
        style={{
          position: 'fixed',
          bottom: 0,
          left: 0,
          right: 0,
          zIndex: 200,
          borderTopLeftRadius: 16,
          borderTopRightRadius: 16,
          backgroundColor: '#ffffff',
          borderTop: '0.5px solid #e5e5ea',
          boxShadow: '0 -4px 16px rgba(0,0,0,0.06)',
        }}
      >
        <View className="mx-auto flex w-full max-w-2xl flex-row items-center justify-around py-2">
          {(
            [
              { key: 'home', label: '首页', icon: <House size={22} color={activeTab === 'home' ? '#e92e6f' : '#999'} /> },
              { key: 'words', label: '我的单词', icon: <Library size={22} color={activeTab === 'words' ? '#e92e6f' : '#999'} /> },
              { key: 'growth', label: '我的成长值', icon: <TrendingUp size={22} color={activeTab === 'growth' ? '#e92e6f' : '#999'} /> },
            ] as const
          ).map((tab) => (
            <View
              key={tab.key}
              className="flex flex-col items-center px-6 py-1"
              onClick={() => {
                if (tab.key === 'words') openBank();
                else setActiveTab(tab.key as 'home' | 'growth');
              }}
            >
              {tab.icon}
              <Text
                className={`mt-1 block text-xs ${activeTab === tab.key ? 'font-semibold text-primary' : 'text-gray-400'}`}
              >
                {tab.label}
              </Text>
            </View>
          ))}
        </View>
      </View>
      </View>
    </View>
  );
}