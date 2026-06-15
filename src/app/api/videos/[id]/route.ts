import { createUserHash, getApiKeyFromRequest } from "@/lib/auth";
import { getUsageSummary, upsertVideoTask, markTaskAsFailed } from "@/lib/db";
import { HttpError, jsonError } from "@/lib/errors";
import { getVideoTask } from "@/lib/upstream";

export const runtime = "nodejs";

type RouteContext = {
  params: Promise<{ id: string }>;
};

export async function GET(request: Request, context: RouteContext) {
  const { id } = await context.params;
  let userHash = "";
  try {
    const apiKey = getApiKeyFromRequest(request);
    if (!apiKey) {
      throw new HttpError("请输入中转密钥。", 401, "missing_api_key", "invalid_request_error");
    }

    userHash = createUserHash(apiKey);
    const task = await getVideoTask(apiKey, id);
    const storedTask = upsertVideoTask(userHash, task);

    return Response.json({ task, storedTask, usage: getUsageSummary(userHash) });
  } catch (error) {
    if (userHash && id) {
      const isPermanent = error instanceof HttpError && (error.status === 404 || error.status === 400);
      const isUnrecognized = error instanceof Error && error.message.toLowerCase().includes("unrecognized");
      if (isPermanent || isUnrecognized) {
        const msg = error instanceof Error ? error.message : "上游查询失败";
        try {
          markTaskAsFailed(userHash, id, msg);
        } catch (dbErr) {
          console.error("[video-api] failed to mark task as failed in db", dbErr);
        }
      }
    }
    return jsonError(error);
  }
}
