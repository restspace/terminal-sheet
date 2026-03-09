const MAX_PREVIEW_LINES = 6;

export function renderTerminalText(raw: string): string {
  const screen: string[][] = [[]];
  let row = 0;
  let column = 0;

  for (let index = 0; index < raw.length; index += 1) {
    const character = raw[index];

    if (character === undefined) {
      break;
    }

    if (character === '\u001b') {
      const nextCharacter = raw[index + 1];

      if (nextCharacter === '[') {
        const sequence = readCsiSequence(raw, index + 2);

        if (!sequence) {
          break;
        }

        applyCsiSequence(sequence.parameters, sequence.final, {
          getLine: () => ensureRow(screen, row),
          setLine: (nextLine) => {
            screen[row] = nextLine;
          },
          getRow: () => row,
          setRow: (nextRow) => {
            row = Math.max(0, nextRow);
            ensureRow(screen, row);
          },
          getColumn: () => column,
          setColumn: (nextColumn) => {
            column = Math.max(0, nextColumn);
          },
          clearScreen: () => {
            screen.length = 0;
            screen.push([]);
            row = 0;
            column = 0;
          },
        });
        index = sequence.endIndex;
        continue;
      }

      if (nextCharacter === ']') {
        index = readOscSequenceEnd(raw, index + 2);
        continue;
      }

      if (nextCharacter) {
        index += 1;
      }

      continue;
    }

    if (character === '\r') {
      column = 0;
      continue;
    }

    if (character === '\n') {
      row += 1;
      column = 0;
      ensureRow(screen, row);
      continue;
    }

    if (character === '\b') {
      if (column > 0) {
        column -= 1;
        ensureRow(screen, row).splice(column, 1);
      }

      continue;
    }

    if (character === '\t') {
      const spacesToInsert = 2;

      for (let offset = 0; offset < spacesToInsert; offset += 1) {
        writeCharacter(' ');
      }

      continue;
    }

    if (isControlCharacter(character)) {
      continue;
    }

    writeCharacter(character);
  }

  return screen.map((line) => line.join('').trimEnd()).join('\n');

  function writeCharacter(character: string): void {
    const line = ensureRow(screen, row);

    while (line.length < column) {
      line.push(' ');
    }

    if (column === line.length) {
      line.push(character);
    } else {
      line[column] = character;
    }

    column += 1;
  }
}

export function extractPreviewLines(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0)
    .slice(-MAX_PREVIEW_LINES);
}

function isControlCharacter(character: string): boolean {
  return character < ' ' || character === '\u007f';
}

function readCsiSequence(
  raw: string,
  startIndex: number,
): {
  parameters: string;
  final: string;
  endIndex: number;
} | null {
  let parameters = '';

  for (let index = startIndex; index < raw.length; index += 1) {
    const character = raw[index];

    if (!character) {
      break;
    }

    if (character >= '@' && character <= '~') {
      return {
        parameters,
        final: character,
        endIndex: index,
      };
    }

    parameters += character;
  }

  return null;
}

function readOscSequenceEnd(raw: string, startIndex: number): number {
  for (let index = startIndex; index < raw.length; index += 1) {
    const character = raw[index];
    const nextCharacter = raw[index + 1];

    if (character === '\u0007') {
      return index;
    }

    if (character === '\u001b' && nextCharacter === '\\') {
      return index + 1;
    }
  }

  return raw.length - 1;
}

function applyCsiSequence(
  parameters: string,
  final: string,
  state: {
    getLine: () => string[];
    setLine: (nextLine: string[]) => void;
    getRow: () => number;
    setRow: (row: number) => void;
    getColumn: () => number;
    setColumn: (column: number) => void;
    clearScreen: () => void;
  },
): void {
  const line = state.getLine();
  const row = state.getRow();
  const column = state.getColumn();
  const values = parameters
    .split(';')
    .map((part) => Number.parseInt(part.replace(/[^\d-]/g, ''), 10));
  const maybeFirstValue = values[0];
  const maybeSecondValue = values[1];
  const firstValue =
    maybeFirstValue !== undefined && Number.isFinite(maybeFirstValue)
      ? maybeFirstValue
      : 0;
  const secondValue =
    maybeSecondValue !== undefined && Number.isFinite(maybeSecondValue)
      ? maybeSecondValue
      : 0;

  switch (final) {
    case 'A':
      state.setRow(row - Math.max(firstValue, 1));
      return;
    case 'B':
      state.setRow(row + Math.max(firstValue, 1));
      return;
    case 'C':
      state.setColumn(column + Math.max(firstValue, 1));
      return;
    case 'D':
      state.setColumn(column - Math.max(firstValue, 1));
      return;
    case 'G':
      state.setColumn(Math.max(firstValue, 1) - 1);
      return;
    case 'H':
    case 'f':
      state.setRow(Math.max(firstValue || 1, 1) - 1);
      state.setColumn(Math.max(secondValue || 1, 1) - 1);
      return;
    case 'J':
      if (firstValue === 2) {
        state.clearScreen();
      }

      return;
    case 'K': {
      const mode = firstValue;

      if (mode === 2) {
        state.setLine([]);
        state.setColumn(0);
        return;
      }

      if (mode === 1) {
        const nextLine = [...line];

        for (
          let index = 0;
          index < Math.min(column, nextLine.length);
          index += 1
        ) {
          nextLine[index] = ' ';
        }

        state.setLine(nextLine);
        return;
      }

      state.setLine(line.slice(0, column));
      return;
    }
    case 'P':
      state.setLine([
        ...line.slice(0, column),
        ...line.slice(column + Math.max(firstValue, 1)),
      ]);
      return;
    default:
      return;
  }
}

function ensureRow(screen: string[][], row: number): string[] {
  while (screen.length <= row) {
    screen.push([]);
  }

  return screen[row]!;
}
