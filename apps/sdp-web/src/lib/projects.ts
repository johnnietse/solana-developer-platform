import type { ListProjectsResponse, Project } from "@sdp/types";
import type { SdpApiClient } from "@/lib/sdp-api";

export async function fetchProjects(request: SdpApiClient["request"]): Promise<Project[]> {
  const response = await request("/v1/projects");
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`SDP API request failed (${response.status}): ${body}`);
  }

  const json = (await response.json()) as { data: ListProjectsResponse } | ListProjectsResponse;
  const payload = "data" in json ? json.data : json;
  return payload.projects;
}

export async function fetchDefaultProject(
  request: SdpApiClient["request"]
): Promise<Project | null> {
  const projects = await fetchProjects(request);
  return projects[0] ?? null;
}
