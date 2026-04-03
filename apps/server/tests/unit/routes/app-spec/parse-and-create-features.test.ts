import { describe, it, expect } from 'vitest';

describe('app-spec/parse-and-create-features.ts - JSON extraction', () => {
  // Test the JSON extraction regex pattern used in parseAndCreateFeatures
  const jsonExtractionPattern = /\{[\s\S]*"features"[\s\S]*\}/;

  describe('JSON extraction regex', () => {
    it('should extract JSON with features array', () => {
      const content = `Here is the response:
{
  "features": [
    {
      "id": "feature-1",
      "title": "Test Feature",
      "description": "A test feature",
      "priority": 1,
      "complexity": "simple",
      "dependencies": []
    }
  ]
}`;

      const match = content.match(jsonExtractionPattern);
      expect(match).not.toBeNull();
      expect(match![0]).toContain('"features"');
      expect(match![0]).toContain('"id": "feature-1"');
    });

    it('should extract JSON with multiple features', () => {
      const content = `Some text before
{
  "features": [
    {
      "id": "feature-1",
      "title": "Feature 1"
    },
    {
      "id": "feature-2",
      "title": "Feature 2"
    }
  ]
}
Some text after`;

      const match = content.match(jsonExtractionPattern);
      expect(match).not.toBeNull();
      expect(match![0]).toContain('"features"');
      expect(match![0]).toContain('"feature-1"');
      expect(match![0]).toContain('"feature-2"');
    });

    it('should extract JSON with nested objects and arrays', () => {
      const content = `Response:
{
  "features": [
    {
      "id": "feature-1",
      "dependencies": ["dep-1", "dep-2"],
      "metadata": {
        "tags": ["tag1", "tag2"]
      }
    }
  ]
}`;

      const match = content.match(jsonExtractionPattern);
      expect(match).not.toBeNull();
      expect(match![0]).toContain('"dependencies"');
      expect(match![0]).toContain('"dep-1"');
    });

    it('should handle JSON with whitespace and newlines', () => {
      const content = `Text before
{
  "features": [
    {
      "id": "feature-1",
      "title": "Feature",
      "description": "A feature\nwith newlines"
    }
  ]
}
Text after`;

      const match = content.match(jsonExtractionPattern);
      expect(match).not.toBeNull();
      expect(match![0]).toContain('"features"');
    });

    it('should extract JSON when features array is empty', () => {
      const content = `Response:
{
  "features": []
}`;

      const match = content.match(jsonExtractionPattern);
      expect(match).not.toBeNull();
      expect(match![0]).toContain('"features"');
      expect(match![0]).toContain('[]');
    });

    it('should not match content without features key', () => {
      const content = `{
  "otherKey": "value"
}`;

      const match = content.match(jsonExtractionPattern);
      expect(match).toBeNull();
    });

    it('should not match content without JSON structure', () => {
      const content = 'Just plain text with features mentioned';
      const match = content.match(jsonExtractionPattern);
      expect(match).toBeNull();
    });

    it('should extract JSON when features key appears multiple times', () => {
      const content = `Before:
{
  "features": [
    {
      "id": "feature-1",
      "title": "Feature"
    }
  ]
}
After: The word "features" appears again`;

      const match = content.match(jsonExtractionPattern);
      expect(match).not.toBeNull();
      // Should match from first { to last }
      expect(match![0]).toContain('"features"');
    });

    it('should handle JSON with escaped quotes', () => {
      const content = `{
  "features": [
    {
      "id": "feature-1",
      "description": "A feature with \\"quotes\\""
    }
  ]
}`;

      const match = content.match(jsonExtractionPattern);
      expect(match).not.toBeNull();
      expect(match![0]).toContain('"features"');
    });

    it('should extract JSON with complex nested structure', () => {
      const content = `Response:
{
  "features": [
    {
      "id": "feature-1",
      "dependencies": [
        {
          "id": "dep-1",
          "type": "required"
        }
      ],
      "metadata": {
        "tags": ["tag1"],
        "notes": "Some notes"
      }
    }
  ],
  "metadata": {
    "version": "1.0"
  }
}`;

      const match = content.match(jsonExtractionPattern);
      expect(match).not.toBeNull();
      expect(match![0]).toContain('"features"');
      expect(match![0]).toContain('"metadata"');
    });
  });

  describe('JSON parsing validation', () => {
    it('should parse valid feature JSON structure', () => {
      const validJson = `{
  "features": [
    {
      "id": "feature-1",
      "title": "Test Feature",
      "description": "A test feature",
      "priority": 1,
      "complexity": "simple",
      "dependencies": []
    }
  ]
}`;

      const parsed = JSON.parse(validJson);
      expect(parsed.features).toBeDefined();
      expect(Array.isArray(parsed.features)).toBe(true);
      expect(parsed.features.length).toBe(1);
      expect(parsed.features[0].id).toBe('feature-1');
      expect(parsed.features[0].title).toBe('Test Feature');
    });

    it('should handle features with optional fields', () => {
      const jsonWithOptionalFields = `{
  "features": [
    {
      "id": "feature-1",
      "title": "Feature",
      "priority": 2,
      "complexity": "moderate"
    }
  ]
}`;

      const parsed = JSON.parse(jsonWithOptionalFields);
      expect(parsed.features[0].id).toBe('feature-1');
      expect(parsed.features[0].priority).toBe(2);
      // description and dependencies are optional
      expect(parsed.features[0].description).toBeUndefined();
      expect(parsed.features[0].dependencies).toBeUndefined();
    });

    it('should handle features with dependencies', () => {
      const jsonWithDeps = `{
  "features": [
    {
      "id": "feature-1",
      "title": "Feature 1",
      "dependencies": []
    },
    {
      "id": "feature-2",
      "title": "Feature 2",
      "dependencies": ["feature-1"]
    }
  ]
}`;

      const parsed = JSON.parse(jsonWithDeps);
      expect(parsed.features[0].dependencies).toEqual([]);
      expect(parsed.features[1].dependencies).toEqual(['feature-1']);
    });
  });
});
