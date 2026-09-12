export interface ControlOutput {
  paneId: string;
  data: string;
}

const OUTPUT_PATTERN = /^%output (%\d+) (.*)$/;
const LAYOUT_CHANGE_PATTERN = /^%layout-change /;

export const decodeControlValue = (value: string): string => value.replace(
  /\\([0-7]{3})/g,
  (_match, octal: string) => String.fromCharCode(Number.parseInt(octal, 8)),
);

export const parseControlOutput = (line: string): ControlOutput | null => {
  const match = OUTPUT_PATTERN.exec(line);
  if (!match) return null;
  return { paneId: match[1], data: decodeControlValue(match[2]) };
};

export const isControlLayoutChange = (line: string): boolean => LAYOUT_CHANGE_PATTERN.test(line);
