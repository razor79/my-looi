export type ExplicitRobotCommand =
  | { kind: "move"; direction: "forward" | "backward" | "stop" }
  | { kind: "turn"; direction: "left" | "right"; degrees: 90 | 180 }
  | { kind: "sleep" }
  | { kind: "dance" }
  | { kind: "gesture"; gesture: "nod"; count: number };

// Narrow STT recovery aliases are accepted only in the address position and
// still require the remainder to parse as a deterministic physical command.
const PREFIX_RE = /^\s*((?:луи|луй|луї|луі|лу\s*[,.;:\-–—]?\s*и)|looi|макс|max|робот|robot|уи|уй|рога)\s*[,!:\-–—]?\s+(.+)$/i;
export function hasExplicitRobotAddress(text: string): boolean {
  return PREFIX_RE.test(text.trim());
}

const MOVE_VERB_RE = /(?:^|\s)(?:едь|езжай|поедь|проедь|двигайся|двинься|повернись|поверни)(?=$|[\s.,!?])/i;

function isBareDirectionCommand(command: string, variants: string): boolean {
  return new RegExp(`^(?:${variants})(?:\\s+(?:пожалуйста|немного|чуть(?:-чуть)?))?[.!?]*$`, "i").test(command.trim());
}

/** Standalone STOP is an absolute safety keyword and never requires an address. */
export function containsEmergencyStopWord(text: string): boolean {
  return /(?:^|[^a-zа-яіїєґ])(?:стоп|stop)(?=$|[^a-zа-яіїєґ])/iu.test(text);
}

/**
 * Parse deterministic physical commands. Wheel movement/sleep still require an
 * explicit address at utterance start. STOP is additionally handled by the
 * global emergency path before this parser.
 */
function normalizeKnownGluedRobotAddress(text: string): string {
  // Whisper occasionally joins the wake address to a short deterministic command
  // (for example "Луикивни три раза"). Only split known physical-command stems so
  // arbitrary conversational words beginning with "луи" are not broadened.
  return text.trim().replace(
    /^(луи|луй|луї|луі|макс|max|робот|robot|уи|уй|рога)(?=(?:кивни|кивай|стоп|стой|спи|засни|потанцуй|потанцюй|танцуй|танцюй|dance|впер[её]д|назад|влево|вправо|налево|направо|развернись))/iu,
    "$1 "
  );
}


function stripNaturalCommandLeadIns(command: string): string {
  let value = command.trim();
  // Address-at-start remains mandatory. These fillers are accepted only AFTER
  // a valid "Луи/Робот" address so natural forms like "Робот, давай назад"
  // remain deterministic physical commands rather than broad conversation.
  const leadIn = /^(?:(?:ну\s+)?давай(?:-ка)?|ну-ка|теперь|а\s+теперь|ладно|хорошо|окей|пожалуйста)\s+/iu;
  for (let i = 0; i < 3; i += 1) {
    const next = value.replace(leadIn, "");
    if (next === value) break;
    value = next.trim();
  }
  return value;
}

export function parseExplicitRobotCommand(text: string): ExplicitRobotCommand | null {
  const match = PREFIX_RE.exec(normalizeKnownGluedRobotAddress(text));
  if (!match) return null;

  const command = stripNaturalCommandLeadIns(match[2].trim().toLowerCase());

  if (/(?:^|\s)(?:спи|засни|засыпай|иди\s+спать|ложись\s+спать)(?=$|[\s.,!?])/i.test(command)) {
    return { kind: "sleep" };
  }

  if (/(?:^|\s)(?:кивни|кивай|сделай\s+кивок)(?=$|[\s.,!?])/i.test(command)) {
    return { kind: "gesture", gesture: "nod", count: parseRequestedNodCount(command) };
  }

  if (/(?:^|\s)(?:потанцуй|станцуй|танцуй|потанцюй|станцюй|танцюй|dance|do\s+a\s+dance)(?=$|[\s.,!?])/iu.test(command)) {
    return { kind: "dance" };
  }

  if (/(?:^|\s)(?:стоп|стой|остановись|останови\s+движение)(?=$|[\s.,!?])/i.test(command)) {
    return { kind: "move", direction: "stop" };
  }

  if (
    /(?:^|\s)(?:развернись|разверни|повернись\s+обратно|поверни\s+обратно)(?=$|[\s.,!?])/i.test(command) ||
    /(?:^|\s)(?:180|сто\s+восемьдесят)\s*(?:градус(?:ов|а)?|°)?(?=$|[\s.,!?])/i.test(command)
  ) {
    // Clockwise/right is the deterministic default for a 180° turn.
    return { kind: "turn", direction: "right", degrees: 180 };
  }

  const hasMoveVerb = MOVE_VERB_RE.test(command);

  if (
    (hasMoveVerb && /(?:^|\s)(?:впер[её]д|прямо)(?=$|[\s.,!?])/i.test(command)) ||
    isBareDirectionCommand(command, "впер[её]д|прямо")
  ) {
    return { kind: "move", direction: "forward" };
  }
  if (
    (hasMoveVerb && /(?:^|\s)(?:назад|обратно)(?=$|[\s.,!?])/i.test(command)) ||
    isBareDirectionCommand(command, "назад|обратно")
  ) {
    return { kind: "move", direction: "backward" };
  }
  if (
    (hasMoveVerb && /(?:^|\s)(?:влево|налево|левее)(?=$|[\s.,!?])/i.test(command)) ||
    isBareDirectionCommand(command, "влево|налево|левее")
  ) {
    return { kind: "turn", direction: "left", degrees: 90 };
  }
  if (
    (hasMoveVerb && /(?:^|\s)(?:вправо|направо|правее)(?=$|[\s.,!?])/i.test(command)) ||
    isBareDirectionCommand(command, "вправо|направо|правее")
  ) {
    return { kind: "turn", direction: "right", degrees: 90 };
  }

  return null;
}

function parseRequestedNodCount(command: string): number {
  const digit = /(?:^|\s)([1-5])\s*(?:раз(?:а)?|разок)?(?=$|[\s.,!?])/i.exec(command);
  if (digit) return Number(digit[1]);

  const wordCounts: Array<[RegExp, number]> = [
    [/(?:^|\s)(?:пять|пятикратно)(?=\s|$|[.,!?])/i, 5],
    [/(?:^|\s)(?:четыре|четырежды)(?=\s|$|[.,!?])/i, 4],
    [/(?:^|\s)(?:три|трижды)(?=\s|$|[.,!?])/i, 3],
    [/(?:^|\s)(?:два|две|дважды)(?=\s|$|[.,!?])/i, 2],
    [/(?:^|\s)(?:один|одна|один раз)(?=\s|$|[.,!?])/i, 1],
  ];
  for (const [pattern, count] of wordCounts) {
    if (pattern.test(command)) return count;
  }
  return 1;
}
