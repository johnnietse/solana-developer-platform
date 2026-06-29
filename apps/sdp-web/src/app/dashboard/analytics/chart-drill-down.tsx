"use client";

import { useCallback } from "react";
import { XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { motion, AnimatePresence } from "motion/react";

interface ChartDrillDownProps {
  open: boolean;
  onClose: () => void;
  title: string;
  subtitle?: string;
  items: Array<{ label: string; value: string }>;
}

export function ChartDrillDown({ open, onClose, title, subtitle, items }: ChartDrillDownProps) {
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    },
    [onClose]
  );

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-50 flex items-center justify-center bg-gray-1400/50 backdrop-blur-sm"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.12 }}
          onClick={onClose}
          onKeyDown={handleKeyDown}
          tabIndex={-1}
        >
          <motion.div
            className="w-full max-w-lg rounded-xl bg-white p-6 shadow-2xl"
            initial={{ opacity: 0, scale: 0.96, y: 8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, y: 8 }}
            transition={{ duration: 0.12, ease: "easeOut" }}
            onClick={(e: React.MouseEvent) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 className="text-lg font-semibold text-[#1c1c1d]">{title}</h2>
                {subtitle && <p className="text-sm text-[rgba(28,28,29,0.72)]">{subtitle}</p>}
              </div>
              <Button variant="ghost" size="sm" type="button" onClick={onClose} className="h-8 w-8 shrink-0 p-0 text-[rgba(28,28,29,0.72)] hover:text-[#1c1c1d]">
                <XIcon className="h-5 w-5" />
              </Button>
            </div>
            <div className="mt-5 space-y-3">
              {items.map((item) => (
                <div key={item.label} className="flex items-center justify-between rounded-lg bg-[rgba(28,28,29,0.03)] px-4 py-2.5">
                  <span className="text-sm text-[rgba(28,28,29,0.72)]">{item.label}</span>
                  <span className="text-sm font-medium text-[#1c1c1d]">{item.value}</span>
                </div>
              ))}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
