"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { Workspace } from "@/types/workspace";
import { Loading } from "@/components/ui/loading";
import { DataTable } from "@/components/ui/data-table/data-table";
import {
  getWorkspaceColumns,
  initialWorkspaceTableSorting,
  WorkspaceWithCounts,
} from "./workspace-columns"; // Assuming workspace-columns.tsx is in the same directory

async function fetchWorkspacesWithCounts(): Promise<WorkspaceWithCounts[]> {
  const response = await fetch("/api/workspaces");
  if (!response.ok) {
    throw new Error(`Failed to fetch workspaces: ${response.statusText}`);
  }
  const data: Workspace[] = await response.json();

  const workspacesWithCounts = await Promise.all(
    data.map(async (workspace) => {
      try {
        const tabsRes = await fetch(`/api/workspaces/${workspace.id}/tabs`);
        if (!tabsRes.ok) {
          console.warn(
            `Failed to fetch tabs for workspace ${workspace.id}: ${tabsRes.status}`
          );
          return {
            ...workspace,
            conversationCount: 0,
          };
        }
        const tabsData = await tabsRes.json();
        const conversationCount = tabsData.conversations?.length || 0;
        return {
          ...workspace,
          conversationCount,
          // Include folder name for better zip naming
          // The 'folder' property should already be on the Workspace type from /api/workspaces
        };
      } catch (e) {
        console.error(
          `Error processing tabs for workspace ${workspace.id}:`,
          e
        );
        return {
          ...workspace,
          conversationCount: 0,
        };
      }
    })
  );
  return workspacesWithCounts.filter((ws) => ws.conversationCount > 0);
}

// Helper to trigger browser download for a blob
function triggerBlobDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// Helper to generate timestamp string YYYYMMDDHHMMSS for client-side consistency
function getClientTimestampString(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = (now.getMonth() + 1).toString().padStart(2, "0");
  const day = now.getDate().toString().padStart(2, "0");
  const hours = now.getHours().toString().padStart(2, "0");
  const minutes = now.getMinutes().toString().padStart(2, "0");
  const seconds = now.getSeconds().toString().padStart(2, "0");
  return `${year}${month}${day}${hours}${minutes}${seconds}`;
}

// Define type for the download request body
interface DownloadRequestBody {
  workspaceId?: string; // For single download
  workspaceName?: string; // For single download (folder name inside zip)
  workspaceIds?: string[]; // For batch download of selected items (>=2)
}

// New helper function to execute the download API call and handle blob response
async function executeDownload(
  bodyPayload: DownloadRequestBody,
  defaultFilename: string
) {
  try {
    const response = await fetch("/api/download-conversations", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(bodyPayload),
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(
        `Failed to download zip: ${response.status} ${response.statusText}. ${
          errorData.error || ""
        } ${errorData.details || ""}`
      );
    }

    const blob = await response.blob();
    // Determine filename: Use Content-Disposition if available, else defaultFilename
    const contentDisposition = response.headers.get("content-disposition");
    let filename = defaultFilename;
    if (contentDisposition) {
      const filenameMatch = contentDisposition.match(
        /filename[^;=\n]*=((['"])(.*?)\2|[^;\n]*)/i
      );
      if (filenameMatch && filenameMatch[3]) {
        filename = filenameMatch[3];
      }
    }
    triggerBlobDownload(blob, filename);
    // alert("Conversation zip download initiated. Check your downloads."); // Removed by user previously
  } catch (e: unknown) {
    console.error("Error during download execution:", e);
    let message = "An unknown error occurred during download.";
    if (e instanceof Error) {
      message = e.message;
    }
    alert(`Error downloading conversations: ${message}`);
    throw e; // Re-throw to be caught by calling function if needed for state management
  }
}

export function WorkspaceList() {
  const router = useRouter();
  const [isDownloading, setIsDownloading] = useState(false);

  const {
    data: workspaces = [],
    isLoading,
    isError,
    error,
  } = useQuery<WorkspaceWithCounts[], Error>({
    queryKey: ["workspaces"],
    queryFn: fetchWorkspacesWithCounts,
  });

  const handleWorkspaceClick = (workspaceId: string) => {
    router.push(`/workspace/${workspaceId}`);
  };

  const handleDownloadSelectedZip = async (
    selectedWorkspaces: WorkspaceWithCounts[]
  ) => {
    if (selectedWorkspaces.length === 0) {
      alert("No workspace selected.");
      return;
    }

    setIsDownloading(true);
    const timestamp = getClientTimestampString();
    let bodyPayload: DownloadRequestBody = {};
    let defaultFilename = "";

    try {
      if (selectedWorkspaces.length === 1) {
        // Single item selected
        const ws = selectedWorkspaces[0];
        console.log(`Requesting single zip for workspace: ${ws.id}`);
        bodyPayload = {
          workspaceId: ws.id,
          workspaceName: ws.folder || ws.id, // For folder name inside zip
        };
        defaultFilename = `cursor_chat_history_${timestamp}_${ws.id}.zip`;
      } else {
        // 2 or more items selected
        console.log(
          `Processing ${selectedWorkspaces.length} selected workspaces as a single batch.`
        );
        const workspaceIds = selectedWorkspaces.map((ws) => ws.id);
        bodyPayload = { workspaceIds };
        defaultFilename = `cursor_chat_history_${timestamp}.zip`;
      }
      await executeDownload(bodyPayload, defaultFilename);
    } catch {
      // Error is already alerted by executeDownload and re-thrown.
      // This catch block is primarily for the finally clause to run.
    } finally {
      setIsDownloading(false);
    }
  };

  const handleDownloadAllZip = async () => {
    if (!workspaces || workspaces.length === 0) {
      alert("No workspaces available to download.");
      return;
    }
    setIsDownloading(true);
    const timestamp = getClientTimestampString();
    const bodyPayload: DownloadRequestBody = {}; // No specific IDs for "all"
    const defaultFilename = `cursor_chat_history_${timestamp}.zip`;
    try {
      await executeDownload(bodyPayload, defaultFilename);
    } catch {
      // Error is already alerted by executeDownload and re-thrown.
      // This catch block is primarily for the finally clause to run.
    } finally {
      setIsDownloading(false);
    }
  };

  const columns = useMemo(() => getWorkspaceColumns(handleWorkspaceClick), []);

  if (isLoading) {
    return <Loading message="Loading workspaces..." />;
  }

  if (isError) {
    return (
      <div className="text-red-500">
        Error loading workspaces: {error?.message || "Unknown error"}
      </div>
    );
  }

  return (
    <DataTable
      columns={columns}
      data={workspaces}
      initialSorting={initialWorkspaceTableSorting}
      onDownloadClick={handleDownloadSelectedZip}
      onDownloadAllClick={handleDownloadAllZip}
      isToolbarLoading={isDownloading}
    />
  );
}
