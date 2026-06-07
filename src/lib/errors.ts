export class HttpError extends Error {
  status: number;
  code: string;
  type: string;

  constructor(message: string, status = 500, code = "internal_error", type = "server_error") {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
    this.type = type;
  }
}

type UpstreamErrorContext = {
  operation: string;
  url: string;
};

function truncateLogValue(value: string, maxLength = 1200) {
  return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
}

function getStringValue(value: unknown) {
  return typeof value === "string" ? value : "";
}

function getQuotaErrorMessage(message: string) {
  const quotaMatch = message.match(/token remain quota:\s*([^\s,]+),\s*need quota:\s*([^\s,]+)/i);
  if (!quotaMatch) {
    return "额度不足，请检查中转账户余额。";
  }

  return `额度不足：当前余额 ${quotaMatch[1]}，本次需要 ${quotaMatch[2]}。请充值或降低生成时长后重试。`;
}

function logUpstreamError(
  response: Response,
  context: UpstreamErrorContext | undefined,
  error: { message: string; code: string; type: string; rawBody: string }
) {
  console.error("[video-upstream] request failed", {
    operation: context?.operation || "unknown",
    url: context?.url || response.url || "unknown",
    status: response.status,
    statusText: response.statusText,
    code: error.code,
    type: error.type,
    message: error.message,
    body: truncateLogValue(error.rawBody)
  });
}

export function jsonError(error: unknown) {
  if (error instanceof HttpError) {
    return Response.json(
      { error: { message: getFriendlyErrorMessage(error.message, error.code, error.status), code: error.code, type: error.type } },
      { status: error.status }
    );
  }

  console.error("[video-api] unhandled error", {
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined
  });
  return Response.json(
    { error: { message: "服务暂时不可用，请稍后重试。", code: "internal_error", type: "server_error" } },
    { status: 500 }
  );
}

export function getFriendlyErrorMessage(message: string, code = "", status = 0) {
  const lowerCode = code.toLowerCase();
  const lowerMessage = message.toLowerCase();

  if (status === 401 || lowerCode.includes("api_key") || lowerMessage.includes("api key")) {
    return "密钥无效或已失效，请重新登录。";
  }
  if (status === 402 || lowerCode.includes("quota") || lowerCode.includes("balance") || lowerMessage.includes("insufficient")) {
    return getQuotaErrorMessage(message);
  }
  if (status === 429 || lowerCode.includes("rate")) {
    return "请求过于频繁，请稍后再试。";
  }
  if (status === 404) {
    return "任务不存在或已过期，请刷新历史任务。";
  }
  if (lowerCode.includes("network") || lowerCode.includes("timeout")) {
    return "无法连接上游服务，请稍后重试。";
  }
  if (lowerCode.includes("prompt")) {
    return message;
  }
  if (lowerCode.includes("file") || lowerCode.includes("upload")) {
    return message;
  }
  if (lowerCode.includes("model")) {
    return "当前模型暂不可用，请稍后再试。";
  }
  if (status >= 500) {
    return "上游服务暂时繁忙，请稍后刷新或重试。";
  }

  return message || "请求失败，请稍后重试。";
}

export async function readUpstreamError(response: Response, context?: UpstreamErrorContext) {
  const fallback = `Upstream request failed with status ${response.status}`;
  let rawBody = "";

  try {
    rawBody = await response.text();
    const body = rawBody ? JSON.parse(rawBody) : null;
    const upstreamError = body?.error;
    const message =
      getStringValue(upstreamError?.message) ||
      getStringValue(upstreamError?.reason) ||
      getStringValue(body?.message) ||
      fallback;
    const code = getStringValue(upstreamError?.code) || getStringValue(body?.code) || "upstream_error";
    const type = getStringValue(upstreamError?.type) || getStringValue(body?.type) || "upstream_error";
    const mappedError = {
      message: getFriendlyErrorMessage(message, code, response.status),
      code,
      type,
      rawBody
    };
    logUpstreamError(response, context, mappedError);
    return {
      message: mappedError.message,
      code: mappedError.code,
      type: mappedError.type
    };
  } catch {
    logUpstreamError(response, context, {
      message: fallback,
      code: "upstream_error",
      type: "upstream_error",
      rawBody
    });
    return {
      message: getFriendlyErrorMessage(fallback, "upstream_error", response.status),
      code: "upstream_error",
      type: "upstream_error"
    };
  }
}
