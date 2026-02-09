import { NextResponse } from "next/server";
import { testConnection } from "@/lib/services/test-connection";
import type { TestConnectionRequest, TestConnectionResponse, ApiResponse } from "@/types/api";

export async function POST(request: Request) {
  let body: TestConnectionRequest;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json<ApiResponse>(
      { success: false, error: "Invalid JSON body" },
      { status: 400 },
    );
  }

  if (!body.type || !body.url || !body.apiKey) {
    return NextResponse.json<ApiResponse>(
      { success: false, error: "type, url, and apiKey are required" },
      { status: 400 },
    );
  }

  const result: TestConnectionResponse = await testConnection(body);

  return NextResponse.json<ApiResponse<TestConnectionResponse>>({
    success: result.success,
    data: result,
    error: result.success ? undefined : result.message,
  });
}
