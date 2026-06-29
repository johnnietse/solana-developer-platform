"use client";

import { useState, useMemo, useDeferredValue, useCallback } from "react";
import { motion } from "motion/react";
import { SearchIcon, XIcon, ColumnsIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { formatCurrency, formatNumber } from "./analytics-utils";
import type { StablecoinEntry, GeographyEntry, AttributionEntry } from "./analytics-types";

interface AnalyticsTableProps {
  stablecoins: StablecoinEntry[];
  geography: GeographyEntry[];
  attribution: AttributionEntry[];
}

type SortKey = keyof StablecoinEntry;

const ALL_COLUMNS: { key: SortKey; label: string }[] = [
  { key: "symbol", label: "Symbol" },
  { key: "name", label: "Name" },
  { key: "totalSupply", label: "Total Supply" },
  { key: "circulatingSupply", label: "Circulating" },
  { key: "marketCapUsd", label: "Market Cap" },
  { key: "holderCount", label: "Holders" },
  { key: "medianBalance", label: "Median Balance" },
  { key: "priceUsd", label: "Price" },
  { key: "percentChange24h", label: "24h Change" },
];

function CardFrame({ title, description, children }: { title: string; description: string; children: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-[rgba(28,28,29,0.1)] bg-[#fcfcfa] shadow-[0_2px_10px_rgba(28,28,29,0.05)]">
      <div className="flex items-center justify-between gap-4 p-5 pb-0">
        <div>
          <p className="text-[19px] leading-6 font-medium text-[#1c1c1d]">{title}</p>
          <p className="text-sm text-[rgba(28,28,29,0.56)]">{description}</p>
        </div>
      </div>
      <div className="p-5">
        {children}
      </div>
    </div>
  );
}

export function AnalyticsTable({ stablecoins, geography, attribution }: AnalyticsTableProps) {
  const [sortKey, setSortKey] = useState<SortKey>("symbol");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const [search, setSearch] = useState("");
  const deferredSearch = useDeferredValue(search);
  const [visibleColumns, setVisibleColumns] = useState<Set<string>>(
    () => new Set(ALL_COLUMNS.map((c) => c.key))
  );

  const toggleColumn = useCallback((key: string) => {
    setVisibleColumns((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  function toggleSort(key: SortKey) {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("asc");
    }
  }

  const filtered = useMemo(
    () =>
      stablecoins.filter(
        (c) =>
          c.symbol.toLowerCase().includes(deferredSearch.toLowerCase()) ||
          c.name.toLowerCase().includes(deferredSearch.toLowerCase())
      ),
    [stablecoins, deferredSearch]
  );

  const sorted = [...filtered].sort((a, b) => {
    const aVal = a[sortKey];
    const bVal = b[sortKey];
    if (aVal == null) return 1;
    if (bVal == null) return -1;
    if (typeof aVal === "string") {
      return sortDir === "asc"
        ? (aVal as string).localeCompare(bVal as string)
        : (bVal as string).localeCompare(aVal as string);
    }
    return sortDir === "asc"
      ? (aVal as number) - (bVal as number)
      : (bVal as number) - (aVal as number);
  });

  function SortIcon({ col }: { col: SortKey }) {
    if (sortKey !== col) return null;
    return <span className="ml-1 text-[rgba(28,28,29,0.44)]">{sortDir === "asc" ? "▲" : "▼"}</span>;
  }

  function SortHeader({ col, children }: { col: SortKey; children: string }) {
    return (
      <TableHead
        className="cursor-pointer select-none whitespace-nowrap hover:text-[#1c1c1d]"
        onClick={() => toggleSort(col)}
      >
        {children}
        <SortIcon col={col} />
      </TableHead>
    );
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2, ease: "easeOut", delay: 0.2 }}
      className="space-y-6"
    >
      <CardFrame title="Stablecoin Metrics" description="Full breakdown across all tracked stablecoins">
        <div className="space-y-4">
          <div className="flex items-center justify-end gap-2">
            <div className="relative w-56 shrink-0">
              <SearchIcon className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[rgba(28,28,29,0.72)]" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search by name or symbol..."
                className="pl-9 pr-8"
              />
              {search && (
                <button
                  type="button"
                  onClick={() => setSearch("")}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-[rgba(28,28,29,0.72)] hover:text-[#1c1c1d]"
                >
                  <XIcon className="h-4 w-4" />
                </button>
              )}
            </div>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="sm" type="button" className="h-8 gap-1.5 px-2 text-xs text-[rgba(28,28,29,0.72)] hover:text-[#1c1c1d]">
                  <ColumnsIcon className="h-4 w-4" />
                  Columns
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-44">
                {ALL_COLUMNS.map((col) => (
                  <DropdownMenuCheckboxItem
                    key={col.key}
                    checked={visibleColumns.has(col.key)}
                    onCheckedChange={() => toggleColumn(col.key)}
                  >
                    {col.label}
                  </DropdownMenuCheckboxItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  {ALL_COLUMNS.filter((c) => visibleColumns.has(c.key)).map((c) => (
                    <SortHeader key={c.key} col={c.key}>{c.label}</SortHeader>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {sorted.map((coin) => (
                  <TableRow key={coin.mintAddress}>
                    {visibleColumns.has("symbol") && (
                      <TableCell className="font-medium text-[#1c1c1d]">{coin.symbol}</TableCell>
                    )}
                    {visibleColumns.has("name") && (
                      <TableCell className="text-[rgba(28,28,29,0.72)]">{coin.name}</TableCell>
                    )}
                    {visibleColumns.has("totalSupply") && (
                      <TableCell className="text-[#1c1c1d]">{formatCurrency(coin.totalSupply)}</TableCell>
                    )}
                    {visibleColumns.has("circulatingSupply") && (
                      <TableCell className="text-[#1c1c1d]">{formatCurrency(coin.circulatingSupply)}</TableCell>
                    )}
                    {visibleColumns.has("marketCapUsd") && (
                      <TableCell className="text-[#1c1c1d]">{formatCurrency(coin.marketCapUsd ?? 0)}</TableCell>
                    )}
                    {visibleColumns.has("holderCount") && (
                      <TableCell className="text-[#1c1c1d]">{formatNumber(coin.holderCount)}</TableCell>
                    )}
                    {visibleColumns.has("medianBalance") && (
                      <TableCell className="text-[#1c1c1d]">{formatCurrency(coin.medianBalance)}</TableCell>
                    )}
                    {visibleColumns.has("priceUsd") && (
                      <TableCell className="text-[#1c1c1d]">
                        {coin.priceUsd != null ? `$${coin.priceUsd.toFixed(2)}` : "—"}
                      </TableCell>
                    )}
                    {visibleColumns.has("percentChange24h") && (
                      <TableCell>
                        {coin.percentChange24h != null ? (
                          <span
                            className={
                              coin.percentChange24h >= 0 ? "text-[#0c804c]" : "text-[#9e2b38]"
                            }
                          >
                            {coin.percentChange24h >= 0 ? "+" : ""}
                            {(coin.percentChange24h * 100).toFixed(2)}%
                          </span>
                        ) : (
                          "—"
                        )}
                      </TableCell>
                    )}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </div>
      </CardFrame>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <CardFrame title="Geography Breakdown" description="Holder distribution by region">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Region</TableHead>
                <TableHead>Percentage</TableHead>
                <TableHead>Holders</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {geography.map((g) => (
                <TableRow key={g.region}>
                  <TableCell className="font-medium text-[#1c1c1d]">{g.region}</TableCell>
                  <TableCell className="text-[#1c1c1d]">{g.percentage}%</TableCell>
                  <TableCell className="text-[#1c1c1d]">{formatNumber(g.holderCount)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardFrame>

        <CardFrame title="Attribution Breakdown" description="Holder distribution by category">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Category</TableHead>
                <TableHead>Percentage</TableHead>
                <TableHead>Holders</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {attribution.map((a) => (
                <TableRow key={a.category}>
                  <TableCell className="font-medium capitalize text-[#1c1c1d]">
                    {a.category}
                  </TableCell>
                  <TableCell className="text-[#1c1c1d]">{a.percentage}%</TableCell>
                  <TableCell className="text-[#1c1c1d]">{formatNumber(a.holderCount)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardFrame>
      </div>
    </motion.div>
  );
}
