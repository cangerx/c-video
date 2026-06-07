import { createUserHash, getApiKeyFromRequest } from "@/lib/auth";
import { getStoredTask, getUsageSummary, recordUsageEvent, upsertVideoTask } from "@/lib/db";
import { HttpError, jsonError } from "@/lib/errors";
import { retryVideoTask } from "@/lib/upstream";
import { calculateCostUnits } from "@/lib/video-request";

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
    const previousTask = getStoredTask(userHash, id);
    const task = await retryVideoTask(apiKey, id);
    const costUnits = calculateCostUnits(task.seconds || previousTask?.seconds);
    const storedTask = upsertVideoTask(userHash, task, { costUnits });
    recordUsageEvent(userHash, task.id, "retry", costUnits);

    return Response.json({ task, storedTask, usage: getUsageSummary(userHash) });
  } catch (error) {
    return jsonError(error);
  }
}
