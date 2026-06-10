"use client";

import { ClipboardEvent, FormEvent, KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import type { StoredVideoTask, UpstreamVideoTask, UsageSummary, VideoStatus } from "@/lib/types";

type CreateResponse = {
  task: UpstreamVideoTask;
  storedTask: StoredVideoTask;
  usage?: UsageSummary;
  storageMode?: "r2" | "direct";
};

type ListResponse = {
  object: "list";
  data: StoredVideoTask[];
  usage?: UsageSummary;
};

type TaskResponse = {
  task: UpstreamVideoTask;
  storedTask: StoredVideoTask;
  usage?: UsageSummary;
};

type UploadResponse = {
  object: "list";
  data: Array<{
    name: string;
    size: number;
    type: string;
    url: string;
  }>;
  storageMode: "r2" | "direct";
};

type RefreshRequest = {
  taskId: string;
  controller: AbortController;
};

type SubmitRequest = {
  apiKey: string;
  controller: AbortController;
  sessionVersion: number;
};

type UploadRequest = SubmitRequest;

type MutationRequest = RefreshRequest & {
  mutationVersion: number;
  sessionVersion: number;
};

const aspectOptions = [
  { label: "16:9", size: "1280x720", name: "横屏", hint: "通用视频" },
  { label: "9:16", size: "720x1280", name: "竖屏", hint: "短视频" },
  { label: "1:1", size: "1024x1024", name: "方形", hint: "社媒封面" },
  { label: "4:3", size: "1024x768", name: "经典", hint: "叙事镜头" },
  { label: "3:4", size: "768x1024", name: "肖像", hint: "人物主体" },
  { label: "21:9", size: "1280x548", name: "宽银幕", hint: "电影感" }
];
const batchOptions = [1, 3, 5];
const fixedResolution = "720p";
const modelOptions = [
  {
    id: "seedance_2",
    name: "Seedance 2.0",
    eyebrow: "参考图创作",
    defaultSeconds: "15",
    seconds: ["5", "10", "15"],
    ratios: ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"]
  },
  {
    id: "happyhorse-1.0",
    name: "HappyHorse 1.0",
    eyebrow: "长镜头优先",
    defaultSeconds: "15",
    seconds: ["15"],
    ratios: ["16:9", "9:16", "1:1", "4:3", "3:4"]
  }
];
const maxUploadFiles = 9;
const maxUploadFileSizeMb = 10;
const maxUploadFileBytes = maxUploadFileSizeMb * 1024 * 1024;
const activeTaskPollIntervalMs = 10_000;
const backgroundTaskPollIntervalMs = 30_000;
const statusText: Record<VideoStatus, string> = {
  queued: "排队中",
  in_progress: "生成中",
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消"
};

const runningSteps = ["提交任务", "排队调度", "渲染镜头", "合成视频", "等待回传"];

function getFocusableElements(container: HTMLElement | null) {
  if (!container) {
    return [];
  }

  return Array.from(
    container.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
    )
  );
}

function focusFirstDialogElement(container: HTMLElement | null) {
  if (!container) {
    return;
  }

  const preferredElement = container.querySelector<HTMLElement>("[data-dialog-focus]");
  (preferredElement || getFocusableElements(container)[0])?.focus();
}

function isAbortError(error: unknown) {
  return error instanceof Error && error.name === "AbortError";
}

function getErrorMessage(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }
  return "请求失败，请稍后重试。";
}

async function readJsonOrThrow<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(body?.error?.message || `请求失败：${response.status}`);
  }
  return body as T;
}

function isRunning(status?: VideoStatus) {
  return status === "queued" || status === "in_progress";
}

function formatElapsedTime(startedAt: string | null | undefined, currentTime: number) {
  if (!startedAt) {
    return "00:00";
  }

  const startedTime = new Date(startedAt).getTime();
  if (!Number.isFinite(startedTime)) {
    return "00:00";
  }

  const elapsed = Math.max(0, currentTime - startedTime);
  const totalSeconds = Math.floor(elapsed / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function getElapsedMs(startedAt: string | null | undefined, currentTime: number) {
  if (!startedAt) {
    return 0;
  }

  const startedTime = new Date(startedAt).getTime();
  if (!Number.isFinite(startedTime)) {
    return 0;
  }

  return Math.max(0, currentTime - startedTime);
}

function getStepIndex(status?: VideoStatus, progress?: number | null) {
  if (status === "completed") {
    return runningSteps.length - 1;
  }
  if (status === "queued") {
    return 1;
  }
  if (status === "in_progress" && typeof progress === "number") {
    if (progress >= 90) {
      return 4;
    }
    if (progress >= 60) {
      return 3;
    }
    return 2;
  }
  if (status === "in_progress") {
    return 2;
  }
  return 0;
}

function getTaskHeadline(task: StoredVideoTask) {
  if (task.status === "failed") {
    return "生成失败";
  }
  if (task.status === "cancelled") {
    return "任务已取消";
  }
  if (task.status === "completed" && !task.videoUrl) {
    return "视频链接待回传";
  }
  if (task.status === "completed") {
    return "视频已生成";
  }
  return `任务 ${task.upstreamTaskId.slice(0, 8)} 正在生成`;
}

function getTaskDescription(task: StoredVideoTask, fallbackSize: string, fallbackSeconds: string) {
  if (task.status === "failed") {
    return task.errorMessage || "渲染失败，可重试。";
  }
  if (task.status === "cancelled") {
    return "任务已停止。";
  }
  if (task.status === "completed" && !task.videoUrl) {
    return "视频链接待回传，可刷新。";
  }
  return `${task.size || fallbackSize} · ${task.seconds || fallbackSeconds}s · 15-60 分钟`;
}

function formatDateTime(value: string | null | undefined) {
  if (!value) {
    return "--";
  }

  const time = new Date(value).getTime();
  if (!Number.isFinite(time)) {
    return "--";
  }

  return new Date(value).toLocaleString();
}

function getRemoteMediaUrls(value: string) {
  return value
    .split(/[\n,]/)
    .map((url) => url.trim())
    .filter(Boolean);
}

function mergeRemoteMediaUrls(value: string, urls: string[]) {
  return Array.from(new Set([...getRemoteMediaUrls(value), ...urls])).join("\n");
}

function isValidRemoteMediaUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function getAspectBySize(value: string | null | undefined) {
  return aspectOptions.find((option) => option.size === value)?.label || "16:9";
}

function getModelOption(modelId: string | null | undefined) {
  if (!modelId) {
    return modelOptions[0];
  }
  if (modelId.startsWith("seedance_2")) {
    return modelOptions[0];
  }

  return modelOptions.find((option) => option.id === modelId) || modelOptions[0];
}

function getModelName(modelId: string | null | undefined) {
  return getModelOption(modelId).name;
}

function getTaskCostUnits(task: StoredVideoTask, _fallbackSeconds: string) {
  return task.costUnits > 0 ? task.costUnits : 1;
}

function requestBrowserNotifications() {
  if (typeof window === "undefined" || !("Notification" in window) || Notification.permission !== "default") {
    return;
  }

  void Notification.requestPermission().catch(() => null);
}

function sendTaskNotification(task: StoredVideoTask) {
  if (typeof window === "undefined" || !("Notification" in window) || Notification.permission !== "granted") {
    return;
  }

  const title = task.status === "completed" ? "视频生成完成" : task.status === "failed" ? "视频生成失败" : "任务状态已更新";
  const body = task.prompt ? task.prompt.slice(0, 80) : `任务 ${task.upstreamTaskId.slice(0, 8)}`;
  try {
    new Notification(title, { body });
  } catch {
    // Some browsers expose Notification but block construction in constrained contexts.
  }
}

export default function Home() {
  const [apiKey, setApiKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [selectedModel, setSelectedModel] = useState(modelOptions[0].id);
  const [seconds, setSeconds] = useState("15");
  const [batchCount, setBatchCount] = useState(1);
  const [size, setSize] = useState("1280x720");
  const [aspect, setAspect] = useState("16:9");
  const [files, setFiles] = useState<File[]>([]);
  const [mediaUrls, setMediaUrls] = useState("");
  const [activeTask, setActiveTask] = useState<StoredVideoTask | null>(null);
  const [tasks, setTasks] = useState<StoredVideoTask[]>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isUploadingReferences, setIsUploadingReferences] = useState(false);
  const [isLoadingHistory, setIsLoadingHistory] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [showRatioPanel, setShowRatioPanel] = useState(false);
  const [showLogin, setShowLogin] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [detailTaskId, setDetailTaskId] = useState<string | null>(null);
  const [usageSummary, setUsageSummary] = useState<UsageSummary | null>(null);
  const [lastStorageMode, setLastStorageMode] = useState<"r2" | "direct" | null>(null);
  const [lastUploadedUrls, setLastUploadedUrls] = useState<string[]>([]);
  const [draftApiKey, setDraftApiKey] = useState("");
  const [now, setNow] = useState(Date.now());
  const [previewUrls, setPreviewUrls] = useState<string[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const loginDialogRef = useRef<HTMLDivElement>(null);
  const historyDialogRef = useRef<HTMLElement>(null);
  const detailDialogRef = useRef<HTMLElement>(null);
  const lastFocusedElementRef = useRef<HTMLElement | null>(null);
  const refreshRequestsRef = useRef(new Map<string, RefreshRequest>());
  const historyRequestControllerRef = useRef<AbortController | null>(null);
  const submitRequestRef = useRef<SubmitRequest | null>(null);
  const uploadRequestRef = useRef<UploadRequest | null>(null);
  const activeMutationRequestRef = useRef<MutationRequest | null>(null);
  const notificationWatchIdsRef = useRef(new Set<string>());
  const notifiedTaskKeysRef = useRef(new Set<string>());
  const sessionVersionRef = useRef(0);
  const mutationVersionRef = useRef(0);

  const activeStepIndex = getStepIndex(activeTask?.status, activeTask?.progress);
  const elapsedTime = useMemo(() => formatElapsedTime(activeTask?.createdAt, now), [activeTask?.createdAt, now]);
  const activeTaskElapsedMs = useMemo(() => getElapsedMs(activeTask?.createdAt, now), [activeTask?.createdAt, now]);
  const isActiveTaskDelayed = Boolean(activeTask && isRunning(activeTask.status) && activeTaskElapsedMs >= 60 * 60 * 1000);
  const currentModel = useMemo(() => getModelOption(selectedModel), [selectedModel]);
  const availableAspectOptions = useMemo(
    () => aspectOptions.filter((option) => currentModel.ratios.includes(option.label)),
    [currentModel]
  );
  const availableSecondOptions = currentModel.seconds;
  const remoteMediaUrlList = useMemo(() => getRemoteMediaUrls(mediaUrls), [mediaUrls]);
  const backgroundRunningTaskIds = useMemo(
    () =>
      tasks
        .filter((task) => isRunning(task.status) && task.upstreamTaskId !== activeTask?.upstreamTaskId)
        .map((task) => task.upstreamTaskId)
        .join("|"),
    [activeTask?.upstreamTaskId, tasks]
  );
  const referenceCount = files.length + remoteMediaUrlList.length;
  const detailTask = useMemo(() => {
    if (!detailTaskId) {
      return null;
    }

    const candidates = [activeTask, ...tasks].filter(Boolean) as StoredVideoTask[];
    return candidates.find((task) => task.upstreamTaskId === detailTaskId) || null;
  }, [activeTask, detailTaskId, tasks]);

  useEffect(() => {
    const nextPreviewUrls = files.map((file) => URL.createObjectURL(file));
    setPreviewUrls(nextPreviewUrls);

    return () => {
      nextPreviewUrls.forEach((url) => URL.revokeObjectURL(url));
    };
  }, [files]);

  useEffect(() => {
    const savedKey = sessionStorage.getItem("video_api_key");
    if (savedKey) {
      setApiKey(savedKey);
      setDraftApiKey(savedKey);
    }
  }, []);

  useEffect(() => {
    if (apiKey) {
      sessionStorage.setItem("video_api_key", apiKey);
    } else {
      sessionStorage.removeItem("video_api_key");
    }
  }, [apiKey]);

  useEffect(() => {
    return () => {
      abortRefreshRequests();
      historyRequestControllerRef.current?.abort();
      submitRequestRef.current?.controller.abort();
      uploadRequestRef.current?.controller.abort();
      activeMutationRequestRef.current?.controller.abort();
    };
  }, []);

  useEffect(() => {
    const activeDialog = showLogin
      ? loginDialogRef.current
      : detailTask
        ? detailDialogRef.current
        : showHistory
          ? historyDialogRef.current
          : null;
    if (!activeDialog) {
      lastFocusedElementRef.current?.focus();
      lastFocusedElementRef.current = null;
      return;
    }

    lastFocusedElementRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    focusFirstDialogElement(activeDialog);
  }, [detailTask, showLogin, showHistory]);

  useEffect(() => {
    if (!notice) {
      return;
    }

    const timer = window.setTimeout(() => setNotice(""), 2200);
    return () => window.clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    if (!activeTask) {
      return;
    }

    if (isRunning(activeTask.status)) {
      notificationWatchIdsRef.current.add(activeTask.upstreamTaskId);
      return;
    }

    if (activeTask.status !== "completed" && activeTask.status !== "failed") {
      return;
    }

    const notifyKey = `${activeTask.upstreamTaskId}:${activeTask.status}`;
    if (
      notificationWatchIdsRef.current.has(activeTask.upstreamTaskId) &&
      !notifiedTaskKeysRef.current.has(notifyKey)
    ) {
      notifiedTaskKeysRef.current.add(notifyKey);
      sendTaskNotification(activeTask);
    }
  }, [activeTask?.status, activeTask?.upstreamTaskId]);

  useEffect(() => {
    tasks.forEach((task) => {
      if (isRunning(task.status)) {
        notificationWatchIdsRef.current.add(task.upstreamTaskId);
        return;
      }

      if (task.status !== "completed" && task.status !== "failed") {
        return;
      }

      const notifyKey = `${task.upstreamTaskId}:${task.status}`;
      if (
        notificationWatchIdsRef.current.has(task.upstreamTaskId) &&
        !notifiedTaskKeysRef.current.has(notifyKey)
      ) {
        notifiedTaskKeysRef.current.add(notifyKey);
        sendTaskNotification(task);
      }
    });
  }, [tasks]);

  async function loadHistory(key = apiKey) {
    const requestKey = key.trim();
    historyRequestControllerRef.current?.abort();

    if (!requestKey) {
      setTasks([]);
      setUsageSummary(null);
      setIsLoadingHistory(false);
      return;
    }

    const controller = new AbortController();
    historyRequestControllerRef.current = controller;
    setIsLoadingHistory(true);
    setError("");
    try {
      const response = await fetch("/api/videos?limit=30", {
        headers: { "x-video-api-key": requestKey },
        cache: "no-store",
        signal: controller.signal
      });
      const body = await readJsonOrThrow<ListResponse>(response);
      if (controller.signal.aborted || historyRequestControllerRef.current !== controller) {
        return;
      }
      setTasks(body.data);
      setUsageSummary(body.usage || null);
      setActiveTask((current) =>
        current && body.data.some((task) => task.upstreamTaskId === current.upstreamTaskId)
          ? current
          : body.data[0] ?? null
      );
    } catch (err) {
      if (isAbortError(err) || controller.signal.aborted || historyRequestControllerRef.current !== controller) {
        return;
      }
      setError(getErrorMessage(err));
    } finally {
      if (historyRequestControllerRef.current === controller) {
        historyRequestControllerRef.current = null;
        setIsLoadingHistory(false);
      }
    }
  }

  useEffect(() => {
    if (!apiKey) {
      return;
    }

    const handle = window.setTimeout(() => {
      void loadHistory(apiKey);
    }, 350);
    return () => window.clearTimeout(handle);
  }, [apiKey]);

  function abortRefreshRequests(taskId?: string) {
    if (taskId) {
      refreshRequestsRef.current.get(taskId)?.controller.abort();
      refreshRequestsRef.current.delete(taskId);
      return;
    }

    refreshRequestsRef.current.forEach((request) => request.controller.abort());
    refreshRequestsRef.current.clear();
  }

  async function refreshTask(taskId: string) {
    if (!apiKey.trim()) {
      return null;
    }

    abortRefreshRequests(taskId);
    const controller = new AbortController();
    const refreshRequest = { taskId, controller };
    const mutationVersion = mutationVersionRef.current;
    const sessionVersion = sessionVersionRef.current;
    refreshRequestsRef.current.set(taskId, refreshRequest);
    const isStaleRefresh = () =>
      controller.signal.aborted ||
      refreshRequestsRef.current.get(taskId) !== refreshRequest ||
      sessionVersionRef.current !== sessionVersion ||
      mutationVersionRef.current !== mutationVersion;

    try {
      const response = await fetch(`/api/videos/${encodeURIComponent(taskId)}`, {
        headers: { "x-video-api-key": apiKey.trim() },
        cache: "no-store",
        signal: controller.signal
      });
      if (isStaleRefresh()) {
        return null;
      }

      const body = await readJsonOrThrow<TaskResponse>(response);
      if (isStaleRefresh() || body.storedTask.upstreamTaskId !== taskId) {
        return null;
      }

      setUsageSummary(body.usage || null);
      setActiveTask((current) => (current?.upstreamTaskId === taskId ? body.storedTask : current));
      setTasks((current) => {
        const rest = current.filter((task) => task.upstreamTaskId !== body.storedTask.upstreamTaskId);
        return [body.storedTask, ...rest].sort(
          (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
        );
      });
      return body.storedTask;
    } catch (err) {
      if (isAbortError(err) || isStaleRefresh()) {
        return null;
      }
      throw err;
    } finally {
      if (refreshRequestsRef.current.get(taskId) === refreshRequest) {
        refreshRequestsRef.current.delete(taskId);
      }
    }
  }

  useEffect(() => {
    if (!activeTask || !isRunning(activeTask.status)) {
      return;
    }

    let stopped = false;
    let timeout: number | undefined;

    const poll = async () => {
      try {
        const nextTask = await refreshTask(activeTask.upstreamTaskId);
        if (nextTask) {
          setError("");
        }
      } catch (err) {
        setNotice(`状态同步暂时失败，已自动重试：${getErrorMessage(err)}`);
      } finally {
        if (!stopped) {
          timeout = window.setTimeout(poll, activeTaskPollIntervalMs);
        }
      }
    };

    timeout = window.setTimeout(poll, activeTaskPollIntervalMs);
    return () => {
      stopped = true;
      abortRefreshRequests(activeTask.upstreamTaskId);
      if (timeout) {
        window.clearTimeout(timeout);
      }
    };
  }, [activeTask?.upstreamTaskId, activeTask?.status, apiKey]);

  useEffect(() => {
    if (!apiKey.trim() || !backgroundRunningTaskIds) {
      return;
    }

    let stopped = false;
    const pollQueue = async () => {
      for (const taskId of backgroundRunningTaskIds.split("|").filter(Boolean)) {
        if (stopped) {
          return;
        }
        await refreshTask(taskId).catch(() => null);
      }
    };

    void pollQueue();
    const timer = window.setInterval(() => void pollQueue(), backgroundTaskPollIntervalMs);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [apiKey, backgroundRunningTaskIds]);

  useEffect(() => {
    if (!activeTask || !isRunning(activeTask.status)) {
      return;
    }

    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [activeTask?.upstreamTaskId, activeTask?.status]);

  async function addFiles(nextFiles: FileList | File[]) {
    const incomingFiles = Array.from(nextFiles);
    const invalidFile = incomingFiles.find((file) => !file.type.startsWith("image/"));
    const oversizedFile = incomingFiles.find((file) => file.size > maxUploadFileBytes);

    if (isSubmitting || submitRequestRef.current) {
      setError("任务正在提交，请等待提交完成后再添加参考图。");
      return 0;
    }
    if (uploadRequestRef.current) {
      setError("参考图正在上传，请等待 R2 地址返回后再添加。");
      return 0;
    }
    if (invalidFile) {
      setError("参考素材仅支持图片格式。");
    }
    if (oversizedFile) {
      setError(`单张图片不能超过 ${maxUploadFileSizeMb}MB。`);
    }

    const validFiles = incomingFiles.filter((file) => file.type.startsWith("image/") && file.size <= maxUploadFileBytes);
    const availableSlots = maxUploadFiles - files.length - remoteMediaUrlList.length;
    if (availableSlots <= 0) {
      setError(`最多添加 ${maxUploadFiles} 张参考图。`);
      return 0;
    }
    if (validFiles.length > availableSlots) {
      setError(`最多添加 ${maxUploadFiles} 张参考图，已自动保留前 ${availableSlots} 张。`);
    }

    const appendedFiles = validFiles.slice(0, availableSlots);
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }

    if (!appendedFiles.length) {
      return 0;
    }

    if (!apiKey.trim()) {
      setFiles((current) => [...current, ...appendedFiles]);
      setNotice(`已暂存 ${appendedFiles.length} 张参考图，登录后提交时会上传。`);
      return appendedFiles.length;
    }

    const uploadKey = apiKey.trim();
    const sessionVersion = sessionVersionRef.current;
    const controller = new AbortController();
    const uploadRequest = { apiKey: uploadKey, controller, sessionVersion };
    uploadRequestRef.current = uploadRequest;
    const isStaleUpload = () =>
      controller.signal.aborted ||
      uploadRequestRef.current !== uploadRequest ||
      sessionVersionRef.current !== sessionVersion ||
      uploadRequest.apiKey !== apiKey.trim();

    setIsUploadingReferences(true);
    setError("");
    setNotice(`正在上传 ${appendedFiles.length} 张参考图到 R2`);
    try {
      const formData = new FormData();
      appendedFiles.forEach((file) => formData.append("media[]", file));

      const response = await fetch("/api/uploads", {
        method: "POST",
        headers: { "x-video-api-key": uploadKey },
        body: formData,
        signal: controller.signal
      });
      if (isStaleUpload()) {
        return 0;
      }

      const body = await readJsonOrThrow<UploadResponse>(response);
      if (isStaleUpload()) {
        return 0;
      }

      if (body.storageMode === "direct") {
        setLastStorageMode("direct");
        setFiles((current) => [...current, ...appendedFiles]);
        setNotice(`已暂存 ${appendedFiles.length} 张参考图，当前为直传模式。`);
        return appendedFiles.length;
      }

      const uploadedUrls = body.data.map((item) => item.url).filter(Boolean);
      if (!uploadedUrls.length) {
        throw new Error("R2 上传完成但未返回参考图地址，请稍后重试。");
      }

      setLastStorageMode("r2");
      setLastUploadedUrls((current) => Array.from(new Set([...current, ...uploadedUrls])));
      setMediaUrls((current) => mergeRemoteMediaUrls(current, uploadedUrls));
      setNotice(`已上传 ${uploadedUrls.length} 张参考图到 R2`);
      return uploadedUrls.length;
    } catch (err) {
      if (isAbortError(err) || isStaleUpload()) {
        return 0;
      }
      setFiles((current) => [...current, ...appendedFiles]);
      setError(`${getErrorMessage(err)} 已暂存到本地，提交时会重试上传。`);
      return appendedFiles.length;
    } finally {
      if (uploadRequestRef.current === uploadRequest) {
        uploadRequestRef.current = null;
        setIsUploadingReferences(false);
      }
    }
  }

  function handlePaste(event: ClipboardEvent<HTMLElement>) {
    const pastedImages = Array.from(event.clipboardData.items)
      .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
      .map((item) => item.getAsFile())
      .filter((file): file is File => Boolean(file));

    if (!pastedImages.length) {
      return;
    }

    event.preventDefault();
    void addFiles(pastedImages);
  }

  function selectAspect(nextAspect: string) {
    const option = aspectOptions.find((item) => item.label === nextAspect);
    setAspect(nextAspect);
    if (option) {
      setSize(option.size);
    }
    setShowRatioPanel(false);
  }

  function selectModel(modelId: string) {
    const nextModel = getModelOption(modelId);
    setSelectedModel(nextModel.id);
    setSeconds(nextModel.defaultSeconds);
    if (!nextModel.ratios.includes(aspect)) {
      const fallbackAspect = aspectOptions.find((option) => option.label === "16:9");
      setAspect("16:9");
      setSize(fallbackAspect?.size || "1280x720");
    }
  }

  function handleLogin() {
    const nextKey = draftApiKey.trim();
    if (!nextKey) {
      setError("请输入中转密钥后再登录。");
      return;
    }
    sessionVersionRef.current += 1;
    abortRefreshRequests();
    historyRequestControllerRef.current?.abort();
    historyRequestControllerRef.current = null;
    submitRequestRef.current?.controller.abort();
    submitRequestRef.current = null;
    uploadRequestRef.current?.controller.abort();
    uploadRequestRef.current = null;
    activeMutationRequestRef.current?.controller.abort();
    activeMutationRequestRef.current = null;
    setIsSubmitting(false);
    setIsUploadingReferences(false);
    setIsLoadingHistory(false);
    setTasks([]);
    setActiveTask(null);
    setDetailTaskId(null);
    setUsageSummary(null);
    setLastStorageMode(null);
    setLastUploadedUrls([]);
    setNotice("");
    notificationWatchIdsRef.current.clear();
    notifiedTaskKeysRef.current.clear();
    setApiKey(nextKey);
    setShowLogin(false);
    setError("");
    void loadHistory(nextKey);
  }

  function handleLogout() {
    setApiKey("");
    setDraftApiKey("");
    setTasks([]);
    setActiveTask(null);
    setDetailTaskId(null);
    setUsageSummary(null);
    setLastStorageMode(null);
    setLastUploadedUrls([]);
    setNotice("");
    notificationWatchIdsRef.current.clear();
    notifiedTaskKeysRef.current.clear();
    sessionVersionRef.current += 1;
    mutationVersionRef.current += 1;
    abortRefreshRequests();
    historyRequestControllerRef.current?.abort();
    historyRequestControllerRef.current = null;
    submitRequestRef.current?.controller.abort();
    submitRequestRef.current = null;
    uploadRequestRef.current?.controller.abort();
    uploadRequestRef.current = null;
    activeMutationRequestRef.current?.controller.abort();
    activeMutationRequestRef.current = null;
    setIsSubmitting(false);
    setIsUploadingReferences(false);
    setIsLoadingHistory(false);
    sessionStorage.removeItem("video_api_key");
  }

  async function copyText(value: string | null | undefined, label: string) {
    if (!value) {
      return;
    }

    try {
      await navigator.clipboard.writeText(value);
      setNotice(`${label}已复制`);
    } catch {
      setError("复制失败，请手动复制。");
    }
  }

  function fillRemoteUrlsFromLastUpload() {
    if (!lastUploadedUrls.length) {
      return;
    }

    setMediaUrls((current) => mergeRemoteMediaUrls(current, lastUploadedUrls));
    setFiles([]);
    setNotice("已合并远程参考 URL");
  }

  function getReferenceLabelForUrl(url: string, fallbackIndex: number) {
    const index = remoteMediaUrlList.findIndex((item) => item === url);
    return `@IMG_${index >= 0 ? index + 1 : fallbackIndex + 1}`;
  }

  function loadTaskIntoEditor(task: StoredVideoTask) {
    setActiveTask(task);
    if (task.prompt) {
      setPrompt(task.prompt);
    }
    if (task.seconds) {
      setSeconds(task.seconds);
    }
    if (task.model) {
      setSelectedModel(getModelOption(task.model).id);
    }
    if (task.size) {
      setSize(task.size);
      setAspect(getAspectBySize(task.size));
    }
    setFiles([]);
    setMediaUrls(task.mediaUrls.join("\n"));
    setLastUploadedUrls(task.mediaUrls);
    setLastStorageMode(task.mediaUrls.length ? "r2" : null);
    setShowHistory(false);
    setDetailTaskId(null);
    setNotice(task.prompt ? "已载入提示词和参考图，可继续改写。" : "已载入参考图，原任务未保存提示词。");
    refreshTask(task.upstreamTaskId)
      .then((freshTask) => {
        if (!freshTask) {
          return;
        }
        if (freshTask.prompt) {
          setPrompt(freshTask.prompt);
          setNotice("已从上游刷新并载入提示词。");
        }
        if (freshTask.seconds) {
          setSeconds(freshTask.seconds);
        }
        if (freshTask.model) {
          setSelectedModel(getModelOption(freshTask.model).id);
        }
        if (freshTask.size) {
          setSize(freshTask.size);
          setAspect(getAspectBySize(freshTask.size));
        }
        if (freshTask.mediaUrls.length) {
          setMediaUrls(freshTask.mediaUrls.join("\n"));
          setLastUploadedUrls(freshTask.mediaUrls);
          setLastStorageMode("r2");
        }
      })
      .catch((err) => setError(getErrorMessage(err)));
  }

  function buildCreateFormData(options: { mediaUrls?: string[]; files?: File[] } = {}) {
    const formData = new FormData();
    const nextMediaUrls = options.mediaUrls ?? remoteMediaUrlList;
    const nextFiles = options.files ?? files;
    formData.set("model", selectedModel);
    formData.set("prompt", prompt.trim());
    formData.set("seconds", seconds);
    formData.set("size", size);

    nextMediaUrls.forEach((url) => formData.append("media_urls", url));
    nextFiles.forEach((file) => formData.append("media[]", file));

    return formData;
  }

  async function uploadPendingFilesForSubmit(pendingFiles: File[], submitKey: string, signal: AbortSignal) {
    const formData = new FormData();
    pendingFiles.forEach((file) => formData.append("media[]", file));

    const response = await fetch("/api/uploads", {
      method: "POST",
      headers: { "x-video-api-key": submitKey },
      body: formData,
      signal
    });

    return readJsonOrThrow<UploadResponse>(response);
  }

  function handleDialogKeyDown(event: KeyboardEvent<HTMLElement>, close: () => void) {
    if (event.key === "Escape") {
      close();
      return;
    }
    if (event.key !== "Tab") {
      return;
    }

    const focusableElements = getFocusableElements(event.currentTarget);
    if (!focusableElements.length) {
      return;
    }

    const firstElement = focusableElements[0];
    const lastElement = focusableElements[focusableElements.length - 1];
    if (event.shiftKey && document.activeElement === firstElement) {
      event.preventDefault();
      lastElement.focus();
    } else if (!event.shiftKey && document.activeElement === lastElement) {
      event.preventDefault();
      firstElement.focus();
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");

    if (!apiKey.trim()) {
      setShowLogin(true);
      setError("请先登录中转密钥。");
      return;
    }
    if (!prompt.trim()) {
      setError("请输入视频提示词。");
      return;
    }
    if (isUploadingReferences || uploadRequestRef.current) {
      setError("参考图仍在上传，请等待 R2 地址返回后再提交。");
      return;
    }
    if (prompt.length > 3500) {
      setError("提示词不能超过 3500 个字符。");
      return;
    }
    if (referenceCount > maxUploadFiles) {
      setError(`最多添加 ${maxUploadFiles} 张参考图。`);
      return;
    }
    if (files.some((file) => file.size > maxUploadFileBytes)) {
      setError(`单张图片不能超过 ${maxUploadFileSizeMb}MB。`);
      return;
    }
    if (files.some((file) => !file.type.startsWith("image/"))) {
      setError("参考素材仅支持图片格式。");
      return;
    }
    if (remoteMediaUrlList.some((url) => !isValidRemoteMediaUrl(url))) {
      setError("参考图 URL 格式不正确，请使用 http 或 https 链接。");
      return;
    }

    const submitKey = apiKey.trim();
    const sessionVersion = sessionVersionRef.current;
    submitRequestRef.current?.controller.abort();
    const controller = new AbortController();
    const submitRequest = { apiKey: submitKey, controller, sessionVersion };
    submitRequestRef.current = submitRequest;
    const isStaleSubmit = () =>
      controller.signal.aborted ||
      submitRequestRef.current !== submitRequest ||
      sessionVersionRef.current !== sessionVersion;

    setIsSubmitting(true);
    setLastStorageMode(null);
    setLastUploadedUrls([]);
    requestBrowserNotifications();
    const createdTasks: StoredVideoTask[] = [];
    let nextUsageSummary: UsageSummary | null = null;
    let nextStorageMode: "r2" | "direct" | null = null;
    let submissionMediaUrls = remoteMediaUrlList;
    let submissionFiles = files;
    try {
      if (submissionFiles.length) {
        setIsUploadingReferences(true);
        setNotice(`正在上传 ${submissionFiles.length} 张本地参考图`);
        const uploadBody = await uploadPendingFilesForSubmit(submissionFiles, submitKey, controller.signal);
        if (isStaleSubmit()) {
          return;
        }

        nextStorageMode = uploadBody.storageMode;
        if (uploadBody.storageMode === "r2") {
          const uploadedUrls = uploadBody.data.map((item) => item.url).filter(Boolean);
          if (!uploadedUrls.length) {
            throw new Error("R2 上传完成但未返回参考图地址，请稍后重试。");
          }

          submissionMediaUrls = Array.from(new Set([...submissionMediaUrls, ...uploadedUrls]));
          submissionFiles = [];
          setFiles([]);
          setMediaUrls(submissionMediaUrls.join("\n"));
          setLastUploadedUrls(uploadedUrls);
          setLastStorageMode("r2");
          setNotice("参考图已转为远程 URL，正在提交任务。");
        } else {
          setLastStorageMode("direct");
          setNotice("当前为直传模式，正在提交任务。");
        }
        setIsUploadingReferences(false);
      }

      for (let index = 0; index < batchCount; index += 1) {
        const response = await fetch("/api/videos", {
          method: "POST",
          headers: { "x-video-api-key": submitKey },
          body: buildCreateFormData({ mediaUrls: submissionMediaUrls, files: submissionFiles }),
          signal: controller.signal
        });
        if (isStaleSubmit()) {
          return;
        }

        const body = await readJsonOrThrow<CreateResponse>(response);
        if (isStaleSubmit() || submitRequest.apiKey !== submitKey) {
          return;
        }

        createdTasks.push(body.storedTask);
        notificationWatchIdsRef.current.add(body.storedTask.upstreamTaskId);
        nextUsageSummary = body.usage || nextUsageSummary;
        nextStorageMode = body.storageMode || nextStorageMode;
        setError("");
        setActiveTask(body.storedTask);
        setTasks((current) => {
          const rest = current.filter((task) => task.upstreamTaskId !== body.storedTask.upstreamTaskId);
          return [body.storedTask, ...rest];
        });
      }

      setUsageSummary(nextUsageSummary);
      setLastStorageMode(nextStorageMode);
      setLastUploadedUrls(createdTasks[0]?.mediaUrls || []);
      setError("");
      setNotice(`已提交 ${createdTasks.length} 条视频任务，可继续改写下一条。`);
    } catch (err) {
      if (isAbortError(err) || isStaleSubmit()) {
        return;
      }
      setError(
        createdTasks.length
          ? `已提交 ${createdTasks.length} 条，后续提交失败：${getErrorMessage(err)}`
          : getErrorMessage(err)
      );
    } finally {
      if (submitRequestRef.current === submitRequest) {
        submitRequestRef.current = null;
        setIsSubmitting(false);
        setIsUploadingReferences(false);
      }
    }
  }

  async function mutateTask(action: "cancel" | "retry", taskId: string) {
    if (!apiKey.trim()) {
      setShowLogin(true);
      setError("请先登录中转密钥。");
      return;
    }

    setError("");
    mutationVersionRef.current += 1;
    activeMutationRequestRef.current?.controller.abort();
    abortRefreshRequests(taskId);

    const controller = new AbortController();
    const mutationRequest = {
      taskId,
      controller,
      mutationVersion: mutationVersionRef.current,
      sessionVersion: sessionVersionRef.current
    };
    activeMutationRequestRef.current = mutationRequest;
    const isStaleMutation = () =>
      controller.signal.aborted ||
      activeMutationRequestRef.current !== mutationRequest ||
      mutationVersionRef.current !== mutationRequest.mutationVersion ||
      sessionVersionRef.current !== mutationRequest.sessionVersion;

    try {
      const response = await fetch(`/api/videos/${encodeURIComponent(taskId)}/${action}`, {
        method: "POST",
        headers: { "x-video-api-key": apiKey.trim() },
        signal: controller.signal
      });
      if (isStaleMutation()) {
        return;
      }

      const body = await readJsonOrThrow<TaskResponse>(response);
      if (isStaleMutation() || body.storedTask.upstreamTaskId !== taskId) {
        return;
      }

      if (action === "retry") {
        requestBrowserNotifications();
        notificationWatchIdsRef.current.add(body.storedTask.upstreamTaskId);
      }
      setUsageSummary(body.usage || null);
      mutationVersionRef.current += 1;
      setActiveTask((current) => (current?.upstreamTaskId === taskId ? body.storedTask : current));
      setTasks((current) => {
        const rest = current.filter((task) => task.upstreamTaskId !== body.storedTask.upstreamTaskId);
        return [body.storedTask, ...rest];
      });
    } catch (err) {
      if (isAbortError(err) || isStaleMutation()) {
        return;
      }
      setError(getErrorMessage(err));
    } finally {
      if (activeMutationRequestRef.current === mutationRequest) {
        activeMutationRequestRef.current = null;
      }
    }
  }

  return (
    <main className="app-shell">
      <section className="app-main">
        <div className="promo-ticker" aria-label="活动公告">
          <div className="ticker-track">
            <span>Seedance 2.0 · 720p</span>
            <span>电影推镜 · 人物转身 · 产品展示</span>
            <span>银幕光影 · 精准调度</span>
            <span>灵感成片 · 长线渲染</span>
            <span>Seedance 2.0 · 720p</span>
            <span>电影推镜 · 人物转身 · 产品展示</span>
            <span>银幕光影 · 精准调度</span>
            <span>灵感成片 · 长线渲染</span>
          </div>
        </div>

        <header className="topbar compact">
          <div className="brand-lockup">
            <span className="brand-dot" />
            <div>
              <strong>C-AI</strong>
              <small>Seedance 720p</small>
            </div>
          </div>
          {apiKey ? (
            <div className="topbar-actions">
              <div className="usage-pill" aria-label="最近 30 天用量">
                <span>30 天用量</span>
                <strong>{usageSummary?.totalCostUnits ?? 0}</strong>
                <small>次</small>
              </div>
              <div className="session-pill">
                <span>已登录</span>
                <strong>{apiKey.slice(0, 4)}••••{apiKey.slice(-4)}</strong>
                <button type="button" onClick={() => {
                  setShowHistory(true);
                  void loadHistory();
                }}>
                  历史
                </button>
                <button type="button" onClick={handleLogout}>退出</button>
              </div>
            </div>
          ) : (
            <button className="login-trigger" type="button" onClick={() => setShowLogin(true)}>
              登录密钥
            </button>
          )}
        </header>

        <form className="creation-card" onPaste={handlePaste} onSubmit={handleSubmit}>
          <div className="mode-tabs">
            <button className="selected" type="button">视频创作</button>
          </div>
          <div className="form-head">
            <div>
              <span>Prompt</span>
              <strong id="prompt-label">镜头指令</strong>
            </div>
            <small>{prompt.length}/3500</small>
          </div>

          <textarea
            className="prompt-box"
            aria-labelledby="prompt-label"
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            placeholder="雨夜霓虹，@IMG_1 转身入镜，手持浅景深。"
            maxLength={3500}
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => {
              event.preventDefault();
              void addFiles(event.dataTransfer.files);
            }}
          />

          <div className="asset-row">
            <button
              className={`asset-tile ${isUploadingReferences ? "uploading" : ""}`}
              type="button"
              disabled={isUploadingReferences}
              onClick={() => fileInputRef.current?.click()}
            >
              <b>{isUploadingReferences ? "↥" : "+"}</b>
              <span>{isUploadingReferences ? "上传中" : "参考素材"}</span>
              <small>{referenceCount}/{maxUploadFiles}</small>
            </button>
            <p>
              @IMG_1 · @IMG_2 · @IMG_3<br />
              单张 ≤ {maxUploadFileSizeMb}MB，登录后粘贴/拖拽会先上传 R2。
            </p>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              multiple
              onChange={(event) => event.target.files && void addFiles(event.target.files)}
            />
          </div>

          {isUploadingReferences ? (
            <div className="upload-status" role="status" aria-live="polite">
              <span />
              <strong>正在上传参考图到 R2</strong>
              <small>成功后会自动写入下方远程 URL，不会重复上传。</small>
            </div>
          ) : null}

          {files.length ? (
            <div className="reference-strip">
              {files.map((file, index) => (
                <div className="reference-chip" key={`${file.name}-${file.lastModified}-${index}`}>
                  <img src={previewUrls[index]} alt={file.name} />
                  <span>@IMG_{remoteMediaUrlList.length + index + 1}</span>
                  <button
                    aria-label={`移除参考素材 ${remoteMediaUrlList.length + index + 1}`}
                    type="button"
                    onClick={() => setFiles((current) => current.filter((_, fileIndex) => fileIndex !== index))}
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          ) : null}

          <div className="url-row">
            <textarea
              aria-label="远程参考图 URL"
              value={mediaUrls}
              onChange={(event) => setMediaUrls(event.target.value)}
              placeholder="远程参考图 URL，多个用换行或逗号分隔"
              rows={3}
            />
            <p className={`storage-note ${lastStorageMode || ""}`}>
              {lastStorageMode === "r2"
                ? "本地图片已转存云存储，长任务期间更稳定。"
                : lastStorageMode === "direct"
                  ? "当前为直传模式，生产环境建议配置 R2。"
                  : "视频不落盘保存，只使用上游返回的视频 URL 预览。"}
            </p>
            {lastUploadedUrls.length ? (
              <div className="uploaded-url-panel">
                <div className="uploaded-url-head">
                  <span>R2 参考图地址</span>
                  <div>
                    <button type="button" onClick={() => void copyText(lastUploadedUrls.join("\n"), "参考地址")}>
                      复制全部
                    </button>
                    <button type="button" onClick={fillRemoteUrlsFromLastUpload}>
                      填入 URL
                    </button>
                  </div>
                </div>
                <div className="uploaded-url-list">
                  {lastUploadedUrls.map((url, index) => (
                    <button
                      key={`${url}-${index}`}
                      type="button"
                      onClick={() => void copyText(url, getReferenceLabelForUrl(url, index))}
                    >
                      <span>{getReferenceLabelForUrl(url, index)}</span>
                      <strong>{url}</strong>
                    </button>
                  ))}
                </div>
              </div>
            ) : null}
          </div>

          <div className="control-row">
            <div className="ratio-wrap">
              <button
                aria-controls="ratio-panel"
                aria-expanded={showRatioPanel}
                className="control-pill ratio-pill"
                type="button"
                onClick={() => setShowRatioPanel((value) => !value)}
              >
                {currentModel.name} <i /> {aspect} <i /> {seconds} 秒
              </button>
              {showRatioPanel ? (
                <div className="ratio-popover" id="ratio-panel" role="group" aria-label="画面规格">
                  <div className="ratio-panel-head">
                    <div>
                      <strong>生成规格</strong>
                      <span>选择模型、画幅和时长</span>
                    </div>
                    <button type="button" onClick={() => setShowRatioPanel(false)} aria-label="关闭画面规格面板">
                      ×
                    </button>
                  </div>
                  <p>模型</p>
                  <div className="model-grid">
                    {modelOptions.map((model) => (
                      <button
                        aria-pressed={selectedModel === model.id}
                        className={selectedModel === model.id ? "selected" : ""}
                        key={model.id}
                        type="button"
                        onClick={() => selectModel(model.id)}
                      >
                        <span>{model.eyebrow}</span>
                        <strong>{model.name}</strong>
                        <small>{model.id === "happyhorse-1.0" ? "默认 15 秒 · 720P" : "多画幅 · 720p"}</small>
                      </button>
                    ))}
                  </div>
                  <p>画幅比例</p>
                  <div className="aspect-grid">
                    {availableAspectOptions.map((option) => (
                      <button
                        className={aspect === option.label ? "selected" : ""}
                        aria-pressed={aspect === option.label}
                        key={option.label}
                        type="button"
                        onClick={() => selectAspect(option.label)}
                      >
                        <span className="aspect-preview" data-aspect={option.label} />
                        <strong>{option.label}</strong>
                        <small>{option.name} · {option.hint}</small>
                      </button>
                    ))}
                  </div>
                  <div className="duration-head">
                    <p>视频时长</p>
                    <strong>{seconds} 秒</strong>
                  </div>
                  <div className="duration-grid">
                    {availableSecondOptions.map((option) => (
                      <button
                        className={seconds === option ? "selected" : ""}
                        aria-pressed={seconds === option}
                        key={option}
                        type="button"
                        onClick={() => setSeconds(option)}
                      >
                        {option}s
                      </button>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>

            <div className="batch-picker" aria-label="批量生成数量">
              {batchOptions.map((option) => (
                <button
                  aria-pressed={batchCount === option}
                  className={batchCount === option ? "selected" : ""}
                  key={option}
                  type="button"
                  onClick={() => setBatchCount(option)}
                >
                  {option} 条
                </button>
              ))}
            </div>

            <button className="send-button" type="submit" disabled={isSubmitting || isUploadingReferences}>
              {isUploadingReferences ? "上传中" : isSubmitting ? "排队中" : batchCount > 1 ? `提交 ${batchCount} 条` : "立即生成"}
            </button>
          </div>
        </form>

        {activeTask ? (
        <section className="generation-panel">
          <section className="preview-dock">
            <div className="dock-head">
              <div>
                <span>生成进程</span>
                <strong>{statusText[activeTask.status]}</strong>
              </div>
              <span className={`status ${activeTask.status}`}>{statusText[activeTask.status]}</span>
            </div>
            <div className="video-stage">
              {activeTask?.videoUrl && activeTask.status === "completed" ? (
                <video src={activeTask.videoUrl} controls playsInline poster={activeTask.thumbnailUrl || undefined} />
              ) : (
                <div className={`stage-placeholder ${isRunning(activeTask.status) ? "running" : ""}`}>
                  {isRunning(activeTask.status) ? (
                    <div className="render-suite">
                    <div className="render-animation">
                      <div className="film-frame">
                        <span />
                        <span />
                        <span />
                      </div>
                      <div className="render-beam" />
                      <div className="spark-field">
                        <i />
                        <i />
                        <i />
                        <i />
                      </div>
                    </div>
                    <div className="render-meta">
                      <div>
                        <span>已等待</span>
                        <strong>{elapsedTime}</strong>
                      </div>
                      <div>
                        <span>渲染窗口</span>
                        <strong>15-60 分钟</strong>
                      </div>
                      <div>
                        <span>状态同步</span>
                        <strong>在线</strong>
                      </div>
                    </div>
                    <div className="render-steps">
                      {runningSteps.map((step, index) => (
                        <span className={index <= activeStepIndex ? "active" : ""} key={step}>
                          {step}
                        </span>
                      ))}
                    </div>
                  </div>
                  ) : (
                    <div className={`terminal-state ${activeTask.status}`}>
                      <span>{statusText[activeTask.status]}</span>
                    </div>
                  )}
                  <strong>{getTaskHeadline(activeTask)}</strong>
                  <span>
                    {getTaskDescription(activeTask, size, seconds)}
                  </span>
                  {isActiveTaskDelayed ? (
                    <p className="task-error">当前处于高峰期，资源较紧张。任务已进入长时等待队列，请耐心等待，系统仍会持续查询最新状态。</p>
                  ) : null}
                </div>
              )}
            </div>
            {activeTask ? (
              <div className="task-metrics" aria-label="当前任务摘要">
                <span>ID {activeTask.upstreamTaskId.slice(0, 8)}</span>
                <span>{activeTask.size || size}</span>
                <span>{activeTask.seconds || seconds}s</span>
                <span>用量 {getTaskCostUnits(activeTask, seconds)} 次</span>
              </div>
            ) : null}
            {activeTask ? (
              <div className="dock-actions">
                <button
                  type="button"
                  onClick={() => refreshTask(activeTask.upstreamTaskId).catch((err) => setError(getErrorMessage(err)))}
                >
                  刷新
                </button>
                <button type="button" onClick={() => setDetailTaskId(activeTask.upstreamTaskId)}>
                  详情
                </button>
                <button type="button" onClick={() => void copyText(activeTask.upstreamTaskId, "任务 ID")}>
                  复制 ID
                </button>
                <button type="button" disabled={!isRunning(activeTask.status)} onClick={() => mutateTask("cancel", activeTask.upstreamTaskId)}>
                  取消
                </button>
                <button type="button" disabled={activeTask.status !== "failed"} onClick={() => mutateTask("retry", activeTask.upstreamTaskId)}>
                  重试
                </button>
                {activeTask.videoUrl ? (
                  <a href={activeTask.videoUrl} target="_blank" rel="noreferrer">
                    打开视频
                  </a>
                ) : (
                  <button type="button" disabled>
                    打开视频
                  </button>
                )}
                {activeTask.videoUrl ? (
                  <button type="button" onClick={() => void copyText(activeTask.videoUrl, "视频链接")}>
                    复制链接
                  </button>
                ) : null}
                {activeTask.videoUrl ? (
                  <a className="download-action" href={activeTask.videoUrl} download target="_blank" rel="noreferrer">
                    高清下载
                  </a>
                ) : null}
              </div>
            ) : null}
            {activeTask?.errorMessage ? <p className="task-error">{activeTask.errorMessage}</p> : null}
          </section>
        </section>
        ) : null}

        <footer className="app-footer">
          <div className="footer-brand">
            <span className="footer-mark">C</span>
            <div>
              <strong>C-AI</strong>
              <small>© 2026 苍洱 · All rights reserved</small>
            </div>
          </div>
          <div className="footer-legal">未经授权不得商用</div>
        </footer>
      </section>

      {showHistory ? (
        <div className="history-overlay">
          <section
            className="history-drawer"
            ref={historyDialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="history-title"
            onKeyDown={(event) => handleDialogKeyDown(event, () => setShowHistory(false))}
          >
            <div className="drawer-head">
              <div>
                <span>最近 30 天</span>
                <h2 id="history-title">历史任务</h2>
              </div>
              <div>
                <button type="button" onClick={() => loadHistory()} disabled={!apiKey || isLoadingHistory}>
                  {isLoadingHistory ? "查询中" : "刷新"}
                </button>
                <button type="button" onClick={() => setShowHistory(false)} aria-label="关闭历史任务">
                  ×
                </button>
              </div>
            </div>
            {tasks.length ? (
              <div className="history-list">
                {tasks.map((task) => (
                  <div
                    className={`history-item ${activeTask?.upstreamTaskId === task.upstreamTaskId ? "active" : ""}`}
                    key={task.upstreamTaskId}
                  >
                    <div className="history-item-top">
                      <span className={`status ${task.status}`}>{statusText[task.status]}</span>
                      <span className="history-cost">用量 {getTaskCostUnits(task, seconds)} 次</span>
                    </div>
                    <strong>{task.prompt || "未保存提示词"}</strong>
                    <small>{getModelName(task.model)} · {task.seconds || "--"}s · {formatDateTime(task.updatedAt)}</small>
                    <div className="history-actions">
                      <button
                        type="button"
                        onClick={() => loadTaskIntoEditor(task)}
                      >
                        复用
                      </button>
                      <button type="button" onClick={() => setDetailTaskId(task.upstreamTaskId)}>
                        详情
                      </button>
                      {task.videoUrl ? (
                        <a href={task.videoUrl} download target="_blank" rel="noreferrer">
                          下载
                        </a>
                      ) : null}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="empty-list">暂无任务记录。</p>
            )}
          </section>
        </div>
      ) : null}

      {detailTask ? (
        <div className="detail-overlay">
          <section
            className="detail-card"
            ref={detailDialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="detail-title"
            onKeyDown={(event) => handleDialogKeyDown(event, () => setDetailTaskId(null))}
          >
            <div className="detail-head">
              <div>
                <span>任务详情</span>
                <h2 id="detail-title">{statusText[detailTask.status]}</h2>
              </div>
              <button data-dialog-focus type="button" onClick={() => setDetailTaskId(null)} aria-label="关闭任务详情">
                ×
              </button>
            </div>
            <div className="detail-summary">
              <div>
                <span>任务 ID</span>
                <strong>{detailTask.upstreamTaskId.slice(0, 12)}</strong>
              </div>
              <div>
                <span>规格</span>
                <strong>{detailTask.size || size}</strong>
              </div>
              <div>
                <span>时长</span>
                <strong>{detailTask.seconds || seconds}s</strong>
              </div>
              <div>
                <span>用量</span>
                <strong>{getTaskCostUnits(detailTask, seconds)} 次</strong>
              </div>
            </div>
            <div className="detail-grid">
              <div>
                <span>创建时间</span>
                <strong>{formatDateTime(detailTask.createdAt)}</strong>
              </div>
              <div>
                <span>更新时间</span>
                <strong>{formatDateTime(detailTask.updatedAt)}</strong>
              </div>
              <div>
                <span>保存期限</span>
                <strong>{formatDateTime(detailTask.expiresAt)}</strong>
              </div>
              <div>
                <span>模型</span>
                <strong>{getModelName(detailTask.model)}</strong>
              </div>
            </div>
            <div className="detail-prompt">
              <span>提示词</span>
              <p>{detailTask.prompt || "未保存提示词。"}</p>
            </div>
            {detailTask.mediaUrls.length ? (
              <div className="media-link-list">
                <span>参考图</span>
                {detailTask.mediaUrls.map((url, index) => (
                  <a href={url} key={`${url}-${index}`} target="_blank" rel="noreferrer">
                    @IMG_{index + 1} · {url}
                  </a>
                ))}
              </div>
            ) : null}
            {detailTask.errorMessage ? (
              <div className="detail-error">
                <span>错误信息</span>
                <p>{detailTask.errorMessage}</p>
              </div>
            ) : null}
            <div className="detail-actions">
              <button
                type="button"
                onClick={() => refreshTask(detailTask.upstreamTaskId).catch((err) => setError(getErrorMessage(err)))}
              >
                刷新状态
              </button>
              <button type="button" onClick={() => void copyText(detailTask.upstreamTaskId, "任务 ID")}>
                复制 ID
              </button>
              <button type="button" onClick={() => void copyText(detailTask.prompt || "", "提示词")}>
                复制提示词
              </button>
              <button type="button" onClick={() => loadTaskIntoEditor(detailTask)}>
                复用到编辑器
              </button>
              {detailTask.videoUrl ? (
                <a href={detailTask.videoUrl} target="_blank" rel="noreferrer">
                  打开视频
                </a>
              ) : null}
              {detailTask.videoUrl ? (
                <a className="download-action" href={detailTask.videoUrl} download target="_blank" rel="noreferrer">
                  高清下载
                </a>
              ) : null}
              {detailTask.videoUrl ? (
                <button type="button" onClick={() => void copyText(detailTask.videoUrl, "视频链接")}>
                  复制视频链接
                </button>
              ) : null}
            </div>
          </section>
        </div>
      ) : null}

      {showLogin ? (
        <div className="login-overlay">
          <div
            className="login-card"
            ref={loginDialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="login-title"
            onKeyDown={(event) => handleDialogKeyDown(event, () => setShowLogin(false))}
          >
            <button className="login-close" type="button" onClick={() => setShowLogin(false)} aria-label="关闭登录弹窗">
              ×
            </button>
            <h2 id="login-title">密钥登录</h2>
            <label className="login-field">
              <span>API Key</span>
              <input
                autoFocus
                data-dialog-focus
                type={showKey ? "text" : "password"}
                value={draftApiKey}
                onChange={(event) => setDraftApiKey(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    handleLogin();
                  }
                }}
                placeholder="粘贴你的 API Key"
              />
            </label>
            <div className="login-actions">
              <button type="button" onClick={() => setShowKey((value) => !value)}>
                {showKey ? "隐藏密钥" : "显示密钥"}
              </button>
              <button className="primary" type="button" onClick={handleLogin}>
                进入工作台
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {notice ? <div className="toast-notice" role="status">{notice}</div> : null}
      {error ? <div className="toast-error" role="alert">{error}</div> : null}
    </main>
  );
}
