export type VideoStatus = "queued" | "in_progress" | "completed" | "failed" | "cancelled";

export type UpstreamError = {
  message?: string;
  code?: string;
  type?: string;
  param?: string | null;
  reason?: string;
};

export type UpstreamVideoTask = {
  id: string;
  object?: string;
  created?: number;
  created_at?: number;
  model?: string;
  prompt?: string;
  seconds?: string | number;
  size?: string;
  status: VideoStatus;
  progress?: number | null;
  video_url?: string | null;
  thumbnail_url?: string | null;
  error?: UpstreamError | null;
  metadata?: Record<string, unknown> | null;
};

export type StoredVideoTask = {
  id: number;
  upstreamTaskId: string;
  model: string | null;
  prompt: string | null;
  seconds: string | null;
  size: string | null;
  mediaUrls: string[];
  costUnits: number;
  status: VideoStatus;
  progress: number | null;
  videoUrl: string | null;
  thumbnailUrl: string | null;
  errorMessage: string | null;
  errorCode: string | null;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
};

export type UsageEvent = {
  id: number;
  taskId: string | null;
  action: "create" | "retry";
  costUnits: number;
  createdAt: string;
};

export type UsageSummary = {
  totalCostUnits: number;
  recentEvents: UsageEvent[];
};

export type ApiErrorBody = {
  error: {
    message: string;
    code?: string;
    type?: string;
  };
};
