import { createUserHash, getApiKeyFromRequest } from "@/lib/auth";
import { HttpError, jsonError } from "@/lib/errors";
import { getUsageSummary, listStoredTasks, recordUsageEvent, upsertVideoTask } from "@/lib/db";
import { createVideoTask } from "@/lib/upstream";
import { prepareVideoFormData } from "@/lib/video-request";
import { isR2Configured } from "@/lib/config";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const apiKey = getApiKeyFromRequest(request);
    if (!apiKey) {
      throw new HttpError("请输入中转密钥。", 401, "missing_api_key", "invalid_request_error");
    }

    const { searchParams } = new URL(request.url);
    const limit = Number(searchParams.get("limit") || 30);
    const userHash = createUserHash(apiKey);

    return Response.json({
      object: "list",
      data: listStoredTasks(userHash, limit),
      usage: getUsageSummary(userHash),
      r2Configured: isR2Configured()
    });
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(request: Request) {
  try {
    const apiKey = getApiKeyFromRequest(request);
    if (!apiKey) {
      throw new HttpError("请输入中转密钥。", 401, "missing_api_key", "invalid_request_error");
    }

    const formData = await request.formData();
    const prompt = String(formData.get("prompt") || formData.get("input") || "").trim();
    if (!prompt) {
      throw new HttpError("请输入视频提示词。", 400, "missing_prompt", "invalid_request_error");
    }
    if (prompt.length > 3500) {
      throw new HttpError("提示词不能超过 3500 个字符。", 400, "prompt_too_long", "invalid_request_error");
    }

    const userHash = createUserHash(apiKey);
    const prepared = await prepareVideoFormData(formData, userHash);
    const storedPrompt = String(prepared.formData.get("prompt") || prepared.formData.get("input") || prompt).trim();
    const storedSeconds = String(prepared.formData.get("seconds") || prepared.formData.get("duration") || "15");
    const storedSize = String(prepared.formData.get("size") || "1280x720");
    const storedModel = String(prepared.formData.get("model") || "seedance-2");
    const task = await createVideoTask(apiKey, prepared.formData);
    const storedTask = upsertVideoTask(userHash, task, {
      mediaUrls: prepared.mediaUrls,
      costUnits: prepared.costUnits,
      prompt: storedPrompt,
      seconds: storedSeconds,
      size: storedSize,
      model: storedModel
    });
    recordUsageEvent(userHash, task.id, "create", prepared.costUnits);

    return Response.json({
      task,
      storedTask,
      usage: getUsageSummary(userHash),
      storageMode: prepared.storageMode
    });
  } catch (error) {
    return jsonError(error);
  }
}
