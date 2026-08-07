export type HealthStatus = "checking" | "ready" | "unavailable";

export function decodeHealthResponse(value: unknown): "ready" | "unavailable" {
  if (
    typeof value === "object" &&
    value !== null &&
    "status" in value &&
    value.status === "ready"
  ) {
    return "ready";
  }

  return "unavailable";
}

export async function fetchReadiness(signal?: AbortSignal): Promise<HealthStatus> {
  try {
    const response = await fetch("/api/v1/health/ready", {
      headers: { Accept: "application/json" },
      signal
    });
    if (!response.ok) {
      return "unavailable";
    }

    return decodeHealthResponse(await response.json());
  } catch {
    return "unavailable";
  }
}

