import { Component, type ReactNode } from "react";

function EditorBody({ render }: { render(): ReactNode }) {
  return render();
}
/** Rendering failures must not take down navigation or destroy the live/local document. */
export class EditorRecoveryBoundary extends Component<
  {
    render(): ReactNode;
    readText(): string;
    backup(): void;
    onFailure(): void;
  },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch() {
    this.props.onFailure();
  }
  render() {
    if (!this.state.failed) return <EditorBody render={this.props.render} />;
    let text = "";
    try {
      text = this.props.readText();
    } catch {
      /* Raw checkpoint remains recoverable. */
    }
    return (
      <section className="editor-recovery-view">
        <div role="alert">
          编辑器显示异常，文档和本地修改仍保留，未进行清空或覆盖。可先下载恢复文件。
        </div>
        <button onClick={this.props.backup}>下载恢复文件</button>
        {text && (
          <pre
            style={{
              whiteSpace: "pre-wrap",
              overflowWrap: "anywhere",
              fontFamily: "inherit",
            }}
          >
            {text}
          </pre>
        )}
      </section>
    );
  }
}
