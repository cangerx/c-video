import { getVideoApiBaseUrl } from "./config";
import { HttpError, readUpstreamError } from "./errors";
import type { UpstreamError, UpstreamVideoTask, VideoStatus } from "./types";

type UpstreamContext = {
  operation: string;
  url: string;
};

type VideoJsonPayload = Record<string, unknown> & {
  references?: Array<{ name: string; url: string }>;
};

const happyHorseModel = "happyhorse-1.0";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function getRecordValue(value: Record<string, unknown>, key: string) {
  const next = value[key];
  return isRecord(next) ? next : {};
}

function getStringValue(...values: unknown[]) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value;
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      return String(value);
    }
  }

  return "";
}

function getNumberValue(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number(value.replace("%", "").trim());
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

function normalizeStatus(value: unknown): VideoStatus {
  const status = getStringValue(value).toLowerCase();
  if (["completed", "complete", "success", "succeeded", "finished"].includes(status)) {
    return "completed";
  }
  if (["running", "processing", "in_progress", "in-progress", "generating", "started"].includes(status)) {
    return "in_progress";
  }
  if (["failed", "failure", "error"].includes(status)) {
    return "failed";
  }
  if (["cancelled", "canceled", "cancel"].includes(status)) {
    return "cancelled";
  }

  return "queued";
}

function normalizeError(...values: unknown[]): UpstreamError | null {
  for (const value of values) {
    if (isRecord(value)) {
      const message = getStringValue(value.message, value.reason);
      const code = getStringValue(value.code);
      const type = getStringValue(value.type);
      if (message || code || type) {
        return { message, code, type };
      }
    }
    if (typeof value === "string" && value.trim()) {
      return { message: value };
    }
  }

  return null;
}

function normalizeVideoTask(body: unknown, fallbackId = ""): UpstreamVideoTask {
  if (!isRecord(body)) {
    throw new HttpError("上游返回格式异常，请稍后重试。", 502, "invalid_upstream_response", "upstream_error");
  }

  const data = getRecordValue(body, "data");
  const task = getRecordValue(body, "task");
  const payload = Object.keys(data).length ? data : Object.keys(task).length ? task : body;
  const metadata = getRecordValue(payload, "metadata");
  const properties = getRecordValue(body, "properties");
  const error = normalizeError(payload.error, body.error, body.fail_reason);
  const id = getStringValue(fallbackId, payload.id, body.task_id, body.id);

  if (!id) {
    console.error("[video-upstream] invalid task response", { body });
    throw new HttpError("上游没有返回任务 ID，请稍后重试。", 502, "missing_upstream_task_id", "upstream_error");
  }

  return {
    id,
    object: getStringValue(payload.object, body.object) || "video",
    created: getNumberValue(payload.created ?? body.created ?? body.created_at) ?? undefined,
    created_at: getNumberValue(payload.created_at ?? payload.created ?? body.created_at) ?? undefined,
    model: getStringValue(payload.model, properties.upstream_model_name, properties.origin_model_name),
    prompt: getStringValue(payload.prompt, metadata.prompt, body.prompt, properties.input),
    seconds: getStringValue(payload.seconds, metadata.duration),
    size: getStringValue(payload.size),
    status: normalizeStatus(payload.status ?? body.status),
    progress: getNumberValue(payload.progress ?? body.progress),
    video_url: getStringValue(payload.video_url, body.video_url) || null,
    thumbnail_url: getStringValue(payload.thumbnail_url, body.thumbnail_url) || null,
    error,
    metadata: isRecord(metadata) ? metadata : null
  };
}

function authHeaders(apiKey: string) {
  return { Authorization: `Bearer ${apiKey}` };
}

function hasFormDataFiles(formData: FormData) {
  return Array.from(formData.values()).some((value) => value instanceof File);
}

function sizeToRatio(size: string) {
  switch (size) {
    case "720x1280":
      return "9:16";
    case "1024x1024":
      return "1:1";
    case "1024x768":
      return "4:3";
    case "768x1024":
      return "3:4";
    default:
      return "16:9";
  }
}

function formDataToJsonPayload(formData: FormData) {
  const model = String(formData.get("model") || "");
  const prompt = String(formData.get("prompt") || formData.get("input") || "");
  const seconds = Number(formData.get("seconds") || formData.get("duration") || 15);
  const size = String(formData.get("size") || "1280x720");
  const mediaUrls = formData.getAll("media_urls").map(String).filter(Boolean);

  if (model === happyHorseModel) {
    const payload: VideoJsonPayload = {
      model,
      prompt,
      duration: Number.isFinite(seconds) ? seconds : 15,
      metadata: {
        resolution: "720P",
        ratio: sizeToRatio(size),
        prompt_extend: false,
        watermark: false
      }
    };

    if (mediaUrls.length === 1) {
      payload.input_reference = mediaUrls[0];
    } else if (mediaUrls.length > 1) {
      payload.input_reference = mediaUrls;
    }

    return payload;
  }

  const payload: VideoJsonPayload = {};

  for (const [key, value] of formData.entries()) {
    if (key === "media_urls") {
      continue;
    }
    payload[key] = String(value);
  }

  if (mediaUrls.length) {
    payload.references = mediaUrls.map((url, index) => ({
      name: `IMG_${index + 1}`,
      url
    }));
  }

  return payload;
}

function maybeLogCreatePayload(formData: FormData, payload: VideoJsonPayload | null) {
  if (process.env.NODE_ENV === "production" && process.env.VIDEO_DEBUG_REQUESTS !== "1") {
    return;
  }

  const mediaUrls = payload?.references?.map((item) => item.url).filter(Boolean) || formData.getAll("media_urls").map(String).filter(Boolean);
  console.info("[video-upstream] create payload", {
    mode: payload ? "json" : "multipart",
    model: String(formData.get("model") || ""),
    seconds: String(formData.get("seconds") || ""),
    duration: String(formData.get("duration") || ""),
    size: String(formData.get("size") || ""),
    mediaUrlCount: mediaUrls.length,
    mediaUrls,
    references: payload?.references || [],
    fileCount: Array.from(formData.values()).filter((value) => value instanceof File).length
  });
}

async function parseVideoTask(response: Response, context: UpstreamContext): Promise<UpstreamVideoTask> {
  if (!response.ok) {
    const upstreamError = await readUpstreamError(response, context);
    throw new HttpError(upstreamError.message, response.status, upstreamError.code, upstreamError.type);
  }

  const body = await response.json();
  return normalizeVideoTask(body);
}

async function fetchUpstream(context: UpstreamContext, init: RequestInit) {
  try {
    return await fetch(context.url, init);
  } catch (error) {
    console.error("[video-upstream] network error", {
      operation: context.operation,
      url: context.url,
      message: error instanceof Error ? error.message : String(error)
    });
    throw error;
  }
}

export async function createVideoTask(apiKey: string, formData: FormData) {
  const context = { operation: "createVideoTask", url: `${getVideoApiBaseUrl()}/v1/videos` };
  const canSendJson = !hasFormDataFiles(formData);
  const jsonPayload = canSendJson ? formDataToJsonPayload(formData) : null;
  maybeLogCreatePayload(formData, jsonPayload);
  const response = await fetchUpstream(context, {
    method: "POST",
    headers: canSendJson
      ? { ...authHeaders(apiKey), "Content-Type": "application/json" }
      : authHeaders(apiKey),
    body: canSendJson ? JSON.stringify(jsonPayload) : formData
  });

  return parseVideoTask(response, context);
}

export async function getVideoTask(apiKey: string, id: string) {
  const context = { operation: "getVideoTask", url: `${getVideoApiBaseUrl()}/v1/videos/${encodeURIComponent(id)}` };
  const response = await fetchUpstream(context, {
    headers: authHeaders(apiKey),
    cache: "no-store"
  });

  const task = await parseVideoTask(response, context);
  return { ...task, id };
}

export async function cancelVideoTask(apiKey: string, id: string) {
  const context = { operation: "cancelVideoTask", url: `${getVideoApiBaseUrl()}/v1/videos/${encodeURIComponent(id)}/cancel` };
  const response = await fetchUpstream(context, {
    method: "POST",
    headers: authHeaders(apiKey)
  });

  const task = await parseVideoTask(response, context);
  return { ...task, id };
}

export async function retryVideoTask(apiKey: string, id: string) {
  const context = { operation: "retryVideoTask", url: `${getVideoApiBaseUrl()}/v1/videos/${encodeURIComponent(id)}/retry` };
  const response = await fetchUpstream(context, {
    method: "POST",
    headers: authHeaders(apiKey)
  });

  const task = await parseVideoTask(response, context);
  return { ...task, id };
}
