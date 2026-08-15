export interface GcodeCommentState {
  readonly parenthesisDepth: number;
}

export interface NormalizedGcodeLine {
  readonly command: string | null;
  readonly state: GcodeCommentState;
}

export const INITIAL_GCODE_COMMENT_STATE: GcodeCommentState = Object.freeze({
  parenthesisDepth: 0,
});

/**
 * Removes semicolon and parenthetical comments without interpreting commands.
 * Parenthesis depth is carried across physical lines because some producers emit
 * multiline comments. A separating space prevents `X1(comment)Y2` becoming `X1Y2`.
 */
export function normalizeGcodeLine(
  input: string,
  initialState: GcodeCommentState = INITIAL_GCODE_COMMENT_STATE,
): NormalizedGcodeLine {
  let depth = Math.max(0, Math.trunc(initialState.parenthesisDepth));
  let output = '';
  let pendingSeparator = false;

  const line = input.replace(/^\uFEFF/, '').replace(/\r$/, '');
  for (const character of line) {
    if (depth > 0) {
      if (character === '(') {
        depth += 1;
      } else if (character === ')') {
        depth -= 1;
        if (depth === 0) {
          pendingSeparator = output.length > 0;
        }
      }
      continue;
    }

    if (character === ';') {
      break;
    }
    if (character === '(') {
      depth = 1;
      pendingSeparator = output.length > 0;
      continue;
    }
    if (character === ')') {
      // A stray closing parenthesis is data. Silently deleting it could change an
      // otherwise intentionally transmitted command.
      if (pendingSeparator && output.length > 0 && !/\s$/.test(output)) {
        output += ' ';
      }
      pendingSeparator = false;
      output += character;
      continue;
    }

    if (pendingSeparator && output.length > 0 && !/\s/.test(character) && !/\s$/.test(output)) {
      output += ' ';
    }
    pendingSeparator = false;
    output += character;
  }

  const command = output.trim().replace(/\s+/g, ' ');
  return {
    command: command.length === 0 ? null : command,
    state: { parenthesisDepth: depth },
  };
}

export function normalizeStartupMacro(input: string): readonly string[] {
  const commands: string[] = [];
  let state = INITIAL_GCODE_COMMENT_STATE;
  for (const line of input.split(/\r?\n/)) {
    const normalized = normalizeGcodeLine(line, state);
    state = normalized.state;
    if (normalized.command !== null) {
      commands.push(normalized.command);
    }
  }
  return commands;
}
