interface TerminalOutputProps {
  lines: string[];
}

export function TerminalOutput({ lines }: TerminalOutputProps) {
  return (
    <div className="bg-card border border-border rounded-lg p-4 font-mono text-sm max-h-48 overflow-y-auto">
      {lines.map((line, index) => (
        <div key={index} className="text-foreground">
          <span className="text-primary">$</span> {line}
        </div>
      ))}
      {lines.length === 0 && (
        <div className="text-muted-foreground italic">Waiting for output...</div>
      )}
    </div>
  );
}
