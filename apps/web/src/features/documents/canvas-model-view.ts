import type { CanvasModel } from "aidcanvas/model";
import { nativeCanvasElement } from "@core/shared/canvas-elements.js";

/** Legacy AI elements need native UI names, not a new CRDT lineage.
 * Only adapt the view projection: opening/selecting must never save a repair.
 * New server inserts already carry these names in their persisted model.
 */
export function withNativeCanvasView(model: CanvasModel): CanvasModel {
  const getValue = model.getValue.bind(model);
  model.getValue = () => {
    const value = getValue();
    return { ...value, scene: nativeCanvasElement(value.scene) };
  };
  return model;
}
