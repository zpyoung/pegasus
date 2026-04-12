import { describe, it, expect } from "vitest";
import {
  specToXml,
  getStructuredSpecPromptInstruction,
  getAppSpecFormatInstruction,
  APP_SPEC_XML_FORMAT,
  type SpecOutput,
} from "@/lib/app-spec-format.js";

describe("app-spec-format.ts", () => {
  describe("specToXml", () => {
    it("should convert minimal spec to XML", () => {
      const spec: SpecOutput = {
        project_name: "Test Project",
        overview: "A test project",
        technology_stack: ["TypeScript", "Node.js"],
        core_capabilities: ["Testing", "Development"],
        implemented_features: [
          { name: "Feature 1", description: "First feature" },
        ],
      };

      const xml = specToXml(spec);

      expect(xml).toContain('<?xml version="1.0" encoding="UTF-8"?>');
      expect(xml).toContain("<project_specification>");
      expect(xml).toContain("</project_specification>");
      expect(xml).toContain("<project_name>Test Project</project_name>");
      expect(xml).toContain("<technology>TypeScript</technology>");
      expect(xml).toContain("<capability>Testing</capability>");
    });

    it("should escape XML special characters", () => {
      const spec: SpecOutput = {
        project_name: "Test & Project",
        overview: "Description with <tags>",
        technology_stack: ["TypeScript"],
        core_capabilities: ["Cap"],
        implemented_features: [],
      };

      const xml = specToXml(spec);

      expect(xml).toContain("Test &amp; Project");
      expect(xml).toContain("&lt;tags&gt;");
    });

    it("should include file_locations when provided", () => {
      const spec: SpecOutput = {
        project_name: "Test",
        overview: "Test",
        technology_stack: ["TS"],
        core_capabilities: ["Cap"],
        implemented_features: [
          {
            name: "Feature",
            description: "Desc",
            file_locations: ["src/index.ts"],
          },
        ],
      };

      const xml = specToXml(spec);

      expect(xml).toContain("<file_locations>");
      expect(xml).toContain("<location>src/index.ts</location>");
    });

    it("should not include file_locations when empty", () => {
      const spec: SpecOutput = {
        project_name: "Test",
        overview: "Test",
        technology_stack: ["TS"],
        core_capabilities: ["Cap"],
        implemented_features: [
          { name: "Feature", description: "Desc", file_locations: [] },
        ],
      };

      const xml = specToXml(spec);

      expect(xml).not.toContain("<file_locations>");
    });

    it("should include additional_requirements when provided", () => {
      const spec: SpecOutput = {
        project_name: "Test",
        overview: "Test",
        technology_stack: ["TS"],
        core_capabilities: ["Cap"],
        implemented_features: [],
        additional_requirements: ["Node.js 18+"],
      };

      const xml = specToXml(spec);

      expect(xml).toContain("<additional_requirements>");
      expect(xml).toContain("<requirement>Node.js 18+</requirement>");
    });

    it("should include development_guidelines when provided", () => {
      const spec: SpecOutput = {
        project_name: "Test",
        overview: "Test",
        technology_stack: ["TS"],
        core_capabilities: ["Cap"],
        implemented_features: [],
        development_guidelines: ["Use ESLint"],
      };

      const xml = specToXml(spec);

      expect(xml).toContain("<development_guidelines>");
      expect(xml).toContain("<guideline>Use ESLint</guideline>");
    });

    it("should include implementation_roadmap when provided", () => {
      const spec: SpecOutput = {
        project_name: "Test",
        overview: "Test",
        technology_stack: ["TS"],
        core_capabilities: ["Cap"],
        implemented_features: [],
        implementation_roadmap: [
          { phase: "Phase 1", status: "completed", description: "Setup" },
        ],
      };

      const xml = specToXml(spec);

      expect(xml).toContain("<implementation_roadmap>");
      expect(xml).toContain("<status>completed</status>");
    });

    it("should not include optional sections when empty", () => {
      const spec: SpecOutput = {
        project_name: "Test",
        overview: "Test",
        technology_stack: ["TS"],
        core_capabilities: ["Cap"],
        implemented_features: [],
        additional_requirements: [],
        development_guidelines: [],
        implementation_roadmap: [],
      };

      const xml = specToXml(spec);

      expect(xml).not.toContain("<additional_requirements>");
      expect(xml).not.toContain("<development_guidelines>");
      expect(xml).not.toContain("<implementation_roadmap>");
    });
  });

  describe("getStructuredSpecPromptInstruction", () => {
    it("should return non-empty prompt instruction", () => {
      const instruction = getStructuredSpecPromptInstruction();
      expect(instruction).toBeTruthy();
      expect(instruction.length).toBeGreaterThan(100);
    });

    it("should mention required fields", () => {
      const instruction = getStructuredSpecPromptInstruction();
      expect(instruction).toContain("project_name");
      expect(instruction).toContain("overview");
      expect(instruction).toContain("technology_stack");
    });
  });

  describe("getAppSpecFormatInstruction", () => {
    it("should return non-empty format instruction", () => {
      const instruction = getAppSpecFormatInstruction();
      expect(instruction).toBeTruthy();
      expect(instruction.length).toBeGreaterThan(100);
    });

    it("should include critical formatting requirements", () => {
      const instruction = getAppSpecFormatInstruction();
      expect(instruction).toContain("CRITICAL FORMATTING REQUIREMENTS");
    });
  });

  describe("APP_SPEC_XML_FORMAT", () => {
    it("should contain valid XML template structure", () => {
      expect(APP_SPEC_XML_FORMAT).toContain("<project_specification>");
      expect(APP_SPEC_XML_FORMAT).toContain("</project_specification>");
    });
  });
});
