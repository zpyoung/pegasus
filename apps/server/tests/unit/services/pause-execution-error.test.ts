import { describe, it, expect } from "vitest";
import { PauseExecutionError } from "@/services/pause-execution-error.js";

describe("PauseExecutionError", () => {
  describe("construction", () => {
    it("should be an instance of Error", () => {
      const error = new PauseExecutionError("feat-1", "question");
      expect(error).toBeInstanceOf(Error);
    });

    it("should be an instance of PauseExecutionError", () => {
      const error = new PauseExecutionError("feat-1", "question");
      expect(error).toBeInstanceOf(PauseExecutionError);
    });

    it("should set name to PauseExecutionError", () => {
      const error = new PauseExecutionError("feat-1", "question");
      expect(error.name).toBe("PauseExecutionError");
    });

    it("should set featureId correctly", () => {
      const error = new PauseExecutionError("feat-abc", "question");
      expect(error.featureId).toBe("feat-abc");
    });

    it('should set reason to "question"', () => {
      const error = new PauseExecutionError("feat-1", "question");
      expect(error.reason).toBe("question");
    });

    it('should set reason to "approval"', () => {
      const error = new PauseExecutionError("feat-1", "approval");
      expect(error.reason).toBe("approval");
    });

    it("should set isPauseError to true", () => {
      const error = new PauseExecutionError("feat-1", "question");
      expect(error.isPauseError).toBe(true);
    });

    it("should use default message when none provided", () => {
      const error = new PauseExecutionError("feat-1", "question");
      expect(error.message).toBe("Execution paused: question");
    });

    it("should use default message for approval reason", () => {
      const error = new PauseExecutionError("feat-1", "approval");
      expect(error.message).toBe("Execution paused: approval");
    });

    it("should use custom message when provided", () => {
      const error = new PauseExecutionError(
        "feat-1",
        "question",
        "Custom pause message",
      );
      expect(error.message).toBe("Custom pause message");
    });
  });

  describe("type narrowing", () => {
    it("should allow narrowing via instanceof from Error", () => {
      const error: Error = new PauseExecutionError("feat-1", "question");
      if (error instanceof PauseExecutionError) {
        expect(error.featureId).toBe("feat-1");
        expect(error.isPauseError).toBe(true);
      } else {
        throw new Error("Should have been a PauseExecutionError");
      }
    });

    it("should not be confused with generic errors", () => {
      const genericError = new Error("something broke");
      expect(genericError instanceof PauseExecutionError).toBe(false);
    });

    it("isPauseError property allows duck-typing check", () => {
      const error = new PauseExecutionError("feat-1", "question");
      // Duck-typing check pattern used in ExecutionService catch block
      expect((error as { isPauseError?: boolean }).isPauseError).toBe(true);
    });
  });
});
