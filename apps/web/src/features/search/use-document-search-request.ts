import { useEffect, useState } from "react";
import { documentSearchQuery } from "./document-search-navigation.js";

export function useDocumentSearchRequest(documentId: string) {
  const read = () => {
    const query = documentSearchQuery(window.location.hash, documentId);
    return query ? { query } : null;
  };
  const [request, setRequest] = useState(read);
  useEffect(() => {
    const changed = () => setRequest(read());
    changed();
    window.addEventListener("hashchange", changed);
    return () => window.removeEventListener("hashchange", changed);
  }, [documentId]);
  return request;
}
