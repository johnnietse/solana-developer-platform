"use client";

import { toPng } from "html-to-image";
import { DownloadIcon } from "lucide-react";
import { Button } from "@/components/ui/button";

export async function exportPng(element: HTMLElement | null, filename: string) {
  if (!element) return;
  try {
    const dataUrl = await toPng(element, {
      quality: 1,
      pixelRatio: 2,
      backgroundColor: "#ffffff",
    });
    const a = document.createElement("a");
    a.href = dataUrl;
    a.download = `${filename}.png`;
    a.click();
  } catch {
    const svg = element.querySelector("svg");
    if (!svg) return;
    const svgData = new XMLSerializer().serializeToString(svg);
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const img = new Image();
    const url = URL.createObjectURL(new Blob([svgData], { type: "image/svg+xml;charset=utf-8" }));
    await new Promise<void>((resolve, reject) => {
      img.onload = () => {
        const scale = 2;
        canvas.width = img.width * scale;
        canvas.height = img.height * scale;
        ctx.scale(scale, scale);
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, img.width, img.height);
        ctx.drawImage(img, 0, 0);
        URL.revokeObjectURL(url);
        const a = document.createElement("a");
        a.href = canvas.toDataURL("image/png");
        a.download = `${filename}.png`;
        a.click();
        resolve();
      };
      img.onerror = reject;
      img.src = url;
    });
  }
}

export function ExportButton({
  targetRef,
  filename,
}: {
  targetRef: React.RefObject<HTMLElement | null>;
  filename: string;
}) {
  return (
    <Button
      variant="ghost"
      size="sm"
      type="button"
      onClick={() => exportPng(targetRef.current, filename)}
      className="h-7 gap-1 px-2 text-xs text-[rgba(28,28,29,0.72)] hover:text-[#1c1c1d]"
    >
      <DownloadIcon className="h-3.5 w-3.5" />
      PNG
    </Button>
  );
}
