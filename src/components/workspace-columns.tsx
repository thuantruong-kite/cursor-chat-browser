"use client";

import { ColumnDef, SortingState } from "@tanstack/react-table";
import { format } from "date-fns";
import { Workspace } from "@/types/workspace"; // Assuming your Workspace type is here
import { DataTableColumnHeader } from "@/components/ui/data-table/data-table-column-header";
import { Checkbox } from "@/components/ui/checkbox";

// This interface is currently in workspace-list.tsx
// Consider moving it to a shared types file, e.g., @/types/workspace.ts
export interface WorkspaceWithCounts extends Workspace {
  conversationCount: number;
}

// Helper function to create columns, allowing router to be passed if needed or click handler
export const getWorkspaceColumns = (
  handleWorkspaceClick: (workspaceId: string) => void
): ColumnDef<WorkspaceWithCounts>[] => [
  {
    id: "select",
    header: ({ table }) => (
      <Checkbox
        checked={
          table.getIsAllPageRowsSelected() ||
          (table.getIsSomePageRowsSelected() && "indeterminate")
        }
        onCheckedChange={(value) => table.toggleAllPageRowsSelected(!!value)}
        aria-label="Select all"
        className="translate-y-[2px]"
      />
    ),
    cell: ({ row }) => (
      <Checkbox
        checked={row.getIsSelected()}
        onCheckedChange={(value) => row.toggleSelected(!!value)}
        aria-label="Select row"
        className="translate-y-[2px]"
      />
    ),
    enableSorting: false,
    enableHiding: false,
  },
  {
    accessorKey: "id",
    header: ({ column }) => (
      <DataTableColumnHeader column={column} title="Workspace Hash" />
    ),
    cell: ({ row }) => {
      const id = row.getValue("id") as string;
      return (
        <button
          onClick={() => handleWorkspaceClick(id)}
          className="text-blue-600 hover:underline font-medium break-all text-left"
          title={id}
        >
          {id}
        </button>
      );
    },
    enableSorting: false, // Usually, hashes are not sorted
  },
  {
    accessorKey: "folder",
    header: ({ column }) => (
      <DataTableColumnHeader column={column} title="Folder" />
    ),
    cell: ({ row }) => {
      const folder = row.getValue("folder") as string | undefined;
      return folder ? (
        <div className="flex items-center space-x-2">
          <span className="text-gray-500 mt-1">📁</span>
          <span className="break-all text-sm" title={folder}>
            {folder.replaceAll("file:///", "")}
          </span>
        </div>
      ) : (
        <span className="text-gray-400 italic">No folder</span>
      );
    },
    // Enable sorting for folder if desired
  },
  {
    accessorKey: "lastModified",
    header: ({ column }) => (
      <DataTableColumnHeader
        className="!w-[220px]"
        column={column}
        title="Last Modified"
      />
    ),
    cell: ({ row }) => {
      const lastModified = row.getValue("lastModified") as string;
      try {
        return format(new Date(lastModified), "PPP p");
      } catch (error) {
        console.error("Error formatting date:", lastModified, error);
        return "Invalid Date";
      }
    },
  },
  {
    accessorKey: "conversationCount",
    header: ({ column }) => (
      <DataTableColumnHeader column={column} title="Conversations" />
    ),
    cell: ({ row }) => {
      return (
        <div className="text-right pr-4">
          {row.getValue("conversationCount")}
        </div>
      );
    },
    // Cell content is already a number, default sort should work.
  },
];

export const initialWorkspaceTableSorting: SortingState = [
  { id: "lastModified", desc: true },
];
