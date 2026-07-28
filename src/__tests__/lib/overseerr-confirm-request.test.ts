/**
 * Unit tests for the overseerr_confirm_request MCP tool — approves or declines
 * a pending request in Overseerr's request queue via PUT /request/{id}/approve|decline.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockApproveRequest = vi.fn();
const mockDeclineRequest = vi.fn();
vi.mock("@/lib/services/overseerr", () => ({
  approveRequest: (...a: unknown[]) => mockApproveRequest(...a),
  declineRequest: (...a: unknown[]) => mockDeclineRequest(...a),
}));

describe("overseerr_confirm_request", () => {
  beforeEach(() => {
    vi.resetModules();
    mockApproveRequest.mockReset();
    mockDeclineRequest.mockReset();
  });

  it("calls approveRequest with requestId when action is 'approve'", async () => {
    mockApproveRequest.mockResolvedValue({ success: true, message: "Request approved" });

    const { registerOverseerrTools } = await import("@/lib/tools/overseerr-tools");
    const { executeTool } = await import("@/lib/tools/registry");
    registerOverseerrTools();

    const raw = await executeTool("overseerr_confirm_request", JSON.stringify({ requestId: 706, action: "approve" }));
    const result = JSON.parse(raw);

    expect(mockApproveRequest).toHaveBeenCalledWith(706);
    expect(mockDeclineRequest).not.toHaveBeenCalled();
    expect(result).toEqual({ success: true, message: "Request approved" });
  });

  it("calls declineRequest with requestId when action is 'decline'", async () => {
    mockDeclineRequest.mockResolvedValue({ success: true, message: "Request declined" });

    const { registerOverseerrTools } = await import("@/lib/tools/overseerr-tools");
    const { executeTool } = await import("@/lib/tools/registry");
    registerOverseerrTools();

    const raw = await executeTool("overseerr_confirm_request", JSON.stringify({ requestId: 42, action: "decline" }));
    const result = JSON.parse(raw);

    expect(mockDeclineRequest).toHaveBeenCalledWith(42);
    expect(mockApproveRequest).not.toHaveBeenCalled();
    expect(result).toEqual({ success: true, message: "Request declined" });
  });

  it("rejects an invalid action via schema validation", async () => {
    const { registerOverseerrTools } = await import("@/lib/tools/overseerr-tools");
    const { executeTool } = await import("@/lib/tools/registry");
    registerOverseerrTools();

    const raw = await executeTool("overseerr_confirm_request", JSON.stringify({ requestId: 706, action: "delete" }));
    const result = JSON.parse(raw);

    expect(result.error).toBeDefined();
    expect(mockApproveRequest).not.toHaveBeenCalled();
    expect(mockDeclineRequest).not.toHaveBeenCalled();
  });

  it("rejects a missing requestId via schema validation", async () => {
    const { registerOverseerrTools } = await import("@/lib/tools/overseerr-tools");
    const { executeTool } = await import("@/lib/tools/registry");
    registerOverseerrTools();

    const raw = await executeTool("overseerr_confirm_request", JSON.stringify({ action: "approve" }));
    const result = JSON.parse(raw);

    expect(result.error).toBeDefined();
    expect(mockApproveRequest).not.toHaveBeenCalled();
  });
});
