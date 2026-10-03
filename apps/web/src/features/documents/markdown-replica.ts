import * as Y from "yjs";
import {
  createHostMarkdownSession,
  updateHostMarkdownSession,
} from "@smartdoca/markdown";

/** Receive the authoritative checkpoint before creating any local CRDT items. */
export function createMarkdownReplica() {
  const doc = new Y.Doc();
  const text = doc.getText("markdown");
  let session: ReturnType<typeof createHostMarkdownSession> | undefined;
  return {
    doc,
    text,
    session(state: Parameters<typeof updateHostMarkdownSession>[1]) {
      session ??= createHostMarkdownSession({
        doc,
        state: state.state,
        saveState: state.saveState,
        ready: state.ready,
      });
      return updateHostMarkdownSession(session, state);
    },
    dispose() {
      session?.dispose?.();
      doc.destroy();
    },
  };
}
