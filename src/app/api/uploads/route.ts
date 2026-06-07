import { createUserHash, getApiKeyFromRequest } from "@/lib/auth";
import { getUploadLimits, isR2Configured } from "@/lib/config";
import { HttpError, jsonError } from "@/lib/errors";
import { uploadReferenceImageToR2 } from "@/lib/storage";

export const runtime = "nodejs";

function getFormFiles(formData: FormData) {
  return [...formData.getAll("media[]"), ...formData.getAll("media")].filter((item): item is File => item instanceof File);
}

export async function POST(request: Request) {
  try {
    const apiKey = getApiKeyFromRequest(request);
    if (!apiKey) {
      throw new HttpError("请输入中转密钥。", 401, "missing_api_key", "invalid_request_error");
    }

    if (!isR2Configured()) {
      return Response.json({ object: "list", data: [], storageMode: "direct" });
    }

    const limits = getUploadLimits();
    const maxBytes = limits.maxFileSizeMb * 1024 * 1024;
    const formData = await request.formData();
    const files = getFormFiles(formData);

    if (!files.length) {
      throw new HttpError("请选择参考图片。", 400, "missing_file", "invalid_request_error");
    }
    if (files.length > limits.maxFiles) {
      throw new HttpError(`最多上传 ${limits.maxFiles} 张参考图。`, 400, "too_many_files", "invalid_request_error");
    }

    files.forEach((file) => {
      if (!file.type.startsWith("image/")) {
        throw new HttpError("参考素材仅支持图片格式。", 400, "invalid_file_type", "invalid_request_error");
      }
      if (file.size > maxBytes) {
        throw new HttpError(`单张图片不能超过 ${limits.maxFileSizeMb}MB。`, 400, "file_too_large", "invalid_request_error");
      }
    });

    const userHash = createUserHash(apiKey);
    const data = [];
    for (const file of files) {
      const url = await uploadReferenceImageToR2(userHash, file).catch(() => {
        throw new HttpError("参考图上传云存储失败，请稍后重试。", 502, "upload_storage_failed", "server_error");
      });
      if (url) {
        data.push({
          name: file.name,
          size: file.size,
          type: file.type,
          url
        });
      }
    }

    return Response.json({ object: "list", data, storageMode: "r2" });
  } catch (error) {
    return jsonError(error);
  }
}
