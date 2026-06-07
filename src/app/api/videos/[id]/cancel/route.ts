import { createUserHash, getApiKeyFromRequest } from "@/lib/auth";
import { getUsageSummary, upsertVideoTask } from "@/lib/db";
import { HttpError, jsonError } from "@/lib/errors";
import { cancelVideoTask } from "@/lib/upstream";

export const runtime = "nodejs";

type RouteContext = {
  params: Promise<{ id: string }>;
};

export async function POST(request: Request, context: RouteContext) {
  try {
    const apiKey = getApiKeyFromRequest(request);
    if (!apiKey) {
      throw new HttpError("请输入中转密钥。", 401, "missing_api_key", "invalid_request_error");
    }

    const { id } = await context.params;
    const userHash = createUserHash(apiKey);
    const task = await cancelVideoTask(apiKey, id);
    const storedTask = upsertVideoTask(userHash, task);

    return Response.json({ task, storedTask, usage: getUsageSummary(userHash) });
  } catch (error) {
    return jsonError(error);
  }
}
