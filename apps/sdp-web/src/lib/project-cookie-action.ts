"use server";

import { cookies } from "next/headers";
import { PROJECT_COOKIE_NAME } from "./project-cookie";

/**
 * Sets (or clears) the selected project cookie server-side.
 * Returns true if the stored value changed, so the caller can decide whether
 * to trigger a router refresh.
 */
export async function selectProjectAction(projectId: string | null): Promise<boolean> {
  const store = await cookies();
  const prev = store.get(PROJECT_COOKIE_NAME)?.value ?? null;

  if (!projectId) {
    store.delete(PROJECT_COOKIE_NAME);
    return prev !== null;
  }

  store.set(PROJECT_COOKIE_NAME, projectId, {
    path: "/",
    maxAge: 31_536_000,
    sameSite: "lax",
  });

  return projectId !== prev;
}
