import { createHash } from "crypto";
import { API_KEY_HEADER, getServerSecret } from "./config";

export function getApiKeyFromRequest(request: Request) {
  const headerKey = request.headers.get(API_KEY_HEADER);
  const bearer = request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
  return (headerKey || bearer || "").trim();
}

export function createUserHash(apiKey: string) {
  return createHash("sha256")
    .update(apiKey)
    .update(":")
    .update(getServerSecret())
    .digest("hex");
}
