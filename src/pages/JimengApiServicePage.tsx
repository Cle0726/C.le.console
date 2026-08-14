import { useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { open } from '@tauri-apps/plugin-dialog';
import {
  Activity, BadgeCheck, CircleAlert, Clipboard, Coins, Copy, Download, Film,
  Gauge, Globe2, HeartPulse, Image as ImageIcon, KeyRound, Layers3,
  LoaderCircle, PanelsTopLeft, Plus, Power, RefreshCw, Save, ShieldCheck, Sparkles,
  Trash2, Upload, WandSparkles,
} from 'lucide-react';
import { jimengApiService } from '../services/jimengApiService';
import type {
  JimengAccount, JimengApiConfig, JimengApiState, JimengMediaRequest, JimengRegion,
  JimengDeviceFlow, JimengRepairReport,
  DoubaoWebState,
} from '../types/jimengApi';
import './JimengApiServicePage.unified.css';
import jimengIcon from '../assets/jimeng.png';

type Tab = 'overview' | 'accounts' | 'image' | 'video' | 'tasks' | 'api';
type Notice = { tone: 'success' | 'error' | 'info'; text: string } | null;
type AccountActionRow = {
  accountId?: string;
  name?: string;
  region?: string;
  ok?: boolean;
  error?: string | null;
  requiresLogin?: boolean;
};
type TaskRecord = {
  id: string;
  kind: 'image' | 'composition' | 'video';
  model: string;
  prompt: string;
  status: 'running' | 'success' | 'failed';
  startedAt: number;
  finishedAt?: number;
  result?: Record<string, unknown>;
  error?: string;
};

const TASK_STORAGE_KEY = 'cle.jimeng.tasks.v1';

function restoreTasks(): TaskRecord[] {
  try {
    const value = JSON.parse(localStorage.getItem(TASK_STORAGE_KEY) ?? '[]');
    return Array.isArray(value) ? value.slice(0, 40) : [];
  } catch {
    return [];
  }
}

const REGIONS: Array<{ id: JimengRegion; label: string }> = [
  { id: 'cn', label: '中国站' },
  { id: 'us', label: '美国站' },
  { id: 'hk', label: '香港站' },
  { id: 'jp', label: '日本站' },
  { id: 'sg', label: '新加坡站' },
];

const RATIOS = ['1:1', '4:3', '3:4', '16:9', '9:16', '3:2', '2:3', '21:9'];
const IMAGE_RESOLUTIONS = ['1k', '2k', '4k'];
const VIDEO_RESOLUTIONS = ['720p', '1080p'];
const DOUBAO_WEB_MODEL_ID = 'doubao-web-seedance-2.0';

function videoDurations(model: string): number[] {
  if (model === DOUBAO_WEB_MODEL_ID) return [5];
  if (model.includes('veo3')) return [8];
  if (model.includes('sora2')) return [4, 8, 12];
  if (model.includes('seedance-2.0')) return Array.from({ length: 12 }, (_, index) => index + 4);
  if (model.includes('3.5-pro')) return [5, 10, 12];
  return [5, 10];
}

const blankAccount = (): JimengAccount => ({
  id: crypto.randomUUID?.() ?? `${Date.now()}-${Math.random()}`,
  name: '',
  region: 'cn',
  sessionId: '',
  authMethod: 'oauthDevice',
  oauthHome: '',
  proxyUrl: '',
  priority: 0,
  enabled: true,
});

function taskDuration(task: TaskRecord) {
  const end = task.finishedAt ?? Date.now();
  return Math.max(0, Math.round((end - task.startedAt) / 1000));
}

function extractAssets(result?: Record<string, unknown>) {
  const data = Array.isArray(result?.data) ? result?.data : [];
  return data.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const record = item as Record<string, unknown>;
    if (typeof record.url === 'string') return [record.url];
    if (typeof record.b64_json === 'string') return [`data:image/png;base64,${record.b64_json}`];
    return [];
  });
}

async function copyText(text: string) {
  await navigator.clipboard.writeText(text);
}

function accountActionRows(value: unknown): AccountActionRow[] {
  return Array.isArray(value)
    ? value.filter((item): item is AccountActionRow => !!item && typeof item === 'object')
    : [];
}

function accountActionFailureText(rows: AccountActionRow[]) {
  const failed = rows.filter((row) => row.ok !== true);
  if (!failed.length) return null;
  const riskBlocked = failed.filter((row) => /shark action check reject|risk|风控/i.test(row.error || ''));
  const needsLogin = failed.filter((row) => row.requiresLogin);
  const labels = (riskBlocked.length ? riskBlocked : needsLogin.length ? needsLogin : failed)
    .map((row) => row.name || row.region?.toUpperCase() || '未知账号')
    .slice(0, 3)
    .join('、');
  if (riskBlocked.length) {
    return `${labels} 登录态有效，但积分领取被 Dreamina 风控拦截；请点击账号右侧“浏览器登录/验证”，在专用浏览器完成验证或领取`;
  }
  if (needsLogin.length) {
    return `${labels} 登录态无效，请点击账号右侧“浏览器登录/验证”并重新登录`;
  }
  return `${labels} 操作失败：${failed[0]?.error || '上游未返回有效结果'}`;
}

function generationErrorText(error: unknown) {
  const message = String(error);
  if (/browser identity missing|requiresBrowserLogin|login error|session expired|HTTP (401|403)|网页登录态/i.test(message)) {
    return `所选账号的网页登录态已失效，请在“账号池”中重新完成浏览器登录。\n${message}`;
  }
  if (/quota|insufficient|credit|额度|积分/i.test(message)) {
    return `账号积分不足或领取失败，请先在“账号池”中查询或领取积分。\n${message}`;
  }
  if (/模型不支持|不支持模型|not supported|invalid.*model/i.test(message)) {
    return `当前账号不支持所选模型，请切换账号、模型或使用自动故障切换。\n${message}`;
  }
  return message;
}

export function JimengApiServicePage({ onOpenCanvas }: { onOpenCanvas?: () => void } = {}) {
  const [state, setState] = useState<JimengApiState | null>(null);
  const [draft, setDraft] = useState<JimengApiConfig | null>(null);
  const [tab, setTab] = useState<Tab>('overview');
  const [busy, setBusy] = useState<string | null>('load');
  const [notice, setNotice] = useState<Notice>(null);
  const [editing, setEditing] = useState<JimengAccount | null>(null);
  const [deviceFlow, setDeviceFlow] = useState<JimengDeviceFlow | null>(null);
  const [accountResult, setAccountResult] = useState<unknown>(null);
  const [repair, setRepair] = useState<JimengRepairReport | null>(null);
  const [tasks, setTasks] = useState<TaskRecord[]>(restoreTasks);
  const [doubaoWeb, setDoubaoWeb] = useState<DoubaoWebState | null>(null);
  const [doubaoWebBusy, setDoubaoWebBusy] = useState(false);

  const [imageMode, setImageMode] = useState<'generation' | 'composition'>('generation');
  const [imageAccountId, setImageAccountId] = useState('');
  const [imageModel, setImageModel] = useState('jimeng-4.5');
  const [imagePrompt, setImagePrompt] = useState('');
  const [negativePrompt, setNegativePrompt] = useState('');
  const [imageRatio, setImageRatio] = useState('1:1');
  const [imageResolution, setImageResolution] = useState('2k');
  const [intelligentRatio, setIntelligentRatio] = useState(false);
  const [sampleStrength, setSampleStrength] = useState(0.7);
  const [imagePaths, setImagePaths] = useState<string[]>([]);
  const [imageUrls, setImageUrls] = useState('');
  const [responseFormat, setResponseFormat] = useState<'url' | 'b64_json'>('url');

  const [videoAccountId, setVideoAccountId] = useState('');
  const [videoModel, setVideoModel] = useState('jimeng-video-3.5-pro');
  const [videoPrompt, setVideoPrompt] = useState('');
  const [videoMode, setVideoMode] = useState<'text' | 'first' | 'first-last' | 'omni'>('text');
  const [videoRatio, setVideoRatio] = useState('16:9');
  const [videoResolution, setVideoResolution] = useState('720p');
  const [videoDuration, setVideoDuration] = useState(5);
  const [videoImagePaths, setVideoImagePaths] = useState<string[]>([]);
  const [videoReferencePaths, setVideoReferencePaths] = useState<string[]>([]);
  const [referenceUrls, setReferenceUrls] = useState('');

  const load = useCallback(async (quiet = false) => {
    if (!quiet) setBusy('load');
    try {
      const next = await jimengApiService.getState();
      setState((current) => (
        current && JSON.stringify(current) === JSON.stringify(next)
          ? current
          : next
      ));
      setDraft((current) => quiet && current ? current : structuredClone(next.config));
      const enabledAccountIds = new Set(next.config.accounts.filter((account) => account.enabled).map((account) => account.id));
      setImageAccountId((current) => current && enabledAccountIds.has(current) ? current : '');
      setVideoAccountId((current) => current && enabledAccountIds.has(current) ? current : '');
    } catch (error) {
      setNotice({ tone: 'error', text: `读取即梦服务状态失败：${String(error)}` });
    } finally {
      if (!quiet) setBusy(null);
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => {
      if (!document.hidden) void load(true);
    }, 10_000);
    return () => window.clearInterval(timer);
  }, [load]);

  useEffect(() => {
    localStorage.setItem(TASK_STORAGE_KEY, JSON.stringify(tasks.slice(0, 40)));
  }, [tasks]);

  useEffect(() => {
    if (!deviceFlow || deviceFlow.status !== 'pending') return;
    let disposed = false;
    const interval = window.setInterval(async () => {
      try {
        const next = await jimengApiService.pollDeviceFlow(deviceFlow.flowId);
        if (disposed) return;
        setDeviceFlow(next);
        if (next.status === 'authorized') {
          await load(true);
          setNotice({ tone: 'success', text: next.message || '浏览器登录完成，即梦 Session 账号已加入账号池' });
          setEditing(null);
        }
      } catch (error) {
        if (!disposed) {
          setDeviceFlow((current) => current ? {
            ...current,
            status: 'failed',
            message: String(error),
          } : current);
        }
      }
    }, Math.max(1500, deviceFlow.pollInterval * 1000));
    return () => {
      disposed = true;
      window.clearInterval(interval);
    };
  }, [deviceFlow?.flowId, deviceFlow?.pollInterval, deviceFlow?.status, load]);

  const enabledAccounts = useMemo(
    () => draft?.accounts.filter((account) => account.enabled) ?? [],
    [draft?.accounts],
  );
  const selfHealLabel = state?.selfHeal?.status === 'healthy'
    ? '正常'
    : state?.selfHeal?.status === 'recovering'
      ? '恢复中'
      : state?.selfHeal?.status === 'degraded'
        ? '降级'
        : '待命';
  const selectedImageAccount = enabledAccounts.find((account) => account.id === imageAccountId);
  const selectedVideoAccount = enabledAccounts.find((account) => account.id === videoAccountId);
  const selectedImageRegion = selectedImageAccount?.region;
  const selectedVideoRegion = selectedVideoAccount?.region;
  const imageModels = useMemo(
    () => state?.models.filter((model) =>
      model.kind === 'image'
      && (!selectedImageRegion || selectedImageAccount?.authMethod === 'oauthDevice' || model.regions.includes(selectedImageRegion))) ?? [],
    [selectedImageAccount?.authMethod, selectedImageRegion, state?.models],
  );
  const videoModels = useMemo(
    () => [
      ...(state?.models.filter((model) =>
        model.kind === 'video'
        && (!selectedVideoRegion || model.regions.includes(selectedVideoRegion))
        && (selectedVideoAccount?.authMethod !== 'oauthDevice'
          || model.id === 'jimeng-video-seedance-2.0'
          || model.id === 'jimeng-video-seedance-2.0-fast')) ?? []),
      { id: DOUBAO_WEB_MODEL_ID, kind: 'video' as const, regions: ['cn' as const] },
    ],
    [selectedVideoAccount?.authMethod, selectedVideoRegion, state?.models],
  );
  const durationOptions = useMemo(() => videoDurations(videoModel), [videoModel]);
  const isDoubaoWebVideo = videoModel === DOUBAO_WEB_MODEL_ID;
  const supportsOmni = selectedVideoRegion === 'cn'
    && (videoModel === 'jimeng-video-seedance-2.0' || videoModel === 'jimeng-video-seedance-2.0-fast');

  useEffect(() => {
    if (imageModels.length && !imageModels.some((model) => model.id === imageModel)) {
      setImageModel(imageModels[0].id);
    }
  }, [imageModel, imageModels]);

  useEffect(() => {
    if (videoModels.length && !videoModels.some((model) => model.id === videoModel)) {
      setVideoModel(videoModels[0].id);
    }
  }, [videoModel, videoModels]);

  useEffect(() => {
    if (!durationOptions.includes(videoDuration)) {
      setVideoDuration(durationOptions[0]);
    }
  }, [durationOptions, videoDuration]);

  useEffect(() => {
    if (videoMode === 'omni' && !supportsOmni) {
      setVideoMode('text');
    }
  }, [supportsOmni, videoMode]);

  useEffect(() => {
    if (!isDoubaoWebVideo) return;
    setVideoMode('text');
    setVideoAccountId('');
    setVideoRatio((current) => ['1:1', '16:9', '9:16'].includes(current) ? current : '16:9');
    void jimengApiService.getDoubaoWebState().then(setDoubaoWeb).catch(() => undefined);
  }, [isDoubaoWebVideo]);

  useEffect(() => {
    if (!isDoubaoWebVideo || !doubaoWeb?.windowOpen) return;
    const timer = window.setInterval(() => {
      void jimengApiService.getDoubaoWebState().then(setDoubaoWeb).catch(() => undefined);
    }, 2500);
    return () => window.clearInterval(timer);
  }, [doubaoWeb?.windowOpen, isDoubaoWebVideo]);

  const openDoubaoWebLogin = async () => {
    setDoubaoWebBusy(true);
    try {
      const next = await jimengApiService.openDoubaoWebLogin();
      setDoubaoWeb(next);
      setNotice({ tone: 'info', text: next.loggedIn ? '豆包网页版已登录' : '请在专用窗口完成豆包登录，完成后本页会自动检测' });
    } catch (error) {
      setNotice({ tone: 'error', text: `无法打开豆包网页版：${String(error)}` });
    } finally {
      setDoubaoWebBusy(false);
    }
  };

  const logoutDoubaoWeb = async () => {
    setDoubaoWebBusy(true);
    try {
      const next = await jimengApiService.logoutDoubaoWeb();
      setDoubaoWeb(next);
      setNotice({ tone: 'success', text: next.message });
    } catch (error) {
      setNotice({ tone: 'error', text: `清除豆包登录状态失败：${String(error)}` });
    } finally {
      setDoubaoWebBusy(false);
    }
  };

  const save = async (config = draft) => {
    if (!config) return;
    setBusy('save');
    setNotice(null);
    try {
      const next = await jimengApiService.saveConfig(config);
      setState(next);
      setDraft(structuredClone(next.config));
      setNotice({ tone: 'success', text: '即梦配置已保存并应用' });
    } catch (error) {
      setNotice({ tone: 'error', text: `保存失败：${String(error)}` });
    } finally {
      setBusy(null);
    }
  };

  const toggleService = async () => {
    if (!state) return;
    setBusy('toggle');
    setNotice(null);
    try {
      const next = await jimengApiService.setEnabled(!state.running);
      setState(next);
      setDraft(structuredClone(next.config));
      setNotice({ tone: 'success', text: next.running ? '即梦 API 已独立启动' : '即梦 API 已停止' });
    } catch (error) {
      setNotice({ tone: 'error', text: `服务操作失败：${String(error)}` });
      await load(true);
    } finally {
      setBusy(null);
    }
  };

  const runAccountAction = async (action: 'check' | 'points' | 'receive', accountId?: string) => {
    setBusy(`${action}:${accountId ?? 'all'}`);
    setAccountResult(null);
    try {
      const result = await jimengApiService.accountAction(action, accountId);
      setAccountResult(result);
      const failure = accountActionFailureText(accountActionRows(result));
      setNotice({
        tone: failure ? 'error' : 'success',
        text: failure || (action === 'check' ? '账号状态检查完成' : action === 'points' ? '积分查询完成' : '每日积分领取完成'),
      });
    } catch (error) {
      setNotice({ tone: 'error', text: `账号操作失败：${String(error)}` });
    } finally {
      setBusy(null);
    }
  };

  const chooseFiles = async (kind: 'image' | 'video', multiple = true): Promise<string[]> => {
    const selected = await open({
      multiple,
      filters: [{
        name: kind === 'image' ? '图片素材' : '视频素材',
        extensions: kind === 'image'
          ? ['png', 'jpg', 'jpeg', 'webp', 'gif']
          : ['mp4', 'mov', 'webm', 'mkv'],
      }],
    });
    if (!selected) return [];
    return typeof selected === 'string' ? [selected] : [...selected];
  };

  const runTask = async (
    kind: TaskRecord['kind'],
    model: string,
    prompt: string,
    operation: () => Promise<Record<string, unknown>>,
  ) => {
    const task: TaskRecord = {
      id: crypto.randomUUID?.() ?? String(Date.now()),
      kind,
      model,
      prompt,
      status: 'running',
      startedAt: Date.now(),
    };
    setTasks((current) => [task, ...current].slice(0, 50));
    setBusy(`task:${task.id}`);
    setTab('tasks');
    try {
      const result = await operation();
      setTasks((current) => current.map((item) =>
        item.id === task.id
          ? { ...item, status: 'success', result, finishedAt: Date.now() }
          : item));
      setNotice({ tone: 'success', text: '生成任务已完成' });
    } catch (error) {
      const message = generationErrorText(error);
      setTasks((current) => current.map((item) =>
        item.id === task.id
          ? { ...item, status: 'failed', error: message, finishedAt: Date.now() }
          : item));
      setNotice({ tone: 'error', text: `生成失败：${message}` });
    } finally {
      setBusy(null);
    }
  };

  const submitImage = async () => {
    if (!imagePrompt.trim()) {
      setNotice({ tone: 'error', text: '请填写图片提示词' });
      return;
    }
    const urlImages = imageUrls.split('\n').map((value) => value.trim()).filter(Boolean);
    const payload: Record<string, unknown> = {
      model: imageModel,
      prompt: imagePrompt.trim(),
      ratio: imageRatio,
      resolution: imageResolution,
      intelligent_ratio: intelligentRatio,
      negative_prompt: negativePrompt.trim() || undefined,
      sample_strength: sampleStrength,
      response_format: responseFormat,
      ...(imageMode === 'composition' && urlImages.length ? { images: urlImages } : {}),
    };
    const request: JimengMediaRequest = {
      accountId: imageAccountId || null,
      payload,
      imagePaths: imageMode === 'composition' ? imagePaths : [],
    };
    await runTask(
      imageMode === 'composition' ? 'composition' : 'image',
      imageModel,
      imagePrompt,
      () => imageMode === 'composition'
        ? jimengApiService.composeImage(request)
        : jimengApiService.generateImage(request),
    );
  };

  const submitVideo = async () => {
    if (!videoPrompt.trim()) {
      setNotice({ tone: 'error', text: '请填写视频提示词' });
      return;
    }
    if (!durationOptions.includes(videoDuration)) {
      setNotice({ tone: 'error', text: `当前模型仅支持 ${durationOptions.join(' / ')} 秒` });
      return;
    }
    if (videoMode === 'omni' && !supportsOmni) {
      setNotice({ tone: 'error', text: 'Omni Reference 仅支持中国区 Seedance 2.0 / Fast 账号' });
      return;
    }
    if (isDoubaoWebVideo) {
      if (videoMode !== 'text') {
        setNotice({ tone: 'error', text: '豆包网页版首版接入当前支持文生视频，请切换到“文生视频”' });
        return;
      }
      if (!['1:1', '16:9', '9:16'].includes(videoRatio)) {
        setNotice({ tone: 'error', text: '豆包网页版当前仅支持 1:1、16:9、9:16' });
        return;
      }
      await runTask('video', videoModel, videoPrompt, () =>
        jimengApiService.generateDoubaoWebVideo({
          prompt: videoPrompt.trim(),
          ratio: videoRatio as '1:1' | '16:9' | '9:16',
        }));
      return;
    }
    const urls = referenceUrls.split('\n').map((value) => value.trim()).filter(Boolean);
    const payload: Record<string, unknown> = {
      model: videoModel,
      prompt: videoPrompt.trim(),
      ratio: videoRatio,
      resolution: videoResolution,
      duration: videoDuration,
      response_format: 'url',
      functionMode: videoMode === 'omni' ? 'omni_reference' : 'first_last_frames',
      ...(urls.length ? { filePaths: urls } : {}),
    };
    await runTask('video', videoModel, videoPrompt, () =>
      jimengApiService.generateVideo({
        accountId: videoAccountId || null,
        payload,
        imagePaths: videoMode === 'text' ? [] : videoImagePaths,
        videoPaths: videoMode === 'omni' ? videoReferencePaths : [],
      }));
  };

  const diagnose = async () => {
    setBusy('repair');
    setRepair(null);
    try {
      const report = await jimengApiService.diagnoseAndRepair();
      setRepair(report);
      setState(report.state);
      setDraft(structuredClone(report.state.config));
      setNotice({
        tone: report.ok ? 'success' : 'error',
        text: report.ok ? '全面检查完成，服务状态正常' : '检查完成，仍有项目需要处理',
      });
    } catch (error) {
      setNotice({ tone: 'error', text: `诊断修复失败：${String(error)}` });
    } finally {
      setBusy(null);
    }
  };

  const closeAccountModal = async () => {
    const flow = deviceFlow;
    setEditing(null);
    setDeviceFlow(null);
    if (flow?.status === 'pending') {
      try {
        await jimengApiService.cancelDeviceFlow(flow.flowId);
      } catch {
        // The flow may already have finished between the click and cancellation.
      }
    }
  };

  const startDeviceLogin = async () => {
    if (!editing) return;
    setBusy('device-flow');
    setDeviceFlow(null);
    try {
      const flow = await jimengApiService.startDeviceFlow(
        editing.id,
        editing.name.trim() || '即梦浏览器账号',
        editing.region,
      );
      setDeviceFlow(flow);
      setNotice({ tone: 'info', text: '专用登录窗口已打开，登录成功后会自动安全保存 Session' });
    } catch (error) {
      setNotice({ tone: 'error', text: `无法启动即梦浏览器登录：${String(error)}` });
    } finally {
      setBusy(null);
    }
  };

  if (!draft || !state) {
    return (
      <div className="jimeng-page jimeng-loading">
        <LoaderCircle className="spin" size={28} />
        <span>正在装载即梦创作 API…</span>
      </div>
    );
  }

  const pooledToken = enabledAccounts.filter((account) => account.authMethod !== 'oauthDevice' && account.sessionId).map((account) => {
    const regionToken = account.region === 'cn'
      ? account.sessionId
      : `${account.region}-${account.sessionId.replace(/^(us|hk|jp|sg)-/, '')}`;
    return account.proxyUrl ? `${account.proxyUrl}@${regionToken}` : regionToken;
  }).join(',');

  return (
    <div className="jimeng-page">
      <div className="page-top-strip jimeng-page-strip">
        <div className="page-top-strip-left">
          <span className="page-top-strip-label">即梦创作 API</span>
        </div>
        <div className="page-top-strip-right-placeholder" aria-hidden="true" />
      </div>

      <div className="page-tabs-row page-tabs-center page-tabs-row-with-leading jimeng-top-tabs">
        <div className="page-tabs-leading">
          <div className="jimeng-context-label">
            <img src={jimengIcon} alt="" aria-hidden="true" className="jimeng-model-icon" />
            <span>独立创作网关</span>
          </div>
        </div>
        <nav className="page-tabs filter-tabs jimeng-tabs">
          {([
            ['overview', <Gauge size={17} />, '服务总览'],
            ['accounts', <KeyRound size={17} />, '账号池'],
            ['image', <ImageIcon size={17} />, '图片生成'],
            ['video', <Film size={17} />, '视频生成'],
            ['tasks', <Activity size={17} />, '任务中心'],
            ['api', <Clipboard size={17} />, 'API 与诊断'],
          ] as Array<[Tab, React.ReactNode, string]>).map(([id, icon, label]) => (
            <button
              key={id}
              type="button"
              className={`filter-tab${tab === id ? ' active' : ''}`}
              onClick={() => setTab(id)}
            >
              {icon}<span>{label}</span>
              {id === 'tasks' && tasks.some((task) => task.status === 'running') && <i className="jimeng-task-dot" />}
            </button>
          ))}
        </nav>
      </div>

      <header className="jimeng-hero">
        <div className="jimeng-hero-mark"><img src={jimengIcon} alt="" aria-hidden="true" className="jimeng-hero-logo" /></div>
        <div>
          <div className="jimeng-eyebrow">JIMENG / DREAMINA CREATIVE GATEWAY</div>
          <h1>即梦创作 API</h1>
          <p>独立账号池、图像合成、视频生成与故障自愈，不影响 C.le. 主 API 网关。</p>
        </div>
        <div className={`jimeng-live ${state.running ? 'online' : ''}`}>
          <i />
          <span>{state.running ? '运行中' : '未运行'}</span>
          <strong>{state.version}</strong>
        </div>
      </header>

      <section className="jimeng-command-bar">
        <div className="jimeng-endpoint">
          <Globe2 size={17} />
          <code>{state.baseUrl}</code>
          <button className="btn btn-secondary icon-only jimeng-copy-button" onClick={() => void copyText(state.baseUrl)} title="复制地址"><Copy size={15} /></button>
        </div>
        <button className={`btn jimeng-button ${state.running ? 'btn-danger' : 'btn-primary'}`} onClick={() => void toggleService()} disabled={!!busy}>
          <Power size={17} />{state.running ? '停止独立服务' : '启动独立服务'}
        </button>
        <button className="btn btn-secondary jimeng-button" onClick={() => void diagnose()} disabled={!!busy}>
          <HeartPulse size={17} />全面检查与修复
        </button>
        {onOpenCanvas && (
          <button className="btn btn-primary jimeng-button" onClick={onOpenCanvas}>
            <PanelsTopLeft size={17} />打开无限画布
          </button>
        )}
      </section>

      {notice && (
        <div className={`jimeng-notice ${notice.tone}`}>
          {notice.tone === 'error' ? <CircleAlert size={17} /> : <BadgeCheck size={17} />}
          <span>{notice.text}</span>
        </div>
      )}

      <main className="jimeng-content">
        {tab === 'overview' && (
          <div className="jimeng-overview">
            <div className="jimeng-stat-grid">
              <article>
                <span>服务状态</span>
                <strong>{state.running ? '健康' : '离线'}</strong>
                <small title={state.selfHeal?.lastError ?? undefined}>
                  独立端口 {draft.port} · 自愈 {selfHealLabel}
                </small>
              </article>
              <article><span>启用账号</span><strong>{enabledAccounts.length}</strong><small>共 {draft.accounts.length} 个账号</small></article>
              <article><span>图片模型</span><strong>{state.models.filter((model) => model.kind === 'image').length}</strong><small>CN / Dreamina</small></article>
              <article><span>视频模型</span><strong>{state.models.filter((model) => model.kind === 'video').length}</strong><small>含 Seedance / Veo / Sora</small></article>
            </div>
            <section className="jimeng-panel">
              <div className="jimeng-panel-title"><Sparkles size={19} /><div><h2>运行配置</h2><p>保存后仅重启即梦 sidecar，不触碰 1466 主网关。</p></div></div>
              <div className="jimeng-form-grid compact">
                <label><span>独立服务端口</span><input type="number" min={1024} max={65535} value={draft.port} onChange={(event) => setDraft({ ...draft, port: Number(event.target.value) || 15100 })} /></label>
                <label className="jimeng-switch-row"><span>详细调试日志</span><input type="checkbox" checked={draft.debugLogs} onChange={(event) => setDraft({ ...draft, debugLogs: event.target.checked })} /></label>
              </div>
              <button className="btn btn-primary jimeng-button" onClick={() => void save()} disabled={!!busy}><Save size={16} />保存并应用</button>
            </section>
            {repair && (
              <section className="jimeng-panel">
                <div className="jimeng-panel-title"><HeartPulse size={19} /><div><h2>最近一次检查</h2><p>{repair.restarted ? '检测到故障并已重启 sidecar' : '未触发重启'}</p></div></div>
                <div className="jimeng-check-list">
                  {repair.checks.map((check) => <div key={check.id} className={check.status}><strong>{check.id}</strong><span>{check.detail}</span></div>)}
                </div>
              </section>
            )}
          </div>
        )}

        {tab === 'accounts' && (
          <div className="jimeng-accounts-layout">
            <section className="jimeng-panel">
              <div className="jimeng-panel-title"><KeyRound size={19} /><div><h2>即梦账号池</h2><p>优先使用浏览器 OAuth，每个账号均使用隔离凭据目录；Session ID 作为兼容方案。</p></div></div>
              <div className="jimeng-account-actions">
                <button className="btn btn-primary jimeng-button" onClick={() => setEditing(blankAccount())}><Plus size={16} />添加账号</button>
                <button className="btn btn-secondary jimeng-button" onClick={() => void runAccountAction('check')} disabled={!enabledAccounts.length || !!busy}><RefreshCw size={16} />检查全部</button>
                <button className="btn btn-secondary jimeng-button" onClick={() => void runAccountAction('points')} disabled={!enabledAccounts.length || !!busy}><Coins size={16} />查询积分</button>
                <button className="btn btn-secondary jimeng-button" onClick={() => void runAccountAction('receive')} disabled={!enabledAccounts.length || !!busy}><Download size={16} />领取每日积分</button>
              </div>
              <div className="jimeng-account-list">
                {draft.accounts.map((account) => (
                  <article key={account.id} className={!account.enabled ? 'disabled' : ''}>
                    <div className="jimeng-account-region">{account.region.toUpperCase()}</div>
                    <div className="jimeng-account-main">
                      <strong>{account.name}<em className={`jimeng-auth-badge ${account.authMethod === 'oauthDevice' ? 'oauth' : ''}`}>{account.authMethod === 'oauthDevice' ? 'OAuth' : 'Session'}</em></strong>
                      <span>{REGIONS.find((region) => region.id === account.region)?.label} · 优先级 {account.priority}</span>
                      <code>{account.authMethod === 'oauthDevice' ? `隔离登录目录 · ${account.oauthHome || '由 C.le. 自动管理'}` : `${account.proxyUrl || 'DIRECT'} · ••••••${account.sessionId.slice(-6)}`}</code>
                    </div>
                    <div className="jimeng-account-buttons">
                      <button className="btn btn-secondary icon-only" onClick={() => { setDeviceFlow(null); setEditing({ ...structuredClone(account), authMethod: 'oauthDevice' }); }} title="浏览器登录/验证"><Globe2 size={15} /></button>
                      <button className="btn btn-secondary icon-only" onClick={() => void runAccountAction('check', account.id)} title="检查"><RefreshCw size={15} /></button>
                      <button className="btn btn-secondary icon-only" onClick={() => setEditing(structuredClone(account))} title="编辑"><KeyRound size={15} /></button>
                      <button className="btn btn-secondary icon-only" onClick={() => setDraft({ ...draft, accounts: draft.accounts.map((item) => item.id === account.id ? { ...item, enabled: !item.enabled } : item) })} title="启用/停用"><Power size={15} /></button>
                      <button className="btn btn-danger icon-only" onClick={() => setDraft({ ...draft, accounts: draft.accounts.filter((item) => item.id !== account.id) })} title="删除"><Trash2 size={15} /></button>
                    </div>
                  </article>
                ))}
                {!draft.accounts.length && <div className="jimeng-empty">还没有即梦账号。点击“添加账号”，浏览器登录后会自动加入账号池。</div>}
              </div>
              <button className="btn btn-primary jimeng-button" onClick={() => void save()} disabled={!!busy}><Save size={16} />保存账号池</button>
            </section>
            {accountResult != null && <pre className="jimeng-result-console">{JSON.stringify(accountResult, null, 2)}</pre>}
          </div>
        )}

        {tab === 'image' && (
          <section className="jimeng-studio">
            <div className="jimeng-studio-head">
              <div><span>IMAGE LAB</span><h2>图片生成与多图合成</h2></div>
              <div className="jimeng-segmented filter-tabs">
                <button className={`filter-tab ${imageMode === 'generation' ? 'active' : ''}`} onClick={() => setImageMode('generation')}>文生图</button>
                <button className={`filter-tab ${imageMode === 'composition' ? 'active' : ''}`} onClick={() => setImageMode('composition')}>图生图 / 合成</button>
              </div>
            </div>
            <div className="jimeng-form-grid">
              <label><span>使用账号</span><select value={imageAccountId} onChange={(event) => setImageAccountId(event.target.value)}><option value="">自动故障切换</option>{enabledAccounts.map((account) => <option key={account.id} value={account.id}>{account.name} · {account.region.toUpperCase()}</option>)}</select></label>
              <label><span>模型</span><select value={imageModel} onChange={(event) => setImageModel(event.target.value)}>{imageModels.map((model) => <option key={model.id}>{model.id}</option>)}</select></label>
              <label><span>比例</span><select value={imageRatio} onChange={(event) => setImageRatio(event.target.value)} disabled={intelligentRatio}>{RATIOS.map((ratio) => <option key={ratio}>{ratio}</option>)}</select></label>
              <label><span>分辨率</span><select value={imageResolution} onChange={(event) => setImageResolution(event.target.value)}>{IMAGE_RESOLUTIONS.map((resolution) => <option key={resolution}>{resolution}</option>)}</select></label>
              <label className="span-2"><span>提示词</span><textarea rows={5} value={imagePrompt} onChange={(event) => setImagePrompt(event.target.value)} placeholder="描述希望生成的画面、构图、光线与风格…" /></label>
              <label className="span-2"><span>负面提示词</span><input value={negativePrompt} onChange={(event) => setNegativePrompt(event.target.value)} placeholder="不希望出现的元素（可选）" /></label>
              {imageMode === 'composition' && (
                <>
                  <label className="span-2"><span>网络图片 URL（每行一个，最多 10 张）</span><textarea rows={3} value={imageUrls} onChange={(event) => setImageUrls(event.target.value)} /></label>
                  <div className="span-2 jimeng-upload-zone">
                    <button className="btn btn-secondary jimeng-button" onClick={async () => setImagePaths((await chooseFiles('image')).slice(0, 10))}><Upload size={17} />选择本地图片</button>
                    <span>{imagePaths.length ? `已选择 ${imagePaths.length} 张` : '支持 JPG / PNG / WebP / GIF'}</span>
                  </div>
                </>
              )}
              <label><span>采样强度 {sampleStrength.toFixed(2)}</span><input type="range" min="0" max="1" step="0.05" value={sampleStrength} onChange={(event) => setSampleStrength(Number(event.target.value))} /></label>
              <label className="jimeng-switch-row"><span>智能比例</span><input type="checkbox" checked={intelligentRatio} onChange={(event) => setIntelligentRatio(event.target.checked)} /></label>
              <label><span>响应格式</span><select value={responseFormat} onChange={(event) => setResponseFormat(event.target.value as 'url' | 'b64_json')}><option value="url">URL</option><option value="b64_json">Base64</option></select></label>
            </div>
            <button className="btn btn-primary jimeng-generate" onClick={() => void submitImage()} disabled={!!busy || !enabledAccounts.length}><WandSparkles size={20} />开始生成图片</button>
          </section>
        )}

        {tab === 'video' && (
          <section className="jimeng-studio video">
            <div className="jimeng-studio-head"><div><span>MOTION LAB</span><h2>视频生成工作台</h2></div></div>
            <div className="jimeng-mode-grid">
              {([
                ['text', '文生视频', '纯提示词生成'],
                ['first', '首帧视频', '单图作为首帧'],
                ['first-last', '首尾帧', '两张图片控制过渡'],
                ['omni', 'Omni Reference', '混合图片与视频参考'],
              ] as const).map(([id, title, desc]) => (
                <button key={id} className={videoMode === id ? 'active' : ''} onClick={() => setVideoMode(id)} disabled={(isDoubaoWebVideo && id !== 'text') || (id === 'omni' && !supportsOmni)}><strong>{title}</strong><span>{desc}</span></button>
              ))}
            </div>
            {isDoubaoWebVideo && (
              <div className={`jimeng-doubao-login${doubaoWeb?.loggedIn ? ' online' : ''}`}>
                <div>
                  <Globe2 size={20} />
                  <span><strong>{doubaoWeb?.loggedIn ? '豆包网页版已登录' : '豆包网页版未登录'}</strong><small>{doubaoWeb?.message || '使用独立浏览器配置，不需要手动复制 Cookie'}</small></span>
                </div>
                <div>
                  <button className="btn btn-secondary jimeng-button" disabled={doubaoWebBusy} onClick={() => void openDoubaoWebLogin()}>{doubaoWebBusy ? <LoaderCircle className="spin" size={16} /> : <Globe2 size={16} />}{doubaoWeb?.loggedIn ? '打开豆包网页版' : '登录豆包网页版'}</button>
                  {doubaoWeb?.loggedIn && <button className="btn btn-secondary jimeng-button" disabled={doubaoWebBusy} onClick={() => void logoutDoubaoWeb()}>退出登录</button>}
                </div>
              </div>
            )}
            <div className="jimeng-form-grid">
              <label><span>使用账号</span><select value={videoAccountId} onChange={(event) => setVideoAccountId(event.target.value)} disabled={isDoubaoWebVideo}><option value="">{isDoubaoWebVideo ? '豆包网页版会话' : '自动故障切换'}</option>{!isDoubaoWebVideo && enabledAccounts.map((account) => <option key={account.id} value={account.id}>{account.name} · {account.region.toUpperCase()}</option>)}</select></label>
              <label><span>模型</span><select value={videoModel} onChange={(event) => setVideoModel(event.target.value)}>{videoModels.map((model) => <option key={model.id} value={model.id}>{model.id === DOUBAO_WEB_MODEL_ID ? '豆包网页版 · Seedance 2.0' : model.id}</option>)}</select></label>
              <label><span>比例</span><select value={videoRatio} onChange={(event) => setVideoRatio(event.target.value)}>{RATIOS.filter((ratio) => isDoubaoWebVideo ? ['1:1', '16:9', '9:16'].includes(ratio) : ratio !== '3:2' && ratio !== '2:3').map((ratio) => <option key={ratio}>{ratio}</option>)}</select></label>
              <label><span>分辨率</span><select value={isDoubaoWebVideo ? 'auto' : videoResolution} onChange={(event) => setVideoResolution(event.target.value)} disabled={isDoubaoWebVideo}>{isDoubaoWebVideo ? <option value="auto">由豆包自动选择</option> : VIDEO_RESOLUTIONS.map((resolution) => <option key={resolution}>{resolution}</option>)}</select></label>
              <label><span>时长（秒）</span><select value={videoDuration} onChange={(event) => setVideoDuration(Number(event.target.value))}>{durationOptions.map((duration) => <option key={duration} value={duration}>{duration} 秒</option>)}</select></label>
              <label className="span-2"><span>提示词</span><textarea rows={5} value={videoPrompt} onChange={(event) => setVideoPrompt(event.target.value)} placeholder={videoMode === 'omni' ? '@image_file_1 作为主体，运动参考 @video_file_1…' : '描述镜头、主体动作、运镜与氛围…'} /></label>
              {videoMode !== 'text' && <div className="span-2 jimeng-upload-zone"><button className="btn btn-secondary jimeng-button" onClick={async () => setVideoImagePaths((await chooseFiles('image')).slice(0, videoMode === 'first' ? 1 : videoMode === 'first-last' ? 2 : 9))}><Upload size={17} />选择参考图片</button><span>已选择 {videoImagePaths.length} 张</span></div>}
              {videoMode === 'omni' && <div className="span-2 jimeng-upload-zone"><button className="btn btn-secondary jimeng-button" onClick={async () => setVideoReferencePaths((await chooseFiles('video')).slice(0, 3))}><Film size={17} />选择参考视频</button><span>已选择 {videoReferencePaths.length} 个</span></div>}
              {!isDoubaoWebVideo && <label className="span-2"><span>网络素材 URL（每行一个，可选）</span><textarea rows={3} value={referenceUrls} onChange={(event) => setReferenceUrls(event.target.value)} /></label>}
            </div>
            <button className="btn btn-primary jimeng-generate" onClick={() => void submitVideo()} disabled={!!busy || (!isDoubaoWebVideo && !enabledAccounts.length)}><Film size={20} />开始生成视频</button>
          </section>
        )}

        {tab === 'tasks' && (
          <section className="jimeng-panel">
            <div className="jimeng-panel-title"><Activity size={19} /><div><h2>本次运行任务</h2><p>长时间生成不会阻塞 C.le. 主 API 服务。</p></div></div>
            <div className="jimeng-task-list">
              {tasks.map((task) => {
                const assets = extractAssets(task.result);
                return (
                  <article key={task.id} className={task.status}>
                    <div className="jimeng-task-state">{task.status === 'running' ? <LoaderCircle className="spin" /> : task.status === 'success' ? <BadgeCheck /> : <CircleAlert />}</div>
                    <div className="jimeng-task-main">
                      <div><strong>{task.model}</strong><span>{task.kind} · {taskDuration(task)}s</span></div>
                      <p>{task.prompt}</p>
                      {task.error && <pre>{task.error}</pre>}
                      {!!assets.length && <div className="jimeng-assets">{assets.map((asset) => asset.startsWith('data:image') || /\.(png|jpe?g|webp)(\?|$)/i.test(asset) ? <a key={asset.slice(-80)} href={asset} target="_blank" rel="noreferrer"><img src={asset} alt="生成结果" /></a> : <a key={asset} href={asset} target="_blank" rel="noreferrer"><Film size={18} />打开视频结果</a>)}</div>}
                      {task.result && !assets.length && <pre>{JSON.stringify(task.result, null, 2)}</pre>}
                    </div>
                  </article>
                );
              })}
              {!tasks.length && <div className="jimeng-empty">还没有生成任务。</div>}
            </div>
          </section>
        )}

        {tab === 'api' && (
          <div className="jimeng-api-layout">
            <section className="jimeng-panel">
              <div className="jimeng-panel-title"><Layers3 size={19} /><div><h2>标准接口</h2><p>即梦 sidecar 独立运行，关闭控制台后接口仍保持在线。</p></div></div>
              {[
                ['POST', '/v1/images/generations', '文生图'],
                ['POST', '/v1/images/compositions', '单图/多图合成'],
                ['POST', '/v1/videos/generations', '文生视频、图生视频、首尾帧与 Omni Reference'],
                ['GET', '/v1/models', '模型目录'],
                ['POST', '/token/check', '检查账号'],
                ['POST', '/token/points', '查询积分'],
                ['POST', '/token/receive', '领取每日积分'],
              ].map(([method, path, desc]) => <div className="jimeng-endpoint-row" key={path}><b>{method}</b><code>{path}</code><span>{desc}</span></div>)}
            </section>
            <section className="jimeng-panel">
              <div className="jimeng-panel-title"><KeyRound size={19} /><div><h2>兼容 API 调用凭据</h2><p>仅 Session 账号可组成 sidecar Bearer Token；OAuth 账号由 C.le. 内部安全调用。</p></div></div>
              <div className="jimeng-secret-row"><code>{pooledToken ? `••••••••${pooledToken.slice(-10)}` : '尚无启用账号'}</code><button className="btn btn-secondary jimeng-button" disabled={!pooledToken} onClick={() => void copyText(pooledToken)}><Copy size={15} />复制账号池 Token</button></div>
              <pre className="jimeng-code">{`curl ${state.baseUrl}/images/generations \\\n  -H "Authorization: Bearer <TOKEN>" \\\n  -H "Content-Type: application/json" \\\n  -d '{"model":"jimeng-4.5","prompt":"一只黑猫","ratio":"16:9","resolution":"2k"}'`}</pre>
            </section>
          </div>
        )}
      </main>

      {editing && createPortal((
        <div className="jimeng-modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && void closeAccountModal()}>
          <div className="jimeng-modal">
            <div className="jimeng-panel-title"><KeyRound size={20} /><div><h2>{draft.accounts.some((account) => account.id === editing.id) ? '编辑即梦账号' : '添加即梦账号'}</h2><p>浏览器登录为推荐方式，登录成功后自动获取 Session 并接管。</p></div></div>
            <div className="jimeng-auth-switch filter-tabs">
              <button className={`filter-tab ${editing.authMethod === 'oauthDevice' ? 'active' : ''}`} onClick={() => { setDeviceFlow(null); setEditing({ ...editing, authMethod: 'oauthDevice' }); }}><Globe2 size={16} />浏览器登录</button>
              <button className={`filter-tab ${editing.authMethod !== 'oauthDevice' ? 'active' : ''}`} onClick={() => { setDeviceFlow(null); setEditing({ ...editing, authMethod: 'session' }); }}><KeyRound size={16} />Session ID</button>
            </div>
            {editing.authMethod === 'oauthDevice' ? (
              <div className="jimeng-device-flow">
                <div className="jimeng-device-intro">
                  <ShieldCheck size={25} />
                  <div><strong>隔离浏览器安全登录</strong><span>无需复制 Cookie。C.le. 使用独立浏览器配置登录，只读取即梦 / Dreamina 的 Session。</span></div>
                </div>
                <label className="jimeng-device-name"><span>账号备注</span><input value={editing.name} onChange={(event) => setEditing({ ...editing, name: event.target.value })} placeholder="例如：即梦主账号" /></label>
                <label className="jimeng-device-name"><span>区域</span><select value={editing.region} onChange={(event) => setEditing({ ...editing, region: event.target.value as JimengRegion })}>{REGIONS.map((region) => <option key={region.id} value={region.id}>{region.label}</option>)}</select></label>
                {!deviceFlow ? (
                  <button className="btn btn-primary jimeng-device-start" disabled={busy === 'device-flow'} onClick={() => void startDeviceLogin()}>
                    {busy === 'device-flow' ? <LoaderCircle className="spin" size={19} /> : <Globe2 size={19} />}
                    启动浏览器并登录
                  </button>
                ) : (
                  <div className={`jimeng-device-session ${deviceFlow.status}`}>
                    <div className="jimeng-device-status">
                      {deviceFlow.status === 'pending' ? <LoaderCircle className="spin" /> : deviceFlow.status === 'authorized' ? <BadgeCheck /> : <CircleAlert />}
                      <div><strong>{deviceFlow.status === 'pending' ? '正在等待浏览器登录' : deviceFlow.status === 'authorized' ? '登录完成' : '登录未完成'}</strong><span>{deviceFlow.message || '请在专用浏览器窗口完成登录，本页会自动更新。'}</span></div>
                    </div>
                    <div className="jimeng-device-code">
                      <span>检测方式</span>
                      <code>{deviceFlow.userCode}</code>
                    </div>
                    <div className="jimeng-device-steps"><i>1</i><span>专用窗口登录</span><i>2</i><span>自动检测 Session</span><i>3</i><span>C.le. 自动接管账号</span></div>
                  </div>
                )}
              </div>
            ) : (
              <div className="jimeng-form-grid">
                <label><span>账号名称</span><input value={editing.name} onChange={(event) => setEditing({ ...editing, name: event.target.value })} placeholder="例如：即梦主账号" /></label>
                <label><span>区域</span><select value={editing.region} onChange={(event) => setEditing({ ...editing, region: event.target.value as JimengRegion })}>{REGIONS.map((region) => <option key={region.id} value={region.id}>{region.label}</option>)}</select></label>
                <label className="span-2"><span>Session ID</span><textarea rows={4} value={editing.sessionId} onChange={(event) => setEditing({ ...editing, sessionId: event.target.value.trim() })} placeholder="从即梦 / Dreamina 登录 Cookie 中取得 sessionid" /></label>
                <label><span>账号代理（可选）</span><input value={editing.proxyUrl} onChange={(event) => setEditing({ ...editing, proxyUrl: event.target.value })} placeholder="socks5://127.0.0.1:7890" /></label>
                <label><span>优先级</span><input type="number" value={editing.priority} onChange={(event) => setEditing({ ...editing, priority: Number(event.target.value) || 0 })} /></label>
              </div>
            )}
            <div className="jimeng-modal-actions">
              <button className="btn btn-secondary jimeng-button" onClick={() => void closeAccountModal()}>取消</button>
              {editing.authMethod !== 'oauthDevice' && <button className="btn btn-primary jimeng-button" disabled={!editing.sessionId.trim()} onClick={() => {
                const exists = draft.accounts.some((account) => account.id === editing.id);
                setDraft({ ...draft, accounts: exists ? draft.accounts.map((account) => account.id === editing.id ? editing : account) : [...draft.accounts, editing] });
                setEditing(null);
              }}><Save size={16} />保存到草稿</button>}
            </div>
          </div>
        </div>
      ), window.document.body)}
    </div>
  );
}
