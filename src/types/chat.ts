export type SSEEventType =
  | "text_delta"
  | "tool_call_start"
  | "tool_result"
  | "error"
  | "done"
  | "title_update";

export interface SSEEvent {
  type: SSEEventType;
  data: string;
}

export interface TextDeltaEvent {
  type: "text_delta";
  content: string;
}

export interface ToolCallStartEvent {
  type: "tool_call_start";
  toolCallId: string;
  toolName: string;
  arguments: string;
  startedAt: number; // Unix ms timestamp
}

export interface ToolResultEvent {
  type: "tool_result";
  toolCallId: string;
  toolName: string;
  result: string;
  durationMs: number; // how long the tool call took
  error?: boolean;    // true if the tool threw an error
}

export interface ErrorEvent {
  type: "error";
  message: string;
}

export interface DoneEvent {
  type: "done";
  messageId: string;
  llmDurationMs?: number;   // total LLM streaming time for the final response
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

export interface TitleUpdateEvent {
  type: "title_update";
  conversationId: string;
  title: string;
}

export interface ChatRequest {
  conversationId: string;
  message: string;
  modelId?: string;
}

export interface ToolCallDisplay {
  id: string;
  name: string;
  arguments: string;
  result?: string;
  status: "calling" | "done" | "error";
  durationMs?: number; // tool execution time in ms
  error?: string;      // error message when status === "error"
}
