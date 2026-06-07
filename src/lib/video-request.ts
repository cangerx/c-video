import { getUploadLimits, isR2Configured } from "./config";
import { HttpError } from "./errors";
import { uploadReferenceImageToR2 } from "./storage";

function getFormFiles(formData: FormData) {
  return [...formData.getAll("media[]"), ...formData.getAll("media")].filter((item): item is File => item instanceof File);
}

function getRemoteUrls(formData: FormData) {
  return formData
    .getAll("media_urls")
    .flatMap((value) => String(value).split(/[\n,]/))
    .map((url) => url.trim())
    .filter(Boolean);
}

function assertRemoteUrl(value: string) {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("invalid protocol");
    }
  } catch {
    throw new HttpError("参考图 URL 格式不正确，请使用 http 或 https 链接。", 400, "invalid_media_url", "invalid_request_error");
  }
}

function assertSeconds(value: FormDataEntryValue | null) {
  const seconds = Number(value || 5);
  if (!Number.isInteger(seconds) || seconds < 5 || seconds > 15) {
    throw new HttpError("视频时长仅支持 5-15 秒。", 400, "invalid_seconds", "invalid_request_error");
  }
}

function parseChineseReferenceIndex(value: string) {
  const normalized = value.trim();
  if (/^\d+$/.test(normalized)) {
    return Number(normalized);
  }

  const digits: Record<string, number> = {
    一: 1,
    二: 2,
    两: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9
  };

  if (normalized === "十") {
    return 10;
  }
  if (normalized.startsWith("十")) {
    return 10 + (digits[normalized.slice(1)] || 0);
  }
  if (normalized.endsWith("十")) {
    return (digits[normalized.slice(0, -1)] || 0) * 10;
  }
  if (normalized.includes("十")) {
    const [tens, ones] = normalized.split("十");
    return (digits[tens] || 0) * 10 + (digits[ones] || 0);
  }

  return digits[normalized] || 0;
}

function normalizePromptReferences(prompt: string, referenceCount: number) {
  if (!referenceCount) {
    return prompt;
  }

  return prompt.replace(/@(?:图片|图)\s*([一二两三四五六七八九十]{1,3}|\d{1,2})/g, (match, rawIndex) => {
    const index = parseChineseReferenceIndex(rawIndex);
    return index >= 1 && index <= referenceCount ? `@IMG_${index}` : match;
  });
}

function collectPromptReferenceIndexes(prompt: string) {
  const indexes = new Set<number>();
  const pattern = /@(?:IMG[_-]?(\d{1,2})|(?:图片|图)\s*([一二两三四五六七八九十]{1,3}|\d{1,2}))/gi;
  let match = pattern.exec(prompt);

  while (match) {
    const index = match[1] ? Number(match[1]) : parseChineseReferenceIndex(match[2]);
    if (index > 0) {
      indexes.add(index);
    }
    match = pattern.exec(prompt);
  }

  return Array.from(indexes).sort((a, b) => a - b);
}

function normalizeFormPromptReferences(formData: FormData, referenceCount: number) {
  const promptKey = formData.has("prompt") ? "prompt" : formData.has("input") ? "input" : "";
  if (!promptKey) {
    return;
  }

  const prompt = String(formData.get(promptKey) || "");
  const normalizedPrompt = normalizePromptReferences(prompt, referenceCount);
  const missingIndexes = collectPromptReferenceIndexes(normalizedPrompt).filter((index) => index > referenceCount);
  if (missingIndexes.length) {
    throw new HttpError(
      `提示词引用了 ${missingIndexes.map((index) => `@IMG_${index}`).join("、")}，但当前只有 ${referenceCount} 张参考图。`,
      400,
      "missing_reference_image",
      "invalid_request_error"
    );
  }

  formData.set(promptKey, normalizedPrompt);
}

export function calculateCostUnits(_seconds?: string | number | null) {
  return 1;
}

export async function prepareVideoFormData(formData: FormData, userHash: string) {
  const limits = getUploadLimits();
  const maxBytes = limits.maxFileSizeMb * 1024 * 1024;
  const files = getFormFiles(formData);
  const remoteUrls = getRemoteUrls(formData);
  const totalReferences = files.length + remoteUrls.length;

  assertSeconds(formData.get("seconds") || formData.get("duration"));

  if (totalReferences > limits.maxFiles) {
    throw new HttpError(`最多上传 ${limits.maxFiles} 张参考图。`, 400, "too_many_files", "invalid_request_error");
  }

  remoteUrls.forEach(assertRemoteUrl);

  files.forEach((file) => {
    if (!file.type.startsWith("image/")) {
      throw new HttpError("参考素材仅支持图片格式。", 400, "invalid_file_type", "invalid_request_error");
    }
    if (file.size > maxBytes) {
      throw new HttpError(`单张图片不能超过 ${limits.maxFileSizeMb}MB。`, 400, "file_too_large", "invalid_request_error");
    }
  });

  const nextFormData = new FormData();
  for (const [key, value] of formData.entries()) {
    if (key !== "media[]" && key !== "media" && key !== "media_urls") {
      nextFormData.append(key, value);
    }
  }

  const uploadedUrls: string[] = [];
  if (isR2Configured()) {
    for (const file of files) {
      const url = await uploadReferenceImageToR2(userHash, file).catch(() => {
        throw new HttpError("参考图上传云存储失败，请稍后重试。", 502, "upload_storage_failed", "server_error");
      });
      if (url) {
        uploadedUrls.push(url);
      }
    }
  } else {
    files.forEach((file) => nextFormData.append("media[]", file));
  }

  const mediaUrls = [...remoteUrls, ...uploadedUrls];
  normalizeFormPromptReferences(nextFormData, mediaUrls.length);
  mediaUrls.forEach((url) => nextFormData.append("media_urls", url));

  return {
    formData: nextFormData,
    mediaUrls,
    costUnits: calculateCostUnits(String(formData.get("seconds") || "5")),
    storageMode: isR2Configured() ? "r2" : "direct"
  };
}
