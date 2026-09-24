import type {
  CollaborationAdapter,
  CollaborationContext,
} from "@online-office/univer-sheet";

type CommandEvent = {
  id: string;
  type: number;
  params?: Record<string, unknown>;
  options?: { fromCollab?: boolean };
};
type CommandEvents = {
  Event: { CommandExecuted: string };
  addEvent(
    name: string,
    listener: (event: CommandEvent) => void,
  ): { dispose(): void };
};
export function isLocalSheetMutation(event: CommandEvent, workbookId: string) {
  return (
    event.type === 2 &&
    event.params?.unitId === workbookId &&
    !event.options?.fromCollab
  );
}
/** Compatibility for univer-sheet 0.1.0: FWorkbook.onCommandExecuted drops the
 * options argument despite the package's declaration. Use the public event
 * that retains fromCollab, not a timing flag that could discard concurrent input.
 */
export function withSheetCommandOrigins(
  adapter: CollaborationAdapter,
  editable: () => boolean,
): CollaborationAdapter {
  return {
    ...adapter,
    connect(context: CollaborationContext) {
      const api = context.runtime.univerAPI as unknown as CommandEvents;
      if (!api.addEvent || !api.Event?.CommandExecuted)
        throw Error("表格组件缺少可识别协同来源的命令事件，请更新组件");
      return adapter.connect({
        ...context,
        onLocalMutation(listener) {
          const subscription = api.addEvent(
            api.Event.CommandExecuted,
            (event) => {
              if (editable() && isLocalSheetMutation(event, context.workbookId))
                listener({ id: event.id, params: event.params });
            },
          );
          return () => subscription.dispose();
        },
      });
    },
  };
}
