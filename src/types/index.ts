export interface User {
  id: number;
  plexId: string;
  plexUsername: string;
  plexEmail: string | null;
  plexAvatarUrl: string | null;
  isAdmin: boolean | null;
}

export interface Session {
  id: string;
  userId: number;
  expiresAt: Date;
}

export interface Conversation {
  id: string;
  userId: number;
  title: string | null;
  createdAt: Date;
  updatedAt: Date;
  ownerName?: string;
}

export interface Message {
  id: string;
  conversationId: string;
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  toolCalls: string | null;
  toolCallId: string | null;
  toolName: string | null;
  createdAt: Date;
}
