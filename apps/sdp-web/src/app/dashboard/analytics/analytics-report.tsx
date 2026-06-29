"use client";

import { useState } from "react";
import { FileTextIcon, LoaderIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { toPng } from "html-to-image";

async function captureCard(el: HTMLElement): Promise<string | null> {
  try {
    return await toPng(el, {
      quality: 0.92,
      pixelRatio: 2,
      backgroundColor: "#ffffff",
      cacheBust: true,
    });
  } catch {
    const svg = el.querySelector("svg");
    if (!svg) return null;
    try {
      const xml = new XMLSerializer().serializeToString(svg);
      const canvas = document.createElement("canvas");
      const ctx = canvas.getContext("2d");
      if (!ctx) return null;
      const img = await new Promise<HTMLImageElement>((resolve, reject) => {
        const i = new Image();
        i.onload = () => resolve(i);
        i.onerror = reject;
        i.src = URL.createObjectURL(new Blob([xml], { type: "image/svg+xml;charset=utf-8" }));
      });
      const scale = 2;
      canvas.width = img.width * scale;
      canvas.height = img.height * scale;
      ctx.scale(scale, scale);
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, img.width, img.height);
      ctx.drawImage(img, 0, 0);
      return canvas.toDataURL("image/png");
    } catch {
      return null;
    }
  }
}

function getSectionLabel(el: HTMLElement): string {
  const aria = el.getAttribute("aria-label");
  if (aria) return aria;
  const heading = el.querySelector("h2, h3, .text-\\[19px\\], [class*='font-semibold']");
  if (heading?.textContent?.trim()) return heading.textContent.trim();
  const firstP = el.querySelector("p");
  if (firstP?.textContent?.trim()) return firstP.textContent.trim();
  return "Section";
}

export function ReportButton() {
  const [loading, setLoading] = useState(false);

  async function generateReport() {
    setLoading(true);
    try {
      const cards = document.querySelectorAll<HTMLElement>(
        '[data-analytics-root] [data-report="section"], [data-analytics-root] [role="region"]'
      );
      const entries: { label: string; src: string | null }[] = [];

      for (const card of cards) {
        if (card.getBoundingClientRect().height < 50) continue;
        const label = getSectionLabel(card);
        const src = await captureCard(card);
        entries.push({ label, src });
      }

      const reportHtml = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Analytics Report</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; padding: 40px; color: #1c1c1d; background: #fff; max-width: 900px; margin: 0 auto; }
  h1 { font-size: 28px; font-weight: 600; margin: 0 0 4px; }
  .meta { color: #6b6b6d; font-size: 13px; margin: 0 0 32px; }
  .section { margin-bottom: 32px; }
  .section-label { font-size: 13px; font-weight: 500; color: #6b6b6d; text-transform: uppercase; letter-spacing: 0.5px; margin: 0 0 8px; }
  img { display: block; max-width: 100%; border: 1px solid #e5e5e5; border-radius: 10px; }
  .footer { margin-top: 40px; padding-top: 16px; border-top: 1px solid #eee; font-size: 11px; color: #999; }
</style></head><body>
<h1>Analytics Report</h1>
<p class="meta">Generated ${new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric", hour: "2-digit", minute: "2-digit" })}</p>
${entries.map((e) => e.src ? `<div class="section"><p class="section-label">${e.label}</p><img src="${e.src}" alt="${e.label}" /></div>` : "").join("\n")}
<div class="footer">Solana Developer Platform &mdash; Analytics Export</div>
</body></html>`;

      const blob = new Blob([reportHtml], { type: "text/html" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `analytics-report-${new Date().toISOString().slice(0, 10)}.html`;
      a.click();
      URL.revokeObjectURL(url);
    } finally {
      setLoading(false);
    }
  }

  return (
    <Button
      variant="outline"
      size="sm"
      type="button"
      onClick={generateReport}
      disabled={loading}
      className="gap-1.5"
    >
      {loading ? (
        <LoaderIcon className="h-4 w-4 animate-spin" />
      ) : (
        <FileTextIcon className="h-4 w-4" />
      )}
      {loading ? "Generating..." : "Report"}
    </Button>
  );
}
