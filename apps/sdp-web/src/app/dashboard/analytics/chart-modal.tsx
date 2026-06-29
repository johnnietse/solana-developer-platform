"use client";

import { useCallback, type ReactNode } from "react";
import { motion, AnimatePresence } from "motion/react";
import { XIcon, DownloadIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { exportPng } from "./chart-export";

interface ChartModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
}

export function ChartModal({ open, onClose, title, children }: ChartModalProps) {
  const handleExport = useCallback(() => {
    const el = document.querySelector('[data-modal-chart]') as HTMLElement | null;
    exportPng(el, title.toLowerCase().replace(/\s+/g, "-"));
  }, [title]);

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-50 flex items-center justify-center bg-gray-1400/50 backdrop-blur-sm"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
          onClick={onClose}
        >
          <motion.div
            className="mx-4 flex max-h-[90vh] w-full max-w-5xl flex-col rounded-xl bg-white shadow-2xl"
            initial={{ opacity: 0, scale: 0.96, y: 10 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, y: 10 }}
            transition={{ duration: 0.15, ease: "easeOut" }}
            onClick={(e: React.MouseEvent) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-[rgba(28,28,29,0.1)] px-6 py-4">
              <h2 className="text-lg font-semibold text-[#1c1c1d]">{title}</h2>
              <div className="flex items-center gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  type="button"
                  onClick={handleExport}
                  className="h-8 gap-1.5 px-2.5 text-xs text-[rgba(28,28,29,0.72)] hover:text-[#1c1c1d]"
                >
                  <DownloadIcon className="h-4 w-4" />
                  PNG
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  type="button"
                  onClick={onClose}
                  className="h-8 w-8 p-0 text-[rgba(28,28,29,0.72)] hover:text-[#1c1c1d]"
                >
                  <XIcon className="h-5 w-5" />
                </Button>
              </div>
            </div>
            <div className="flex-1 overflow-auto p-6">
              <div data-modal-chart className="h-[500px]">
                {children}
              </div>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
