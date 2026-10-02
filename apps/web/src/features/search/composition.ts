/** IME confirmation/cancellation keys belong to the input method. */
export function composingKey(event: {
  isComposing?: boolean;
  keyCode?: number;
}) {
  return event.isComposing || event.keyCode === 229;
}

/** Keep unfinished IME text out of find/reveal, which can move editor focus. */
export function createCompositionGate(commit: (value: string) => void) {
  let composing = false;
  return {
    get composing() {
      return composing;
    },
    start() {
      composing = true;
    },
    change(value: string) {
      if (!composing) commit(value);
    },
    end(value: string) {
      composing = false;
      commit(value);
    },
  };
}
