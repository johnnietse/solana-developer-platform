import type { Project } from "@sdp/types";
import { fetchDefaultProject } from "@/lib/projects";
import { createTimedTrace } from "@/lib/request-tracing";
import { createSdpApiClient } from "@/lib/sdp-api";

export interface DashboardLayoutData {
  defaultProject: Project | null;
}

export async function loadDashboardLayoutData(
  orgId: string | null
): Promise<DashboardLayoutData> {
  if (!orgId) {
    return { defaultProject: null };
  }

  const trace = createTimedTrace("dashboard.layout.page");
  let defaultProject: Project | null = null;

  try {
    const apiClient = await trace.step("create_sdp_api_client", () =>
      createSdpApiClient(trace.childContext("dashboard.layout.api"))
    );
    defaultProject = await trace.step("fetch_default_project", () =>
      fetchDefaultProject(apiClient.request)
    );
    trace.log({ ok: true, hasProject: Boolean(defaultProject) });
  } catch (error) {
    trace.log({
      ok: false,
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }

  return { defaultProject };
}
