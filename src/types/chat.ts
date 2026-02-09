export type SSEEventType =
  | "text_delta"
  | "tool_call_start"
  | "tool_result"
  | "error"
  | "done";

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
}

export interface ToolResultEvent {
  type: "tool_result";
  toolCallId: string;
  toolName: string;
  result: string;
}

export interface ErrorEvent {
  type: "error";
  message: string;
}

export interface DoneEvent {
  type: "done";
  messageId: string;
}

export interface ChatRequest {
  conversationId: string;
  message: string;
}

export interface ToolCallDisplay {
  id: string;
  name: string;
  arguments: string;
  result?: string;
  status: "calling" | "done" | "error";
}
