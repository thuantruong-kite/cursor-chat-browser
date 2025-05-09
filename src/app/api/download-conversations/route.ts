import { NextResponse } from "next/server";
import path from "path";
import fs from "fs/promises";
import sqlite3 from "sqlite3";
import { open, Database } from "sqlite";
import JSZip from "jszip";
import { existsSync } from "fs";

// Types from src/app/api/workspaces/[id]/tabs/route.ts
// Consider moving these to a shared types file if not already done
interface ChatBubble {
  role: "user" | "assistant";
  content: string;
  id?: string;
  originalType?: number | string;
  originalSource?: string;
}

interface ResponseConversation {
  id: string;
  name: string;
  summary?: string;
  messages: ChatBubble[];
  createdAt: string;
  lastUpdatedAt: string;
}

// Interim type for the allConversationsMap
interface TempConversation {
  id: string;
  title: string;
  summary?: string;
  lastUpdatedAt: string;
  createdAt: string;
  bubbles: ChatBubble[]; // This will be replaced by 'messages' later
}

// Simplified types for fetching, based on src/app/api/workspaces/[id]/tabs/route.ts
interface RawBubble {
  role?: "user" | "assistant" | string;
  type?: "user" | "assistant" | number | string;
  content?: string;
  text?: string;
  id?: string;
  bubbleId?: string;
}

interface RawTab {
  tabId: string;
  chatTitle: string;
  lastSendTime: number;
  bubbles: RawBubble[];
}

interface ComposerMessage {
  role?: "user" | "assistant" | string;
  type?: number | string;
  content?: string;
  text?: string;
  lastUpdatedAt?: number | string | Date;
  id?: string;
}

interface ComposerInstance {
  composerId: string;
  name?: string;
  createdAt?: number | string | Date;
  lastUpdatedAt?: number | string | Date;
  messages?: ComposerMessage[];
  conversation?: ComposerMessage[];
  fullConversationHeadersOnly?: {
    bubbleId: string;
    type: number;
    serverBubbleId?: string;
  }[];
  latestConversationSummary?: {
    summary?: {
      summary?: string;
    };
  };
}

const safeParseTimestamp = (
  timestamp: number | string | Date | undefined | null
): string => {
  try {
    if (timestamp === null || timestamp === undefined) {
      return new Date().toISOString();
    }
    if (timestamp instanceof Date) {
      return timestamp.toISOString();
    }
    if (typeof timestamp === "string") {
      const date = new Date(timestamp);
      if (!isNaN(date.getTime())) {
        return date.toISOString();
      }
    }
    if (typeof timestamp === "number") {
      const d = new Date(
        timestamp > 100000000000 ? timestamp : timestamp * 1000
      );
      return d.toISOString();
    }
    return new Date().toISOString();
  } catch (error) {
    console.error("Error parsing timestamp:", error, "Raw value:", timestamp);
    return new Date().toISOString();
  }
};

const createBubble = (
  role: "user" | "assistant",
  content: string,
  id?: string,
  originalType?: number | string,
  originalSource?: string
): ChatBubble => {
  return {
    role,
    content,
    id,
    originalType,
    originalSource,
  };
};

async function fetchConversationsForWorkspace(
  workspaceId: string,
  workspacePathBase: string
): Promise<ResponseConversation[]> {
  let db: Database | null = null;
  let globalDb: Database | null = null;
  try {
    const dbPath = path.join(workspacePathBase, workspaceId, "state.vscdb");
    if (!existsSync(dbPath)) {
      console.warn(
        `Database not found for workspace ${workspaceId} at ${dbPath}`
      );
      return [];
    }

    db = await open({
      filename: dbPath,
      driver: sqlite3.Database,
    });

    const chatResult = await db.get(
      `SELECT value FROM ItemTable WHERE [key] = 'workbench.panel.aichat.view.aichat.chatdata'`
    );
    const composerMetadataResult = await db.get(
      `SELECT value FROM ItemTable WHERE [key] = 'composer.composerData'`
    );

    const allConversationsMap = new Map<string, TempConversation>();
    const allBubblesMap = new Map<string, ChatBubble[]>();
    const headerOrderMap = new Map<string, Map<string, number>>();
    const workspaceComposerIds = new Set<string>();

    if (chatResult && chatResult.value) {
      const chatData = JSON.parse(chatResult.value);
      (chatData.tabs || []).forEach((tab: RawTab) => {
        const processedBubbles: ChatBubble[] = [];
        (tab.bubbles || []).forEach((b: RawBubble) => {
          const role =
            b.role === "user" || b.type === "user" ? "user" : "assistant";
          const content = b.content || b.text || "";
          if (content.trim()) {
            processedBubbles.push(
              createBubble(
                role,
                content,
                b.id || b.bubbleId,
                b.type,
                "chatResult"
              )
            );
          }
        });
        allBubblesMap.set(tab.tabId, processedBubbles);

        // Create a TempConversation object
        const conversation: TempConversation = {
          id: tab.tabId,
          title:
            tab.chatTitle?.split("\n")[0] || `Chat ${tab.tabId.slice(0, 8)}`,
          summary: undefined,
          lastUpdatedAt: safeParseTimestamp(tab.lastSendTime),
          createdAt: safeParseTimestamp(tab.lastSendTime),
          bubbles: [], // Bubbles will be consolidated later via allBubblesMap and then set to messages
        };
        allConversationsMap.set(tab.tabId, conversation);
      });
    }

    if (composerMetadataResult && composerMetadataResult.value) {
      const globalDbPath = path.join(
        workspacePathBase,
        "..",
        "globalStorage",
        "state.vscdb"
      );
      if (existsSync(globalDbPath)) {
        try {
          globalDb = await open({
            filename: globalDbPath,
            driver: sqlite3.Database,
          });
        } catch (e) {
          console.warn(
            `Could not open global DB at ${globalDbPath}. Error: ${e}`
          );
        }
      }

      if (globalDb) {
        const composerMetadataForGlobal: {
          allComposers: {
            composerId: string;
            name?: string;
            createdAt?: number | string | Date;
            lastUpdatedAt?: number | string | Date;
          }[];
        } = JSON.parse(composerMetadataResult.value);

        const keys = composerMetadataForGlobal.allComposers.map((it) => {
          workspaceComposerIds.add(it.composerId);
          return `composerData:${it.composerId}`;
        });

        if (keys.length > 0) {
          const placeholders = keys.map(() => "?").join(",");
          const composersBodyResult = await globalDb.all(
            `SELECT value FROM cursorDiskKV WHERE [key] IN (${placeholders})`,
            keys
          );

          const parsedComposers: ComposerInstance[] = composersBodyResult.map(
            (it) => JSON.parse(it.value)
          );

          for (const composer of parsedComposers) {
            const composerId = composer.composerId;
            const existingBubbles = allBubblesMap.get(composerId) || [];

            if (composer.fullConversationHeadersOnly?.length) {
              const orderMap = new Map<string, number>();
              composer.fullConversationHeadersOnly.forEach((header, index) => {
                orderMap.set(header.bubbleId, index);
              });
              headerOrderMap.set(composerId, orderMap);
            }

            const messagesSource = composer.messages || composer.conversation;
            if (messagesSource && Array.isArray(messagesSource)) {
              for (const msg of messagesSource) {
                const role =
                  msg.role === "user" || msg.type === 1 ? "user" : "assistant";
                const content = msg.content || msg.text || "";
                if (content.trim()) {
                  existingBubbles.push(
                    createBubble(
                      role,
                      content,
                      msg.id,
                      msg.type,
                      "composerMessage"
                    )
                  );
                }
              }
            }
            allBubblesMap.set(composerId, existingBubbles);

            if (allConversationsMap.has(composerId)) {
              const existingConv = allConversationsMap.get(composerId)!;
              existingConv.title = composer.name || existingConv.title;
              existingConv.summary =
                composer.latestConversationSummary?.summary?.summary ||
                existingConv.summary;
              existingConv.lastUpdatedAt = safeParseTimestamp(
                composer.lastUpdatedAt ||
                  composer.createdAt ||
                  existingConv.lastUpdatedAt
              );
              existingConv.createdAt = safeParseTimestamp(
                composer.createdAt || existingConv.createdAt
              );
            } else {
              // Create a new TempConversation for this composer
              const newConversation: TempConversation = {
                id: composerId,
                title: composer.name || `Chat ${composerId.slice(0, 8)}`,
                summary:
                  composer.latestConversationSummary?.summary?.summary ||
                  composer.name, // Fallback to composer name
                lastUpdatedAt: safeParseTimestamp(
                  composer.lastUpdatedAt || composer.createdAt
                ),
                createdAt: safeParseTimestamp(
                  composer.createdAt || composer.lastUpdatedAt
                ),
                bubbles: [], // Bubbles will be consolidated later
              };
              allConversationsMap.set(composerId, newConversation);
            }
          }
        }

        const globalRawBubbles = await globalDb.all(
          `SELECT key, value FROM cursorDiskKV WHERE key LIKE 'bubbleId:%'`
        );

        for (const rawBubble of globalRawBubbles) {
          try {
            const bubbleData = JSON.parse(rawBubble.value);
            const keyParts = rawBubble.key.split(":");
            if (keyParts.length > 1) {
              const composerId = keyParts[1];
              if (!workspaceComposerIds.has(composerId)) {
                continue;
              }

              const role =
                bubbleData.type === 1
                  ? "user"
                  : bubbleData.type === 0 || bubbleData.type === 2
                  ? "assistant"
                  : "assistant";
              const textContent = bubbleData.text || bubbleData.richText || "";

              if (textContent.trim()) {
                const existingBubbles = allBubblesMap.get(composerId) || [];
                existingBubbles.push(
                  createBubble(
                    role,
                    textContent,
                    bubbleData.bubbleId || keyParts[2],
                    bubbleData.type,
                    "globalBubble"
                  )
                );
                allBubblesMap.set(composerId, existingBubbles);

                if (!allConversationsMap.has(composerId)) {
                  const composerMeta =
                    composerMetadataForGlobal.allComposers.find(
                      (c) => c.composerId === composerId
                    );
                  allConversationsMap.set(composerId, {
                    id: composerId,
                    title:
                      (composerMeta && composerMeta.name) ||
                      `Chat ${composerId.slice(0, 8)}`,
                    summary: undefined,
                    lastUpdatedAt: safeParseTimestamp(
                      composerMeta?.lastUpdatedAt || undefined
                    ),
                    createdAt: safeParseTimestamp(
                      composerMeta?.createdAt || undefined
                    ),
                    bubbles: [],
                  });
                } else {
                  const composerMeta =
                    composerMetadataForGlobal.allComposers.find(
                      (c) => c.composerId === composerId
                    );
                  if (composerMeta?.lastUpdatedAt) {
                    const conv = allConversationsMap.get(composerId)!;
                    conv.lastUpdatedAt = safeParseTimestamp(
                      composerMeta.lastUpdatedAt
                    );
                  }
                }
              }
            }
          } catch {
            /* ignore parse errors for individual bubbles */
          }
        }
      }
    }

    const finalConversationsList: ResponseConversation[] = [];
    allConversationsMap.forEach((tempConv) => {
      const consolidatedBubbles = allBubblesMap.get(tempConv.id) || [];
      const uniqueBubbles = consolidatedBubbles.filter(
        (bubble, index, self) =>
          index ===
          self.findIndex(
            (b) => b.content === bubble.content && b.role === bubble.role
          )
      );

      const headerMap = headerOrderMap.get(tempConv.id);
      if (headerMap && headerMap.size > 0) {
        uniqueBubbles.sort((a, b) => {
          const indexA = headerMap.get(a.id || "");
          const indexB = headerMap.get(b.id || "");
          if (indexA !== undefined && indexB !== undefined) {
            return indexA - indexB;
          }
          if (indexA !== undefined) return -1;
          if (indexB !== undefined) return 1;
          return 0;
        });
      }

      // Convert TempConversation to ResponseConversation
      if (uniqueBubbles.length > 0) {
        finalConversationsList.push({
          id: tempConv.id,
          name: tempConv.title, // Map title to name
          summary: tempConv.summary,
          messages: uniqueBubbles, // Assign the processed uniqueBubbles
          createdAt: tempConv.createdAt,
          lastUpdatedAt: tempConv.lastUpdatedAt,
        });
      }
    });

    finalConversationsList.sort(
      (a, b) =>
        new Date(b.lastUpdatedAt).getTime() -
        new Date(a.lastUpdatedAt).getTime()
    );
    return finalConversationsList;
  } catch (error) {
    console.error(
      `Failed to get conversations for workspace ${workspaceId}:`,
      error
    );
    return []; // Return empty array on error
  } finally {
    if (db) await db.close();
    if (globalDb) await globalDb.close();
  }
}

function convertConversationToMarkdown(
  conversation: ResponseConversation
): string {
  let markdown = `# ${conversation.name}\n\n`;

  markdown += `_Created: ${new Date(
    conversation.createdAt
  ).toLocaleString()}_\n`;
  markdown += `_Last Updated: ${new Date(
    conversation.lastUpdatedAt
  ).toLocaleString()}_\n\n---\n\n`;

  if (conversation.summary) {
    markdown += `**Summary:** ${conversation.summary}\n\n`;
  }

  conversation.messages?.forEach((bubble) => {
    markdown += `### ${
      bubble.role.charAt(0).toUpperCase() + bubble.role.slice(1)
    }\n\n`;
    // Assuming bubble.content contains the text.
    // The original src/lib/download.ts convertChatToMarkdown had more complex logic for bubble.text, selections, etc.
    // This is a simplified version. Adapt if more details from ChatBubble are needed.
    if (bubble.content) {
      markdown += bubble.content + "\n\n";
    } else if (bubble.role === "assistant") {
      markdown += "_[No text content available]_\n\n";
    }
    markdown += "---\n\n";
  });

  return markdown;
}

// Helper to generate timestamp string YYYYMMDDHHMMSS
function getTimestampString(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = (now.getMonth() + 1).toString().padStart(2, "0"); // Months are 0-indexed
  const day = now.getDate().toString().padStart(2, "0");
  const hours = now.getHours().toString().padStart(2, "0");
  const minutes = now.getMinutes().toString().padStart(2, "0");
  const seconds = now.getSeconds().toString().padStart(2, "0");
  return `${year}${month}${day}${hours}${minutes}${seconds}`;
}

// Helper to sanitize filenames
function sanitizeFilename(name: string): string {
  return name.replace(/[<>:"/\\|?*\x00-\x1F]/g, "_").replace(/\.$/, "_");
}

export async function POST(request: Request) {
  const zip = new JSZip();
  const workspacePathBase = process.env.WORKSPACE_PATH || "";

  if (!workspacePathBase) {
    return NextResponse.json(
      { error: "WORKSPACE_PATH environment variable is not set." },
      { status: 500 }
    );
  }

  try {
    const body = await request.json();
    // Check for workspaceIds (plural) first for the new multi-select case
    const {
      workspaceId,
      workspaceIds,
      workspaceName: providedWorkspaceName,
    } = body;
    const timestamp = getTimestampString();

    if (
      workspaceIds &&
      Array.isArray(workspaceIds) &&
      workspaceIds.length > 0
    ) {
      // New: Handle multiple selected workspaces into a single zip
      let foundAnyConversationsForSelected = false;
      for (const id of workspaceIds) {
        const currentWorkspaceId = sanitizeFilename(id); // Sanitize for folder name
        const conversations = await fetchConversationsForWorkspace(
          id, // Use original id for fetching
          workspacePathBase
        );
        if (conversations.length > 0) {
          foundAnyConversationsForSelected = true;
          const workspaceFolder = zip.folder(currentWorkspaceId); // Folder name is sanitized workspaceId
          if (!workspaceFolder) {
            console.warn(
              `Could not create folder '${currentWorkspaceId}' in zip for selected workspaces.`
            );
            continue; // Skip this workspace if folder creation fails
          }
          conversations.forEach((conv) => {
            const markdownContent = convertConversationToMarkdown(conv);
            const filename = sanitizeFilename(conv.name || conv.id) + ".md";
            workspaceFolder.file(filename, markdownContent);
          });
        }
      }

      if (!foundAnyConversationsForSelected) {
        return NextResponse.json(
          { error: "No conversations found for the selected workspaces." },
          { status: 404 }
        );
      }

      const zipFileName = `cursor_chat_history_${timestamp}.zip`;
      const content = await zip.generateAsync({ type: "nodebuffer" });
      return new NextResponse(content, {
        status: 200,
        headers: {
          "Content-Type": "application/zip",
          "Content-Disposition": `attachment; filename="${zipFileName}"`,
        },
      });
    } else if (workspaceId) {
      // Existing: Download for a single workspace
      const conversations = await fetchConversationsForWorkspace(
        workspaceId,
        workspacePathBase
      );
      if (conversations.length === 0) {
        return NextResponse.json(
          {
            error: `No conversations found for workspace ${workspaceId} - ${
              providedWorkspaceName || ""
            }`,
          },
          { status: 404 }
        );
      }

      const folderNameInZip = sanitizeFilename(workspaceId);
      const workspaceFolder = zip.folder(folderNameInZip);
      if (!workspaceFolder) {
        throw new Error(`Could not create folder '${folderNameInZip}' in zip`);
      }

      conversations.forEach((conv) => {
        const markdownContent = convertConversationToMarkdown(conv);
        const filename = sanitizeFilename(conv.name || conv.id) + ".md";
        workspaceFolder.file(filename, markdownContent);
      });

      const zipFileName = `cursor_chat_history_${timestamp}_${sanitizeFilename(
        workspaceId
      )}.zip`;
      const content = await zip.generateAsync({ type: "nodebuffer" });

      return new NextResponse(content, {
        status: 200,
        headers: {
          "Content-Type": "application/zip",
          "Content-Disposition": `attachment; filename="${zipFileName}"`,
        },
      });
    } else {
      // Download all workspaces
      const entries = await fs.readdir(workspacePathBase, {
        withFileTypes: true,
      });
      let foundAnyConversations = false;

      for (const entry of entries) {
        if (entry.isDirectory()) {
          // ALWAYS use entry.name (workspaceId) for the folder name inside the zip for "all" downloads.
          const workspaceIdForFolder = entry.name;

          const conversations = await fetchConversationsForWorkspace(
            workspaceIdForFolder, // Use directory name (workspaceId) as ID for fetching
            workspacePathBase
          );

          if (conversations.length > 0) {
            foundAnyConversations = true;
            const folderName = sanitizeFilename(workspaceIdForFolder); // Use workspaceId for folder name
            const workspaceFolder = zip.folder(folderName);
            if (!workspaceFolder) {
              throw new Error(`Could not create folder '${folderName}' in zip`);
            }
            conversations.forEach((conv) => {
              const markdownContent = convertConversationToMarkdown(conv);
              const filename = sanitizeFilename(conv.name || conv.id) + ".md";
              workspaceFolder.file(filename, markdownContent);
            });
          }
        }
      }

      if (!foundAnyConversations) {
        return NextResponse.json(
          { error: "No conversations found in any workspace." },
          { status: 404 }
        );
      }

      const zipFileName = `cursor_chat_history_${timestamp}.zip`;
      const content = await zip.generateAsync({ type: "nodebuffer" });
      return new NextResponse(content, {
        status: 200,
        headers: {
          "Content-Type": "application/zip",
          "Content-Disposition": `attachment; filename="${zipFileName}"`,
        },
      });
    }
  } catch (error) {
    console.error("Failed to generate zip file:", error);
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json(
      { error: "Failed to generate zip file", details: errorMessage },
      { status: 500 }
    );
  }
}
