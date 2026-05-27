import { auth } from "@clerk/nextjs/server";
import type { ListProjectsResponse, Project } from "@sdp/types";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { DashboardShell } from "@/components/dashboard-shell";
import { DashboardWorkspaceProvider } from "@/contexts/dashboard-workspace-context";
import { NetworkDebugProvider } from "@/contexts/network-debug-context";
import { getAuthEntryPath } from "@/lib/auth-entry";
import { resolveDashboardAccess } from "@/lib/dashboard-access";
import { type DashboardCacheScope, getDashboardCacheScopeKey } from "@/lib/dashboard-cache-scope";
import { PROJECT_COOKIE_NAME } from "@/lib/project-cookie";
import { sdpApiFetch } from "@/lib/sdp-api";

async function loadProjects(): Promise<Project[]> {
  try {
    const response = await sdpApiFetch<ListProjectsResponse>("/v1/projects");
    return response.projects;
  } catch {
    return [];
  }
}

async function ensureSelectedProjectCookie(projects: Project[]): Promise<void> {
  if (projects.length === 0) return;

  const store = await cookies();
  const current = store.get(PROJECT_COOKIE_NAME)?.value ?? null;
  if (current && projects.some((project) => project.id === current)) {
    return;
  }

  const fallback =
    projects.find((project) => project.slug === "default-sandbox") ?? projects[0] ?? null;
  if (!fallback) return;

  store.set(PROJECT_COOKIE_NAME, fallback.id, {
    path: "/",
    maxAge: 31_536_000,
    sameSite: "lax",
  });
}

export default async function DashboardLayout({ children }: { children: ReactNode }) {
  const { orgRole, orgId, userId } = await auth();

  if (!userId || !orgId) {
    redirect(await getAuthEntryPath());
  }

  const dashboardAccess = resolveDashboardAccess(orgRole);
  const dashboardCacheScope = {
    orgId,
    userId,
  } satisfies DashboardCacheScope;

  const projects = await loadProjects();
  await ensureSelectedProjectCookie(projects);

  return (
    <DashboardWorkspaceProvider
      key={getDashboardCacheScopeKey(dashboardCacheScope)}
      dashboardAccess={dashboardAccess}
      serverDashboardCacheScope={dashboardCacheScope}
      projects={projects}
    >
      <NetworkDebugProvider>
        <DashboardShell>{children}</DashboardShell>
      </NetworkDebugProvider>
    </DashboardWorkspaceProvider>
  );
}
