import { createHash, createHmac, randomUUID } from "crypto";
import { getR2Config, isR2Configured } from "./config";

function hmac(key: Buffer | string, value: string) {
  return createHmac("sha256", key).update(value).digest();
}

function getSigningKey(secretAccessKey: string, dateStamp: string) {
  const dateKey = hmac(`AWS4${secretAccessKey}`, dateStamp);
  const regionKey = hmac(dateKey, "auto");
  const serviceKey = hmac(regionKey, "s3");
  return hmac(serviceKey, "aws4_request");
}

function safeFileName(name: string) {
  const extension = name.includes(".") ? name.split(".").pop() : "";
  const cleanExtension = extension?.replace(/[^a-zA-Z0-9]/g, "").slice(0, 8);
  return cleanExtension ? `${randomUUID()}.${cleanExtension.toLowerCase()}` : randomUUID();
}

export async function uploadReferenceImageToR2(userHash: string, file: File) {
  if (!isR2Configured()) {
    return null;
  }

  const config = getR2Config();
  const body = Buffer.from(await file.arrayBuffer());
  const payloadHash = createHash("sha256").update(body).digest("hex");
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const key = `video/${userHash.slice(0, 12)}/${dateStamp}/${safeFileName(file.name)}`;
  const url = new URL(`${config.endpoint}/${config.bucket}/${key}`);
  const canonicalUri = `/${config.bucket}/${key}`;
  const contentType = file.type || "application/octet-stream";
  const signedHeaders = "content-type;host;x-amz-content-sha256;x-amz-date";
  const canonicalHeaders = [
    `content-type:${contentType}`,
    `host:${url.host}`,
    `x-amz-content-sha256:${payloadHash}`,
    `x-amz-date:${amzDate}`
  ].join("\n");
  const canonicalRequest = [
    "PUT",
    canonicalUri,
    "",
    `${canonicalHeaders}\n`,
    signedHeaders,
    payloadHash
  ].join("\n");
  const credentialScope = `${dateStamp}/auto/s3/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    createHash("sha256").update(canonicalRequest).digest("hex")
  ].join("\n");
  const signingKey = getSigningKey(config.secretAccessKey, dateStamp);
  const signature = hmac(signingKey, stringToSign).toString("hex");

  const response = await fetch(url, {
    method: "PUT",
    headers: {
      Authorization: `AWS4-HMAC-SHA256 Credential=${config.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
      "content-type": contentType,
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": amzDate
    },
    body
  });

  if (!response.ok) {
    throw new Error(`R2 上传失败：${response.status}`);
  }

  return `${config.publicBaseUrl}/${key}`;
}
