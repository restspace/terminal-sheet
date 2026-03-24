const nextResizeGenerationBySessionId = new Map<string, number>();

export function reserveNextTerminalResizeGeneration(
  sessionId: string,
  appliedGeneration: number | null | undefined,
): number {
  const nextGeneration = Math.max(
    nextResizeGenerationBySessionId.get(sessionId) ?? 1,
    (appliedGeneration ?? 0) + 1,
  );

  nextResizeGenerationBySessionId.set(sessionId, nextGeneration + 1);
  return nextGeneration;
}

export function observeAppliedTerminalResizeGeneration(
  sessionId: string,
  appliedGeneration: number | null | undefined,
): void {
  const nextGeneration = Math.max(
    nextResizeGenerationBySessionId.get(sessionId) ?? 1,
    (appliedGeneration ?? 0) + 1,
  );

  nextResizeGenerationBySessionId.set(sessionId, nextGeneration);
}

export function resetTerminalResizeGenerationStateForTests(): void {
  nextResizeGenerationBySessionId.clear();
}
