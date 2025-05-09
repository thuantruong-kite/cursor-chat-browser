"use client";

import { Table } from "@tanstack/react-table";
import { Download, Loader2 } from "lucide-react";
// import { DataTableViewOptions } from "./data-table-view-options"; // Removed as per user changes leading to linter error
import { Button } from "@/components/ui/button";
// import { Input } from "@/components/ui/input";
// import { DataTableFacetedFilter } from "./data-table-faceted-filter"; // If you adapt this later

interface DataTableToolbarProps<TData> {
  table: Table<TData>;
  onDownloadClick?: (selectedRows: TData[]) => void;
  onDownloadAllClick?: () => void;
  isToolbarLoading?: boolean;
  // Add props for filter column and options if you re-add filtering
}

export function DataTableToolbar<TData>({
  table,
  onDownloadClick,
  onDownloadAllClick,
  isToolbarLoading,
}: DataTableToolbarProps<TData>) {
  const selectedRows = table
    .getFilteredSelectedRowModel()
    .rows.map((row) => row.original);
  const hasSelectedRows = selectedRows.length > 0;

  return (
    <div className="flex items-center justify-between py-4">
      <div className="flex flex-1 items-center space-x-2">
        {/* 
        Example of a generic input filter if you want to add one:
        <Input
          placeholder="Filter..."
          value={(table.getColumn("YOUR_COLUMN_ID_HERE")?.getFilterValue() as string) ?? ""}
          onChange={(event) =>
            table.getColumn("YOUR_COLUMN_ID_HERE")?.setFilterValue(event.target.value)
          }
          className="h-8 w-[150px] lg:w-[250px]"
        />
        */}
        {/* 
        Example of faceted filters (would require DataTableFacetedFilter component and options):
        {table.getColumn("status") && (
          <DataTableFacetedFilter
            column={table.getColumn("status")}
            title="Status"
            options={statuses} // You would need to provide these options
          />
        )}
        */}
        {/* 
        {isFiltered && (
          <Button
            variant="ghost"
            onClick={() => table.resetColumnFilters()}
            className="h-8 px-2 lg:px-3"
          >
            Reset
            <X className="ml-2 h-4 w-4" />
          </Button>
        )}
        */}
      </div>
      <div className="flex items-center space-x-2">
        {hasSelectedRows
          ? onDownloadClick && (
              <Button
                size="sm"
                className="ml-auto h-8 lg:flex"
                onClick={() => onDownloadClick(selectedRows)}
                disabled={isToolbarLoading}
              >
                {isToolbarLoading ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <Download className="mr-2 h-4 w-4" />
                )}
                {isToolbarLoading
                  ? "Downloading..."
                  : "Download Selected (.zip)"}
              </Button>
            )
          : onDownloadAllClick && (
              <Button
                size="sm"
                className="ml-auto h-8 lg:flex"
                onClick={onDownloadAllClick}
                disabled={isToolbarLoading}
              >
                {isToolbarLoading ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <Download className="mr-2 h-4 w-4" />
                )}
                {isToolbarLoading ? "Downloading..." : "Download All (.zip)"}
              </Button>
            )}
      </div>
    </div>
  );
}
