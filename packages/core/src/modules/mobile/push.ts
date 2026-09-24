export type MobilePush = {
  userId: string;
  title: string;
  body: string;
  path: string;
};

type Handler = (event: MobilePush) => void;
let handler: Handler | null = null;

export function setMobilePushHandler(next: Handler | null) {
  handler = next;
}

export function queueMobilePush(event: MobilePush) {
  try {
    handler?.(event);
  } catch {
    /* Push delivery must not fail the user action. */
  }
}
