"use client";
import { useEffect } from "react";

export function HomePageClass() {
  useEffect(() => {
    document.documentElement.classList.add("docs-is-home");
    return () => document.documentElement.classList.remove("docs-is-home");
  }, []);
  return null;
}
