import { NextResponse } from "next/server";
import path from "path";
import sqlite3 from "sqlite3";
import { open, Database } from "sqlite";

interface ChatBubble {
  role: "user" | "assistant";
  content: string;
  id?: string;
  originalType?: number | string;
  originalSource?: string;
}

interface ComposerConversation {
  id: string;
  title: string;
  summary?: string;
  lastUpdatedAt: string;
  bubbles: ChatBubble[];
  createdAt: string;
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

// Define a type for the raw bubbles coming from chatData.tabs.bubbles
interface RawBubble {
  role?: "user" | "assistant" | string;
  type?: "user" | "assistant" | number | string; // Can be string like "user" or number
  content?: string;
  text?: string;
  id?: string;
  bubbleId?: string; // Another possible ID field
  // Add any other fields that might exist on raw bubbles
}

interface RawTab {
  tabId: string;
  chatTitle: string;
  lastSendTime: number;
  bubbles: RawBubble[]; // Use RawBubble[] instead of any[]
}

const safeParseTimestamp = (
  timestamp: number | string | Date | undefined | null
): string => {
  try {
    if (timestamp === null || timestamp === undefined) {
      // Optional: Add a log if you want to know when this happens
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

// Define the new response structure type
interface ResponseConversation {
  name: string;
  summary?: string;
  messages: ChatBubble[];
  createdAt: string;
  lastUpdatedAt: string;
}

interface FinalApiResponse {
  conversations: ResponseConversation[];
}

export async function GET(
  request: Request,
  { params }: { params: { id: string } }
) {
  let db: Database | null = null;
  let globalDb: Database | null = null;
  try {
    const workspacePath = process.env.WORKSPACE_PATH || "";
    const dbPath = path.join(workspacePath, params.id, "state.vscdb");

    db = await open({
      filename: dbPath,
      driver: sqlite3.Database,
    });

    const chatResult = await db.get(`
      SELECT value FROM ItemTable
      WHERE [key] = 'workbench.panel.aichat.view.aichat.chatdata'
    `);

    const composerMetadataResult = await db.get(`
      SELECT value FROM ItemTable
      WHERE [key] = 'composer.composerData'
    `);

    // Use a Map to store conversations, keyed by their ID (tabId or composerId)
    const allConversationsMap = new Map<string, ComposerConversation>();
    const allBubblesMap = new Map<string, ChatBubble[]>();
    // New map to store ordering info from fullConversationHeadersOnly
    const headerOrderMap = new Map<string, Map<string, number>>();

    // Set to store composer IDs known to this specific workspace
    const workspaceComposerIds = new Set<string>();

    if (chatResult && chatResult.value) {
      const chatData = JSON.parse(chatResult.value);
      // Process standard chat tabs first
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

        // Create a ComposerConversation object
        const conversation: ComposerConversation = {
          id: tab.tabId,
          title:
            tab.chatTitle?.split("\n")[0] || `Chat ${tab.tabId.slice(0, 8)}`,
          summary: undefined,
          lastUpdatedAt: safeParseTimestamp(tab.lastSendTime),
          createdAt: safeParseTimestamp(tab.lastSendTime),
          bubbles: [], // Bubbles will be consolidated later
        };
        allConversationsMap.set(tab.tabId, conversation);
      });
    }

    if (composerMetadataResult && composerMetadataResult.value) {
      const globalDbPath = path.join(
        workspacePath,
        "..",
        "globalStorage",
        "state.vscdb"
      );

      const resolvedGlobalDbPath = globalDbPath;

      try {
        globalDb = await open({
          filename: resolvedGlobalDbPath,
          driver: sqlite3.Database,
        });
      } catch (e) {
        console.warn(
          `Could not open global DB at ${resolvedGlobalDbPath}, trying legacy paths might be needed. Error: ${e}`
        );
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
          workspaceComposerIds.add(it.composerId); // Add to our set of known IDs
          return `composerData:${it.composerId}`;
        });

        if (keys.length > 0) {
          const placeholders = keys.map(() => "?").join(",");
          const composersBodyResult = await globalDb.all(
            `
            SELECT value FROM cursorDiskKV
            WHERE [key] IN (${placeholders})
          `,
            keys
          );

          const parsedComposers: ComposerInstance[] = composersBodyResult.map(
            (it) => JSON.parse(it.value)
          );

          for (const composer of parsedComposers) {
            const composerId = composer.composerId;
            const existingBubbles = allBubblesMap.get(composerId) || [];

            // Save ordering information if available
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

            // Unify: Check if conversation already exists (e.g., from chatData.tabs)
            if (allConversationsMap.has(composerId)) {
              const existingConv = allConversationsMap.get(composerId)!;
              existingConv.title = composer.name || existingConv.title; // Prefer composer name
              existingConv.summary =
                composer.latestConversationSummary?.summary?.summary || // Then composer.summary from parsedComposers
                existingConv.summary; // Fallback to existing
              existingConv.lastUpdatedAt = safeParseTimestamp(
                composer.lastUpdatedAt ||
                  composer.createdAt ||
                  existingConv.lastUpdatedAt
              );
              // Update createdAt, prioritizing composer.createdAt
              existingConv.createdAt = safeParseTimestamp(
                composer.createdAt || existingConv.createdAt
              );
            } else {
              // Create a new conversation for this composer
              const newConversation: ComposerConversation = {
                id: composerId,
                title: composer.name || `Chat ${composerId.slice(0, 8)}`,
                summary:
                  composer.latestConversationSummary?.summary?.summary || // Prioritize this
                  composer.name, // Fallback to composer name
                lastUpdatedAt: safeParseTimestamp(
                  composer.lastUpdatedAt || composer.createdAt // This becomes lastUpdatedAt
                ),
                createdAt: safeParseTimestamp(
                  composer.createdAt || composer.lastUpdatedAt
                ), // Use createdAt, fallback to lastUpdatedAt
                bubbles: [], // Bubbles will be consolidated later
              };
              allConversationsMap.set(composerId, newConversation);
            }
          }
          // No longer need to set response.composers
        }

        // Fetch from Global DB cursorDiskKV for 'bubbleId:%'
        const globalRawBubbles = await globalDb.all(`
          SELECT key, value FROM cursorDiskKV
          WHERE key LIKE 'bubbleId:%'
        `);

        for (const rawBubble of globalRawBubbles) {
          try {
            const bubbleData = JSON.parse(rawBubble.value);

            const keyParts = rawBubble.key.split(":"); // bubbleId:composerId:bubbleSpecificId
            if (keyParts.length > 1) {
              const composerId = keyParts[1];

              // Only process this global bubble if its composerId is known to this workspace
              if (!workspaceComposerIds.has(composerId)) {
                // This bubble belongs to a composer not in the current workspace's metadata, skip it.
                // console.log(`Skipping global bubble for composerId ${composerId} not in workspace ${params.id}`);
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
                    bubbleData.bubbleId || keyParts[2], // Use bubbleData.bubbleId for the ID
                    bubbleData.type,
                    "globalBubble"
                  )
                );
                allBubblesMap.set(composerId, existingBubbles);

                // Unify: If conversation doesn't exist, create it
                if (!allConversationsMap.has(composerId)) {
                  // Try to find a name from the initially fetched composer metadata
                  const composerMeta =
                    composerMetadataForGlobal.allComposers.find(
                      (c) => c.composerId === composerId
                    );
                  const title =
                    composerMeta && composerMeta.name
                      ? composerMeta.name
                      : `Chat ${composerId.slice(0, 8)}`;

                  const newConversation: ComposerConversation = {
                    id: composerId,
                    title: title, // Use looked-up or default title
                    summary: undefined, // Fallback to composerMeta.name
                    lastUpdatedAt: safeParseTimestamp(
                      composerMeta?.lastUpdatedAt || undefined // Get from composer metadata
                    ),
                    createdAt: safeParseTimestamp(
                      composerMeta?.createdAt || undefined
                    ), // Use composerMeta.createdAt
                    bubbles: [],
                  };
                  allConversationsMap.set(composerId, newConversation);
                } else {
                  // Use composer metadata for timestamps rather than bubble timestamp
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
            // Do nothing
          }
        }
      }
    }

    // Consolidate bubbles and sort
    const finalConversationsList: ComposerConversation[] = [];
    allConversationsMap.forEach((conversation) => {
      const consolidatedBubbles = allBubblesMap.get(conversation.id) || [];

      const uniqueBubbles = consolidatedBubbles.filter(
        (bubble, index, self) =>
          index ===
          self.findIndex(
            (b) => b.content === bubble.content && b.role === bubble.role
          )
      );

      // Check if we have ordering information for this conversation
      const headerMap = headerOrderMap.get(conversation.id);

      // If we have ordering info, use it to sort bubbles
      if (headerMap && headerMap.size > 0) {
        // Sort the bubbles according to their position in fullConversationHeadersOnly
        uniqueBubbles.sort((a, b) => {
          const indexA = headerMap.get(a.id || "");
          const indexB = headerMap.get(b.id || "");

          // If both IDs are in the headers, sort by their position
          if (indexA !== undefined && indexB !== undefined) {
            return indexA - indexB;
          }
          // If only one ID is in the headers, prioritize it
          if (indexA !== undefined) return -1;
          if (indexB !== undefined) return 1;

          // Otherwise, keep original order
          return 0;
        });
      }

      conversation.bubbles = uniqueBubbles;
      if (conversation.bubbles.length > 0) {
        finalConversationsList.push(conversation);
      }
    });

    // Sort final conversations by their main timestamp (most recent first)
    finalConversationsList.sort(
      (a, b) =>
        new Date(b.lastUpdatedAt).getTime() -
        new Date(a.lastUpdatedAt).getTime()
    );

    if (
      finalConversationsList.length === 0 &&
      !composerMetadataResult &&
      !chatResult
    ) {
      return NextResponse.json(
        { error: "No chat data found in workspace or global storage" },
        { status: 404 }
      );
    }

    // Transform to the final response structure
    const responseConversations: ResponseConversation[] =
      finalConversationsList.map((conv) => ({
        id: conv.id,
        name: conv.title,
        summary: conv.summary,
        messages: conv.bubbles,
        createdAt: conv.createdAt, // Already a string due to safeParseTimestamp
        lastUpdatedAt: conv.lastUpdatedAt, // Already a string
      }));

    const finalApiResponse: FinalApiResponse = {
      conversations: responseConversations,
    };
    return NextResponse.json(finalApiResponse);
  } catch (error) {
    console.error("Failed to get workspace data:", error);
    return NextResponse.json(
      { error: "Failed to get workspace data" },
      { status: 500 }
    );
  } finally {
    if (db) await db.close();
    if (globalDb) await globalDb.close();
  }
}
