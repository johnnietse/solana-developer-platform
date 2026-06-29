"use client";

import { useState } from "react";
import { PrinterIcon, LoaderIcon } from "lucide-react";
import { Button } from "@/components/ui/button";

export function ReportButton() {
  const [loading, setLoading] = useState(false);

  async function printReport() {
    setLoading(true);
    const style = document.createElement("style");
    style.id = "analytics-print-overrides";
    style.textContent = `
@media print {
  body { background: #fff !important; }
  [data-analytics-root] > div { break-inside: avoid; page-break-inside: avoid; }
  .recharts-wrapper { height: 350px !important; }
  .recharts-legend-item-text { font-size: 11px; }
  .kpi-card { break-inside: avoid; page-break-inside: avoid; }
  table { break-inside: avoid; page-break-inside: avoid; font-size: 10px; }
  th { background: #f5f5f4 !important; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  tr:nth-child(even) { background: #fafaf9 !important; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  h1 { font-size: 20px; margin-bottom: 4px; }
  p { font-size: 11px; }
}
`;
    document.head.appendChild(style);
    await document.fonts.ready;
    setTimeout(() => {
      window.print();
      const el = document.getElementById("analytics-print-overrides");
      if (el) el.remove();
      setLoading(false);
    }, 500);
  }

  return (
    <Button
      variant="outline"
      size="sm"
      type="button"
      onClick={printReport}
      disabled={loading}
      className="gap-1.5"
    >
      {loading ? (
        <LoaderIcon className="h-4 w-4 animate-spin" />
      ) : (
        <PrinterIcon className="h-4 w-4" />
      )}
      {loading ? "Preparing..." : "Print"}
    </Button>
  );
}
