import { useCallback, useRef, useState } from "react";
import { createCompositionGate } from "./composition.js";

export function useFindQuery() {
  const [query, setQuery] = useState("");
  const [value, setValue] = useState("");
  const [composing, setComposing] = useState(false);
  const gate = useRef<ReturnType<typeof createCompositionGate> | null>(null);
  gate.current ??= createCompositionGate(setQuery);
  const updateQuery = useCallback((text: string) => {
    setValue(text);
    gate.current!.end(text);
    setComposing(false);
  }, []);
  return {
    setQuery: updateQuery,
    query,
    composing,
    gate: gate.current,
    inputProps: {
      value,
      onChange: (e: React.ChangeEvent<HTMLInputElement>) => {
        setValue(e.currentTarget.value);
        gate.current!.change(e.currentTarget.value);
      },
      onCompositionStart: () => {
        gate.current!.start();
        setComposing(true);
      },
      onCompositionEnd: (e: React.CompositionEvent<HTMLInputElement>) => {
        setValue(e.currentTarget.value);
        gate.current!.end(e.currentTarget.value);
        setComposing(false);
      },
    },
  };
}
