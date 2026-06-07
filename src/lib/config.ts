export const API_KEY_HEADER = "x-video-api-key";

function getPositiveIntegerEnv(name: string, fallback: number) {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

export function getVideoApiBaseUrl() {
  return (process.env.VIDEO_API_BASE_URL || "https://ai.772.ee").replace(/\/+$/, "");
}

export function getServerSecret() {
  const secret = process.env.SERVER_SECRET;
  if (process.env.NODE_ENV === "production" && (!secret || secret === "change-this-long-random-secret")) {
    throw new Error("SERVER_SECRET must be set before running in production.");
  }
  if (!secret || secret === "change-this-long-random-secret") {
    return "dev-secret-change-before-production";
  }
  return secret;
}

export function isServerSecretConfigured() {
  const secret = process.env.SERVER_SECRET;
  return Boolean(secret && secret !== "change-this-long-random-secret");
}

export function getSqlitePath() {
  return process.env.SQLITE_PATH || "./data/video.db";
}

export function getUploadLimits() {
  return {
    maxFiles: getPositiveIntegerEnv("MAX_UPLOAD_FILES", 9),
    maxFileSizeMb: getPositiveIntegerEnv("MAX_UPLOAD_FILE_SIZE_MB", 10)
  };
}

export function getR2Config() {
  const endpoint = process.env.R2_ENDPOINT || (
    process.env.R2_ACCOUNT_ID ? `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com` : ""
  );

  return {
    endpoint: endpoint.replace(/\/+$/, ""),
    bucket: process.env.R2_BUCKET || "",
    accessKeyId: process.env.R2_ACCESS_KEY_ID || "",
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY || "",
    publicBaseUrl: (process.env.R2_PUBLIC_BASE_URL || "").replace(/\/+$/, "")
  };
}

export function isR2Configured() {
  const config = getR2Config();
  return Boolean(
    config.endpoint &&
      config.bucket &&
      config.accessKeyId &&
      config.secretAccessKey &&
      config.publicBaseUrl
  );
}
