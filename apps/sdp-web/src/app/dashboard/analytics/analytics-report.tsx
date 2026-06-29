"use client";

import { useState } from "react";
import { PrinterIcon, LoaderIcon } from "lucide-react";
import { Button } from "@/components/ui/button";

export function ReportButton() {
  const [loading, setLoading] = useState(false);

  async function printReport() {
    setLoading(true);
    await document.fonts.ready;
    setTimeout(() => {
      window.print();
      setLoading(false);
    }, 300);
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
