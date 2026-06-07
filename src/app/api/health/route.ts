import { getDatabaseHealth } from "@/lib/db";
import { isR2Configured, isServerSecretConfigured } from "@/lib/config";

export const runtime = "nodejs";

export async function GET() {
  try {
    const database = getDatabaseHealth();

    return Response.json({
      ok: database.ok,
      database,
      r2Configured: isR2Configured(),
      serverSecretConfigured: isServerSecretConfigured(),
      node: process.version,
      uptime: Math.round(process.uptime())
    });
  } catch (error) {
    console.error("[health] check failed", {
      message: error instanceof Error ? error.message : String(error)
    });

    return Response.json(
      {
        ok: false,
        error: "health_check_failed"
      },
      { status: 500 }
    );
  }
}
