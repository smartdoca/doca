import { useState } from "react";
import { Package } from "lucide-react";

export function PluginStoreIcon({
  pluginId,
  size = 20,
}: {
  pluginId: string;
  size?: number;
}) {
  const src = `/api/v1/plugin-icons/${encodeURIComponent(pluginId)}`;
  const [loadedSource, setLoadedSource] = useState<string>();
  const [failedSource, setFailedSource] = useState<string>();
  const loaded = loadedSource === src && failedSource !== src;
  return (
    <span
      className="plugin-store-icon"
      style={{ width: size, height: size }}
      aria-hidden="true"
    >
      {!loaded && <Package size={size} />}
      {failedSource !== src && (
        <img
          src={src}
          alt=""
          width={size}
          height={size}
          hidden={!loaded}
          onLoad={() => setLoadedSource(src)}
          onError={() => setFailedSource(src)}
        />
      )}
    </span>
  );
}
