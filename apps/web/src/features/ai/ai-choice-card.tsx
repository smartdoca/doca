import { useI18n } from "@web/shared/i18n.js";
import { useState } from "react";
import { Button, Card, Input, Radio, Space } from "antd";

export function AIChoiceCard({
  question,
  disabled,
  answer,
}: {
  question: { title: string; options: string[] };
  disabled: boolean;
  answer: (value: string) => void | Promise<void>;
}) {
const { t } = useI18n();

  const [selection, setSelection] = useState<string>();
  const [custom, setCustom] = useState("");
  const value = custom.trim() || selection;
  return (
    <Card size="small" className="ai-choice-card" title={question.title}>
      <Space orientation="vertical" style={{ width: "100%" }}>
        <Radio.Group
          value={custom ? undefined : selection}
          disabled={disabled}
          onChange={(e) => {
            setSelection(e.target.value);
            setCustom("");
          }}
        >
          <Space orientation="vertical">
            {question.options.map((option) => (
              <Radio key={option} value={option}>
                {option}
              </Radio>
            ))}
          </Space>
        </Radio.Group>
        {selection && !custom && (
          <Button
            type="link"
            size="small"
            aria-label="取消选择"
            onClick={() => setSelection(undefined)}
            style={{ alignSelf: "flex-start", paddingInline: 0 }}
          >
            取消选择，改为手填
          </Button>
        )}
        <Input.TextArea
          aria-label="自定义答案"
          placeholder="也可以填写自己的想法"
          autoSize={{ minRows: 1, maxRows: 4 }}
          disabled={disabled}
          value={custom}
          onFocus={() => setSelection(undefined)}
          onChange={(e) => {
            setCustom(e.target.value);
            if (e.target.value) setSelection(undefined);
          }}
        />
        <Button
          type="primary"
          size="small"
          disabled={disabled || !value}
          onClick={() =>
            value && void answer(`${question.title}\n我的选择：${value}`)
          }
        >{t("login.continue")}</Button>
      </Space>
    </Card>
  );
}
